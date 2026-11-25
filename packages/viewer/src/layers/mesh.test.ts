// The mesh layer's own behaviour, without a GPU: how a view is applied, the
// line drawn where a plane cuts it, its place for an exploded view, and the
// one pick id it takes and gives back.

import { describe, expect, it } from "vitest";
import { PickIdPool } from "../picking";
import { MeshLayer, type MeshSource, type MeshView } from "./mesh";

// a unit tetrahedron, from the origin along each axis
const tetra = (): MeshSource => ({
  vertices: Float32Array.of(0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1),
  faces: Uint32Array.of(0, 1, 2, 0, 1, 3, 0, 2, 3, 1, 2, 3),
});
const view = (over: Partial<MeshView> = {}): MeshView => ({
  colour: "#ff0000",
  opacity: 1,
  mode: "smooth",
  ...over,
});

describe("MeshLayer", () => {
  it("draws the surface whole until a plane cuts it, then only the crossing", () => {
    const layer = new MeshLayer(tetra(), view());
    const [surface, crossing] = layer.object.children;
    expect(surface?.visible).toBe(true);
    expect(crossing?.visible).toBe(false);
    // z = 0.5, kept above
    layer.setCut({ normal: [0, 0, 1], distance: -0.5 });
    expect(surface?.visible).toBe(false);
    expect(crossing?.visible).toBe(true);
    const crossed = (
      crossing as unknown as { geometry: { getAttribute(n: string): { count: number } } }
    ).geometry.getAttribute("position").count;
    // three faces reach z = 0.5, one segment (two points) each
    expect(crossed).toBe(6);
    layer.setCut(null);
    expect(surface?.visible).toBe(true);
    layer.dispose();
  });

  it("applies a see-through view without writing depth", () => {
    const layer = new MeshLayer(tetra(), view({ opacity: 0.4, mode: "flat" }));
    const surface = layer.object.children[0] as unknown as {
      material: { transparent: boolean; depthWrite: boolean; opacity: number };
    };
    expect(surface.material.transparent).toBe(true);
    expect(surface.material.depthWrite).toBe(false);
    expect(surface.material.opacity).toBeCloseTo(0.4);
    layer.apply(view());
    expect(surface.material.transparent).toBe(false);
    expect(surface.material.depthWrite).toBe(true);
    layer.dispose();
  });

  it("places itself by its surface's centre of mass, inside its box", () => {
    const layer = new MeshLayer(tetra(), view());
    const p = layer.place();
    expect(p.min).toEqual([0, 0, 0]);
    expect(p.max).toEqual([1, 1, 1]);
    for (const c of p.centre) {
      expect(c).toBeGreaterThan(0);
      expect(c).toBeLessThan(1);
    }
    // the same answer, worked out once
    expect(layer.place()).toBe(p);
    layer.dispose();
  });

  it("takes one pick id, resolves it as the mesh, and gives it back", () => {
    const pool = new PickIdPool();
    const layer = new MeshLayer(tetra(), view(), pool);
    expect(pool.outstanding).toBe(1);
    expect(layer.resolvePick(1)).toEqual({ kind: "mesh" });
    expect(layer.resolvePick(2)).toBeNull();
    layer.dispose();
    expect(pool.outstanding).toBe(0);
  });
});
