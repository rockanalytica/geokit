// How a Point Cloud is drawn beyond its colouring: the blend towards class
// colours, dimmed classes, marked points and classes changed in place.

import { PerspectiveCamera, type Points, type ShaderMaterial } from "three";
import { describe, expect, it } from "vitest";
import { blendColour, type CloudSource, type CloudView, markFlags, PointCloudLayer } from "./cloud";

/** One node of four points, classes 0–3. */
const source: CloudSource = {
  cube: [0, 0, 0, 10, 10, 10],
  spacing: 1,
  nodes: [{ key: "0-0-0-0", depth: 0, x: 0, y: 0, z: 0, pointCount: 4 }],
  zOrigin: 0,
  load: async () => ({
    count: 4,
    positions: new Float32Array(12),
    intensity: new Float32Array(4),
    classification: Float32Array.of(0, 1, 2, 3),
    colour: null,
  }),
};

const view: CloudView = {
  colourBy: "classification",
  colourRange: [0, 1],
  filterRange: [-Infinity, Infinity],
  classMask: [],
  size: 2,
  budget: 100,
};

function camera() {
  const c = new PerspectiveCamera(45, 1, 0.1, 1000);
  c.position.set(5, 5, 50);
  c.lookAt(5, 5, 5);
  return c;
}

const settle = () => new Promise((r) => setTimeout(r, 0));

async function loaded(v: CloudView = view) {
  const l = new PointCloudLayer(source);
  l.apply(v, camera(), 500);
  await settle();
  l.apply(v, camera(), 500);
  return l;
}

const uniforms = (l: PointCloudLayer) =>
  ((l.object.children[0] as Points).material as ShaderMaterial).uniforms as Record<
    string,
    { value: unknown }
  >;

describe("the look of a Point Cloud", () => {
  it("blends towards the class colour as far as the view says, 1 when it says nothing", async () => {
    const l = await loaded();
    expect(uniforms(l).uBlend?.value).toBe(1);
    l.apply({ ...view, blend: 0.25, ownColourClass: 0 }, camera(), 500);
    expect(uniforms(l).uBlend?.value).toBe(0.25);
    expect(uniforms(l).uOwnClass?.value).toBe(0);
    l.apply({ ...view, blend: 7 }, camera(), 500);
    expect(uniforms(l).uBlend?.value).toBe(1);
    expect(blendColour([1, 0, 0], [0, 0, 1], 0.25)).toEqual([0.75, 0, 0.25]);
    l.dispose();
  });

  it("dims the classes the view names, and none when it names none", async () => {
    const l = await loaded({ ...view, dim: [false, true, true] });
    expect(uniforms(l).uDimSize?.value).toBe(3);
    l.apply({ ...view, dim: [false, false] }, camera(), 500);
    expect(uniforms(l).uDimSize?.value).toBe(0);
    l.dispose();
  });

  it("marks points of a node, before it lands and after", async () => {
    const l = new PointCloudLayer(source);
    l.mark("0-0-0-0", [1, 3, 9]);
    l.apply(view, camera(), 500);
    await settle();
    expect([...(l.markedIn("0-0-0-0") ?? [])]).toEqual([0, 1, 0, 1]);
    l.mark("0-0-0-0", [0]);
    expect([...(l.markedIn("0-0-0-0") ?? [])]).toEqual([1, 0, 0, 0]);
    l.clearMarks();
    expect([...(l.markedIn("0-0-0-0") ?? [])]).toEqual([0, 0, 0, 0]);
    expect(markFlags(2, [-1, 1, 2])).toEqual(Uint8Array.of(0, 1));
    l.dispose();
  });

  it("changes a loaded node's classes in place, refusing the wrong length", async () => {
    const l = await loaded();
    expect(l.setClassification("0-0-0-0", Float32Array.of(3, 3, 3, 3))).toBe(true);
    const g = (l.object.children[0] as Points).geometry;
    expect([...g.getAttribute("classification").array]).toEqual([3, 3, 3, 3]);
    expect(l.setClassification("0-0-0-0", Float32Array.of(1))).toBe(false);
    expect(l.setClassification("1-0-0-0", Float32Array.of(1, 1, 1, 1))).toBe(false);
    l.dispose();
  });
});
