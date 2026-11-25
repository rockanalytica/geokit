import { describe, expect, it } from "vitest";
import { directionAngles, sectionDirection } from "./direction";
import {
  atPosition,
  niceStep,
  originAlong,
  planeCrossing,
  positionRange,
  readingSign,
  type SectionGeometry,
  sectionPlanes,
  sectionPosition,
  sectionRight,
  sectionUp,
  type Vec3,
} from "./section";

const close = (a: readonly number[], b: readonly number[]) => {
  for (const [k, x] of a.entries()) expect(x).toBeCloseTo(b[k] ?? Number.NaN, 9);
};

/** Whether a point passes every plane, as the renderer's clipping keeps it. */
const kept = (planes: ReturnType<typeof sectionPlanes>, p: Vec3) =>
  planes.every(
    ({ normal: n, distance }) => n[0] * p[0] + n[1] * p[1] + n[2] * p[2] + distance >= 0,
  );

const north: SectionGeometry = { centre: [0, 100, 0], azimuth: 0, plunge: 0, step: 20 };

describe("a Section's direction", () => {
  it("is the way it is looked: azimuth from north, plunge below the horizontal", () => {
    close(sectionDirection(0, 0), [0, 1, 0]);
    close(sectionDirection(90, 0), [1, 0, 0]);
    close(sectionDirection(0, 90), [0, 0, -1]);
    close(sectionDirection(45, 0), [Math.SQRT1_2, Math.SQRT1_2, 0]);
  });

  it("reads back as the angles it was made from", () => {
    for (const [az, pl] of [
      [35, 0],
      [210, 30],
      [359, -20],
    ] as const) {
      const got = directionAngles(sectionDirection(az, pl));
      expect(got.azimuth).toBeCloseTo(az, 9);
      expect(got.plunge).toBeCloseTo(pl, 9);
    }
    expect(directionAngles([0, 0, -1])).toEqual({ azimuth: 0, plunge: 90 });
  });

  it("puts the vertical up on screen, and north for a level", () => {
    close(sectionUp(sectionDirection(35, 0)), [0, 0, 1]);
    close(sectionUp(sectionDirection(0, 90)), [0, 1, 0]);
    // a dipping Section keeps the vertical as it lies in the plane
    const d = sectionDirection(0, 30);
    const up = sectionUp(d);
    expect(up[0] * d[0] + up[1] * d[1] + up[2] * d[2]).toBeCloseTo(0, 9);
    expect(up[2]).toBeGreaterThan(0);
    // looking north, east is to the right
    close(sectionRight(sectionDirection(0, 0), [0, 0, 1]), [1, 0, 0]);
  });
});

describe("what a Section keeps", () => {
  it("Behind is the far side, Front the viewer's", () => {
    expect(kept(sectionPlanes(north, "behind"), [0, 150, 0])).toBe(true);
    expect(kept(sectionPlanes(north, "behind"), [0, 50, 0])).toBe(false);
    expect(kept(sectionPlanes(north, "front"), [0, 50, 0])).toBe(true);
    expect(kept(sectionPlanes(north, "front"), [0, 150, 0])).toBe(false);
  });

  it("swaps them when the same plane faces the other way", () => {
    const south = { ...north, azimuth: 180 };
    expect(kept(sectionPlanes(south, "behind"), [0, 50, 0])).toBe(true);
    expect(kept(sectionPlanes(south, "front"), [0, 150, 0])).toBe(true);
  });

  it("a Band is half a step either side of the plane", () => {
    const band = sectionPlanes(north, "band");
    expect(kept(band, [500, 109, -40])).toBe(true);
    expect(kept(band, [0, 91, 0])).toBe(true);
    expect(kept(band, [0, 111, 0])).toBe(false);
    expect(kept(band, [0, 89, 0])).toBe(false);
  });
});

describe("moving a Section", () => {
  it("slides its centre along its direction", () => {
    const g = { ...north, azimuth: 90, centre: [10, 20, 30] as Vec3 };
    expect(sectionPosition(g)).toBeCloseTo(10, 9);
    close(atPosition(g, 45).centre, [45, 20, 30]);
  });

  it("reads its position in the world's coordinates with the origin added along its direction", () => {
    const g = { ...north, azimuth: 90, centre: [10, 20, 30] as Vec3 };
    const origin: Vec3 = [500000, 7000000, 300];
    // looking east: the world's easting
    expect(sectionPosition(g) + originAlong(g.azimuth, g.plunge, origin)).toBeCloseTo(500010, 6);
    // set at a world position, the centre stays scene-local
    const shift = originAlong(g.azimuth, g.plunge, origin);
    close(atPosition(g, 500045 - shift).centre, [45, 20, 30]);
  });

  it("reads up the axis it lies closest to: eastings, northings, elevations", () => {
    expect(readingSign(90, 0)).toBe(1);
    expect(readingSign(270, 0)).toBe(-1);
    expect(readingSign(0, 0)).toBe(1);
    // looking down, a position is an elevation
    expect(readingSign(0, 90)).toBe(-1);
    expect(readingSign(0, -90)).toBe(1);
  });

  it("spans the box it is dragged across", () => {
    const [lo, hi] = positionRange({ min: [0, 0, 0], max: [100, 200, 50] }, 0, 0);
    expect([lo, hi]).toEqual([0, 200]);
  });

  it("starts with a round twentieth of the extent as its step", () => {
    expect(niceStep(1000)).toBe(50);
    expect(niceStep(430)).toBe(20);
    expect(niceStep(8)).toBeCloseTo(0.5, 12);
    expect(niceStep(0)).toBe(10);
  });
});

describe("where a mesh crosses the plane", () => {
  it("is a line across every triangle it cuts", () => {
    // the unit square in z = 0, two triangles, cut by x = 0.5
    const vertices = Float32Array.from([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]);
    const faces = Uint32Array.from([0, 1, 2, 0, 2, 3]);
    const seg = planeCrossing(vertices, faces, { normal: [1, 0, 0], distance: -0.5 });
    expect(seg.length).toBe(12);
    let length = 0;
    for (let k = 0; k < seg.length; k += 6) {
      expect(seg[k]).toBeCloseTo(0.5, 6);
      expect(seg[k + 3]).toBeCloseTo(0.5, 6);
      length += Math.hypot(
        (seg[k + 3] ?? 0) - (seg[k] ?? 0),
        (seg[k + 4] ?? 0) - (seg[k + 1] ?? 0),
        (seg[k + 5] ?? 0) - (seg[k + 2] ?? 0),
      );
    }
    expect(length).toBeCloseTo(1, 6);
  });

  it("is nothing where the plane misses", () => {
    const vertices = Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const faces = Uint32Array.from([0, 1, 2]);
    expect(planeCrossing(vertices, faces, { normal: [1, 0, 0], distance: -5 }).length).toBe(0);
  });
});
