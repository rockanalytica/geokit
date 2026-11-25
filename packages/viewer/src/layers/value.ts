// What every value-coloured layer shares: a colormap LUT as a
// texture, thresholds and a class mask as uniforms, and the GLSL that turns
// one value into a colour or a discard. Prisms, blocks and points differ in
// geometry and lighting, not in how a value becomes a colour.

import { DataTexture, RGBAFormat, type Texture, UnsignedByteType } from "three";
import { buildLut, type Colormap, EMBER, OKABE_ITO } from "../colormap";
import type { Vec3 } from "../types";

/** Most breaks a view can cut at: the size of the shader's array. */
export const MAX_BREAKS = 16;
/** A class code above this is an element of no class (drawn in the missing colour). */
export const NO_CLASS_ABOVE = 60000;
/** Texels in a continuous Colormap's table; a categorical one has one per colour. */
export const CONTINUOUS_LUT_SIZE = 256;

/** One Viewport's colouring of a column. */
export interface ValueView {
  column: string;
  /** Colour scale limits (continuous). */
  colourRange: [number, number];
  /** Values outside are hidden (continuous). */
  filterRange: [number, number];
  /** Classes shown (categorical), by index. */
  classMask: boolean[];
  /** Whether elements with no value, or of no class, are shown; absent, they are. */
  blanks?: boolean;
  /** What a missing value is drawn in, [r, g, b] 0–255; absent: the default grey. */
  missing?: [number, number, number];
  /** Colours by class index (categorical), [r, g, b] 0–255; absent: the default Colormap. */
  classColours?: [number, number, number][];
  /** The continuous Colormap's stops, [r, g, b] 0–255; absent: the default. */
  colours?: [number, number, number][];
  /**
   * Place values by their logarithm within the colour range (both ends above
   * zero; else it is ignored). A value at or below zero has no logarithm and
   * is drawn as the lowest colour, not as missing.
   */
  log?: boolean;
  /** Equal colour classes over the colour range; 0 or absent: continuous. */
  steps?: number;
  /** Colour classes cut at these values, ascending, at most `MAX_BREAKS`; they override the range. */
  breaks?: number[];
  /** Maximum-intensity projection: high values over low, regardless of depth. */
  mip: boolean;
}

// No function here discards or writes an out parameter: on ANGLE's
// Direct3D backend a discard inside such a function fails to compile with
// optimisation ("argument pulled into unrelated predicate"), and the
// unoptimised retry silently drops branches that follow the call. Each
// fragment shader asks valueHidden() and discards in main() itself.

/**
 * What a missing value is on the GPU. A NaN is not trusted there: ANGLE's
 * Direct3D backend (every WebGL browser on Windows) does not reliably keep
 * the self-comparison test for NaN, and a column of NaN drew nothing at all. So a continuous column
 * is uploaded with each NaN replaced by this finite value, and the shaders
 * ask `isMissing`. The arrays the app reads (picking, inspecting, filters)
 * keep their NaN; only the attribute changes.
 */
export const MISSING_ON_GPU = -3.0e38;

/**
 * Below this a value counts as missing. Far above `MISSING_ON_GPU` so that a
 * face interpolated between a missing corner and a real one (weights down to
 * a few parts in a billion) is still missing, as a NaN would have made it.
 */
export const MISSING_BELOW = -1.0e30;

/** What a missing value is drawn in unless its Colouring says otherwise (#5b5e7a). */
export const MISSING_RGB: [number, number, number] = [91, 94, 122];

/** A column's values as the GPU gets them: NaN becomes `MISSING_ON_GPU`. */
export function gpuValues(values: ArrayLike<number>): Float32Array {
  return Float32Array.from(values, (v) => (Number.isNaN(v) ? MISSING_ON_GPU : v));
}

/** One value as the GPU gets it; see `gpuValues`. */
export const gpuValue = (v: number): number => (Number.isNaN(v) ? MISSING_ON_GPU : v);

/**
 * `isMissing(v)` for any shader that reads a value. No discard in it, for
 * the reason below. A vertex shader that does not include `VALUE_HEAD` or
 * `VALUE_PICK_HEAD` takes this by itself.
 */
export const MISSING_GLSL = /* glsl */ `
  bool isMissing(float v) {
    return v < ${MISSING_BELOW.toExponential(1)};
  }
`;

// NO_CLASS: the code of an element of no class, which is
// drawn in the missing colour rather than as the first class
const NO_CLASS_TEST = `v > ${NO_CLASS_ABOVE.toFixed(1)}`;

/**
 * A filter on the source, as the shaders see it: one flag per element, 1 to
 * draw it. It is a test of its own rather than part of `valueHidden` because
 * a filter asks several questions at once — other columns, and where the
 * element is — which no uniform on the coloured value could answer. The mask
 * is computed once on the CPU and carried as an attribute.
 */
export const KEEP_TEST = /* glsl */ `
  uniform int uFiltered;
  varying float vKept;
  bool filteredOut() {
    return uFiltered == 1 && vKept < 0.5;
  }
`;

/**
 * Whether a value is hidden: filtered out, of a masked class, or a blank
 * switched off.
 *
 * The classes shown arrive as a texture, one texel per class. It was an
 * array of 32 floats, and a class past the 32nd was hidden — silently, and
 * counted as hidden by the plots too, so a Variable of 40 rock types drew as
 * 32 and nothing said which 8 had gone. A texture has no such ceiling.
 */
const VALUE_HIDDEN_TEST = /* glsl */ `
  uniform float uFilterMin;
  uniform float uFilterMax;
  uniform int uCategorical;
  uniform int uBlanks;
  uniform sampler2D uClassMask;
  uniform float uMaskSize;
  bool valueHidden(float v) {
    if (isMissing(v)) return uBlanks == 0;
    if (uCategorical == 1) {
      if (${NO_CLASS_TEST}) return uBlanks == 0;
      int c = int(v + 0.5);
      if (c < 0) return true;
      // no mask reaches it: shown, as a mask short of the classes always meant
      if (float(c) >= uMaskSize) return false;
      return texture2D(uClassMask, vec2((float(c) + 0.5) / uMaskSize, 0.5)).r < 0.5;
    }
    // a value at the bound is kept: interpolated across a face it wobbles by
    // an ulp, and an exact test would speckle the extreme elements away
    // over the ends set only: an open one would open the other too
    float lo = isinf(uFilterMin) ? 0.0 : abs(uFilterMin);
    float hi = isinf(uFilterMax) ? 0.0 : abs(uFilterMax);
    float eps = 1e-6 * max(lo, hi);
    return v < uFilterMin - eps || v > uFilterMax + eps;
  }
`;

const VALUE_HIDDEN = /* glsl */ `
  ${MISSING_GLSL}
  ${VALUE_HIDDEN_TEST}
`;

/** The uniforms and the functions a fragment shader needs to colour a value. */
export const VALUE_HEAD = /* glsl */ `
  uniform sampler2D uLut;
  uniform float uMin;
  uniform float uMax;
  uniform int uMip;
  uniform vec3 uMissing;
  uniform int uLog;
  uniform int uSteps;
  uniform int uBreakCount;
  uniform float uBreaks[${MAX_BREAKS}];
  uniform float uLutSize;
  ${VALUE_HIDDEN}
  // the colour of a value in rgb, and in a its position on the scale, for
  // the MIP depth; a hidden value was discarded before this is asked. The
  // position follows the app's scale: breaks, else log or
  // linear within the range, then equal steps
  vec4 valueColour(float v) {
    if (isMissing(v)) return vec4(uMissing, 0.0);
    if (uCategorical == 1) {
      if (${NO_CLASS_TEST}) return vec4(uMissing, 0.0);
      // a categorical LUT is one texel per colour, so a class indexes it
      // straight, and the wrap repeats the set exactly as classColourOf does
      float c = mod(float(int(v + 0.5)), uLutSize);
      return vec4(texture2D(uLut, vec2((c + 0.5) / uLutSize, 0.5)).rgb, 0.0);
    }
    float t;
    if (uBreakCount > 0) {
      float k = 0.0;
      for (int i = 0; i < ${MAX_BREAKS}; i++) {
        if (i < uBreakCount && v >= uBreaks[i]) k += 1.0;
      }
      t = (k + 0.5) / float(uBreakCount + 1);
    } else {
      float lo = uMin;
      float hi = uMax;
      float x = v;
      if (uLog == 1) {
        lo = log(uMin);
        hi = log(uMax);
        x = v > 0.0 ? log(v) : lo - 1.0;
      }
      t = clamp((x - lo) / max(hi - lo, 1e-9), 0.0, 1.0);
      if (uSteps > 1) {
        float n = float(uSteps);
        t = (min(floor(t * n), n - 1.0) + 0.5) / n;
      }
    }
    // t = 0 and 1 are the centres of the first and last texel, whatever the table's size
    return vec4(texture2D(uLut, vec2((t * (uLutSize - 1.0) + 0.5) / uLutSize, 0.5)).rgb, t);
  }
`;

/** The same test for an id pass, so a hidden element cannot be picked. */
export const VALUE_PICK_HEAD = VALUE_HIDDEN;

/**
 * The same test in a vertex shader that already has `isMissing`: where the
 * value is the same at every vertex of an element — a block, a sphere — it
 * is hidden whole before anything of it is rasterised.
 */
export const VALUE_HIDDEN_VERT = VALUE_HIDDEN_TEST;

export function lutTexture(map: Colormap): DataTexture {
  // a categorical map gets one texel per colour, so the shader can index a
  // class directly however many there are; a continuous one is sampled
  // across 256 as before
  const size = map.kind === "categorical" ? Math.max(1, map.colors.length) : CONTINUOUS_LUT_SIZE;
  const tex = new DataTexture(buildLut(map, size), size, 1, RGBAFormat, UnsignedByteType);
  tex.needsUpdate = true;
  return tex;
}

/** One texel per class, red 255 where the class is shown. */
function maskTexture(size: number): DataTexture {
  const tex = new DataTexture(new Uint8Array(size * 4), size, 1, RGBAFormat, UnsignedByteType);
  tex.needsUpdate = true;
  return tex;
}

/** A uniform's slot: three.js reads and writes `.value`. */
type Slot<T> = { value: T };

/**
 * Every uniform the value shader reads, typed: a misspelt name fails tsc
 * where a string key silently did nothing. A layer's own material adds its
 * uniforms to a copy of these.
 */
export type ValueUniforms = {
  uLut: Slot<Texture>;
  uMin: Slot<number>;
  uMax: Slot<number>;
  uFiltered: Slot<number>;
  uFilterMin: Slot<number>;
  uFilterMax: Slot<number>;
  uCategorical: Slot<number>;
  uBlanks: Slot<number>;
  uMip: Slot<number>;
  uLutSize: Slot<number>;
  uClassMask: Slot<Texture>;
  uMaskSize: Slot<number>;
  /** rgb, 0–1. */
  uMissing: Slot<Vec3>;
  uLog: Slot<number>;
  uSteps: Slot<number>;
  uBreakCount: Slot<number>;
  uBreaks: Slot<number[]>;
};

/** An untyped uniform table, for a caller that builds its own. Prefer `ValueUniforms`. */
export type Uniforms = Record<string, { value: unknown }>;
/** Sets a uniform by name, ignoring a name the table lacks. Prefer writing a `ValueUniforms` slot. */
export const setUniform = (u: Uniforms, k: string, v: unknown) => {
  const slot = u[k];
  if (slot) slot.value = v;
};

const CHOSEN_KEPT = 8;

/**
 * The default LUTs, and chosen ones built once per set of colours.
 *
 * Chosen colours are found by the array the caller passes, so a Viewport that
 * hands the same array every frame costs a lookup; a different array is
 * looked up by its contents once. Colours are not read again while the same
 * array is passed: change them by passing a new array, not by editing one.
 * The last eight in use are kept, least recently used dropped first.
 */
export class Luts {
  readonly continuous = lutTexture(EMBER);
  readonly categorical = lutTexture(OKABE_ITO);
  /** Bound where nothing is masked, so the sampler always has a texture. */
  readonly noMask = maskTexture(1);
  private mask: DataTexture | null = null;
  // Map order is use order: the first entry is the least recently used
  private readonly chosen = new Map<string, DataTexture>();
  // the key an array of colours made, by the kind it was asked for as
  private readonly keyOf: Record<Colormap["kind"], WeakMap<object, string>> = {
    sequential: new WeakMap(),
    diverging: new WeakMap(),
    cyclic: new WeakMap(),
    categorical: new WeakMap(),
  };

  private made(kind: Colormap["kind"], colors: [number, number, number][]): DataTexture {
    const keys = this.keyOf[kind];
    let key = keys.get(colors);
    if (key === undefined || !this.chosen.has(key)) {
      key = `${kind}|${colors.join(";")}`;
      keys.set(colors, key);
    }
    let tex = this.chosen.get(key);
    if (tex) {
      this.chosen.delete(key);
      this.chosen.set(key, tex);
      return tex;
    }
    tex = lutTexture({ name: "chosen", kind, colors });
    this.chosen.set(key, tex);
    if (this.chosen.size > CHOSEN_KEPT) {
      const [oldest, old] = this.chosen.entries().next().value as [string, DataTexture];
      old.dispose();
      this.chosen.delete(oldest);
    }
    return tex;
  }

  categoricalFor(colors?: [number, number, number][]): DataTexture {
    return colors ? this.made("categorical", colors) : this.categorical;
  }

  /**
   * The classes shown, as a texture of `size` texels. Rebuilt when the class
   * count changes and rewritten when the mask does, so ticking a class costs
   * an upload of a few hundred bytes and nothing else.
   */
  maskFor(mask: readonly boolean[], size: number): DataTexture {
    let fresh = false;
    if (!this.mask || this.mask.image.width !== size) {
      this.mask?.dispose();
      this.mask = maskTexture(size);
      fresh = true;
    }
    const data = this.mask.image.data as Uint8Array;
    let changed = fresh;
    for (let i = 0; i < size; i++) {
      const want = (mask[i] ?? true) ? 255 : 0;
      if (data[i * 4] !== want) {
        data[i * 4] = want;
        changed = true;
      }
    }
    if (changed) this.mask.needsUpdate = true;
    return this.mask;
  }

  continuousFor(colors?: [number, number, number][]): DataTexture {
    return colors ? this.made("sequential", colors) : this.continuous;
  }

  dispose() {
    this.continuous.dispose();
    this.categorical.dispose();
    this.noMask.dispose();
    this.mask?.dispose();
    for (const t of this.chosen.values()) t.dispose();
    this.chosen.clear();
  }
}

/** Fresh value uniforms bound to a LUT set. */
export function valueUniforms(luts: Luts): ValueUniforms {
  return {
    uLut: { value: luts.continuous },
    uMin: { value: 0 },
    uMax: { value: 1 },
    uFiltered: { value: 0 },
    uFilterMin: { value: -Infinity },
    uFilterMax: { value: Infinity },
    uCategorical: { value: 0 },
    uBlanks: { value: 1 },
    uMip: { value: 0 },
    uLutSize: { value: CONTINUOUS_LUT_SIZE },
    uClassMask: { value: luts.noMask },
    uMaskSize: { value: 0 },
    uMissing: { value: [MISSING_RGB[0] / 255, MISSING_RGB[1] / 255, MISSING_RGB[2] / 255] },
    uLog: { value: 0 },
    uSteps: { value: 0 },
    uBreakCount: { value: 0 },
    uBreaks: { value: new Array<number>(MAX_BREAKS).fill(0) },
  };
}

/** Set the value uniforms for a column of the given kind. */
export function applyValue(
  u: ValueUniforms,
  kind: "continuous" | "categorical",
  view: ValueView,
  luts: Luts,
) {
  u.uMip.value = view.mip && kind === "continuous" ? 1 : 0;
  u.uBlanks.value = view.blanks === false ? 0 : 1;
  const [mr, mg, mb] = view.missing ?? MISSING_RGB;
  u.uMissing.value = [mr / 255, mg / 255, mb / 255];
  if (kind === "categorical") {
    u.uCategorical.value = 1;
    const lut = luts.categoricalFor(view.classColours);
    u.uLut.value = lut;
    u.uLutSize.value = lut.image.width;
    // one texel per class, however many there are: the mask and the colours
    // are both per class, so either says how many
    const size = Math.max(view.classMask.length, view.classColours?.length ?? 0, 1);
    u.uClassMask.value = luts.maskFor(view.classMask, size);
    u.uMaskSize.value = size;
  } else {
    u.uCategorical.value = 0;
    const lut = luts.continuousFor(view.colours);
    u.uLut.value = lut;
    u.uLutSize.value = lut.image.width;
    u.uMaskSize.value = 0;
    const [lo, hi] = view.colourRange;
    u.uMin.value = lo;
    u.uMax.value = hi;
    u.uLog.value = view.log && lo > 0 && hi > lo ? 1 : 0;
    u.uSteps.value = view.steps ?? 0;
    const breaks = (view.breaks ?? []).slice(0, MAX_BREAKS);
    u.uBreakCount.value = breaks.length;
    const slots = u.uBreaks.value;
    for (let i = 0; i < MAX_BREAKS; i++) slots[i] = breaks[i] ?? 0;
    u.uFilterMin.value = view.filterRange[0];
    u.uFilterMax.value = view.filterRange[1];
  }
}

// ---- The shader's rules, in TypeScript ------------------------------------
// A GPU cannot run in a unit test, so the rules of `valueHidden` and
// `valueColour` above are written here a second time, line for line, over the
// same uniforms. Tests pin the rules through these; change one, change both.

const texel = (t: Texture, i: number): [number, number, number] => {
  const d = (t.image as { data: Uint8Array }).data;
  return [d[i * 4] ?? 0, d[i * 4 + 1] ?? 0, d[i * 4 + 2] ?? 0];
};

/** Whether the shader treats a value, as the GPU gets it or as NaN, as missing. */
export const isMissing = (v: number): boolean => Number.isNaN(v) || v < MISSING_BELOW;

/** `valueHidden` of the shader: whether this value is discarded. */
export function valueHidden(u: ValueUniforms, v: number): boolean {
  if (isMissing(v)) return u.uBlanks.value === 0;
  if (u.uCategorical.value === 1) {
    if (v > NO_CLASS_ABOVE) return u.uBlanks.value === 0;
    const c = Math.trunc(v + 0.5);
    if (c < 0) return true;
    // no mask reaches it: shown
    if (c >= u.uMaskSize.value) return false;
    return texel(u.uClassMask.value, c)[0] < 128;
  }
  const min = u.uFilterMin.value;
  const max = u.uFilterMax.value;
  const lo = Number.isFinite(min) ? Math.abs(min) : 0;
  const hi = Number.isFinite(max) ? Math.abs(max) : 0;
  const eps = 1e-6 * Math.max(lo, hi);
  return v < min - eps || v > max + eps;
}

/**
 * `valueColour` of the shader for a value that is not hidden: its colour as
 * [r, g, b] 0–255, and its position on the scale (0 for a class or a
 * missing value). A table is read as the nearest texel, as it is on the GPU.
 */
export function valueColour(
  u: ValueUniforms,
  v: number,
): { rgb: [number, number, number]; t: number } {
  const missing = u.uMissing.value;
  const miss: [number, number, number] = [missing[0] * 255, missing[1] * 255, missing[2] * 255];
  if (isMissing(v)) return { rgb: miss, t: 0 };
  const size = u.uLutSize.value;
  if (u.uCategorical.value === 1) {
    if (v > NO_CLASS_ABOVE) return { rgb: miss, t: 0 };
    const k = Math.trunc(v + 0.5);
    const c = ((k % size) + size) % size;
    return { rgb: texel(u.uLut.value, c), t: 0 };
  }
  let t: number;
  const count = u.uBreakCount.value;
  if (count > 0) {
    let k = 0;
    for (let i = 0; i < MAX_BREAKS; i++) if (i < count && v >= (u.uBreaks.value[i] ?? 0)) k++;
    t = (k + 0.5) / (count + 1);
  } else {
    let lo = u.uMin.value;
    let hi = u.uMax.value;
    let x = v;
    if (u.uLog.value === 1) {
      lo = Math.log(lo);
      hi = Math.log(hi);
      x = v > 0 ? Math.log(v) : lo - 1;
    }
    t = Math.min(1, Math.max(0, (x - lo) / Math.max(hi - lo, 1e-9)));
    const steps = u.uSteps.value;
    if (steps > 1) t = (Math.min(Math.floor(t * steps), steps - 1) + 0.5) / steps;
  }
  const coord = (t * (size - 1) + 0.5) / size;
  const index = Math.min(size - 1, Math.max(0, Math.floor(coord * size)));
  return { rgb: texel(u.uLut.value, index), t };
}
