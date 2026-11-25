import { describe, expect, it } from "vitest";
import { MeasureLine, measure, nearestVertex } from "./measure";
import type { Vec3 } from "./types";

describe("measure", () => {
  it("gives each leg's length, azimuth and plunge, and the total", () => {
    const m = measure([
      [0, 0, 0],
      [0, 10, 0], // north
      [10, 10, 0], // east
      [10, 10, -10], // straight down
      [10, 20, 0], // north and up, 45 degrees
    ]);
    expect(m.legs.map((l) => l.length)).toEqual([10, 10, 10, Math.hypot(10, 10)]);
    const want = [
      [0, 0],
      [90, 0],
      [0, 90],
      [0, -45],
    ];
    for (const [k, leg] of m.legs.entries()) {
      expect(leg.azimuth).toBeCloseTo(want[k]?.[0] ?? Number.NaN, 9);
      expect(leg.plunge).toBeCloseTo(want[k]?.[1] ?? Number.NaN, 9);
    }
    expect(m.total).toBeCloseTo(30 + Math.SQRT2 * 10, 9);
    expect(m.legs.map((l) => l.along)).toEqual([10, 20, 30, m.total]);
  });

  it("reads azimuth clockwise from north through the circle, as a Section's direction does", () => {
    const az = (to: Vec3) => measure([[0, 0, 0], to]).legs[0]?.azimuth ?? Number.NaN;
    expect(az([1, 0, 0])).toBeCloseTo(90);
    expect(az([0, -1, 0])).toBeCloseTo(180);
    expect(az([-1, 0, 0])).toBeCloseTo(270);
    expect(az([-1, 1, 0])).toBeCloseTo(315);
    // down is positive: a leg that falls plunges
    expect(
      measure([
        [0, 0, 0],
        [0, 1, -1],
      ]).legs[0]?.plunge,
    ).toBeCloseTo(45);
  });

  it("is empty for fewer than two points, and gives a leg of no length no direction", () => {
    expect(measure([])).toEqual({ legs: [], total: 0 });
    expect(measure([[1, 2, 3]])).toEqual({ legs: [], total: 0 });
    const m = measure([
      [1, 2, 3],
      [1, 2, 3],
    ]);
    expect(m.legs[0]).toMatchObject({ length: 0, azimuth: 0, plunge: 0 });
    expect(m.total).toBe(0);
  });
});

describe("nearestVertex", () => {
  const v = Float32Array.of(0, 0, 0, 5, 0, 0, 5, 5, 5);

  it("finds the closest, with its place and distance", () => {
    const n = nearestVertex(v, [4, 1, 0]);
    expect(n?.index).toBe(1);
    expect(n?.position).toEqual([5, 0, 0]);
    expect(n?.distance).toBeCloseTo(Math.SQRT2);
  });

  it("finds none beyond the distance it is given, or in no vertices", () => {
    expect(nearestVertex(v, [100, 0, 0], 3)).toBeNull();
    expect(nearestVertex(v, [0.5, 0, 0], 1)?.index).toBe(0);
    expect(nearestVertex(new Float32Array(0), [0, 0, 0])).toBeNull();
  });
});

describe("MeasureLine", () => {
  it("draws a line and a dot at each point, and nothing for none", () => {
    const line = new MeasureLine();
    expect(line.object.children).toHaveLength(2);
    line.set([
      [0, 0, 0],
      [1, 1, 1],
      [2, 0, 0],
    ]);
    expect(line.object.visible).toBe(true);
    const [l, d] = line.object.children as unknown as {
      geometry: { getAttribute(n: string): { count: number } };
    }[];
    expect(l?.geometry.getAttribute("position").count).toBe(3);
    expect(d?.geometry.getAttribute("position").count).toBe(3);
    line.set([]);
    expect(line.object.visible).toBe(false);
    line.dispose();
  });
});
