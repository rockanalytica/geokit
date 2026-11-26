// The playground: the one place the shaders actually run. A synthetic Point
// Cloud, a Mesh, a field of Blocks and a ring of camera Frusta, drawn through
// a LayerHost, under a Section or a clip box, picked with the mouse, with a
// legend, a measuring line and a lasso (alt-drag) that marks points. `?selftest` runs the checks a headless browser can read
// back (see `selftest`), and writes them into #result.

import {
  AmbientLight,
  DirectionalLight,
  IcosahedronGeometry,
  PerspectiveCamera,
  Scene,
  WebGLRenderer,
} from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import "../../ui/src/tokens.css";
import {
  atPosition,
  BLUE_ORANGE,
  BlockLayer,
  buildLegend,
  type CloudNodePoints,
  type CloudSource,
  type Colormap,
  CYCLE,
  clipBox,
  EMBER,
  type Frustum,
  FrustumLayer,
  insideLasso,
  LassoPath,
  LayerHost,
  legendModel,
  MeasureLine,
  MeshLayer,
  measure,
  type PickHit,
  PointCloudLayer,
  type SectionSpec,
  sectionSpec,
  simplifyPath,
  type ValueView,
  type Vec2,
  type Vec3,
  VIRIDIS,
} from "../src/index";

const errors: string[] = [];
for (const level of ["error", "warn"] as const) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    errors.push(`${level}: ${args.map(String).join(" ")}`);
    original(...args);
  };
}
window.addEventListener("error", (e) => errors.push(`uncaught: ${e.message}`));

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

// ---- Synthetic data --------------------------------------------------------

/** A repeatable pseudo-random sequence, so every run draws the same scene. */
function random(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

const terrain = (x: number, y: number) => 6 * Math.sin(x / 11) * Math.cos(y / 13);

/** An octree over a 100 m cube: a coarse root and eight children of finer points. */
function cloudSource(): CloudSource {
  const nodes: CloudSource["nodes"] = [
    { key: "0-0-0-0", depth: 0, x: 0, y: 0, z: 0, pointCount: 3000 },
  ];
  for (let i = 0; i < 8; i++) {
    const [x, y, z] = [i & 1, (i >> 1) & 1, (i >> 2) & 1];
    nodes.push({ key: `1-${x}-${y}-${z}`, depth: 1, x, y, z, pointCount: 6000 });
  }
  const load = async (key: string): Promise<CloudNodePoints> => {
    const pts = await make(key);
    if (key === "0-0-0-0") rootPositions = pts.positions;
    return pts;
  };
  const make = async (key: string): Promise<CloudNodePoints> => {
    await new Promise((r) => setTimeout(r, 30));
    const [depth, ix, iy, iz] = key.split("-").map(Number) as [number, number, number, number];
    const n = depth === 0 ? 3000 : 6000;
    const rand = random(1 + ix + 2 * iy + 4 * iz + 8 * depth);
    const positions = new Float32Array(n * 3);
    const intensity = new Float32Array(n);
    const classification = new Float32Array(n);
    const colour = new Uint8Array(n * 3);
    for (let i = 0; i < n; i++) {
      const w = depth === 0 ? 100 : 50;
      const x = (depth === 0 ? -50 : -50 + ix * 50) + rand() * w;
      const y = (depth === 0 ? -50 : -50 + iy * 50) + rand() * w;
      const z = terrain(x, y) + (rand() - 0.5) * 0.4;
      positions.set([x, y, z], i * 3);
      intensity[i] = 40 + 160 * rand();
      classification[i] = z > 3 ? 5 : z > -3 ? 2 : 1;
      colour.set([120 + z * 10, 160, 120 - z * 8], i * 3);
    }
    return { count: n, positions, intensity, classification, colour };
  };
  return { cube: [-50, -50, -50, 50, 50, 50], spacing: 3, nodes, load, zOrigin: 0 };
}

function blocks(): { centres: Float32Array; values: Float32Array; count: number } {
  const [nx, ny, nz] = [16, 16, 6];
  const centres = new Float32Array(nx * ny * nz * 3);
  const values = new Float32Array(nx * ny * nz);
  let k = 0;
  for (let i = 0; i < nx; i++)
    for (let j = 0; j < ny; j++)
      for (let l = 0; l < nz; l++) {
        centres.set([-45 + i * 5, -45 + j * 5 - 60, -15 + l * 5], k * 3);
        // a smooth field, with a gap of missing values
        values[k] =
          i === 3 && j === 3 ? Number.NaN : 50 + 40 * Math.sin(i / 3) * Math.cos(j / 4) + l * 5;
        k++;
      }
  return { centres, values, count: k };
}

// ---- The scene --------------------------------------------------------------

const view = $("view");
const renderer = new WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
renderer.setClearColor(0x1f1f23);
view.append(renderer.domElement);
const scene = new Scene();
scene.add(new AmbientLight(0xffffff, 1.2), new DirectionalLight(0xffffff, 1.5));
const camera = new PerspectiveCamera(45, 1, 0.5, 2000);
camera.up.set(0, 0, 1);
camera.position.set(90, -140, 80);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, -20, 0);

const host = new LayerHost(renderer, scene);

const cloud = host.add(new PointCloudLayer(cloudSource(), host.ids));
cloud.onChange = () => (needsDraw = true);

const ico = new IcosahedronGeometry(12, 2);
const mesh = host.add(
  new MeshLayer(
    {
      vertices: Float32Array.from(ico.getAttribute("position").array),
      faces: Uint32Array.from({ length: ico.getAttribute("position").count }, (_, i) => i),
    },
    { colour: "#4aa3df", opacity: 0.9, mode: "smooth" },
    host.ids,
  ),
);
mesh.setOffset([20, 20, 25]);

const field = blocks();
const maps: Record<string, Colormap> = {
  Ember: EMBER,
  Viridis: VIRIDIS,
  "Blue-Orange": BLUE_ORANGE,
  Cycle: CYCLE,
};
const blockView = (colours: Colormap): ValueView => ({
  column: "value",
  colourRange: [10, 130],
  filterRange: [Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY],
  classMask: [],
  mip: false,
  colours: colours.colors,
});
const blockLayer = host.add(
  new BlockLayer(
    { centres: field.centres, sizes: [4.5, 4.5, 4.5], values: field.values, kind: "continuous" },
    blockView(EMBER),
    host.ids,
  ),
);

const line = new MeasureLine();
scene.add(line.object);

/** Twelve cameras on a ring 60 m up, each looking at the middle. */
function ring(): Frustum[] {
  const out: Frustum[] = [];
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * 2 * Math.PI;
    const p: Vec3 = [80 * Math.cos(a), 80 * Math.sin(a), 60];
    // z forward towards the middle, x right along the ring, y down = z × x
    const len = Math.hypot(p[0], p[1], p[2]);
    const z: Vec3 = [-p[0] / len, -p[1] / len, -p[2] / len];
    const x: Vec3 = [-Math.sin(a), Math.cos(a), 0];
    const y: Vec3 = [
      z[1] * x[2] - z[2] * x[1],
      z[2] * x[0] - z[0] * x[2],
      z[0] * x[1] - z[1] * x[0],
    ];
    out.push({
      position: p,
      rotation: [x[0], y[0], z[0], x[1], y[1], z[1], x[2], y[2], z[2]],
      fovY: 0.8,
      aspect: 1.5,
    });
  }
  return out;
}
const frustumView = (highlight: number | null) => ({
  size: 8,
  colours: [255, 204, 0] as [number, number, number],
  highlight,
});
const frusta = host.add(new FrustumLayer(ring(), frustumView(null), host.ids));

const lasso = new LassoPath();
scene.add(lasso.object);
/** The root node's positions, kept to lasso them. */
let rootPositions: Float32Array | null = null;

// ---- Controls ---------------------------------------------------------------

let needsDraw = true;
let colormap: Colormap = EMBER;
const picked: Vec3[] = [];

/** The selftest's second look: by class, blended half way, class 5 dimmed. */
let byClass = false;
const cloudView = () => ({
  ...(byClass
    ? {
        colourBy: "classification" as const,
        blend: 0.5,
        ownColourClass: 1,
        dim: [false, false, false, false, false, true],
      }
    : { colourBy: "elevation" as const }),
  colourRange: [-8, 8] as [number, number],
  filterRange: [Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY] as [number, number],
  classMask: [],
  colours: colormap.colors,
  size: 3,
  budget: 60_000,
});

function section(): SectionSpec | null {
  const keep = $<HTMLSelectElement>("keep").value;
  if (keep === "none") return null;
  if (keep === "box-in" || keep === "box-out") {
    const v = Number($<HTMLInputElement>("position").value);
    const box = { min: [v - 40, -110, -50] as Vec3, max: [v + 40, 50, 50] as Vec3 };
    return clipBox(box, keep === "box-in" ? "inside" : "outside");
  }
  const g = {
    centre: [0, 0, 0] as Vec3,
    azimuth: Number($<HTMLInputElement>("azimuth").value),
    plunge: Number($<HTMLInputElement>("plunge").value),
    step: 10,
  };
  const at = atPosition(g, Number($<HTMLInputElement>("position").value));
  return sectionSpec(at, keep as "behind" | "front" | "band");
}

function refresh() {
  host.setSection(section());
  blockLayer.apply(blockView(colormap));
  const legend = $("legend");
  legend.replaceChildren(
    buildLegend(document, legendModel({ kind: "continuous", view: blockView(colormap) }), {
      caption: "Value (blocks)",
    }),
  );
  needsDraw = true;
}
for (const id of ["keep", "azimuth", "plunge", "position"])
  $(id).addEventListener("input", refresh);
$("map").addEventListener("input", () => {
  colormap = maps[$<HTMLSelectElement>("map").value] ?? EMBER;
  refresh();
});
controls.addEventListener("change", () => (needsDraw = true));

function describe(hit: PickHit | null): string {
  if (!hit) return "nothing";
  const t = hit.target;
  if (t.kind === "point")
    return `point ${t.index} of node ${t.node} at ${t.position.map((c) => c.toFixed(1)).join(", ")}`;
  if (t.kind === "element" && hit.layer === frusta) return `camera ${t.index}`;
  if (t.kind === "element")
    return `block ${t.index} at ${(blockLayer.block(t.index)?.centre ?? []).join(", ")}`;
  return t.kind;
}

function where(hit: PickHit | null): Vec3 | null {
  if (!hit) return null;
  if (hit.target.kind === "point") return hit.target.position;
  if (hit.target.kind === "element") return blockLayer.block(hit.target.index)?.centre ?? null;
  return null;
}

renderer.domElement.addEventListener("click", (e) => {
  if (e.altKey) return;
  const rect = renderer.domElement.getBoundingClientRect();
  const hit = host.pickAt(e.clientX - rect.left, e.clientY - rect.top, camera);
  $("status").textContent = `picked ${describe(hit)}`;
  frusta.apply(
    frustumView(hit?.layer === frusta && hit.target.kind === "element" ? hit.target.index : null),
  );
  needsDraw = true;
  const p = where(hit);
  if (p && e.shiftKey) {
    picked.push(p);
    line.set(picked);
    const m = measure(picked);
    $("status").textContent += `\nline ${m.total.toFixed(1)} m in ${m.legs.length} legs`;
    needsDraw = true;
  }
});

/** Mark the root node's points inside a loop of screen points. */
function lassoMark(loop: Vec2[]) {
  if (!rootPositions) return 0;
  camera.updateMatrixWorld();
  const vp = camera.projectionMatrix.clone().multiply(camera.matrixWorldInverse).elements;
  const inside = insideLasso(
    rootPositions,
    vp,
    simplifyPath(loop),
    view.clientWidth,
    view.clientHeight,
  );
  cloud.mark("0-0-0-0", inside);
  needsDraw = true;
  return inside.length;
}

let drawing: Vec2[] | null = null;
renderer.domElement.addEventListener("pointerdown", (e) => {
  if (!e.altKey || e.button !== 0) return;
  controls.enabled = false;
  drawing = [[e.offsetX, e.offsetY]];
});
renderer.domElement.addEventListener("pointermove", (e) => {
  if (!drawing) return;
  drawing.push([e.offsetX, e.offsetY]);
  lasso.set(drawing, view.clientWidth, view.clientHeight);
  needsDraw = true;
});
renderer.domElement.addEventListener("pointerup", () => {
  if (!drawing) return;
  $("status").textContent = `lasso marked ${lassoMark(drawing)} points`;
  drawing = null;
  controls.enabled = true;
  lasso.set([], 1, 1);
});

function resize() {
  const w = view.clientWidth;
  const h = view.clientHeight;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  needsDraw = true;
}
window.addEventListener("resize", resize);

function frame() {
  controls.update();
  if (needsDraw) {
    needsDraw = false;
    cloud.apply(cloudView(), camera, renderer.domElement.clientHeight);
    renderer.render(scene, camera);
  }
  requestAnimationFrame(frame);
}

resize();
refresh();
requestAnimationFrame(frame);
$("status").textContent = "ready";

// ---- The self-test ------------------------------------------------------------

/**
 * What a headless browser can check of the shaders: the programs linked with
 * no error logged, and a grid of picks found a block, a point and the mesh,
 * each as the layer that drew it, and nothing under a section that clips it.
 */
async function selftest() {
  await new Promise((r) => setTimeout(r, 1500));
  needsDraw = true;
  await new Promise((r) => setTimeout(r, 300));
  const kinds = new Map<string, number>();
  const sweep = () => {
    kinds.clear();
    const w = renderer.domElement.clientWidth;
    const h = renderer.domElement.clientHeight;
    for (let y = 4; y < h; y += Math.max(4, Math.floor(h / 40))) {
      for (let x = 4; x < w; x += Math.max(4, Math.floor(w / 60))) {
        const hit = host.pickAt(x, y, camera);
        const k = hit ? hit.target.kind : "none";
        kinds.set(k, (kinds.get(k) ?? 0) + 1);
      }
    }
    return Object.fromEntries(kinds);
  };
  const open = sweep();
  // keep only what lies behind a plane through the middle, and sweep again
  $<HTMLSelectElement>("keep").value = "box-in";
  refresh();
  const boxed = sweep();
  // and with the box cut out instead: only what lies outside it stays
  $<HTMLSelectElement>("keep").value = "box-out";
  refresh();
  const cutOut = sweep();
  $<HTMLSelectElement>("keep").value = "none";
  refresh();
  // the second look, a lasso round the middle and a highlighted camera, drawn once
  byClass = true;
  const w = view.clientWidth;
  const h = view.clientHeight;
  const loop: Vec2[] = [
    [w * 0.3, h * 0.3],
    [w * 0.7, h * 0.3],
    [w * 0.7, h * 0.7],
    [w * 0.3, h * 0.7],
  ];
  lasso.set(loop, w, h);
  const marked = lassoMark(loop);
  frusta.apply(frustumView(3));
  needsDraw = true;
  await new Promise((r) => setTimeout(r, 300));
  const cameras = sweep().element ?? 0;
  const gl = renderer.getContext();
  const programs = renderer.info.programs?.length ?? 0;
  $("result").textContent = JSON.stringify({
    ok: errors.length === 0,
    errors,
    programs,
    open,
    boxed,
    cutOut,
    resident: cloud.resident,
    marked,
    cameras,
    glError: gl.getError(),
  });
  document.body.dataset.done = "1";
}
if (new URLSearchParams(location.search).has("selftest")) void selftest();
