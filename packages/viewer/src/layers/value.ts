// What every value-coloured layer shares: a colormap LUT as a
// texture, thresholds and a class mask as uniforms, and the GLSL that turns
// one value into a colour or a discard. Prisms, blocks and points differ in
// geometry and lighting, not in how a value becomes a colour.

import { DataTexture, RGBAFormat, UnsignedByteType } from "three";
import { buildLut, type Colormap, EMBER, OKABE_ITO } from "../colormap";

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
  /** Place values by their logarithm within the colour range (both ends above zero). */
  log?: boolean;
  /** Equal colour classes over the colour range; 0 or absent: continuous. */
  steps?: number;
  /** Colour classes cut at these values, ascending, at most 16; they override the range. */
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
const NO_CLASS_TEST = "v > 60000.0";

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
  uniform float uBreaks[16];
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
      for (int i = 0; i < 16; i++) {
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
    return vec4(texture2D(uLut, vec2(t * (255.0 / 256.0) + 0.5 / 256.0, 0.5)).rgb, t);
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
  const size = map.kind === "categorical" ? Math.max(1, map.colors.length) : 256;
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

export type Uniforms = Record<string, { value: unknown }>;
export const setUniform = (u: Uniforms, k: string, v: unknown) => {
  const slot = u[k];
  if (slot) slot.value = v;
};

/** The default LUTs, and chosen ones built once per set of colours. */
export class Luts {
  readonly continuous = lutTexture(EMBER);
  readonly categorical = lutTexture(OKABE_ITO);
  /** Bound where nothing is masked, so the sampler always has a texture. */
  readonly noMask = maskTexture(1);
  private mask: DataTexture | null = null;
  private maskKey = "";
  // several Viewports may colour one layer with different maps; a few are kept
  private readonly chosen = new Map<string, DataTexture>();

  private made(kind: Colormap["kind"], colors: [number, number, number][]): DataTexture {
    const key = `${kind}|${colors.join(";")}`;
    let tex = this.chosen.get(key);
    if (!tex) {
      tex = lutTexture({ name: "chosen", kind, colors });
      this.chosen.set(key, tex);
      if (this.chosen.size > 8) {
        const [oldest, old] = this.chosen.entries().next().value as [string, DataTexture];
        old.dispose();
        this.chosen.delete(oldest);
      }
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
    if (!this.mask || this.mask.image.width !== size) {
      this.mask?.dispose();
      this.mask = maskTexture(size);
      this.maskKey = "";
    }
    let key = `${size}`;
    for (let i = 0; i < size; i++) key += (mask[i] ?? true) ? "1" : "0";
    if (key !== this.maskKey) {
      const data = this.mask.image.data as Uint8Array;
      for (let i = 0; i < size; i++) data[i * 4] = (mask[i] ?? true) ? 255 : 0;
      this.mask.needsUpdate = true;
      this.maskKey = key;
    }
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
export function valueUniforms(luts: Luts): Uniforms {
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
    uLutSize: { value: 256 },
    uClassMask: { value: luts.noMask },
    uMaskSize: { value: 0 },
    uMissing: { value: MISSING_RGB.map((c) => c / 255) },
    uLog: { value: 0 },
    uSteps: { value: 0 },
    uBreakCount: { value: 0 },
    uBreaks: { value: new Array(16).fill(0) },
  };
}

/** Set the value uniforms for a column of the given kind. */
export function applyValue(
  u: Uniforms,
  kind: "continuous" | "categorical",
  view: ValueView,
  luts: Luts,
) {
  setUniform(u, "uMip", view.mip && kind === "continuous" ? 1 : 0);
  setUniform(u, "uBlanks", view.blanks === false ? 0 : 1);
  const [mr, mg, mb] = view.missing ?? MISSING_RGB;
  setUniform(u, "uMissing", [mr / 255, mg / 255, mb / 255]);
  if (kind === "categorical") {
    setUniform(u, "uCategorical", 1);
    const lut = luts.categoricalFor(view.classColours);
    setUniform(u, "uLut", lut);
    setUniform(u, "uLutSize", lut.image.width);
    // one texel per class, however many there are: the mask and the colours
    // are both per class, so either says how many
    const size = Math.max(view.classMask.length, view.classColours?.length ?? 0, 1);
    setUniform(u, "uClassMask", luts.maskFor(view.classMask, size));
    setUniform(u, "uMaskSize", size);
  } else {
    setUniform(u, "uCategorical", 0);
    setUniform(u, "uLut", luts.continuousFor(view.colours));
    setUniform(u, "uLutSize", 256);
    setUniform(u, "uMaskSize", 0);
    setUniform(u, "uMin", view.colourRange[0]);
    setUniform(u, "uMax", view.colourRange[1]);
    const [lo, hi] = view.colourRange;
    setUniform(u, "uLog", view.log && lo > 0 && hi > lo ? 1 : 0);
    setUniform(u, "uSteps", view.steps ?? 0);
    const breaks = (view.breaks ?? []).slice(0, 16);
    setUniform(u, "uBreakCount", breaks.length);
    const slots = u.uBreaks?.value as number[] | undefined;
    if (slots) for (let i = 0; i < 16; i++) slots[i] = breaks[i] ?? 0;
    setUniform(u, "uFilterMin", view.filterRange[0]);
    setUniform(u, "uFilterMax", view.filterRange[1]);
  }
}
