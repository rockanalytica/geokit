import { describe, expect, it } from "vitest";
import { buildLut, EMBER, luminance, OKABE_ITO } from "./colormap";

describe("Ember", () => {
  it("is monotonic in luminance and never blue or purple", () => {
    const map = EMBER;
    expect(map.colors).toHaveLength(64);
    let prev = -1;
    for (const c of map.colors) {
      const lum = luminance(c);
      expect(lum).toBeGreaterThan(prev);
      prev = lum;
      // blue never dominates: the map lives between red and yellow
      expect(c[2]).toBeLessThanOrEqual(Math.max(c[0], c[1]) + 1);
    }
  });
});

describe("buildLut", () => {
  it("interpolates continuous maps and cycles categorical ones", () => {
    const lut = buildLut(EMBER, 64);
    expect(lut.length).toBe(256);
    expect(lut[3]).toBe(255);
    const cat = buildLut(OKABE_ITO, 16);
    // Okabe–Ito's eight, from orange to black, then round again
    expect(OKABE_ITO.colors).toHaveLength(8);
    expect([cat[0], cat[1], cat[2]]).toEqual([230, 159, 0]);
    expect([cat[7 * 4], cat[7 * 4 + 1], cat[7 * 4 + 2]]).toEqual([0, 0, 0]);
    expect([cat[8 * 4], cat[8 * 4 + 1], cat[8 * 4 + 2]]).toEqual([230, 159, 0]);
  });
});
