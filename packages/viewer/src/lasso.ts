// Lasso: a freehand loop drawn on the screen, and the points inside it.
//
// The loop is a polygon in CSS pixels, y down, as pointer events give it.
// A point is inside when its projection on the screen is, whether or not
// something nearer hides it (the lasso reaches through), and only when it is
// in front of the camera. Pure maths over a flat xyz array, plus a small
// three.js object that draws the loop over everything else.
//
// `viewProjection` is the camera's projection times its view (world to clip
// space), column-major, as three.js's `Matrix4.elements` holds it.

import { BufferGeometry, Float32BufferAttribute, LineLoop, ShaderMaterial } from "three";

/** A screen position, CSS pixels from the top left. */
export type Vec2 = [number, number];

/**
 * The path with no more than `max` vertices, keeping its shape: points are
 * taken evenly along its length. A path already that short is returned as it is.
 */
export function simplifyPath(points: readonly Vec2[], max = 40): Vec2[] {
  if (points.length <= max || max < 3) return points.slice();
  const along = [0];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1] as Vec2;
    const b = points[i] as Vec2;
    along.push((along[i - 1] ?? 0) + Math.hypot(b[0] - a[0], b[1] - a[1]));
  }
  const total = along[along.length - 1] ?? 0;
  if (total === 0) return [points[0] as Vec2];
  const out: Vec2[] = [];
  let j = 0;
  for (let k = 0; k < max; k++) {
    const want = (total * k) / max;
    while (j < points.length - 2 && (along[j + 1] ?? 0) < want) j++;
    const a = points[j] as Vec2;
    const b = points[j + 1] as Vec2;
    const span = (along[j + 1] ?? 0) - (along[j] ?? 0);
    const t = span > 0 ? (want - (along[j] ?? 0)) / span : 0;
    out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
  }
  return out;
}

/** Whether (x, y) is inside the polygon, by the even-odd rule. */
export function insidePolygon(polygon: readonly Vec2[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i] as Vec2;
    const [xj, yj] = polygon[j] as Vec2;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * The index of every point, of the xyz triples in `positions`, whose screen
 * position lies inside `polygon` on a view `width` × `height` px: hidden or
 * not, but never behind the camera. In ascending order.
 */
export function insideLasso(
  positions: ArrayLike<number>,
  viewProjection: ArrayLike<number>,
  polygon: readonly Vec2[],
  width: number,
  height: number,
): Uint32Array {
  if (polygon.length < 3) return new Uint32Array(0);
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of polygon) {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  const m = Array.from({ length: 16 }, (_, i) => viewProjection[i] ?? 0);
  const [m0, m1, , m3, m4, m5, , m7, m8, m9, , m11, m12, m13, , m15] = m as number[];
  const out: number[] = [];
  const n = Math.floor(positions.length / 3);
  for (let i = 0; i < n; i++) {
    const px = positions[i * 3] ?? 0;
    const py = positions[i * 3 + 1] ?? 0;
    const pz = positions[i * 3 + 2] ?? 0;
    const w = (m3 ?? 0) * px + (m7 ?? 0) * py + (m11 ?? 0) * pz + (m15 ?? 0);
    if (!(w > 0)) continue;
    const cx = ((m0 ?? 0) * px + (m4 ?? 0) * py + (m8 ?? 0) * pz + (m12 ?? 0)) / w;
    const cy = ((m1 ?? 0) * px + (m5 ?? 0) * py + (m9 ?? 0) * pz + (m13 ?? 0)) / w;
    const sx = ((cx + 1) / 2) * width;
    const sy = ((1 - cy) / 2) * height;
    if (sx < x0 || sx > x1 || sy < y0 || sy > y1) continue;
    if (insidePolygon(polygon, sx, sy)) out.push(i);
  }
  return Uint32Array.from(out);
}

const VERT = /* glsl */ `
  uniform vec2 uViewport;
  void main() {
    // CSS px, y down, to clip space
    vec2 ndc = vec2(position.x / uViewport.x * 2.0 - 1.0, 1.0 - position.y / uViewport.y * 2.0);
    gl_Position = vec4(ndc, 0.0, 1.0);
  }
`;
const FRAG = /* glsl */ `
  precision highp float;
  uniform vec3 uColour;
  void main() { gl_FragColor = vec4(uColour, 1.0); }
`;

/** The loop drawn as it is being made, in screen pixels, over everything else. */
export class LassoPath {
  readonly object: LineLoop;
  private readonly material: ShaderMaterial;

  constructor(colour: [number, number, number] = [255, 140, 0]) {
    this.material = new ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uViewport: { value: [1, 1] },
        uColour: { value: [colour[0] / 255, colour[1] / 255, colour[2] / 255] },
      },
      depthTest: false,
      depthWrite: false,
    });
    this.object = new LineLoop(new BufferGeometry(), this.material);
    this.object.name = "Lasso";
    this.object.frustumCulled = false;
    this.object.renderOrder = 1000;
    this.object.visible = false;
  }

  /** Draw the loop through these screen points on a view `width` × `height` px; none hides it. */
  set(points: readonly Vec2[], width: number, height: number) {
    const xyz = new Float32Array(points.length * 3);
    for (const [i, p] of points.entries()) xyz.set([p[0], p[1], 0], i * 3);
    this.object.geometry.dispose();
    this.object.geometry = new BufferGeometry();
    this.object.geometry.setAttribute("position", new Float32BufferAttribute(xyz, 3));
    const slot = this.material.uniforms.uViewport;
    if (slot) slot.value = [Math.max(1, width), Math.max(1, height)];
    this.object.visible = points.length > 1;
  }

  /** The screen points drawn now. */
  get points(): Vec2[] {
    const a = this.object.geometry.getAttribute("position");
    if (!a) return [];
    const out: Vec2[] = [];
    for (let i = 0; i < a.count; i++) out.push([a.getX(i), a.getY(i)]);
    return out;
  }

  dispose() {
    this.object.geometry.dispose();
    this.material.dispose();
  }
}
