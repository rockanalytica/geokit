// The layer host with no GPU: a stand-in renderer that records what it is
// asked to draw, and a pixel table in place of the readback.

import {
  type Camera,
  type Color,
  Group,
  type Mesh,
  PerspectiveCamera,
  type Plane,
  Scene,
  type Vector2,
  type WebGLRenderTarget,
} from "three";
import { describe, expect, it } from "vitest";
import { type HostRenderer, type Layer, LayerHost, type PickRead } from "./host";
import { MeshLayer } from "./layers/mesh";
import { encodePick, type PickPass, type PickTarget } from "./picking";
import { boxPlanes, clipBox, keeps, sectionSpec } from "./section";

function fakeRenderer(onRender: (scene: Scene) => void = () => {}) {
  const r: HostRenderer & { renders: number } = {
    clippingPlanes: [],
    localClippingEnabled: false,
    renders: 0,
    getSize: (t: Vector2) => t.set(200, 100),
    getRenderTarget: () => null,
    setRenderTarget: () => {},
    render: (scene: Scene, _camera: Camera) => {
      r.renders++;
      onRender(scene);
    },
    getClearColor: (t: Color) => t.set(0x123456),
    getClearAlpha: () => 1,
    setClearColor: () => {},
    readRenderTargetPixels: (_t: WebGLRenderTarget, _x, _y, _w, _h, b: Uint8Array) => b.fill(0),
  };
  return r;
}

/** A pickable stand-in: the ids it was given and what it was told. */
class Fake implements Layer {
  readonly object = new Group();
  readonly passes: PickPass[] = [];
  entered = 0;
  exited = 0;
  clip: { planes: readonly Plane[]; intersect: boolean } | null = null;
  cut: unknown = "unset";
  constructor(
    readonly base: number,
    readonly count: number,
    readonly needsDetail = false,
  ) {}
  apply() {}
  dispose() {}
  enterPick(pass: PickPass = "id") {
    this.entered++;
    this.passes.push(pass);
  }
  exitPick() {
    this.exited++;
  }
  resolvePick(id: number, detail?: number): PickTarget | null {
    const i = id - this.base;
    if (i < 0 || i >= this.count) return null;
    return this.needsDetail
      ? { kind: "point", node: `n${id}`, index: detail ?? 0, position: [1, 2, 3] }
      : { kind: "element", index: i };
  }
  setClip(planes: readonly Plane[], intersect: boolean) {
    this.clip = { planes, intersect };
  }
  setCut(plane: unknown) {
    this.cut = plane;
  }
}

const camera = () => new PerspectiveCamera(45, 2, 0.1, 100);
/** A read that answers each pass from a table. */
const table =
  (answers: Partial<Record<PickPass, number>>): PickRead =>
  (_x, _y, pass) =>
    Uint8Array.of(...encodePick(answers[pass] ?? 0), 255);

describe("LayerHost.pickAt", () => {
  it("routes an id to the layer that owns it, hiding what has no ids while it renders", () => {
    const scene = new Scene();
    const decoy = new Group();
    scene.add(decoy);
    const seen: boolean[] = [];
    const renderer = fakeRenderer(() => seen.push(decoy.visible));
    const host = new LayerHost(renderer, scene, { read: table({ id: 5 }) });
    const a = new Fake(host.ids.take(3), 3);
    const b = new Fake(host.ids.take(2), 2);
    host.add(a);
    host.add(b);
    const cam = camera();
    const hit = host.pickAt(10, 20, cam);
    expect(hit?.layer).toBe(b);
    expect(hit?.id).toBe(5);
    expect(hit?.target).toEqual({ kind: "element", index: 1 });
    // one pass, with the decoy hidden and then shown again
    expect(seen).toEqual([false]);
    expect(decoy.visible).toBe(true);
    expect([a.entered, a.exited, b.entered, b.exited]).toEqual([1, 1, 1, 1]);
    // the camera is as it was
    expect(cam.view?.enabled ?? false).toBe(false);
  });

  it("is null for the background, for a pixel off the canvas, and with nothing pickable", () => {
    const renderer = fakeRenderer();
    const host = new LayerHost(renderer, new Scene(), { read: table({ id: 0 }) });
    expect(host.pickAt(1, 1, camera())).toBeNull();
    host.add(new Fake(host.ids.take(1), 1));
    expect(host.pickAt(1, 1, camera())).toBeNull();
    const before = renderer.renders;
    expect(host.pickAt(-1, 5, camera())).toBeNull();
    expect(host.pickAt(200, 5, camera())).toBeNull();
    expect(host.pickAt(5, 100, camera())).toBeNull();
    expect(renderer.renders).toBe(before);
  });

  it("is null when no layer owns the id it read", () => {
    const host = new LayerHost(fakeRenderer(), new Scene(), { read: table({ id: 99 }) });
    host.add(new Fake(host.ids.take(3), 3));
    expect(host.pickAt(1, 1, camera())).toBeNull();
  });

  it("draws a layer that needs a second pass alone, and reads the index from it", () => {
    const scene = new Scene();
    const visible: Record<string, boolean>[] = [];
    let cloud: Fake | undefined;
    let blocks: Fake | undefined;
    const renderer = fakeRenderer(() => {
      visible.push({
        cloud: cloud?.object.visible ?? false,
        blocks: blocks?.object.visible ?? false,
      });
    });
    const host = new LayerHost(renderer, scene, { read: table({ id: 7, detail: 123456 }) });
    blocks = host.add(new Fake(host.ids.take(3), 3));
    // ids 4..: the cloud's nodes
    cloud = host.add(new Fake(host.ids.take(10), 10, true));
    const hit = host.pickAt(3, 3, camera());
    expect(hit?.layer).toBe(cloud);
    expect(hit?.target).toEqual({
      kind: "point",
      node: "n7",
      index: 123456,
      position: [1, 2, 3],
    });
    expect(cloud.passes).toEqual(["id", "detail"]);
    expect(blocks.passes).toEqual(["id"]);
    expect(visible).toEqual([
      { cloud: true, blocks: true },
      { cloud: true, blocks: false },
    ]);
    expect(blocks.object.visible).toBe(true);
    expect(cloud.exited).toBe(2);
  });

  it("restores the camera's own view offset", () => {
    const host = new LayerHost(fakeRenderer(), new Scene(), { read: table({ id: 1 }) });
    host.add(new Fake(host.ids.take(1), 1));
    const cam = camera();
    cam.setViewOffset(400, 200, 10, 10, 100, 50);
    host.pickAt(1, 1, cam);
    expect(cam.view).toMatchObject({ enabled: true, offsetX: 10, offsetY: 10, width: 100 });
  });

  it("picks a real Mesh Layer through its id material", () => {
    const scene = new Scene();
    let during = "";
    let mesh: MeshLayer | undefined;
    const renderer = fakeRenderer(() => {
      const surface = mesh?.object.children[0] as Mesh | undefined;
      during = (surface?.material as { type: string } | undefined)?.type ?? "";
    });
    const host = new LayerHost(renderer, scene, { read: table({ id: 1 }) });
    mesh = host.add(
      new MeshLayer(
        { vertices: Float32Array.of(0, 0, 0, 1, 0, 0, 0, 1, 0), faces: Uint32Array.of(0, 1, 2) },
        { colour: "#fff", opacity: 1, mode: "smooth" },
        host.ids,
      ),
    );
    expect(host.pickAt(5, 5, camera())?.target).toEqual({ kind: "mesh" });
    expect(during).toBe("ShaderMaterial");
    const surface = mesh.object.children[0] as Mesh;
    expect((surface.material as { type: string }).type).toBe("MeshLambertMaterial");
  });
});

describe("LayerHost.setSection", () => {
  const g = { centre: [0, 0, 0] as [number, number, number], azimuth: 0, plunge: 0, step: 10 };

  it("clips by the renderer's planes and hands each layer its cut", () => {
    const renderer = fakeRenderer();
    const host = new LayerHost(renderer, new Scene());
    const l = host.add(new Fake(1, 1));
    host.setSection(sectionSpec(g, "behind"));
    expect(renderer.clippingPlanes).toHaveLength(1);
    expect(renderer.localClippingEnabled).toBe(false);
    expect(l.clip?.intersect).toBe(false);
    expect(l.cut).toMatchObject({ distance: -0 });
    // the plane is three.js's, with the kit's keep rule: n·p + d ≥ 0
    const p = renderer.clippingPlanes[0];
    expect(p?.distanceToPoint({ x: 0, y: 5, z: 0 } as never)).toBeGreaterThan(0);
    host.setSection(null);
    expect(renderer.clippingPlanes).toHaveLength(0);
    expect(l.cut).toBeNull();
    expect(l.clip?.planes).toHaveLength(0);
  });

  it("gives a section set before a layer was added to the layer when it is", () => {
    const host = new LayerHost(fakeRenderer(), new Scene());
    host.setSection(sectionSpec(g, "band"));
    const l = host.add(new Fake(1, 1));
    expect(l.clip?.planes).toHaveLength(2);
    expect(l.cut).not.toBeNull();
  });

  it("clips a box in by the renderer, and a box out by each material", () => {
    const box = { min: [0, 0, 0], max: [10, 10, 10] } as const;
    const renderer = fakeRenderer();
    const host = new LayerHost(renderer, new Scene());
    const l = host.add(new Fake(1, 1));
    host.setSection(clipBox({ min: [...box.min], max: [...box.max] }, "inside"));
    expect(renderer.clippingPlanes).toHaveLength(6);
    expect(renderer.localClippingEnabled).toBe(false);
    expect(l.cut).toBeNull();
    host.setSection(clipBox({ min: [...box.min], max: [...box.max] }, "outside"));
    expect(renderer.clippingPlanes).toHaveLength(0);
    expect(renderer.localClippingEnabled).toBe(true);
    expect(l.clip).toMatchObject({ intersect: true });
    expect(l.clip?.planes).toHaveLength(6);
  });

  it("puts a real Mesh's materials under the planes that cut a box out", () => {
    const host = new LayerHost(fakeRenderer(), new Scene());
    const mesh = host.add(
      new MeshLayer(
        { vertices: Float32Array.of(0, 0, 0, 1, 0, 0, 0, 1, 0), faces: Uint32Array.of(0, 1, 2) },
        { colour: "#fff", opacity: 1, mode: "smooth" },
        host.ids,
      ),
    );
    const surface = mesh.object.children[0] as Mesh;
    const m = surface.material as { clippingPlanes: Plane[] | null; clipIntersection: boolean };
    host.setSection(clipBox({ min: [0, 0, 0], max: [1, 1, 1] }, "outside"));
    expect(m.clippingPlanes).toHaveLength(6);
    expect(m.clipIntersection).toBe(true);
    host.setSection(clipBox({ min: [0, 0, 0], max: [1, 1, 1] }, "inside"));
    expect(m.clippingPlanes).toBeNull();
    expect(m.clipIntersection).toBe(false);
  });

  it("removes a layer from the scene without disposing it", () => {
    const scene = new Scene();
    const host = new LayerHost(fakeRenderer(), scene);
    const l = host.add(new Fake(1, 1));
    expect(scene.children).toContain(l.object);
    host.remove(l);
    expect(scene.children).not.toContain(l.object);
    expect(host.layers).toHaveLength(0);
  });
});

describe("a clip box", () => {
  const box = { min: [0, 0, 0], max: [10, 10, 10] } as {
    min: [number, number, number];
    max: [number, number, number];
  };

  it("keeps what is inside it, or what is outside", () => {
    const inside = clipBox(box, "inside");
    const outside = clipBox(box, "outside");
    expect(inside.planes).toEqual(boxPlanes(box));
    for (const [p, isIn] of [
      [[5, 5, 5], true],
      [[0, 0, 0], true],
      [[10, 10, 10], true],
      [[11, 5, 5], false],
      [[5, -1, 5], false],
      [[5, 5, 10.5], false],
    ] as const) {
      expect(keeps(inside, [...p]), `${p} in`).toBe(isIn);
      expect(keeps(outside, [...p]), `${p} out`).toBe(!isIn || p.some((c) => c === 0 || c === 10));
    }
  });
});
