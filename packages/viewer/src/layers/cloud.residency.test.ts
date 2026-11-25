// The Point Cloud's choice, residency, failure and picking, with no GPU.

import { Box3, PerspectiveCamera, type Plane, type Points, Vector3 } from "three";
import { describe, expect, it } from "vitest";
import { PickIdPool } from "../picking";
import { Problem } from "../problem";
import {
  type ChoosableNode,
  type CloudNodePoints,
  type CloudSource,
  type CloudView,
  chooseNodes,
  PointCloudLayer,
} from "./cloud";

const settle = () => new Promise((r) => setTimeout(r, 0));

/** `n` points, the first at (1, 2, 3). */
function decoded(n: number): CloudNodePoints {
  const positions = new Float32Array(n * 3);
  positions.set([1, 2, 3]);
  return {
    count: n,
    positions,
    intensity: new Float32Array(n),
    classification: new Float32Array(n),
    colour: null,
  };
}

/** A root and its eight children over a 100 m cube, each claiming `claim` points. */
function source(load: CloudSource["load"], claim = 100): CloudSource {
  const nodes = [{ key: "0-0-0-0", depth: 0, x: 0, y: 0, z: 0, pointCount: claim }];
  for (let i = 0; i < 8; i++) {
    const [x, y, z] = [i & 1, (i >> 1) & 1, (i >> 2) & 1];
    nodes.push({ key: `1-${x}-${y}-${z}`, depth: 1, x, y, z, pointCount: claim });
  }
  return { cube: [0, 0, 0, 100, 100, 100], spacing: 10, nodes, zOrigin: 0, load };
}

const view: CloudView = {
  colourBy: "elevation",
  colourRange: [0, 100],
  filterRange: [-Infinity, Infinity],
  classMask: [],
  size: 2,
  budget: 10_000,
};

function cameraAt(distance: number, at: [number, number, number] = [50, 50, 50]) {
  const c = new PerspectiveCamera(45, 1, 0.1, 1e6);
  c.position.set(at[0], at[1], at[2] + distance);
  c.lookAt(...at);
  return c;
}

// ---- chooseNodes, on its own -----------------------------------------------

interface T extends ChoosableNode<T> {
  key: string;
}
const tree = (): T => {
  const box = (min: number, max: number) =>
    new Box3(new Vector3(min, min, min), new Vector3(max, max, max));
  const kid = (k: string, min: number, max: number): T => ({
    key: k,
    depth: 1,
    pointCount: 100,
    box: box(min, max),
    children: [],
  });
  return {
    key: "root",
    depth: 0,
    pointCount: 100,
    box: box(0, 100),
    // a near child and a far one: the camera looks down from above, so the upper is nearer
    children: [kid("near", 50, 100), kid("far", 0, 50)],
  };
};

describe("chooseNodes", () => {
  it("is empty without a root", () => {
    expect(chooseNodes<T>(null, cameraAt(200), 500, 1e6, 10)).toEqual([]);
  });

  it("stops at the root where its points already touch on screen", () => {
    expect(chooseNodes(tree(), cameraAt(100_000), 500, 1e6, 10).map((n) => n.key)).toEqual([
      "root",
    ]);
  });

  it("opens the root close up, the nearer child first, and spends the budget on it", () => {
    const cam = cameraAt(200, [10, 10, 10]);
    const all = chooseNodes(tree(), cam, 500, 1e6, 10).map((n) => n.key);
    expect(all).toEqual(["root", "near", "far"]);
    // room for two nodes: the root and the child that is nearer
    const two = chooseNodes(tree(), cam, 500, 200, 10).map((n) => n.key);
    expect(two).toEqual(["root", "near"]);
    // a budget below the root still gives the root: something is drawn
    expect(chooseNodes(tree(), cam, 500, 1, 10).map((n) => n.key)).toEqual(["root"]);
  });

  it("passes over what the view does not hold, or what `skip` names, with all under it", () => {
    const cam = cameraAt(200, [10, 10, 10]);
    const skipped = chooseNodes(tree(), cam, 500, 1e6, 10, (b) => b.max.x <= 50).map((n) => n.key);
    expect(skipped).toEqual(["root", "near"]);
    // a camera looking away holds nothing
    const away = cameraAt(200, [10, 10, 10]);
    away.lookAt(10, 10, 1000);
    expect(chooseNodes(tree(), away, 500, 1e6, 10)).toEqual([]);
  });

  it("opens finer levels under a parallel projection on spacing alone", async () => {
    const { OrthographicCamera } = await import("three");
    const o = new OrthographicCamera(-50, 50, 50, -50, 0.1, 1000);
    o.position.set(50, 50, 500);
    o.lookAt(50, 50, 50);
    // 100 m over 500 px: the root's 10 m points are 50 px apart, its children's 25
    expect(chooseNodes(tree(), o, 500, 1e6, 10)).toHaveLength(3);
    // over 5 px they are under a pixel and stay shut
    expect(chooseNodes(tree(), o, 5, 1e6, 10)).toHaveLength(1);
  });
});

// ---- residency --------------------------------------------------------------

describe("a node that fails", () => {
  it("is reported, left alone until its wait is over, then asked for again", async () => {
    let now = 0;
    const asked: string[] = [];
    let fail = true;
    const l = new PointCloudLayer(
      source(async (key) => {
        asked.push(key);
        if (fail) throw new Error("disk");
        return decoded(3);
      }),
      new PickIdPool(),
      () => now,
    );
    const errors: string[] = [];
    l.onError = (key, e) => errors.push(`${key}:${e.message}`);
    l.apply(view, cameraAt(100_000), 500);
    await settle();
    expect(errors).toEqual(["0-0-0-0:disk"]);
    expect(l.stateOf("0-0-0-0")).toBe("failed");
    expect(l.failed).toHaveLength(1);
    expect(l.failed[0]).toMatchObject({ key: "0-0-0-0", failures: 1, retryAt: 1000 });
    // the app draws again and again: no request until the wait is over
    for (const t of [0, 500, 999]) {
      now = t;
      l.apply(view, cameraAt(100_000), 500);
    }
    expect(asked).toHaveLength(1);
    now = 1000;
    l.apply(view, cameraAt(100_000), 500);
    await settle();
    expect(asked).toHaveLength(2);
    // failed again: the wait doubles
    expect(l.failed[0]).toMatchObject({ failures: 2, retryAt: 1000 + 2000 });
    fail = false;
    now = 3000;
    l.apply(view, cameraAt(100_000), 500);
    await settle();
    expect(l.stateOf("0-0-0-0")).toBe("loaded");
    expect(l.failed).toEqual([]);
    expect(l.resident).toBe(3);
  });

  it("waits no longer than half a minute", async () => {
    let now = 0;
    const l = new PointCloudLayer(
      source(async () => {
        throw new Error("no");
      }),
      new PickIdPool(),
      () => now,
    );
    l.onError = () => {};
    for (let i = 0; i < 12; i++) {
      l.apply(view, cameraAt(100_000), 500);
      await settle();
      now = l.failed[0]?.retryAt ?? now;
    }
    const f = l.failed[0];
    expect((f?.retryAt ?? 0) - now).toBe(0);
    l.apply(view, cameraAt(100_000), 500);
    await settle();
    expect((l.failed[0]?.retryAt ?? 0) - now).toBe(30_000);
  });

  it("is a node whose arrays do not match its count", async () => {
    const bad: CloudNodePoints[] = [
      { ...decoded(2), positions: new Float32Array(3) },
      { ...decoded(2), intensity: new Float32Array(1) },
      { ...decoded(2), classification: new Float32Array(3) },
      { ...decoded(2), colour: new Uint8Array(5) },
      { ...decoded(2), count: 2.5 },
      { ...decoded(2), count: -1 },
    ];
    for (const points of bad) {
      const l = new PointCloudLayer(source(async () => points));
      const seen: Error[] = [];
      l.onError = (_k, e) => seen.push(e);
      l.apply(view, cameraAt(100_000), 500);
      await settle();
      expect(l.stateOf("0-0-0-0")).toBe("failed");
      expect(l.resident).toBe(0);
      expect(l.object.children).toHaveLength(0);
      expect(seen[0]).toBeInstanceOf(Problem);
      expect((seen[0] as Problem).code).toBe("cloud.bad_node");
    }
  });

  it("is a loader that throws before it returns a promise", async () => {
    const l = new PointCloudLayer(
      source(() => {
        throw new Error("sync");
      }),
    );
    const seen: string[] = [];
    l.onError = (_k, e) => seen.push(e.message);
    l.apply(view, cameraAt(100_000), 500);
    await settle();
    expect(seen).toEqual(["sync"]);
  });
});

describe("what is resident", () => {
  it("counts the points decoded, not the source's claim", async () => {
    const l = new PointCloudLayer(source(async () => decoded(7), 1000));
    l.apply(view, cameraAt(100_000), 500);
    await settle();
    expect(l.resident).toBe(7);
  });

  it("holds nothing that lands after dispose", async () => {
    let release: (p: CloudNodePoints) => void = () => {};
    const pool = new PickIdPool();
    const l = new PointCloudLayer(
      source(() => new Promise<CloudNodePoints>((r) => (release = r))),
      pool,
    );
    l.apply(view, cameraAt(100_000), 500);
    l.dispose();
    release(decoded(5));
    await settle();
    expect(l.resident).toBe(0);
    expect(l.object.children).toHaveLength(0);
    expect(pool.outstanding).toBe(0);
  });

  it("settles over budget as a node lands, not at the next choice", async () => {
    const releases: ((p: CloudNodePoints) => void)[] = [];
    const l = new PointCloudLayer(
      source(() => new Promise<CloudNodePoints>((r) => releases.push(r)), 10),
    );
    // four loads start under a roomy budget...
    l.apply(view, cameraAt(200), 500);
    expect(releases).toHaveLength(4);
    // ...then the choice shrinks to the root, whose budget is 4: 2 × 4 = 8 points
    l.apply({ ...view, budget: 4 }, cameraAt(100_000), 500);
    for (const r of releases) r(decoded(3));
    await settle();
    expect(l.resident).toBeLessThanOrEqual(8);
    // the root, which the Viewport still draws, is what stays
    expect(l.stateOf("0-0-0-0")).toBe("loaded");
  });

  it("does not drop what another Viewport draws, until it is forgotten", async () => {
    const l = new PointCloudLayer(source(async () => decoded(60), 10));
    const b = {};
    const small = { ...view, budget: 50 };
    // Viewport b, close up: five nodes of 10 claimed points
    l.apply(small, cameraAt(200), 500, b);
    await settle();
    l.apply(small, cameraAt(200), 500, b);
    await settle();
    expect(l.resident).toBeGreaterThan(100);
    const held = l.resident;
    // the default Viewport sees only the root; b's nodes are over twice the budget but b's
    l.apply(small, cameraAt(100_000), 500);
    expect(l.resident).toBe(held);
    l.forget(b);
    l.apply(small, cameraAt(100_000), 500);
    expect(l.resident).toBe(60);
    expect(l.stateOf("0-0-0-0")).toBe("loaded");
  });
});

describe("picking a point", () => {
  it("takes an id per node held, resolves a node and an index, and gives the ids back", async () => {
    const pool = new PickIdPool();
    const l = new PointCloudLayer(
      source(async () => decoded(5)),
      pool,
    );
    expect(l.needsDetail).toBe(true);
    l.apply(view, cameraAt(100_000), 500);
    await settle();
    expect(pool.outstanding).toBe(1);
    expect(l.resolvePick(1, 0)).toEqual({
      kind: "point",
      node: "0-0-0-0",
      index: 0,
      position: [1, 2, 3],
    });
    expect(l.resolvePick(1, 4)).toMatchObject({ index: 4, position: [0, 0, 0] });
    expect(l.resolvePick(1, 5)).toBeNull();
    expect(l.resolvePick(1, -1)).toBeNull();
    expect(l.resolvePick(2, 0)).toBeNull();
    l.dispose();
    expect(pool.outstanding).toBe(0);
  });

  it("swaps every held node to the id materials and back", async () => {
    const l = new PointCloudLayer(
      source(async () => decoded(2)),
      new PickIdPool(),
    );
    l.apply(view, cameraAt(100_000), 500);
    await settle();
    const points = l.object.children[0] as Points;
    const colour = points.material;
    l.enterPick("id");
    const id = points.material as unknown as { fragmentShader: string; vertexShader: string };
    expect(id).not.toBe(colour);
    l.enterPick("detail");
    const detail = points.material as unknown as { fragmentShader: string; vertexShader: string };
    expect(detail).not.toBe(id);
    // the detail pass writes the vertex index; both clip and share the value filter
    expect(detail.vertexShader).toContain("gl_VertexID");
    expect(detail.fragmentShader).toContain("floor((vIndex) + 0.5)");
    expect(id.fragmentShader).toContain("floor((uId) + 0.5)");
    for (const m of [id, detail]) {
      expect(m.fragmentShader).toContain("#include <clipping_planes_fragment>");
      expect(m.fragmentShader).toContain("valueHidden(vValue)");
    }
    l.exitPick();
    expect(points.material).toBe(colour);
  });
});

describe("a cloud under a clip", () => {
  const plane = (normal: [number, number, number], distance: number) =>
    ({ normal: new Vector3(...normal), constant: distance }) as unknown as Plane;

  it("does not ask for nodes the planes clip away wholly", () => {
    const asked: string[] = [];
    const l = new PointCloudLayer(
      source(async (k) => {
        asked.push(k);
        return decoded(1);
      }),
    );
    // everything is behind x = 1000
    l.setClip([plane([1, 0, 0], -1000)], false);
    l.apply(view, cameraAt(200), 500);
    expect(asked).toEqual([]);
    // keep x ≥ 50: the children at x = 0 are clipped, the root is only part clipped
    l.setClip([plane([1, 0, 0], -50.5)], false);
    l.apply(view, cameraAt(200), 500);
    expect(asked.every((k) => k === "0-0-0-0" || k.split("-")[1] === "1")).toBe(true);
    expect(asked).toContain("0-0-0-0");
  });

  it("cuts a box out: nodes wholly inside it are skipped, a node it only touches is not", () => {
    const asked: string[] = [];
    const l = new PointCloudLayer(
      source(async (k) => {
        asked.push(k);
        return decoded(1);
      }),
    );
    // the outward planes of the box x, y, z in 0..50: behind all six = inside it
    const out = (n: [number, number, number], d: number) => plane(n, d);
    l.setClip(
      [
        out([-1, 0, 0], 0),
        out([1, 0, 0], -50),
        out([0, -1, 0], 0),
        out([0, 1, 0], -50),
        out([0, 0, -1], 0),
        out([0, 0, 1], -50),
      ],
      true,
    );
    l.apply(view, cameraAt(200), 500);
    expect(asked).toContain("0-0-0-0");
    expect(asked).not.toContain("1-0-0-0");
    expect(asked).toContain("1-1-1-1");
  });
});
