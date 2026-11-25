// GPU ID-buffer picking: every pickable element renders its id
// as a colour into a one-pixel target under the cursor, which works for
// instanced everything. Ids are 24-bit, allocated by the Viewer so they are
// unique across layers; 0 is the background.

import {
  FrontSide,
  type IUniform,
  type Light,
  type Material,
  NoBlending,
  type Object3D,
  type Plane,
  ShaderMaterial,
  type Side,
} from "three";
import { Problem } from "./problem";
import type { SectionPlane, Vec3 } from "./types";

/**
 * The passes of a pick. `id` draws each element's id; `detail` draws, for a
 * layer whose elements are too many for an id each (a Point Cloud), the
 * index of the element within what the id named.
 */
export type PickPass = "id" | "detail";

/** What a pick lands on, as the layer that owns it reports. */
export type PickTarget =
  | { kind: "interval"; table: string; index: number }
  | { kind: "element"; index: number }
  /** One point of a Point Cloud: its node, its index in that node, and where it is (scene-local). */
  | { kind: "point"; node: string; index: number; position: Vec3 }
  | { kind: "mesh" };

/** A layer that can render its ids and name what an id is. */
export interface Pickable {
  /** What it adds to the scene. */
  readonly object: Object3D;
  /** Swap to id materials; hide what has no id. */
  enterPick(pass?: PickPass): void;
  exitPick(): void;
  /** What `id` is, if it is this layer's; `detail` is the second pass's index, for a layer that has one. */
  resolvePick(id: number, detail?: number): PickTarget | null;
  /** True when `id` alone is not enough: the host then renders the `detail` pass and reads it. */
  readonly needsDetail?: boolean;
}

/** GLSL for the colour that encodes `id` (a float holding an integer): `encodePick` is its twin. */
export const PICK_ENCODE = /* glsl */ `
  vec3 pickColour(float id) {
    return vec3(mod(id, 256.0), mod(floor(id / 256.0), 256.0), floor(id / 65536.0)) / 255.0;
  }
`;

/** The bytes `PICK_ENCODE` makes of `id`, which `decodePick` reads back. */
export function encodePick(id: number): [number, number, number] {
  return [id % 256, Math.floor(id / 256) % 256, Math.floor(id / 65536)];
}

// The clipping chunks every shader of the kit includes, in one place: a
// layer's own colour pass and its id pass clip alike, so what cannot be seen
// cannot be picked. `clipping: true` on the material turns them on.
export const CLIP_VERT_PARS = "#include <clipping_planes_pars_vertex>";
export const CLIP_VERT = "#include <clipping_planes_vertex>";
export const CLIP_FRAG_PARS = "#include <clipping_planes_pars_fragment>";
export const CLIP_FRAG = "#include <clipping_planes_fragment>";

/**
 * Clip these materials by their own planes. The renderer's planes clip what
 * lies behind any of them; a material's can clip only what lies behind all,
 * which is how a box is cut out. Null puts the material back under the renderer's.
 * (A material's planes only count while the renderer's `localClippingEnabled` is on.)
 */
export function applyClip(
  materials: Iterable<Material>,
  planes: readonly Plane[] | null,
  intersect: boolean,
): void {
  for (const m of materials) {
    const local = intersect && planes && planes.length > 0 ? [...planes] : null;
    if ((m.clippingPlanes === null) !== (local === null)) m.needsUpdate = true;
    m.clippingPlanes = local;
    m.clipIntersection = local !== null;
  }
}

export interface PickMaterialOptions {
  /** Declarations for the vertex shader: attributes, uniforms, varyings. */
  vertexHead?: string;
  /** Sets `vec4 mvPosition` and `gl_Position`; default: the geometry as it is. */
  vertexMain?: string;
  /** Declarations for the fragment shader (a varying declared in the vertex head is declared here too). */
  fragmentHead?: string;
  /** Runs first in main: where an element that is hidden is discarded. */
  fragmentMain?: string;
  /** A GLSL float expression for the id drawn; default `uId`, the uniform. */
  idExpr?: string;
  /** Uniforms beyond `uId`; a slot shared with a layer's own material stays shared. */
  uniforms?: Record<string, IUniform>;
  side?: Side;
}

/**
 * The id-pass material every pickable layer builds from: opaque, unblended,
 * clipped as the layer is, writing `PICK_ENCODE` of the id. Layers differ in
 * how they place a vertex and what they discard, not in how an id is written.
 */
export function pickMaterial(o: PickMaterialOptions = {}): ShaderMaterial {
  return new ShaderMaterial({
    vertexShader: /* glsl */ `
      ${CLIP_VERT_PARS}
      ${o.vertexHead ?? ""}
      void main() {
        ${
          o.vertexMain ??
          "vec4 mvPosition = modelViewMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * mvPosition;"
        }
        ${CLIP_VERT}
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      uniform float uId;
      ${CLIP_FRAG_PARS}
      ${PICK_ENCODE}
      ${o.fragmentHead ?? ""}
      void main() {
        ${CLIP_FRAG}
        ${o.fragmentMain ?? ""}
        // rounded: a varying is only close to its integer
        gl_FragColor = vec4(pickColour(floor((${o.idExpr ?? "uId"}) + 0.5)), 1.0);
      }
    `,
    uniforms: { uId: { value: 0 }, ...o.uniforms },
    side: o.side ?? FrontSide,
    blending: NoBlending,
    clipping: true,
  });
}

/** A plane of this kit as three.js's own, which is what a clipping plane is there. */
export const toClipPlane = (p: SectionPlane, into: Plane): Plane => {
  into.normal.set(p.normal[0], p.normal[1], p.normal[2]);
  into.constant = p.distance;
  return into;
};

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
