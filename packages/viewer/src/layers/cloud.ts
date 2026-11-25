// A point cloud: COPC octree nodes streamed as the camera asks
// for them, under a point budget. Each Viewport chooses its own nodes before
// it renders: from the root down, nearest detail first, a node kept while
// its parent's point spacing still spans more than a pixel on screen, until
// the budget is spent. Nodes are additive — each level holds points of its
// own — so whatever of a choice has loaded is drawn, and the picture sharpens
// as the rest arrives. Nodes no Viewport has chosen for a while are dropped
// once twice the budget is loaded.
//
// Points colour by their own colour, or through the shared value shader by
// intensity, classification or elevation — the same GPU path as every other
// value-coloured layer, filter and class mask included.

import {
  Box3,
  BufferAttribute,
  BufferGeometry,
  Float32BufferAttribute,
  Frustum,
  Group,
  Matrix4,
  type OrthographicCamera,
  type PerspectiveCamera,
  Points,
  ShaderMaterial,
  Vector3,
} from "three";
import { applyValue, Luts, setUniform, VALUE_HEAD, valueUniforms } from "./value";

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
  /** Every node, by COPC key "D-X-Y-Z". */
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
}

const MODE: Record<CloudColour, number> = {
  rgb: 0,
  intensity: 1,
  classification: 2,
  elevation: 3,
};

const VERT = /* glsl */ `
  attribute float intensity;
  attribute float classification;
  attribute vec3 colour;
  uniform int uMode;
  uniform float uZ0;
  uniform float uSize;
  varying float vValue;
  varying vec3 vColour;
  #include <clipping_planes_pars_vertex>
  void main() {
    vValue = uMode == 1 ? intensity : uMode == 2 ? classification : position.z + uZ0;
    vColour = colour;
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = uSize;
    gl_Position = projectionMatrix * mvPosition;
    #include <clipping_planes_vertex>
  }
`;

const FRAG = /* glsl */ `
  precision highp float;
  ${VALUE_HEAD}
  uniform int uMode;
  varying float vValue;
  varying vec3 vColour;
  #include <clipping_planes_pars_fragment>
  void main() {
    #include <clipping_planes_fragment>
    if (length(gl_PointCoord - 0.5) > 0.5) discard;
    if (uMode != 0 && valueHidden(vValue)) discard;
    vec3 rgb = uMode == 0 ? vColour : valueColour(vValue).rgb;
    gl_FragColor = vec4(rgb, 1.0);
  }
`;

/** Loads under way at once. */
const MAX_LOADING = 4;
/** Choices a node is kept after its last, so up to this many Viewports share one cloud. */
const RECENT = 4;

interface Node {
  key: string;
  depth: number;
  pointCount: number;
  box: Box3;
  children: Node[];
  points: Points | null;
  loading: boolean;
  /** The last choice that kept it, for eviction. */
  used: number;
}

export class PointCloudLayer {
  readonly object = new Group();
  private readonly luts = new Luts();
  private readonly uniforms = valueUniforms(this.luts);
  private readonly material: ShaderMaterial;
  private readonly root: Node | null;
  private readonly byKey = new Map<string, Node>();
  private loadingCount = 0;
  private loadedPoints = 0;
  private choice = 0;
  private readonly frustum = new Frustum();
  private readonly m = new Matrix4();
  private readonly eye = new Vector3();
  /** Called when a node lands, so the Viewer draws again. */
  onChange: () => void = () => {};

  constructor(readonly source: CloudSource) {
    this.object.name = "Point Cloud";
    this.uniforms.uMode = { value: 0 };
    this.uniforms.uZ0 = { value: source.zOrigin };
    this.uniforms.uSize = { value: 2 };
    this.material = new ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: this.uniforms,
      clipping: true,
    });
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
        points: null,
        loading: false,
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

  /** Points loaded and held, for the panel. */
  get resident(): number {
    return this.loadedPoints;
  }

  /**
   * Choose what a Viewport draws of the cloud and ask for what is missing.
   * `heightPx` is the Viewport's height on screen.
   */
  apply(view: CloudView, camera: PerspectiveCamera | OrthographicCamera, heightPx: number) {
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
    setUniform(this.uniforms, "uMode", MODE[view.colourBy]);
    setUniform(this.uniforms, "uSize", Math.max(1, view.size));
    const chosen = this.choose(camera, heightPx, view.budget);
    this.choice++;
    for (const n of this.byKey.values()) {
      if (n.points) n.points.visible = false;
    }
    const wanted: Node[] = [];
    for (const n of chosen) {
      n.used = this.choice;
      if (n.points) n.points.visible = true;
      else if (!n.loading) wanted.push(n);
    }
    for (const n of wanted) {
      if (this.loadingCount >= MAX_LOADING) break;
      this.load(n);
    }
    this.evict(view.budget);
  }

  /** The nodes a camera should see, nearest detail first, within the budget. */
  private choose(
    camera: PerspectiveCamera | OrthographicCamera,
    heightPx: number,
    budget: number,
  ): Node[] {
    if (!this.root) return [];
    camera.updateMatrixWorld();
    this.m.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.m);
    camera.getWorldPosition(this.eye);
    const spacing = (n: Node) => this.source.spacing / 2 ** n.depth;
    // how many pixels a world unit covers: under a perspective it falls off
    // with distance, under a parallel projection it is the same everywhere,
    // so a node is chosen on its spacing alone
    let onScreen: (n: Node) => number;
    if ("isOrthographicCamera" in camera) {
      const world = Math.max(1e-6, (camera.top - camera.bottom) / camera.zoom);
      const k = heightPx / world;
      onScreen = (n) => spacing(n) * k;
    } else {
      const k = heightPx / (2 * Math.tan((camera.fov * Math.PI) / 360));
      onScreen = (n) => (spacing(n) * k) / Math.max(1e-6, n.box.distanceToPoint(this.eye));
    }
    const out: Node[] = [];
    let total = 0;
    const open: { n: Node; p: number }[] = [{ n: this.root, p: Infinity }];
    while (open.length > 0) {
      let best = 0;
      for (let i = 1; i < open.length; i++) if ((open[i]?.p ?? 0) > (open[best]?.p ?? 0)) best = i;
      const next = open.splice(best, 1)[0];
      if (!next) break;
      const { n } = next;
      if (!this.frustum.intersectsBox(n.box)) continue;
      if (total + n.pointCount > budget && out.length > 0) continue;
      out.push(n);
      total += n.pointCount;
      // finer detail only while this level's points are still apart on screen
      const p = onScreen(n);
      if (p <= 1) continue;
      for (const c of n.children) open.push({ n: c, p: onScreen(c) });
    }
    return out;
  }

  private load(n: Node) {
    n.loading = true;
    this.loadingCount++;
    this.source
      .load(n.key)
      .then((pts) => {
        if (!this.byKey.has(n.key)) return;
        const g = new BufferGeometry();
        g.setAttribute("position", new Float32BufferAttribute(pts.positions, 3));
        g.setAttribute("intensity", new Float32BufferAttribute(pts.intensity, 1));
        g.setAttribute("classification", new Float32BufferAttribute(pts.classification, 1));
        const colour = pts.colour ?? new Uint8Array(pts.count * 3).fill(200);
        g.setAttribute("colour", new BufferAttribute(colour, 3, true));
        const points = new Points(g, this.material);
        points.frustumCulled = false;
        points.visible = false;
        n.points = points;
        this.object.add(points);
        this.loadedPoints += n.pointCount;
        this.onChange();
      })
      .catch((e: unknown) => console.error(`Point Cloud node ${n.key}:`, e))
      .finally(() => {
        n.loading = false;
        this.loadingCount--;
      });
  }

  /**
   * Past twice the budget, drop the nodes chosen longest ago — never one
   * chosen in the last few choices, which another Viewport may be drawing.
   */
  private evict(budget: number) {
    if (this.loadedPoints <= 2 * budget) return;
    const held = [...this.byKey.values()]
      .filter((n) => n.points && n.used < this.choice - RECENT)
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
    this.loadedPoints -= n.pointCount;
    n.points = null;
  }

  dispose() {
    for (const n of this.byKey.values()) this.drop(n);
    this.byKey.clear();
    this.material.dispose();
    this.luts.dispose();
  }
}
