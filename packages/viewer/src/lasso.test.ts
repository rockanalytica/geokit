// The lasso without a GPU: simplifying a path, the even-odd test, and which
// points a loop takes under a real camera.

import { PerspectiveCamera } from "three";
import { describe, expect, it } from "vitest";
import { insideLasso, insidePolygon, LassoPath, simplifyPath, type Vec2 } from "./lasso";

/** A camera at z = 10 looking down −z at the origin, on a 200 × 100 px view. */
function camera() {
  const c = new PerspectiveCamera(90, 2, 0.1, 100);
  c.position.set(0, 0, 10);
  c.lookAt(0, 0, 0);
  c.updateMatrixWorld();
  c.updateProjectionMatrix();
  return c.projectionMatrix.clone().multiply(c.matrixWorldInverse).elements;
}

const square = (x0: number, y0: number, x1: number, y1: number): Vec2[] => [
  [x0, y0],
  [x1, y0],
  [x1, y1],
  [x0, y1],
];

describe("simplifyPath", () => {
  it("keeps a short path and thins a long one evenly", () => {
    const short: Vec2[] = [
      [0, 0],
      [1, 0],
      [1, 1],
    ];
    expect(simplifyPath(short)).toEqual(short);
    const long: Vec2[] = Array.from({ length: 1001 }, (_, i) => [i, 0]);
    const s = simplifyPath(long, 10);
    expect(s).toHaveLength(10);
    expect(s[0]).toEqual([0, 0]);
    expect(s[5]?.[0]).toBeCloseTo(500);
  });
});

describe("insidePolygon", () => {
  it("follows the even-odd rule round a concave shape", () => {
    // a U: the notch at the top middle is outside
    const u: Vec2[] = [
      [0, 0],
      [3, 0],
      [3, 3],
      [2, 3],
      [2, 1],
      [1, 1],
      [1, 3],
      [0, 3],
    ];
    expect(insidePolygon(u, 0.5, 2)).toBe(true);
    expect(insidePolygon(u, 1.5, 2)).toBe(false);
    expect(insidePolygon(u, 1.5, 0.5)).toBe(true);
    expect(insidePolygon(u, 4, 1)).toBe(false);
  });
});

describe("insideLasso", () => {
  const vp = camera();
  // the origin lands at the view's centre (100, 50); x right, y up in the world
  const positions = Float32Array.of(
    0,
    0,
    0, // 0: centre
    5,
    0,
    0, // 1: right of centre
    0,
    0,
    -20, // 2: behind 0 from the camera: hidden, still taken
    0,
    0,
    20, // 3: behind the camera
    -5,
    5,
    0, // 4: top left
  );

  it("takes what projects inside, hidden or not, never what is behind the camera", () => {
    expect([...insideLasso(positions, vp, square(90, 40, 110, 60), 200, 100)]).toEqual([0, 2]);
  });

  it("follows the screen's y down", () => {
    expect([...insideLasso(positions, vp, square(0, 0, 90, 40), 200, 100)]).toEqual([4]);
  });

  it("takes nothing for a loop of fewer than three points", () => {
    expect(
      insideLasso(
        positions,
        vp,
        [
          [0, 0],
          [200, 100],
        ],
        200,
        100,
      ),
    ).toHaveLength(0);
  });
});

describe("LassoPath", () => {
  it("holds the loop it draws, and is hidden with fewer than two points", () => {
    const path = new LassoPath();
    path.set(square(1, 2, 3, 4), 100, 100);
    expect(path.points).toEqual(square(1, 2, 3, 4));
    expect(path.object.visible).toBe(true);
    path.set([], 100, 100);
    expect(path.object.visible).toBe(false);
    path.dispose();
  });
});
