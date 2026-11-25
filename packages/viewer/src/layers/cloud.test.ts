import { PerspectiveCamera, type Points } from "three";
import { describe, expect, it } from "vitest";
import { type CloudSource, type CloudView, PointCloudLayer } from "./cloud";

// A cube of 100 m: a root of 100 points and its eight children of 100 each,
// spacing 10 m at the root. What a Viewport chooses depends on how far the
// camera is and how many points the budget allows.

function source(loaded: string[]): CloudSource {
  const nodes = [{ key: "0-0-0-0", depth: 0, x: 0, y: 0, z: 0, pointCount: 100 }];
  for (let i = 0; i < 8; i++) {
    const [x, y, z] = [i & 1, (i >> 1) & 1, (i >> 2) & 1];
    nodes.push({ key: `1-${x}-${y}-${z}`, depth: 1, x, y, z, pointCount: 100 });
  }
  return {
    cube: [0, 0, 0, 100, 100, 100],
    spacing: 10,
    nodes,
    zOrigin: 0,
    load: async (key) => {
      loaded.push(key);
      return {
        count: 1,
        positions: new Float32Array(3),
        intensity: new Float32Array(1),
        classification: new Float32Array(1),
        colour: null,
      };
    },
  };
}

const view: CloudView = {
  colourBy: "elevation",
  colourRange: [0, 100],
  filterRange: [-Infinity, Infinity],
  classMask: [],
  size: 2,
  budget: 10_000,
};

function cameraAt(distance: number) {
  const c = new PerspectiveCamera(45, 1, 0.1, 1e6);
  c.position.set(50, 50, 50 + distance);
  c.lookAt(50, 50, 50);
  return c;
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe("PointCloudLayer", () => {
  it("asks only for the root from far away, where its points already touch on screen", async () => {
    const loaded: string[] = [];
    const l = new PointCloudLayer(source(loaded));
    l.apply(view, cameraAt(100_000), 500);
    expect(loaded).toEqual(["0-0-0-0"]);
  });

  it("refines close up, within the budget and at most four loads at once", async () => {
    const loaded: string[] = [];
    const l = new PointCloudLayer(source(loaded));
    l.apply(view, cameraAt(200), 500);
    expect(loaded.length).toBe(4);
    expect(loaded[0]).toBe("0-0-0-0");
    await settle();
    l.apply(view, cameraAt(200), 500);
    expect(new Set(loaded).size).toBe(8);
    await settle();
    l.apply(view, cameraAt(200), 500);
    expect(new Set(loaded).size).toBe(9);
    // a budget of three nodes' points chooses three
    const few: string[] = [];
    const m = new PointCloudLayer(source(few));
    m.apply({ ...view, budget: 300 }, cameraAt(200), 500);
    expect(few.length).toBe(3);
  });

  it("draws what has loaded of the choice", async () => {
    const l = new PointCloudLayer(source([]));
    let changes = 0;
    l.onChange = () => changes++;
    l.apply(view, cameraAt(100_000), 500);
    await settle();
    expect(changes).toBe(1);
    l.apply(view, cameraAt(100_000), 500);
    const shown = l.object.children.filter((c) => (c as Points).visible);
    expect(shown.length).toBe(1);
    // what was decoded (1 point), not what the source claimed (100)
    expect(l.resident).toBe(1);
  });
});
