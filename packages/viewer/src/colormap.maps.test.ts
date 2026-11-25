import { describe, expect, it } from "vitest";
import {
  BLUE_ORANGE,
  buildLut,
  type Colormap,
  CYCLE,
  EMBER,
  luminance,
  sampleColormap,
  symmetricRange,
  VIRIDIS,
} from "./colormap";

const px = (lut: Uint8Array, i: number) => [
  lut[i * 4],
  lut[i * 4 + 1],
  lut[i * 4 + 2],
  lut[i * 4 + 3],
];
const map = (kind: Colormap["kind"], colors: [number, number, number][]): Colormap => ({
  name: "t",
  kind,
  colors,
});
const dist = (a: readonly number[], b: readonly number[]) =>
  Math.hypot(...a.map((x, i) => x - (b[i] ?? 0)));

describe("Viridis", () => {
  it("is 64 stops from dark purple to yellow, lightness rising at every one", () => {
    expect(VIRIDIS.kind).toBe("sequential");
    expect(VIRIDIS.colors).toHaveLength(64);
    expect(VIRIDIS.colors[0]).toEqual([68, 1, 84]);
    expect(VIRIDIS.colors.at(-1)).toEqual([253, 231, 37]);
    let prev = -1;
    for (const c of VIRIDIS.colors) {
      const l = luminance(c);
      expect(l).toBeGreaterThan(prev);
      prev = l;
    }
  });
});

describe("Blue–Orange", () => {
  it("is a diverging map: a pale middle, blue below it, orange above, ends as dark as each other", () => {
    expect(BLUE_ORANGE.kind).toBe("diverging");
    const n = BLUE_ORANGE.colors.length;
    expect(n % 2).toBe(1);
    const mid = BLUE_ORANGE.colors[(n - 1) / 2] ?? [0, 0, 0];
    expect(Math.min(...mid)).toBeGreaterThan(200);
    const lo = BLUE_ORANGE.colors[0] ?? [0, 0, 0];
    const hi = BLUE_ORANGE.colors.at(-1) ?? [0, 0, 0];
    expect(lo[2]).toBeGreaterThan(lo[0]);
    expect(hi[0]).toBeGreaterThan(hi[2]);
    expect(Math.abs(luminance(lo) - luminance(hi))).toBeLessThan(0.05);
    // lightest in the middle: falling away on both sides
    const lum = BLUE_ORANGE.colors.map(luminance);
    const k = (n - 1) / 2;
    for (let i = 1; i <= k; i++) {
      expect(lum[k - i] ?? 0).toBeLessThanOrEqual((lum[k - i + 1] ?? 0) + 1e-9);
      expect(lum[k + i] ?? 0).toBeLessThanOrEqual((lum[k + i - 1] ?? 0) + 1e-9);
    }
  });

  it("puts its pale middle at the middle of an odd table, and of any sample at 0.5", () => {
    const lut = buildLut(BLUE_ORANGE, 65);
    expect(px(lut, 32)).toEqual([...(BLUE_ORANGE.colors[16] ?? [])].concat(255));
    const half = sampleColormap(BLUE_ORANGE, 0.5);
    expect(half).toEqual(BLUE_ORANGE.colors[16]);
  });
});

describe("Cycle", () => {
  it("runs once round, so the step from its last colour to its first is as small as any other", () => {
    expect(CYCLE.kind).toBe("cyclic");
    const c = CYCLE.colors;
    const steps = c.map((a, i) => dist(a, c[(i + 1) % c.length] ?? a));
    const seam = steps.at(-1) ?? 0;
    expect(seam).toBeLessThan(Math.max(...steps) * 1.2);
    expect(seam).toBeGreaterThan(0);
  });

  it("wraps: t and t + 1 are one colour, and a table leaves the first colour out of its end", () => {
    for (const t of [0, 0.13, 0.5, 0.99]) {
      const a = sampleColormap(CYCLE, t);
      const b = sampleColormap(CYCLE, t + 1);
      const c = sampleColormap(CYCLE, t - 1);
      for (let k = 0; k < 3; k++) {
        expect(b[k] ?? 0).toBeCloseTo(a[k] ?? 0, 6);
        expect(c[k] ?? 0).toBeCloseTo(a[k] ?? 0, 6);
      }
    }
    const lut = buildLut(CYCLE, 96);
    expect(px(lut, 0)).toEqual([...(CYCLE.colors[0] ?? [])].concat(255));
    // two table entries per stop: entry 2 is the second stop, entry 1 halfway
    expect(px(lut, 2)).toEqual([...(CYCLE.colors[1] ?? [])].concat(255));
    // the last entry is not the first colour again, but one step short of it
    expect(px(lut, 95)).not.toEqual(px(lut, 0));
    const last = px(lut, 95).slice(0, 3) as number[];
    const first = px(lut, 0).slice(0, 3) as number[];
    expect(dist(last, first)).toBeLessThan(dist(first, px(lut, 8).slice(0, 3) as number[]));
  });
});

describe("buildLut edge cases", () => {
  const red: [number, number, number] = [255, 0, 0];
  const blue: [number, number, number] = [0, 0, 255];

  it("fills a table from a single colour", () => {
    for (const kind of ["sequential", "diverging", "cyclic"] as const) {
      const lut = buildLut(map(kind, [red]), 4);
      for (let i = 0; i < 4; i++) expect(px(lut, i), kind).toEqual([255, 0, 0, 255]);
    }
  });

  it("runs between two colours, ends exact", () => {
    const lut = buildLut(map("sequential", [red, blue]), 5);
    expect(px(lut, 0)).toEqual([255, 0, 0, 255]);
    expect(px(lut, 4)).toEqual([0, 0, 255, 255]);
    expect(px(lut, 2)).toEqual([128, 0, 128, 255]);
    // a cyclic pair goes there and back: the last entry is on its way home
    const cyc = buildLut(map("cyclic", [red, blue]), 4);
    expect([px(cyc, 0), px(cyc, 2)]).toEqual([
      [255, 0, 0, 255],
      [0, 0, 255, 255],
    ]);
    expect(px(cyc, 3)).toEqual([128, 0, 128, 255]);
  });

  it("makes a table of one entry: the first colour, or a diverging map's middle", () => {
    expect(px(buildLut(map("sequential", [red, blue]), 1), 0)).toEqual([255, 0, 0, 255]);
    expect(px(buildLut(map("cyclic", [red, blue]), 1), 0)).toEqual([255, 0, 0, 255]);
    expect(px(buildLut(map("diverging", [red, [255, 255, 255], blue]), 1), 0)).toEqual([
      255, 255, 255, 255,
    ]);
    expect(px(buildLut(EMBER, 1), 0).every(Number.isFinite)).toBe(true);
  });

  it("makes no table for size 0, and black for no colours", () => {
    expect(buildLut(EMBER, 0)).toHaveLength(0);
    expect(px(buildLut(map("sequential", []), 2), 1)).toEqual([0, 0, 0, 255]);
    expect(px(buildLut(map("categorical", []), 2), 1)).toEqual([0, 0, 0, 255]);
  });

  it("clamps a sample outside 0–1 on a map that does not wrap", () => {
    expect(sampleColormap(EMBER, -3)).toEqual(EMBER.colors[0]);
    expect(sampleColormap(EMBER, 9)).toEqual(EMBER.colors.at(-1));
  });
});

describe("symmetricRange", () => {
  it("centres a range on a value, wide enough for both ends", () => {
    expect(symmetricRange([-3, 10])).toEqual([-10, 10]);
    expect(symmetricRange([2, 3], 5)).toEqual([2, 8]);
    expect(symmetricRange([0, 0])).toEqual([0, 0]);
  });
});
