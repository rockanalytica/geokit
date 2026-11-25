import { describe, expect, it } from "vitest";
import { directionAngles, planeAttitude, planeNormal, sectionDirection } from "./direction";

type Vec3 = [number, number, number];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

describe("a plane's attitude", () => {
  it("is read back from its normal, either way up", () => {
    for (const dd of [0, 35, 210, 359])
      for (const dip of [10, 45, 89]) {
        const n = planeNormal(dd, dip);
        for (const m of [n, n.map((v) => -v) as Vec3]) {
          const got = planeAttitude(m);
          expect(got.dipDirection).toBeCloseTo(dd, 9);
          expect(got.dip).toBeCloseTo(dip, 9);
        }
      }
  });

  it("is level with dip direction 0 for a vertical normal, and dips 90° for a level one", () => {
    expect(planeAttitude([0, 0, 1])).toEqual({ dipDirection: 0, dip: 0 });
    expect(planeAttitude([0, 0, -1])).toEqual({ dipDirection: 0, dip: 0 });
    expect(planeAttitude([1, 0, 0]).dip).toBeCloseTo(90, 9);
  });

  it("has as its steepest line the Line of its dip direction and dip, as azimuth and plunge", () => {
    for (const dd of [0, 35, 210, 359])
      for (const dip of [10, 45, 89]) {
        const n = planeNormal(dd, dip);
        const down = sectionDirection(dd, dip);
        // in the plane
        expect(dot(down, n)).toBeCloseTo(0, 12);
        expect(directionAngles(down).azimuth).toBeCloseTo(dd, 9);
        expect(directionAngles(down).plunge).toBeCloseTo(dip, 9);
        // and no direction in the plane plunges more
        const strike = sectionDirection(dd - 90, 0);
        for (let k = 0; k < 360; k += 5) {
          const th = (k * Math.PI) / 180;
          const v: Vec3 = [0, 1, 2].map(
            (i) => Math.cos(th) * (strike[i] ?? 0) + Math.sin(th) * (down[i] ?? 0),
          ) as Vec3;
          expect(dot(v, n)).toBeCloseTo(0, 12);
          expect(directionAngles(v).plunge).toBeLessThanOrEqual(dip + 1e-9);
        }
      }
  });
});
