// GPU ID-buffer picking: every pickable element renders its id
// as a colour into a one-pixel target under the cursor, which works for
// instanced everything. Ids are 24-bit, allocated by the Viewer so they are
// unique across layers; 0 is the background.

import type { Light, Object3D } from "three";
import { Problem } from "./problem";

/** What a pick lands on, as the layer that owns it reports. */
export type PickTarget =
  | { kind: "interval"; table: string; index: number }
  | { kind: "element"; index: number }
  | { kind: "mesh" };

/** A layer that can render its ids and name what an id is. */
export interface Pickable {
  /** What it adds to the scene. */
  readonly object: Object3D;
  /** Swap to id materials; hide what has no id. */
  enterPick(): void;
  exitPick(): void;
  resolvePick(id: number): PickTarget | null;
}

/** A GLSL expression for the colour that encodes `id` (a float holding an integer). */
export const PICK_ENCODE = /* glsl */ `
  vec3 pickColour(float id) {
    return vec3(mod(id, 256.0), mod(floor(id / 256.0), 256.0), floor(id / 65536.0)) / 255.0;
  }
`;

/**
 * For the id pass: everything in the scene that renders no ids hidden, since
 * it would draw its ordinary colour into the id buffer, which can read as a
 * real id — a point cloud, a Mesh Set's body, a Coordinate box. Lights have no
 * colour of their own to draw. Returns how to show them again.
 */
export function hideWhatHasNoIds(
  scene: { children: readonly Object3D[] },
  pickables: Iterable<Pickable>,
): () => void {
  const own = new Set<Object3D>();
  for (const p of pickables) own.add(p.object);
  const hidden = scene.children.filter(
    (o) => o.visible && !own.has(o) && !(o as Partial<Light>).isLight,
  );
  for (const o of hidden) o.visible = false;
  return () => {
    for (const o of hidden) o.visible = true;
  };
}

/** The id a pixel holds, 0 for the background. */
export function decodePick(rgba: Uint8Array): number {
  return (rgba[0] ?? 0) | ((rgba[1] ?? 0) << 8) | ((rgba[2] ?? 0) << 16);
}

/**
 * Where a layer's ids come from and go back to.
 *
 * An id need only be unique among the layers registered *now* — it is read
 * from a pixel and handed straight to the layer that owns it — so a block
 * given back can be handed out again. A layer that is rebuilt (after its
 * data changed) gives back exactly what it then asks for, which is
 * why a pool rather than a counter: the counter spent a fresh block every
 * time and a long session of edits exhausted the 24 bits a pixel can carry.
 */
export interface PickIds {
  /** Ids for `count` elements, 1-based, unique among the blocks out now. */
  take(count: number): number;
  /** Give a block back, exactly as it was taken. */
  give(base: number, count: number): void;
}

/** For a layer built outside a Viewer: ids that collide with nothing because nothing asks. */
export const NO_PICK_IDS: PickIds = { take: () => 1, give: () => undefined };

interface Range {
  base: number;
  count: number;
}

/** A free list over the 24-bit id space: first fit, neighbours coalesced. */
export class PickIdPool implements PickIds {
  /** The first id never yet handed out. Everything below it is out or free. */
  private next = 1;
  /** Blocks given back, by ascending base, never touching one another. */
  private free: Range[] = [];

  take(count: number): number {
    if (count <= 0) return this.next;
    for (let i = 0; i < this.free.length; i++) {
      const r = this.free[i];
      if (!r || r.count < count) continue;
      const base = r.base;
      if (r.count === count) this.free.splice(i, 1);
      else {
        r.base += count;
        r.count -= count;
      }
      return base;
    }
    const base = this.next;
    this.next += count;
    if (this.next > 0xffffff)
      throw new Problem("picking.too_many", "more than 16M pickable elements");
    return base;
  }

  give(base: number, count: number): void {
    if (count <= 0) return;
    let i = 0;
    while (i < this.free.length && (this.free[i]?.base ?? 0) < base) i++;
    this.free.splice(i, 0, { base, count });
    // merge with whichever neighbours it now touches
    for (let k = Math.max(0, i - 1); k < this.free.length - 1; ) {
      const a = this.free[k];
      const b = this.free[k + 1];
      if (a && b && a.base + a.count === b.base) {
        a.count += b.count;
        this.free.splice(k + 1, 1);
      } else k++;
    }
    // a free block that reaches the high-water mark was never really spent
    const last = this.free[this.free.length - 1];
    if (last && last.base + last.count === this.next) {
      this.next = last.base;
      this.free.pop();
    }
  }

  /** Start the numbering over. Only sound when no layer holds a block. */
  reset(): void {
    this.next = 1;
    this.free = [];
  }

  /** How many ids are out: 0 when every block has come back. */
  get outstanding(): number {
    return this.next - 1 - this.free.reduce((n, r) => n + r.count, 0);
  }
}
