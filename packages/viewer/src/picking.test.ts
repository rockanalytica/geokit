// Pick ids: 24 bits, handed out per layer and given back when
// the layer goes, so a layer rebuilt over and over costs nothing.

import { AmbientLight, Group, Scene } from "three";
import { describe, expect, it } from "vitest";
import { decodePick, hideWhatHasNoIds, type Pickable, PickIdPool } from "./picking";

describe("the id pass", () => {
  const layer = (object: Group): Pickable => ({
    object,
    enterPick() {},
    exitPick() {},
    resolvePick: () => null,
  });

  it("hides what renders no ids, and shows it again as it was", () => {
    const scene = new Scene();
    const [picked, cloud, box, hidden, light] = [
      new Group(),
      new Group(),
      new Group(),
      new Group(),
      new AmbientLight(),
    ];
    hidden.visible = false;
    scene.add(picked, cloud, box, hidden, light);
    const showAgain = hideWhatHasNoIds(scene, [layer(picked)]);
    expect(picked.visible).toBe(true);
    expect(cloud.visible).toBe(false);
    expect(box.visible).toBe(false);
    expect(light.visible).toBe(true);
    showAgain();
    expect(cloud.visible).toBe(true);
    expect(box.visible).toBe(true);
    // one this Viewport had hidden stays so
    expect(hidden.visible).toBe(false);
  });
});

describe("PickIdPool", () => {
  it("hands out a distinct block per layer", () => {
    const pool = new PickIdPool();
    expect(pool.take(10)).toBe(1);
    expect(pool.take(5)).toBe(11);
    expect(pool.take(1)).toBe(16);
    expect(pool.outstanding).toBe(16);
  });

  it("hands a block back out once it is returned", () => {
    const pool = new PickIdPool();
    const a = pool.take(10);
    const b = pool.take(5);
    pool.give(a, 10);
    // the freed block is big enough, so it is used before fresh numbers
    expect(pool.take(4)).toBe(a);
    expect(pool.take(6)).toBe(a + 4);
    expect(pool.take(1)).toBe(b + 5);
  });

  it("costs nothing to rebuild one layer over and over", () => {
    const pool = new PickIdPool();
    pool.take(1000); // another layer, never rebuilt
    for (let i = 0; i < 10_000; i++) {
      const base = pool.take(10_000);
      pool.give(base, 10_000);
    }
    // 10 000 rebuilds of a layer: the counter would have spent 100M
    expect(pool.outstanding).toBe(1000);
    expect(pool.take(10_000)).toBe(1001);
  });

  it("coalesces neighbours, so a block split up can be taken whole again", () => {
    const pool = new PickIdPool();
    const a = pool.take(10);
    const b = pool.take(10);
    const c = pool.take(10);
    pool.take(5); // keeps the high-water mark above them
    pool.give(a, 10);
    pool.give(c, 10);
    // a and c are apart until b joins them
    expect(pool.take(30)).toBe(36);
    pool.give(b, 10);
    expect(pool.take(30)).toBe(a);
  });

  it("lowers the high-water mark when the last block comes back", () => {
    const pool = new PickIdPool();
    pool.take(10);
    const b = pool.take(0xff_0000);
    pool.give(b, 0xff_0000);
    expect(pool.outstanding).toBe(10);
    // the space is whole again: what would have overflowed now fits
    expect(() => pool.take(0xff_0000)).not.toThrow();
  });

  it("refuses past the 24 bits a pixel can carry", () => {
    const pool = new PickIdPool();
    pool.take(0xffffff - 1);
    expect(() => pool.take(2)).toThrow(/16M/);
  });

  it("starts over on reset, for when the scene empties", () => {
    const pool = new PickIdPool();
    pool.take(0xff_0000);
    pool.reset();
    expect(pool.take(10)).toBe(1);
    expect(pool.outstanding).toBe(10);
  });
});

describe("decodePick", () => {
  it("reads back an id written as a colour", () => {
    for (const id of [1, 255, 256, 65535, 65536, 0xffffff]) {
      const rgba = Uint8Array.of(id & 0xff, (id >> 8) & 0xff, (id >> 16) & 0xff, 255);
      expect(decodePick(rgba)).toBe(id);
    }
  });

  it("reads the background as nothing", () => {
    expect(decodePick(Uint8Array.of(0, 0, 0, 255))).toBe(0);
  });
});
