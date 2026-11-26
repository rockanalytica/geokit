// Camera frusta: where each of a set of cameras stood and what it saw, drawn
// as a wireframe pyramid (apex at the camera, base `size` in front of it) and
// a dot at the apex. All frusta are one merged line set and one point set,
// so thousands cost two draw calls. Each frustum has its own colour, and one
// may be highlighted: drawn in the highlight colour with a bigger dot.
//
// Camera axes follow the computer-vision convention: x right, y down, z
// forward. `rotation` takes camera axes to world axes (world from camera),
// row-major, so a camera's forward is its third column.
//
// Picking is by frustum: the id pass draws every frustum's lines and a large
// dot at its apex in that frustum's id, and `resolvePick` gives
// `{kind: "element", index}`.

import {
  BufferGeometry,
  Float32BufferAttribute,
  Group,
  LineSegments,
  type Material,
  type Plane,
  Points,
  ShaderMaterial,
} from "three";
import {
  applyClip,
  CLIP_FRAG,
  CLIP_FRAG_PARS,
  CLIP_VERT,
  CLIP_VERT_PARS,
  NO_PICK_IDS,
  type Pickable,
  type PickIds,
  type PickPass,
  type PickTarget,
  pickMaterial,
} from "../picking";
import { Problem } from "../problem";
import type { Vec3 } from "../types";

/** One camera: where it is, how it is turned, and its field of view. */
export interface Frustum {
  position: Vec3;
  /** World from camera, row-major 3×3 (x right, y down, z forward). */
  rotation: readonly number[];
  /** Vertical field of view, radians. */
  fovY: number;
  /** Width over height. */
  aspect: number;
}

/** How the frusta are drawn. */
export interface FrustumView {
  /** Distance from the apex to the base, world units. */
  size: number;
  /** Line and dot colour of each frustum, [r, g, b] 0–255; one for all, or one each. */
  colours: [number, number, number] | [number, number, number][];
  /** The frustum drawn highlighted, or null. */
  highlight: number | null;
  /** [r, g, b] 0–255; absent: cyan. */
  highlightColour?: [number, number, number];
  /** Dot size, px; the highlighted one is twice this. Absent: 6. */
  dotSize?: number;
}

/** Where to put a scene camera to look exactly as a frustum's camera did. */
export interface FrustumPose {
  position: Vec3;
  /** A point straight ahead, one unit away. */
  target: Vec3;
  /** The camera's up (its −y). */
  up: Vec3;
  /** Vertical field of view, degrees, as three.js wants it. */
  fov: number;
}

/** Line vertices per frustum: four edges from the apex, four round the base. */
export const FRUSTUM_LINE_VERTICES = 16;
const HIGHLIGHT: [number, number, number] = [0, 229, 255];
/** How big a dot is in the id pass, px: a click near a camera finds it. */
const PICK_DOT_PX = 16;

/** `rotation` (row-major) times v. */
function turn(r: readonly number[], v: Vec3): Vec3 {
  return [
    (r[0] ?? 0) * v[0] + (r[1] ?? 0) * v[1] + (r[2] ?? 0) * v[2],
    (r[3] ?? 0) * v[0] + (r[4] ?? 0) * v[1] + (r[5] ?? 0) * v[2],
    (r[6] ?? 0) * v[0] + (r[7] ?? 0) * v[1] + (r[8] ?? 0) * v[2],
  ];
}

/** The wireframe of one frustum: 8 segments, 16 xyz vertices. */
export function frustumLines(f: Frustum, size: number): Float32Array {
  const h = size * Math.tan(f.fovY / 2);
  const w = h * f.aspect;
  const [px, py, pz] = f.position;
  const corner = (x: number, y: number): Vec3 => {
    const d = turn(f.rotation, [x, y, size]);
    return [px + d[0], py + d[1], pz + d[2]];
  };
  // top-left, top-right, bottom-right, bottom-left (y down)
  const c = [corner(-w, -h), corner(w, -h), corner(w, h), corner(-w, h)];
  const out = new Float32Array(FRUSTUM_LINE_VERTICES * 3);
  let k = 0;
  const put = (p: Vec3) => {
    out.set(p, k);
    k += 3;
  };
  for (const q of c) {
    put(f.position);
    put(q);
  }
  for (let i = 0; i < 4; i++) {
    put(c[i] as Vec3);
    put(c[(i + 1) % 4] as Vec3);
  }
  return out;
}

/** The scene-camera pose that sees as frustum `f` did. */
export function poseOf(f: Frustum): FrustumPose {
  const fwd = turn(f.rotation, [0, 0, 1]);
  const [x, y, z] = f.position;
  return {
    position: [x, y, z],
    target: [x + fwd[0], y + fwd[1], z + fwd[2]],
    up: turn(f.rotation, [0, -1, 0]),
    fov: (f.fovY * 180) / Math.PI,
  };
}

const VERT = /* glsl */ `
  attribute vec3 colour;
  attribute float aBig;
  uniform float uDot;
  varying vec3 vColour;
  ${CLIP_VERT_PARS}
  void main() {
    vColour = colour;
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = uDot * (1.0 + aBig);
    gl_Position = projectionMatrix * mvPosition;
    ${CLIP_VERT}
  }
`;

const FRAG = /* glsl */ `
  precision highp float;
  uniform int uRound;
  varying vec3 vColour;
  ${CLIP_FRAG_PARS}
  void main() {
    ${CLIP_FRAG}
    if (uRound == 1 && length(gl_PointCoord - 0.5) > 0.5) discard;
    gl_FragColor = vec4(vColour, 1.0);
  }
`;

const PICK_HEAD = /* glsl */ `
  attribute float aIndex;
  uniform float uBase;
  uniform float uPickDot;
  flat varying float vId;
`;
const PICK_MAIN = /* glsl */ `
  vId = uBase + aIndex;
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = uPickDot;
  gl_Position = projectionMatrix * mvPosition;
`;

export class FrustumLayer implements Pickable {
  readonly object = new Group();
  readonly count: number;
  private readonly lines: LineSegments;
  private readonly dots: Points;
  private readonly lineMaterial: ShaderMaterial;
  private readonly dotMaterial: ShaderMaterial;
  private readonly idMaterial: ShaderMaterial;
  private readonly base: number;
  private size = Number.NaN;

  constructor(
    private readonly frusta: readonly Frustum[],
    view: FrustumView,
    private readonly pickIds: PickIds = NO_PICK_IDS,
  ) {
    for (const [i, f] of frusta.entries())
      if (f.rotation.length !== 9 || !(f.fovY > 0) || !(f.aspect > 0))
        throw new Problem("frusta.bad_frustum", `frustum ${i} is malformed`, { index: i });
    this.count = frusta.length;
    this.object.name = "Frusta";
    const n = this.count;

    const lg = new BufferGeometry();
    lg.setAttribute("position", new Float32BufferAttribute(new Float32Array(n * 48), 3));
    lg.setAttribute("colour", new Float32BufferAttribute(new Float32Array(n * 48), 3));
    lg.setAttribute("aBig", new Float32BufferAttribute(new Float32Array(n * 16), 1));
    const li = new Float32Array(n * FRUSTUM_LINE_VERTICES);
    for (let i = 0; i < n; i++)
      li.fill(i, i * FRUSTUM_LINE_VERTICES, (i + 1) * FRUSTUM_LINE_VERTICES);
    lg.setAttribute("aIndex", new Float32BufferAttribute(li, 1));

    const dg = new BufferGeometry();
    const apex = new Float32Array(n * 3);
    for (const [i, f] of frusta.entries()) apex.set(f.position, i * 3);
    dg.setAttribute("position", new Float32BufferAttribute(apex, 3));
    dg.setAttribute("colour", new Float32BufferAttribute(new Float32Array(n * 3), 3));
    dg.setAttribute("aBig", new Float32BufferAttribute(new Float32Array(n), 1));
    dg.setAttribute(
      "aIndex",
      new Float32BufferAttribute(
        Float32Array.from({ length: n }, (_, i) => i),
        1,
      ),
    );

    const material = (round: boolean) =>
      new ShaderMaterial({
        vertexShader: VERT,
        fragmentShader: FRAG,
        uniforms: { uDot: { value: 6 }, uRound: { value: round ? 1 : 0 } },
        clipping: true,
      });
    this.lineMaterial = material(false);
    this.dotMaterial = material(true);
    this.base = pickIds.take(n);
    this.idMaterial = pickMaterial({
      vertexHead: PICK_HEAD,
      vertexMain: PICK_MAIN,
      fragmentHead: "flat varying float vId;",
      idExpr: "vId",
      uniforms: { uBase: { value: this.base }, uPickDot: { value: PICK_DOT_PX } },
    });
    this.lines = new LineSegments(lg, this.lineMaterial);
    this.dots = new Points(dg, this.dotMaterial);
    for (const o of [this.lines, this.dots]) o.frustumCulled = false;
    this.object.add(this.lines, this.dots);
    this.apply(view);
  }

  /** Draw the frusta as this view says. */
  apply(view: FrustumView) {
    const n = this.count;
    if (view.size !== this.size) {
      this.size = view.size;
      const pos = this.lines.geometry.getAttribute("position") as Float32BufferAttribute;
      const arr = pos.array as Float32Array;
      for (const [i, f] of this.frusta.entries()) arr.set(frustumLines(f, view.size), i * 48);
      pos.needsUpdate = true;
    }
    const one = !Array.isArray(view.colours[0]);
    const hl = view.highlightColour ?? HIGHLIGHT;
    const lc = this.lines.geometry.getAttribute("colour") as Float32BufferAttribute;
    const lb = this.lines.geometry.getAttribute("aBig") as Float32BufferAttribute;
    const dc = this.dots.geometry.getAttribute("colour") as Float32BufferAttribute;
    const db = this.dots.geometry.getAttribute("aBig") as Float32BufferAttribute;
    const lcol = lc.array as Float32Array;
    const dcol = dc.array as Float32Array;
    for (let i = 0; i < n; i++) {
      const own = one
        ? (view.colours as [number, number, number])
        : ((view.colours as [number, number, number][])[i] ?? [255, 255, 255]);
      const big = view.highlight === i;
      const c = big ? hl : own;
      const rgb = [c[0] / 255, c[1] / 255, c[2] / 255];
      for (let v = 0; v < FRUSTUM_LINE_VERTICES; v++)
        lcol.set(rgb, (i * FRUSTUM_LINE_VERTICES + v) * 3);
      (lb.array as Float32Array).fill(
        big ? 1 : 0,
        i * FRUSTUM_LINE_VERTICES,
        (i + 1) * FRUSTUM_LINE_VERTICES,
      );
      dcol.set(rgb, i * 3);
      (db.array as Float32Array)[i] = big ? 1 : 0;
    }
    for (const a of [lc, lb, dc, db]) a.needsUpdate = true;
    const dot = view.dotSize ?? 6;
    for (const m of [this.lineMaterial, this.dotMaterial]) {
      const slot = m.uniforms.uDot;
      if (slot) slot.value = dot;
    }
  }

  /** Where to put a scene camera to see as frustum `index` did; null for no such frustum. */
  viewFrom(index: number): FrustumPose | null {
    const f = this.frusta[index];
    return f ? poseOf(f) : null;
  }

  /** The line vertices drawn now, xyz interleaved, 16 per frustum. */
  get lineVertices(): Float32Array {
    return this.lines.geometry.getAttribute("position").array as Float32Array;
  }

  /** The line colours drawn now, rgb 0–1, 16 per frustum. */
  get lineColours(): Float32Array {
    return this.lines.geometry.getAttribute("colour").array as Float32Array;
  }

  setClip(planes: readonly Plane[] | null, intersect: boolean) {
    applyClip(
      [this.lineMaterial, this.dotMaterial, this.idMaterial] as Material[],
      planes,
      intersect,
    );
  }

  enterPick(_pass: PickPass = "id") {
    this.lines.material = this.idMaterial;
    this.dots.material = this.idMaterial;
  }

  exitPick() {
    this.lines.material = this.lineMaterial;
    this.dots.material = this.dotMaterial;
  }

  resolvePick(id: number): PickTarget | null {
    const i = id - this.base;
    return i >= 0 && i < this.count ? { kind: "element", index: i } : null;
  }

  dispose() {
    this.pickIds.give(this.base, this.count);
    this.lines.geometry.dispose();
    this.dots.geometry.dispose();
    this.lineMaterial.dispose();
    this.dotMaterial.dispose();
    this.idMaterial.dispose();
  }
}
