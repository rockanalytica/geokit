// Frusta without a GPU: the wireframe's corners, the colours and the
// highlight, the ids they take and give back, and the pose to fly to.

import { describe, expect, it } from "vitest";
import { PickIdPool } from "../picking";
import { Problem } from "../problem";
import {
  FRUSTUM_LINE_VERTICES,
  type Frustum,
  FrustumLayer,
  type FrustumView,
  frustumLines,
  poseOf,
} from "./frusta";

const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1];
// 90° vertical field of view: at distance 1 the base is ±1 high
const straight: Frustum = { position: [0, 0, 0], rotation: IDENTITY, fovY: Math.PI / 2, aspect: 2 };
// turned to look along world +x, its down along world −z
const sideways: Frustum = {
  position: [10, 0, 0],
  rotation: [0, 0, 1, 1, 0, 0, 0, 1, 0],
  fovY: Math.PI / 2,
  aspect: 1,
};

const view = (over: Partial<FrustumView> = {}): FrustumView => ({
  size: 1,
  colours: [255, 204, 0],
  highlight: null,
  ...over,
});

const triple = (a: Float32Array, v: number) => [a[v * 3], a[v * 3 + 1], a[v * 3 + 2]];

describe("frustumLines", () => {
  it("runs four edges from the apex and four round the base, `size` ahead", () => {
    const l = frustumLines(straight, 1);
    expect(l).toHaveLength(FRUSTUM_LINE_VERTICES * 3);
    expect(triple(l, 0)).toEqual([0, 0, 0]);
    // top-left: x −w, y −h (y down), z forward
    expect(triple(l, 1)).toEqual([-2, -1, 1]);
    expect(triple(l, 3)).toEqual([2, -1, 1]);
    expect(triple(l, 5)).toEqual([2, 1, 1]);
    expect(triple(l, 7)).toEqual([-2, 1, 1]);
    // the base closes on itself
    expect(triple(l, 15)).toEqual(triple(l, 1));
  });

  it("turns with the camera and scales with the size", () => {
    const l = frustumLines(sideways, 2);
    for (let v = 1; v < FRUSTUM_LINE_VERTICES; v += 2) expect(l[v * 3]).toBeCloseTo(12);
  });
});

describe("poseOf", () => {
  it("looks along the camera's z, up its −y, with the field of view in degrees", () => {
    const p = poseOf(sideways);
    expect(p.position).toEqual([10, 0, 0]);
    expect(p.target).toEqual([11, 0, 0]);
    expect(p.up.map((x) => x + 0)).toEqual([0, 0, -1]);
    expect(p.fov).toBeCloseTo(90);
  });
});

describe("FrustumLayer", () => {
  it("colours each frustum, the highlighted one in its own colour", () => {
    const layer = new FrustumLayer([straight, sideways], view({ highlight: 1 }));
    const c = layer.lineColours;
    expect(triple(c, 0).map((x) => Math.round((x ?? 0) * 255))).toEqual([255, 204, 0]);
    expect(triple(c, FRUSTUM_LINE_VERTICES).map((x) => Math.round((x ?? 0) * 255))).toEqual([
      0, 229, 255,
    ]);
    layer.apply(
      view({
        colours: [
          [1, 2, 3],
          [4, 5, 6],
        ],
        highlight: null,
      }),
    );
    expect(
      triple(layer.lineColours, FRUSTUM_LINE_VERTICES).map((x) => Math.round((x ?? 0) * 255)),
    ).toEqual([4, 5, 6]);
    layer.dispose();
  });

  it("rebuilds its lines when the size changes", () => {
    const layer = new FrustumLayer([straight], view());
    expect(triple(layer.lineVertices, 1)).toEqual([-2, -1, 1]);
    layer.apply(view({ size: 3 }));
    expect(triple(layer.lineVertices, 1)).toEqual([-6, -3, 3]);
    layer.dispose();
  });

  it("takes one id per frustum, resolves them, and gives them back", () => {
    const pool = new PickIdPool();
    pool.take(2);
    const layer = new FrustumLayer([straight, sideways], view(), pool);
    expect(pool.outstanding).toBe(4);
    expect(layer.resolvePick(2)).toBeNull();
    expect(layer.resolvePick(3)).toEqual({ kind: "element", index: 0 });
    expect(layer.resolvePick(4)).toEqual({ kind: "element", index: 1 });
    expect(layer.resolvePick(5)).toBeNull();
    layer.dispose();
    expect(pool.outstanding).toBe(2);
  });

  it("swaps both its parts to the id material and back", () => {
    const layer = new FrustumLayer([straight], view());
    const [lines, dots] = layer.object.children as unknown as { material: unknown }[];
    const before = [lines?.material, dots?.material];
    layer.enterPick();
    expect(lines?.material).toBe(dots?.material);
    expect(lines?.material).not.toBe(before[0]);
    layer.exitPick();
    expect([lines?.material, dots?.material]).toEqual(before);
    layer.dispose();
  });

  it("gives the pose of a frustum it has, and null otherwise", () => {
    const layer = new FrustumLayer([straight, sideways], view());
    expect(layer.viewFrom(1)?.target).toEqual([11, 0, 0]);
    expect(layer.viewFrom(2)).toBeNull();
    layer.dispose();
  });

  it("refuses a frustum that is malformed", () => {
    expect(() => new FrustumLayer([{ ...straight, rotation: [1, 0, 0] }], view())).toThrow(Problem);
    expect(() => new FrustumLayer([{ ...straight, fovY: 0 }], view())).toThrow(Problem);
  });
});
