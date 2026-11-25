// Blocks without a GPU: what the instances hold, the ids they take and give
// back, what a pick resolves to, and their place under a clip.

import type { InstancedBufferAttribute, Mesh } from "three";
import { describe, expect, it } from "vitest";
import { PickIdPool } from "../picking";
import { Problem } from "../problem";
import { BlockLayer, type BlockSource } from "./blocks";
import { MISSING_ON_GPU, type ValueView } from "./value";

const view = (over: Partial<ValueView> = {}): ValueView => ({
  column: "",
  colourRange: [0, 10],
  filterRange: [Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY],
  classMask: [],
  mip: false,
  ...over,
});

const source = (): BlockSource => ({
  centres: Float32Array.of(0, 0, 0, 10, 0, 0, 20, 0, 0),
  sizes: [10, 10, 5],
  values: [1, Number.NaN, 3],
  kind: "continuous",
});

describe("BlockLayer", () => {
  it("holds a centre, a size and a value per instance, a missing value as the GPU's sentinel", () => {
    const layer = new BlockLayer(source(), view());
    const g = (layer.object as Mesh).geometry;
    expect((g as unknown as { instanceCount: number }).instanceCount).toBe(3);
    const size = g.getAttribute("aSize") as InstancedBufferAttribute;
    expect([...size.array.slice(0, 6)]).toEqual([10, 10, 5, 10, 10, 5]);
    const value = g.getAttribute("aValue") as InstancedBufferAttribute;
    expect(value.array[1]).toBe(Math.fround(MISSING_ON_GPU));
    expect(layer.block(2)).toEqual({ centre: [20, 0, 0], size: [10, 10, 5] });
    expect(layer.block(3)).toBeNull();
    layer.dispose();
  });

  it("takes one id per block, resolves them, and gives them back", () => {
    const pool = new PickIdPool();
    pool.take(4); // another layer's ids: this one starts after them
    const layer = new BlockLayer(source(), view(), pool);
    expect(pool.outstanding).toBe(7);
    expect(layer.resolvePick(4)).toBeNull();
    expect(layer.resolvePick(5)).toEqual({ kind: "element", index: 0 });
    expect(layer.resolvePick(7)).toEqual({ kind: "element", index: 2 });
    expect(layer.resolvePick(8)).toBeNull();
    layer.dispose();
    expect(pool.outstanding).toBe(4);
  });

  it("swaps to its id material for a pick and back", () => {
    const layer = new BlockLayer(source(), view());
    const colour = layer.object.material;
    layer.enterPick();
    expect(layer.object.material).not.toBe(colour);
    layer.exitPick();
    expect(layer.object.material).toBe(colour);
    layer.dispose();
  });

  it("takes a size for each block as well as one for all", () => {
    const s = source();
    s.sizes = Float32Array.of(1, 2, 3, 4, 5, 6, 7, 8, 9);
    const layer = new BlockLayer(s, view());
    expect(layer.block(1)?.size).toEqual([4, 5, 6]);
    layer.dispose();
  });

  it("refuses arrays that do not agree", () => {
    const bad: BlockSource[] = [
      { ...source(), centres: Float32Array.of(0, 0) },
      { ...source(), values: [1] },
      { ...source(), sizes: Float32Array.of(1, 1, 1) },
    ];
    for (const s of bad) {
      expect(() => new BlockLayer(s, view())).toThrow(Problem);
    }
  });

  it("colours through the value uniforms, by the kind of its column", () => {
    const layer = new BlockLayer(
      { ...source(), values: [0, 1, 2], kind: "categorical" },
      view({ classMask: [true, false, true] }),
    );
    const u = (layer.object.material as unknown as { uniforms: Record<string, { value: number }> })
      .uniforms;
    expect(u.uCategorical?.value).toBe(1);
    expect(u.uMaskSize?.value).toBe(3);
    layer.dispose();
  });

  it("puts both its materials under planes that cut a box out", () => {
    const layer = new BlockLayer(source(), view());
    layer.setClip([{}, {}] as never[], true);
    const m = layer.object.material as unknown as {
      clippingPlanes: unknown[];
      clipIntersection: boolean;
    };
    expect(m.clippingPlanes).toHaveLength(2);
    layer.enterPick();
    const id = layer.object.material as unknown as { clippingPlanes: unknown[] };
    expect(id.clippingPlanes).toHaveLength(2);
    layer.dispose();
  });
});
