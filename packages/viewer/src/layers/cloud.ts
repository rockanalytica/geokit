// A point cloud: COPC octree nodes streamed as the camera asks
// for them, under a point budget. Each Viewport chooses its own nodes before
// it renders: from the root down, nearest detail first, a node kept while
// its parent's point spacing still spans more than a pixel on screen, until
// the budget is spent. Nodes are additive — each level holds points of its
// own — so whatever of a choice has loaded is drawn, and the picture sharpens
// as the rest arrives. Nodes no Viewport is drawing are dropped once twice
// the budget is loaded.
//
// Points colour by their own colour, or through the shared value shader by
// intensity, classification or elevation — the same GPU path as every other
// value-coloured layer, filter and class mask included.
//
// Precision: positions are float32 on the GPU, so they are scene-local — a
// scene origin near the data — and a point is exact to about 2⁻²³ of its
// distance from that origin: 1 mm at 10 km, 1 cm at 100 km. Far from the
// origin the cloud shivers as the camera moves; move the origin, not the
// points. `zOrigin` is added back in the shader, in float32 too, so an
// elevation is good to about a millimetre per 10 km of height.
//
// Picking reaches a single point. The 24-bit ids of a pick pass cannot give
// each of millions of points one, so a node takes one id and a second pass
// draws each point's index within its node (`gl_VertexID`): the host reads
// the node, then the index. A node holds under 2²⁴ points for that.

import {
  Box3,
  BufferAttribute,
  BufferGeometry,
  DataTexture,
  Float32BufferAttribute,
  Frustum,
  Group,
  Matrix4,
  type OrthographicCamera,
  type PerspectiveCamera,
  type Plane,
  Points,
  RGBAFormat,
  ShaderMaterial,
  UnsignedByteType,
  Vector3,
} from "three";
import {
  applyClip,
  CLIP_FRAG,
  CLIP_FRAG_PARS,
  CLIP_VERT,
  CLIP_VERT_PARS,
  NO_PICK_IDS,
  type PickIds,
  type PickPass,
  type PickTarget,
  pickMaterial,
} from "../picking";
import { Problem } from "../problem";
import {
  applyValue,
  Luts,
  VALUE_HEAD,
  VALUE_PICK_HEAD,
  type ValueUniforms,
  valueUniforms,
} from "./value";

/** A node's points, scene-local, as the loader hands them over. */
export interface CloudNodePoints {
  count: number;
  positions: Float32Array;
  intensity: Float32Array;
  classification: Float32Array;
  /** rgb 0–255; null where the cloud has no colour. */
  colour: Uint8Array | null;
}

export interface CloudSource {
  /** The octree's cube, scene-local: min xyz, then max xyz. */
  cube: [number, number, number, number, number, number];
  /** Point spacing at the root; each level halves it. */
  spacing: number;
  /** Every node, by COPC key "D-X-Y-Z". `pointCount` is the source's claim, used to plan a choice. */
  nodes: { key: string; depth: number; x: number; y: number; z: number; pointCount: number }[];
  /** Read and decode one node's points. */
  load: (key: string) => Promise<CloudNodePoints>;
  /** Added to a point's z for its elevation: the scene origin's z. */
  zOrigin: number;
}

export type CloudColour = "rgb" | "intensity" | "classification" | "elevation";

/** One Viewport's drawing of the cloud. */
export interface CloudView {
  colourBy: CloudColour;
  colourRange: [number, number];
  filterRange: [number, number];
  /** Shown by LAS class number, which is a byte (categorical). */
  classMask: boolean[];
  /** The Colormap's stops, and how it places values; absent: the default. */
  colours?: [number, number, number][];
  /** Colours by LAS class number; absent: the default categorical set. */
  classColours?: [number, number, number][];
  log?: boolean;
  steps?: number;
  breaks?: number[];
  /** Point size, px. */
  size: number;
  /** Most points drawn at once. */
  budget: number;
  /**
   * Coloured by classification: how far from the point's own colour towards
   * its class colour, 0–1. Absent: 1, the class colour alone.
   */
  blend?: number;
  /** Coloured by classification: a class that keeps the point's own colour, unblended. */
  ownColourClass?: number;
  /** Classes drawn dimmed (a fifth of their brightness), by LAS class number, in any colouring. */
  dim?: boolean[];
  /** What marked points are drawn in, [r, g, b] 0–255; absent: orange. See `mark`. */
  markColour?: [number, number, number];
}

/** How bright a dimmed class is drawn. */
export const DIMMED = 0.15;
const MARK: [number, number, number] = [255, 140, 0];

const MODE: Record<CloudColour, number> = {
  rgb: 0,
  intensity: 1,
  classification: 2,
  elevation: 3,
};

// What the colour pass and the two id passes share of the vertex shader, so a
// point is placed and sized the same in all three.
const POINT_ATTRIBUTES = /* glsl */ `
  attribute float intensity;
  attribute float classification;
  uniform int uMode;
  uniform float uZ0;
  uniform float uSize;
  varying float vValue;
`;
const POINT_PLACE = /* glsl */ `
  vValue = uMode == 1 ? intensity : uMode == 2 ? classification : position.z + uZ0;
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = uSize;
  gl_Position = projectionMatrix * mvPosition;
`;

const VERT = /* glsl */ `
  ${POINT_ATTRIBUTES}
  attribute vec3 colour;
  attribute float mark;
  varying vec3 vColour;
  varying float vClass;
  varying float vMark;
  ${CLIP_VERT_PARS}
  void main() {
    vColour = colour;
    vClass = classification;
    vMark = mark;
    ${POINT_PLACE}
    ${CLIP_VERT}
  }
`;

const FRAG = /* glsl */ `
  precision highp float;
  ${VALUE_HEAD}
  uniform int uMode;
  uniform float uBlend;
  uniform float uOwnClass;
  uniform sampler2D uDim;
  uniform float uDimSize;
  uniform vec3 uMarkColour;
  varying float vValue;
  varying vec3 vColour;
  varying float vClass;
  varying float vMark;
  ${CLIP_FRAG_PARS}
  void main() {
    ${CLIP_FRAG}
    if (length(gl_PointCoord - 0.5) > 0.5) discard;
    if (uMode != 0 && valueHidden(vValue)) discard;
    vec3 rgb;
    if (uMode == 0) rgb = vColour;
    else if (uMode == 2) {
      float b = abs(vClass - uOwnClass) < 0.5 ? 0.0 : uBlend;
      rgb = mix(vColour, valueColour(vValue).rgb, b);
    } else rgb = valueColour(vValue).rgb;
    float c = floor(vClass + 0.5);
    if (c >= 0.0 && c < uDimSize && texture2D(uDim, vec2((c + 0.5) / uDimSize, 0.5)).r > 0.5)
      rgb *= ${DIMMED.toFixed(2)};
    if (vMark > 0.5) rgb = uMarkColour;
    gl_FragColor = vec4(rgb, 1.0);
  }
`;

/** What the id passes do of the colour pass's discards: a point drawn round, a hidden one not drawn. */
const PICK_FRAGMENT = /* glsl */ `
  if (length(gl_PointCoord - 0.5) > 0.5) discard;
  if (uMode != 0 && valueHidden(vValue)) discard;
`;

/** Loads under way at once. */
const MAX_LOADING = 4;
/** First wait before a node that failed is asked for again; doubled each failure. */
const RETRY_FIRST_MS = 1000;
const RETRY_LAST_MS = 30_000;
/** The most points a node can hold and still be told apart point by point. */
const MAX_NODE_POINTS = 2 ** 24 - 1;

export type CloudNodeState = "idle" | "loading" | "loaded" | "failed";

interface Node {
  key: string;
  depth: number;
  /** The source's claim: what a choice plans with, until the node has loaded. */
  pointCount: number;
  box: Box3;
  children: Node[];
  state: CloudNodeState;
  points: Points | null;
  /** Points actually decoded and held: what residency counts. */
  count: number;
  positions: Float32Array | null;
  /** Its pick id, while it is held. */
  pickId: number;
  failures: number;
  retryAt: number;
  error: Error | null;
  /** The last choice that kept it, for eviction. */
  used: number;
}

// ---- Choosing nodes --------------------------------------------------------

/** What a choice needs of a node: its place in the tree, its size and its box. */
export interface ChoosableNode<N> {
  depth: number;
  pointCount: number;
  box: Box3;
  children: readonly N[];
}

/** A binary max-heap by priority. */
class Heap<T> {
  private readonly items: { item: T; p: number }[] = [];
  get size() {
    return this.items.length;
  }
  push(item: T, p: number) {
    const a = this.items;
    let i = a.push({ item, p }) - 1;
    while (i > 0) {
      const up = (i - 1) >> 1;
      const parent = a[up];
      const here = a[i];
      if (!parent || !here || parent.p >= here.p) break;
      a[up] = here;
      a[i] = parent;
      i = up;
    }
  }
  pop(): T | undefined {
    const a = this.items;
    const top = a[0];
    const last = a.pop();
    if (!top || !last) return top?.item;
    if (a.length > 0) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let big = i;
        if (l < a.length && (a[l]?.p ?? -Infinity) > (a[big]?.p ?? -Infinity)) big = l;
        if (r < a.length && (a[r]?.p ?? -Infinity) > (a[big]?.p ?? -Infinity)) big = r;
        if (big === i) break;
        const x = a[i];
        const y = a[big];
        if (!x || !y) break;
        a[i] = y;
        a[big] = x;
        i = big;
      }
    }
    return top.item;
  }
}

const scratchFrustum = new Frustum();
const scratchMatrix = new Matrix4();
const scratchEye = new Vector3();

/**
 * The nodes a camera should see, nearest detail first, within the budget.
 * From the root down, the node with most pixels between its points first; a
 * node is opened only while its own points are still apart on screen. A node
 * outside the view, or one `skip` names, is passed over with everything under
 * it. `spacing` is the root's point spacing; each level halves it.
 */
export function chooseNodes<N extends ChoosableNode<N>>(
  root: N | null,
  camera: PerspectiveCamera | OrthographicCamera,
  heightPx: number,
  budget: number,
  spacing: number,
  skip?: (box: Box3) => boolean,
): N[] {
  if (!root) return [];
  camera.updateMatrixWorld();
  scratchMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  scratchFrustum.setFromProjectionMatrix(scratchMatrix);
  camera.getWorldPosition(scratchEye);
  const gap = (n: N) => spacing / 2 ** n.depth;
  // how many pixels a world unit covers: under a perspective it falls off
  // with distance, under a parallel projection it is the same everywhere,
  // so a node is chosen on its spacing alone
  let onScreen: (n: N) => number;
  if ("isOrthographicCamera" in camera) {
    const world = Math.max(1e-6, (camera.top - camera.bottom) / camera.zoom);
    const k = heightPx / world;
    onScreen = (n) => gap(n) * k;
  } else {
    const k = heightPx / (2 * Math.tan((camera.fov * Math.PI) / 360));
    onScreen = (n) => (gap(n) * k) / Math.max(1e-6, n.box.distanceToPoint(scratchEye));
  }
  const out: N[] = [];
  let total = 0;
  const open = new Heap<N>();
  open.push(root, Infinity);
  for (let n = open.pop(); n; n = open.pop()) {
    if (!scratchFrustum.intersectsBox(n.box)) continue;
    if (skip?.(n.box)) continue;
    if (total + n.pointCount > budget && out.length > 0) continue;
    out.push(n);
    total += n.pointCount;
    // finer detail only while this level's points are still apart on screen
    if (onScreen(n) <= 1) continue;
    for (const c of n.children) open.push(c, onScreen(c));
  }
  return out;
}

/** Whether a box lies wholly behind a plane (n·p + d < 0 for every point of it). */
function behind(box: Box3, plane: Plane): boolean {
  const n = plane.normal;
  const x = n.x > 0 ? box.max.x : box.min.x;
  const y = n.y > 0 ? box.max.y : box.min.y;
  const z = n.z > 0 ? box.max.z : box.min.z;
  return n.x * x + n.y * y + n.z * z + plane.constant < 0;
}

/** What `decode` found wrong with a node's arrays, or null. */
function badNode(pts: CloudNodePoints): string | null {
  const n = pts.count;
  if (!Number.isInteger(n) || n < 0 || n > MAX_NODE_POINTS) return `${n} points`;
  if (pts.positions.length !== n * 3) return `${pts.positions.length} position values for ${n}`;
  if (pts.intensity.length !== n) return `${pts.intensity.length} intensities for ${n}`;
  if (pts.classification.length !== n) return `${pts.classification.length} classes for ${n}`;
  if (pts.colour && pts.colour.length !== n * 3)
    return `${pts.colour.length} colour bytes for ${n}`;
  return null;
}

// ---- The layer -------------------------------------------------------------

const DEFAULT_VIEWPORT = Symbol("viewport");

export class PointCloudLayer {
  readonly object = new Group();
  /** Pick by node, then by point: see `resolvePick`. */
  readonly needsDetail = true;
  private readonly luts = new Luts();
  private readonly uniforms: ValueUniforms & {
    uMode: { value: number };
    uZ0: { value: number };
    uSize: { value: number };
  };
  private readonly look: {
    uBlend: { value: number };
    uOwnClass: { value: number };
    uDim: { value: DataTexture };
    uDimSize: { value: number };
    uMarkColour: { value: [number, number, number] };
  };
  /** Marked points by node key, as `mark` was told; applied as a node lands. */
  private readonly marks = new Map<string, ArrayLike<number>>();
  private readonly material: ShaderMaterial;
  private readonly idMaterial: ShaderMaterial;
  private readonly detailMaterial: ShaderMaterial;
  private readonly root: Node | null;
  private readonly byKey = new Map<string, Node>();
  private readonly byPickId = new Map<number, Node>();
  private dimmed: boolean[] = [];
  private loadingCount = 0;
  private loadedPoints = 0;
  private choice = 0;
  private budget = 0;
  private disposed = false;
  private picking: PickPass | null = null;
  private clip: { planes: Plane[]; intersect: boolean } | null = null;
  /** Each Viewport's latest choice: what it may be drawing, so what is not dropped. */
  private readonly chosenBy = new Map<unknown, Set<Node>>();
  /** Called when a node lands, so the Viewer draws again. */
  onChange: () => void = () => {};
  /** Called when a node fails to load or is found wrong; it is asked for again after a wait. */
  onError: (key: string, error: Error) => void = (key, error) =>
    console.error(`Point Cloud node ${key}:`, error);

  constructor(
    readonly source: CloudSource,
    private readonly pickIds: PickIds = NO_PICK_IDS,
    /** The clock the retry wait runs on, ms. */
    private readonly now: () => number = () => Date.now(),
  ) {
    this.object.name = "Point Cloud";
    this.uniforms = {
      ...valueUniforms(this.luts),
      uMode: { value: 0 },
      uZ0: { value: source.zOrigin },
      uSize: { value: 2 },
    };
    this.look = {
      uBlend: { value: 1 },
      uOwnClass: { value: NO_OWN_CLASS },
      uDim: { value: dimTexture([]) },
      uDimSize: { value: 0 },
      uMarkColour: { value: [MARK[0] / 255, MARK[1] / 255, MARK[2] / 255] },
    };
    this.material = new ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: { ...this.uniforms, ...this.look },
      clipping: true,
    });
    const idPass = (idExpr: string) =>
      pickMaterial({
        vertexHead: `${POINT_ATTRIBUTES} varying float vIndex;`,
        vertexMain: `vIndex = float(gl_VertexID); ${POINT_PLACE}`,
        fragmentHead: `${VALUE_PICK_HEAD} uniform int uMode; varying float vValue; varying float vIndex;`,
        fragmentMain: PICK_FRAGMENT,
        idExpr,
        // the colour pass's own slots: one filter, one class mask, one size
        uniforms: this.uniforms,
      });
    this.idMaterial = idPass("uId");
    this.detailMaterial = idPass("vIndex");
    const [x0, y0, z0, x1, y1, z1] = source.cube;
    for (const n of source.nodes) {
      const s = 2 ** n.depth;
      const w = [(x1 - x0) / s, (y1 - y0) / s, (z1 - z0) / s] as const;
      const min = new Vector3(x0 + n.x * w[0], y0 + n.y * w[1], z0 + n.z * w[2]);
      const box = new Box3(min, min.clone().add(new Vector3(w[0], w[1], w[2])));
      this.byKey.set(n.key, {
        key: n.key,
        depth: n.depth,
        pointCount: n.pointCount,
        box,
        children: [],
        state: "idle",
        points: null,
        count: 0,
        positions: null,
        pickId: 0,
        failures: 0,
        retryAt: 0,
        error: null,
        used: -1,
      });
    }
    for (const n of source.nodes) {
      if (n.depth === 0) continue;
      const parent = this.byKey.get(`${n.depth - 1}-${n.x >> 1}-${n.y >> 1}-${n.z >> 1}`);
      const child = this.byKey.get(n.key);
      if (parent && child) parent.children.push(child);
    }
    this.root = this.byKey.get("0-0-0-0") ?? null;
  }

  /** Points loaded and held, as decoded, for the panel. */
  get resident(): number {
    return this.loadedPoints;
  }

  /** Where a node stands; "idle" for a key the cloud does not have. */
  stateOf(key: string): CloudNodeState {
    return this.byKey.get(key)?.state ?? "idle";
  }

  /** The nodes that failed and are waiting to be asked for again. */
  get failed(): { key: string; error: Error; failures: number; retryAt: number }[] {
    const out: { key: string; error: Error; failures: number; retryAt: number }[] = [];
    for (const n of this.byKey.values())
      if (n.state === "failed" && n.error)
        out.push({ key: n.key, error: n.error, failures: n.failures, retryAt: n.retryAt });
    return out;
  }

  /**
   * Choose what a Viewport draws of the cloud and ask for what is missing.
   * `heightPx` is the Viewport's height on screen. A Viewport that is shown
   * with others says which it is by `viewport` (any object), so what it draws
   * is not dropped for another's; `forget` it when it closes.
   */
  apply(
    view: CloudView,
    camera: PerspectiveCamera | OrthographicCamera,
    heightPx: number,
    viewport: unknown = DEFAULT_VIEWPORT,
  ) {
    const kind = view.colourBy === "classification" ? "categorical" : "continuous";
    applyValue(
      this.uniforms,
      kind,
      {
        column: "",
        colourRange: view.colourRange,
        filterRange: view.filterRange,
        classMask: view.classMask,
        mip: false,
        ...(view.colours ? { colours: view.colours } : {}),
        ...(view.classColours ? { classColours: view.classColours } : {}),
        ...(view.log === undefined ? {} : { log: view.log }),
        ...(view.steps === undefined ? {} : { steps: view.steps }),
        ...(view.breaks ? { breaks: view.breaks } : {}),
      },
      this.luts,
    );
    this.uniforms.uMode.value = MODE[view.colourBy];
    this.uniforms.uSize.value = Math.max(1, view.size);
    this.look.uBlend.value = Math.min(1, Math.max(0, view.blend ?? 1));
    this.look.uOwnClass.value = view.ownColourClass ?? NO_OWN_CLASS;
    const dim = view.dim ?? [];
    if (!sameFlags(dim, this.dimmed)) {
      this.dimmed = [...dim];
      this.look.uDim.value.dispose();
      this.look.uDim.value = dimTexture(dim);
      this.look.uDimSize.value = dim.some(Boolean) ? dim.length : 0;
    }
    const [mr, mg, mb] = view.markColour ?? MARK;
    this.look.uMarkColour.value = [mr / 255, mg / 255, mb / 255];
    this.budget = view.budget;
    const clip = this.clip;
    const skip = clip
      ? (box: Box3) =>
          clip.intersect
            ? clip.planes.every((p) => behind(box, p))
            : clip.planes.some((p) => behind(box, p))
      : undefined;
    const chosen = chooseNodes(this.root, camera, heightPx, view.budget, this.source.spacing, skip);
    this.choice++;
    this.chosenBy.set(viewport, new Set(chosen));
    for (const n of this.byKey.values()) {
      if (n.points) n.points.visible = false;
    }
    const wanted: Node[] = [];
    const t = this.now();
    for (const n of chosen) {
      n.used = this.choice;
      if (n.points) n.points.visible = true;
      else if (n.state === "idle" || (n.state === "failed" && t >= n.retryAt)) wanted.push(n);
    }
    for (const n of wanted) {
      if (this.loadingCount >= MAX_LOADING) break;
      this.load(n);
    }
    this.evict(view.budget);
  }

  /**
   * Mark points of a node, by their index in it, to be drawn in the view's
   * mark colour (a selection, a preview of what an edit would take); null
   * unmarks the node. Kept for a node not loaded yet, and applied when it lands.
   */
  mark(key: string, indices: ArrayLike<number> | null) {
    if (indices && indices.length > 0) this.marks.set(key, indices);
    else this.marks.delete(key);
    const n = this.byKey.get(key);
    if (n?.points) {
      const a = n.points.geometry.getAttribute("mark") as BufferAttribute;
      (a.array as Uint8Array).set(markFlags(n.count, this.marks.get(key)));
      a.needsUpdate = true;
    }
    this.onChange();
  }

  /** Unmark every node. */
  clearMarks() {
    for (const key of [...this.marks.keys()]) this.mark(key, null);
  }

  /** The mark flags a loaded node draws with (1 marked), or null if it is not loaded. */
  markedIn(key: string): Uint8Array | null {
    const a = this.byKey.get(key)?.points?.geometry.getAttribute("mark");
    return a ? (a.array as Uint8Array) : null;
  }

  /**
   * Replace the classification of a loaded node in place, as when the app's
   * classes change; it is also kept for the node's later loads only if the
   * source's `load` hands it back. False if the node is not loaded or the length is wrong.
   */
  setClassification(key: string, classification: Float32Array): boolean {
    const n = this.byKey.get(key);
    if (!n?.points || classification.length !== n.count) return false;
    const a = n.points.geometry.getAttribute("classification") as BufferAttribute;
    (a.array as Float32Array).set(classification);
    a.needsUpdate = true;
    this.onChange();
    return true;
  }

  /** A Viewport that will not apply again: what only it was drawing may be dropped. */
  forget(viewport: unknown) {
    this.chosenBy.delete(viewport);
  }

  /**
   * Clip by these planes, as the host's section does: a plane clips what is
   * behind it, or with `intersect` only what is behind all of them. Nodes
   * wholly clipped are neither chosen nor loaded.
   */
  setClip(planes: readonly Plane[], intersect: boolean) {
    this.clip = planes.length > 0 ? { planes: [...planes], intersect } : null;
    applyClip(
      [this.material, this.idMaterial, this.detailMaterial],
      this.clip ? this.clip.planes : null,
      intersect,
    );
  }

  private load(n: Node) {
    n.state = "loading";
    this.loadingCount++;
    // asked for now, not a tick later; a loader that throws fails like one that rejects
    let asked: Promise<CloudNodePoints>;
    try {
      asked = this.source.load(n.key);
    } catch (e) {
      asked = Promise.reject(e);
    }
    asked
      .then((pts) => {
        // dropped from the cloud, or the cloud closed, while it was on its way
        if (this.disposed || this.byKey.get(n.key) !== n) return;
        const wrong = badNode(pts);
        if (wrong)
          throw new Problem("cloud.bad_node", `node ${n.key} is malformed: ${wrong}`, {
            key: n.key,
            what: wrong,
          });
        const g = new BufferGeometry();
        g.setAttribute("position", new Float32BufferAttribute(pts.positions, 3));
        g.setAttribute("intensity", new Float32BufferAttribute(pts.intensity, 1));
        g.setAttribute("classification", new Float32BufferAttribute(pts.classification, 1));
        const colour = pts.colour ?? new Uint8Array(pts.count * 3).fill(200);
        g.setAttribute("colour", new BufferAttribute(colour, 3, true));
        g.setAttribute("mark", new BufferAttribute(markFlags(pts.count, this.marks.get(n.key)), 1));
        const points = new Points(g, this.material);
        points.frustumCulled = false;
        points.visible = false;
        n.pickId = this.pickIds.take(1);
        this.byPickId.set(n.pickId, n);
        // one id material serves every node: its id is set as the node is drawn
        points.onBeforeRender = () => {
          if (this.picking !== "id") return;
          const slot = this.idMaterial.uniforms.uId;
          if (slot) slot.value = n.pickId;
          this.idMaterial.uniformsNeedUpdate = true;
        };
        if (this.picking)
          points.material = this.picking === "id" ? this.idMaterial : this.detailMaterial;
        n.points = points;
        n.count = pts.count;
        n.positions = pts.positions;
        n.state = "loaded";
        n.failures = 0;
        n.error = null;
        this.object.add(points);
        this.loadedPoints += n.count;
        // a landing may pass the budget: settle it now, not at the next choice
        this.evict(this.budget);
        this.onChange();
      })
      .catch((e: unknown) => {
        if (this.disposed || this.byKey.get(n.key) !== n) return;
        const error = e instanceof Error ? e : new Error(String(e));
        n.state = "failed";
        n.failures++;
        n.error = error;
        n.retryAt =
          this.now() + Math.min(RETRY_LAST_MS, RETRY_FIRST_MS * 2 ** Math.min(n.failures - 1, 10));
        this.onError(n.key, error);
      })
      .finally(() => {
        this.loadingCount--;
        if (n.state === "loading") n.state = "idle";
      });
  }

  /**
   * Past twice the budget, drop the nodes chosen longest ago — never one in
   * any Viewport's latest choice, which that Viewport may be drawing.
   */
  private evict(budget: number) {
    if (this.loadedPoints <= 2 * budget) return;
    const protectedNodes = new Set<Node>();
    for (const s of this.chosenBy.values()) for (const n of s) protectedNodes.add(n);
    const held = [...this.byKey.values()]
      .filter((n) => n.points && !protectedNodes.has(n))
      .sort((a, b) => a.used - b.used);
    for (const n of held) {
      if (this.loadedPoints <= 2 * budget) break;
      this.drop(n);
    }
  }

  private drop(n: Node) {
    if (!n.points) return;
    this.object.remove(n.points);
    n.points.geometry.dispose();
    this.loadedPoints -= n.count;
    this.byPickId.delete(n.pickId);
    this.pickIds.give(n.pickId, 1);
    n.points = null;
    n.positions = null;
    n.count = 0;
    n.pickId = 0;
    n.state = "idle";
  }

  // ---- Picking ----

  /** Draw ids: the node's, then (`detail`) each point's index in it. */
  enterPick(pass: PickPass = "id") {
    this.picking = pass;
    const m = pass === "id" ? this.idMaterial : this.detailMaterial;
    for (const n of this.byKey.values()) if (n.points) n.points.material = m;
  }

  exitPick() {
    this.picking = null;
    for (const n of this.byKey.values()) if (n.points) n.points.material = this.material;
  }

  /** The node `id` names, and the point `detail` indexes in it. */
  resolvePick(id: number, detail = 0): PickTarget | null {
    const n = this.byPickId.get(id);
    if (!n?.positions || detail < 0 || detail >= n.count) return null;
    const i = Math.floor(detail) * 3;
    return {
      kind: "point",
      node: n.key,
      index: Math.floor(detail),
      position: [n.positions[i] ?? 0, n.positions[i + 1] ?? 0, n.positions[i + 2] ?? 0],
    };
  }

  dispose() {
    this.disposed = true;
    for (const n of [...this.byKey.values()]) this.drop(n);
    this.byKey.clear();
    this.byPickId.clear();
    this.chosenBy.clear();
    this.material.dispose();
    this.idMaterial.dispose();
    this.detailMaterial.dispose();
    this.luts.dispose();
    this.look.uDim.value.dispose();
    this.marks.clear();
  }
}

/** `uOwnClass` when no class keeps its own colour: far from any class number. */
const NO_OWN_CLASS = -1e9;

/** One texel per class, red 255 where the class is dimmed. */
function dimTexture(dim: readonly boolean[]): DataTexture {
  const size = Math.max(1, dim.length);
  const data = new Uint8Array(size * 4);
  for (let i = 0; i < dim.length; i++) data[i * 4] = dim[i] ? 255 : 0;
  const tex = new DataTexture(data, size, 1, RGBAFormat, UnsignedByteType);
  tex.needsUpdate = true;
  return tex;
}

function sameFlags(a: readonly boolean[], b: readonly boolean[]): boolean {
  return a.length === b.length && a.every((x, i) => Boolean(x) === Boolean(b[i]));
}

/** One byte per point, 1 where `indices` names it; indices out of range are passed over. */
export function markFlags(count: number, indices: ArrayLike<number> | undefined): Uint8Array {
  const out = new Uint8Array(count);
  if (indices)
    for (let i = 0; i < indices.length; i++) {
      const k = indices[i] ?? -1;
      if (k >= 0 && k < count) out[k] = 1;
    }
  return out;
}

/**
 * The colour a point is drawn in when coloured by classification, rgb 0–1,
 * before dimming and marking: the GPU's blend, for tests and for an app that
 * colours a mesh the same way. `classColour` is the class's colour, rgb 0–1.
 */
export function blendColour(
  own: [number, number, number],
  classColour: [number, number, number],
  blend: number,
): [number, number, number] {
  const b = Math.min(1, Math.max(0, blend));
  return [
    own[0] + (classColour[0] - own[0]) * b,
    own[1] + (classColour[1] - own[1]) * b,
    own[2] + (classColour[2] - own[2]) * b,
  ];
}
