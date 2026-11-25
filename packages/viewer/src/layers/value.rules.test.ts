// The value shader's colour and hidden rules, pinned through their TypeScript
// mirror (`valueColour`, `valueHidden`) over the uniforms `applyValue` sets,
// so a change to the uniforms or to either side of the mirror shows up here.

import { DataTexture, RGBAFormat, UnsignedByteType } from "three";
import { describe, expect, it } from "vitest";
import { buildLut, EMBER, OKABE_ITO } from "../colormap";
import {
  applyValue,
  gpuValue,
  Luts,
  MAX_BREAKS,
  MISSING_RGB,
  NO_CLASS_ABOVE,
  VALUE_HEAD,
  type ValueView,
  valueColour,
  valueHidden,
  valueUniforms,
} from "./value";

const luts = new Luts();
const lut = buildLut(EMBER, 256);
const ember = (i: number) => [lut[i * 4], lut[i * 4 + 1], lut[i * 4 + 2]];

function uniforms(kind: "continuous" | "categorical", over: Partial<ValueView> = {}) {
  const u = valueUniforms(luts);
  applyValue(
    u,
    kind,
    {
      column: "",
      colourRange: [0, 10],
      filterRange: [Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY],
      classMask: [],
      mip: false,
      ...over,
    },
    luts,
  );
  return u;
}

describe("a missing value", () => {
  it("is shown in the missing colour unless blanks are switched off", () => {
    for (const v of [Number.NaN, gpuValue(Number.NaN)]) {
      const u = uniforms("continuous");
      expect(valueHidden(u, v)).toBe(false);
      const { rgb } = valueColour(u, v);
      for (const [k, c] of MISSING_RGB.entries()) expect(rgb[k]).toBeCloseTo(c, 6);
      expect(valueHidden(uniforms("continuous", { blanks: false }), v)).toBe(true);
    }
  });

  it("takes the colour its view gives it", () => {
    const u = uniforms("continuous", { missing: [255, 0, 0] });
    expect(valueColour(u, Number.NaN).rgb).toEqual([255, 0, 0]);
  });
});

describe("a continuous scale", () => {
  it("runs the table from the range's low end to its high, clamped beyond", () => {
    const u = uniforms("continuous");
    expect(valueColour(u, 0).rgb).toEqual(ember(0));
    expect(valueColour(u, 10).rgb).toEqual(ember(255));
    expect(valueColour(u, 5).rgb).toEqual(ember(128));
    expect(valueColour(u, -50).rgb).toEqual(ember(0));
    expect(valueColour(u, 1e6).rgb).toEqual(ember(255));
    expect(valueColour(u, 2.5).t).toBeCloseTo(0.25);
  });

  it("reaches the first and last texel of a table of any size", () => {
    // the old `t * 255/256 + 0.5/256` was right for 256 texels only
    const u = uniforms("continuous");
    const four = new DataTexture(
      Uint8Array.of(10, 0, 0, 255, 20, 0, 0, 255, 30, 0, 0, 255, 40, 0, 0, 255),
      4,
      1,
      RGBAFormat,
      UnsignedByteType,
    );
    u.uLut.value = four;
    u.uLutSize.value = 4;
    expect(valueColour(u, 0).rgb[0]).toBe(10);
    expect(valueColour(u, 10).rgb[0]).toBe(40);
    expect(valueColour(u, 4).rgb[0]).toBe(20);
    expect(VALUE_HEAD).toContain("uLutSize - 1.0");
    expect(VALUE_HEAD).not.toContain("255.0 / 256.0");
  });

  it("follows a reversed set of colours, which is the same stops the other way round", () => {
    const u = uniforms("continuous", { colours: [...EMBER.colors].reverse() });
    expect(valueColour(u, 0).rgb).toEqual(EMBER.colors.at(-1));
    expect(valueColour(u, 10).rgb).toEqual(EMBER.colors[0]);
  });

  it("places values by their logarithm, and draws one at or below zero as the lowest colour", () => {
    const u = uniforms("continuous", { colourRange: [1, 100], log: true });
    expect(u.uLog.value).toBe(1);
    expect(valueColour(u, 10).t).toBeCloseTo(0.5);
    expect(valueColour(u, 1).t).toBeCloseTo(0);
    expect(valueColour(u, 100).t).toBeCloseTo(1);
    // no logarithm: not missing, not hidden, the lowest colour
    for (const v of [0, -3, -1e9]) {
      expect(valueHidden(u, v)).toBe(false);
      expect(valueColour(u, v).t).toBe(0);
      expect(valueColour(u, v).rgb).toEqual(ember(0));
    }
  });

  it("ignores log where the range reaches zero or is not a range", () => {
    expect(uniforms("continuous", { colourRange: [0, 100], log: true }).uLog.value).toBe(0);
    expect(uniforms("continuous", { colourRange: [5, 5], log: true }).uLog.value).toBe(0);
  });

  it("cuts equal steps over the range, each in the colour of its middle", () => {
    const u = uniforms("continuous", { steps: 4 });
    const ts = [0, 2.4, 2.6, 4.9, 5.1, 7.4, 7.6, 10].map((v) => valueColour(u, v).t);
    expect(ts).toEqual([0.125, 0.125, 0.375, 0.375, 0.625, 0.625, 0.875, 0.875]);
    // steps of 1 are no steps
    expect(valueColour(uniforms("continuous", { steps: 1 }), 2.5).t).toBeCloseTo(0.25);
  });

  it("cuts classes at breaks, a value on a break going up", () => {
    const u = uniforms("continuous", { breaks: [2, 5] });
    const ts = [-1, 1.99, 2, 4.99, 5, 99].map((v) => valueColour(u, v).t);
    const third = (k: number) => (k + 0.5) / 3;
    expect(ts).toEqual([third(0), third(0), third(1), third(1), third(2), third(2)]);
  });

  it("holds as many breaks as the shader's array, and no more", () => {
    const many = Array.from({ length: MAX_BREAKS + 5 }, (_, i) => i);
    const u = uniforms("continuous", { breaks: many });
    expect(u.uBreakCount.value).toBe(MAX_BREAKS);
    expect(u.uBreaks.value).toHaveLength(MAX_BREAKS);
    expect(VALUE_HEAD).toContain(`uBreaks[${MAX_BREAKS}]`);
    // and a shorter list clears what the longer left behind
    applyValue(
      u,
      "continuous",
      {
        column: "",
        colourRange: [0, 1],
        filterRange: [-1, 1],
        classMask: [],
        mip: false,
        breaks: [3],
      },
      luts,
    );
    expect(u.uBreaks.value.slice(0, 3)).toEqual([3, 0, 0]);
    expect(u.uBreakCount.value).toBe(1);
  });
});

describe("the filter", () => {
  it("hides what lies outside, keeping the bound itself and an ulp's wobble past it", () => {
    const u = uniforms("continuous", { filterRange: [2, 8] });
    expect([1, 1.9, 2, 5, 8, 8 + 1e-9, 8.1, 9].map((v) => valueHidden(u, v))).toEqual([
      true,
      true,
      false,
      false,
      false,
      false,
      true,
      true,
    ]);
  });

  it("opens one end alone", () => {
    const u = uniforms("continuous", { filterRange: [Number.NEGATIVE_INFINITY, 8] });
    expect(valueHidden(u, -1e30 + 1)).toBe(false);
    expect(valueHidden(u, 9)).toBe(true);
    expect(valueHidden(u, 7)).toBe(false);
  });
});

describe("classes", () => {
  const view = { classMask: [true, false, true] };

  it("hides a masked class and shows one the mask does not reach", () => {
    const u = uniforms("categorical", view);
    expect([0, 1, 2, 3, 40].map((c) => valueHidden(u, c))).toEqual([
      false,
      true,
      false,
      false,
      false,
    ]);
    // a code below zero is hidden; -1 is still class 0, as the shader truncates -0.5 to 0
    expect(valueHidden(u, -2)).toBe(true);
    expect(valueHidden(u, -1)).toBe(false);
  });

  it("colours a class from its own texel, round again past the end", () => {
    const u = uniforms("categorical", view);
    expect(valueColour(u, 0).rgb).toEqual(OKABE_ITO.colors[0]);
    expect(valueColour(u, 2).rgb).toEqual(OKABE_ITO.colors[2]);
    expect(valueColour(u, 8).rgb).toEqual(OKABE_ITO.colors[0]);
    const mine = uniforms("categorical", {
      ...view,
      classColours: [
        [1, 2, 3],
        [4, 5, 6],
      ],
    });
    expect(valueColour(mine, 2).rgb).toEqual([1, 2, 3]);
    expect(mine.uMaskSize.value).toBe(3);
  });

  it("treats a code above the sentinel as no class: missing colour, hidden with blanks off", () => {
    const u = uniforms("categorical", view);
    expect(valueHidden(u, NO_CLASS_ABOVE)).toBe(false);
    expect(valueHidden(u, NO_CLASS_ABOVE + 1)).toBe(false);
    for (const [k, c] of MISSING_RGB.entries())
      expect(valueColour(u, NO_CLASS_ABOVE + 1).rgb[k]).toBeCloseTo(c, 6);
    const off = uniforms("categorical", { ...view, blanks: false });
    expect(valueHidden(off, NO_CLASS_ABOVE + 1)).toBe(true);
    expect(VALUE_HEAD).toContain(`v > ${NO_CLASS_ABOVE}.0`);
  });
});

describe("applyValue", () => {
  it("writes typed slots of a plain uniforms object", () => {
    const u = uniforms("continuous", { colourRange: [3, 9], mip: true, steps: 5, log: false });
    expect(u.uMin.value).toBe(3);
    expect(u.uMax.value).toBe(9);
    expect(u.uMip.value).toBe(1);
    expect(u.uSteps.value).toBe(5);
    expect(u.uCategorical.value).toBe(0);
    expect(u.uLutSize.value).toBe(256);
    expect(u.uLut.value).toBe(luts.continuous);
    const c = uniforms("categorical", { classMask: [true], mip: true });
    // a maximum-intensity projection is for continuous values
    expect(c.uMip.value).toBe(0);
    expect(c.uCategorical.value).toBe(1);
    expect(c.uLutSize.value).toBe(OKABE_ITO.colors.length);
  });
});

describe("Luts", () => {
  const stops = (n: number): [number, number, number][] => [
    [n, 0, 0],
    [n, 255, 0],
  ];

  it("hands back one texture for one set of colours, by identity or by content", () => {
    const l = new Luts();
    const a = stops(1);
    const t = l.continuousFor(a);
    expect(l.continuousFor(a)).toBe(t);
    expect(l.continuousFor(stops(1))).toBe(t);
    expect(l.continuousFor(stops(2))).not.toBe(t);
    // a categorical set of the same colours is another texture
    expect(l.categoricalFor(a)).not.toBe(t);
    l.dispose();
  });

  it("drops the least recently used of its eight, not the oldest made", () => {
    const l = new Luts();
    const sets = Array.from({ length: 8 }, (_, i) => stops(i));
    const tex = sets.map((s) => l.continuousFor(s));
    // use the first again, so the second is now the one longest unused
    expect(l.continuousFor(sets[0] ?? [])).toBe(tex[0]);
    l.continuousFor(stops(99));
    expect(l.continuousFor(sets[0] ?? [])).toBe(tex[0]);
    expect(l.continuousFor(sets[2] ?? [])).toBe(tex[2]);
    expect(l.continuousFor(sets[1] ?? [])).not.toBe(tex[1]);
    l.dispose();
  });

  it("rewrites a class mask only when it changes", () => {
    const l = new Luts();
    const m = l.maskFor([true, false], 2);
    const v = m.version;
    expect(l.maskFor([true, false], 2)).toBe(m);
    expect(m.version).toBe(v);
    l.maskFor([true, true], 2);
    expect(m.version).toBeGreaterThan(v);
    // missing entries count as shown
    const data = m.image.data as Uint8Array;
    expect([data[0], data[4]]).toEqual([255, 255]);
    l.dispose();
  });
});
