// Sections: a plane in any direction, faced from one
// side. Its direction is the way it is looked at — an azimuth clockwise from
// north and a plunge below the horizontal, as a camera's — so it has a Front,
// the side the viewer stands on, and a Behind, the far side. Scene-local
// coordinates, Z up, Y north.

import { sectionDirection } from "./direction";
import type { Bounds, SectionPlane, Vec3 } from "./types";
import { cross, dot, unit } from "./vec";

// kept for callers of the subpath: the types and `dot` live in one place each
export type { Vec3 };
export { dot };

/** What a Section keeps: one side of the plane, or a band half a step either side of it. */
export type SectionKeep = "front" | "behind" | "band";

export interface SectionGeometry {
  /** A point on the plane, scene-local: where its outline is centred. */
  centre: Vec3;
  /** Degrees clockwise from north of the direction the plane is looked at. */
  azimuth: number;
  /** Degrees below the horizontal of that direction: 90 looks straight down. */
  plunge: number;
  /** Spacing to the next Section of a series, metres; a band is half of it either side. */
  step: number;
}

/**
 * Up on screen when the Section is faced: the vertical as it lies in the
 * plane, or north for a level, whose plane holds no vertical. There is no
 * roll to choose.
 */
export function sectionUp(d: Vec3): Vec3 {
  const pick: Vec3 = Math.abs(d[2]) > 0.9999 ? [0, 1, 0] : [0, 0, 1];
  const k = dot(pick, d);
  return unit([pick[0] - k * d[0], pick[1] - k * d[1], pick[2] - k * d[2]]);
}

/** Right on screen when the Section is faced. */
export function sectionRight(d: Vec3, up: Vec3): Vec3 {
  return unit(cross(d, up));
}

/**
 * The clipping planes that keep what a Section keeps: Behind is the side the
 * direction points into, Front the viewer's, Band both within half a step.
 */
export function sectionPlanes(g: SectionGeometry, keep: SectionKeep): SectionPlane[] {
  const d = sectionDirection(g.azimuth, g.plunge);
  const s = dot(d, g.centre);
  const minus: Vec3 = [-d[0], -d[1], -d[2]];
  if (keep === "behind") return [{ normal: d, distance: -s }];
  if (keep === "front") return [{ normal: minus, distance: s }];
  const half = Math.max(0, g.step) / 2;
  return [
    { normal: d, distance: -s + half },
    { normal: minus, distance: s + half },
  ];
}

/** The plane itself, its normal the direction looked along. */
export function sectionPlane(g: SectionGeometry): SectionPlane {
  const d = sectionDirection(g.azimuth, g.plunge);
  return { normal: d, distance: -dot(d, g.centre) };
}

/** How far along its direction a Section sits: the position its slider shows. */
export const sectionPosition = (g: SectionGeometry) =>
  dot(sectionDirection(g.azimuth, g.plunge), g.centre);

/**
 * What the scene's origin adds to a position along a direction: a
 * Section's centre is scene-local, so its position in the world's
 * coordinates is `sectionPosition` plus this.
 */
export const originAlong = (azimuth: number, plunge: number, origin: Vec3): number =>
  dot(sectionDirection(azimuth, plunge), origin);

/**
 * Which way a Section's position is read: along its direction, turned so the
 * axis it lies closest to counts up — eastings for X, northings for Y,
 * elevations for Z — whichever way along it the Section looks.
 */
export function readingSign(azimuth: number, plunge: number): 1 | -1 {
  const d = sectionDirection(azimuth, plunge);
  const k = [1, 2].reduce((a, b) => (Math.abs(d[b] ?? 0) > Math.abs(d[a] ?? 0) ? b : a), 0);
  return (d[k] ?? 0) < 0 ? -1 : 1;
}

/** The Section moved along its direction to `position`. */
export function atPosition<T extends SectionGeometry>(g: T, position: number): T {
  const d = sectionDirection(g.azimuth, g.plunge);
  const by = position - dot(d, g.centre);
  return {
    ...g,
    centre: [g.centre[0] + by * d[0], g.centre[1] + by * d[1], g.centre[2] + by * d[2]],
  };
}

/** The positions a direction takes across a box: the slider's ends. */
export function positionRange(bounds: Bounds, azimuth: number, plunge: number): [number, number] {
  const d = sectionDirection(azimuth, plunge);
  let lo = Infinity;
  let hi = -Infinity;
  for (const x of [bounds.min[0], bounds.max[0]]) {
    for (const y of [bounds.min[1], bounds.max[1]]) {
      for (const z of [bounds.min[2], bounds.max[2]]) {
        const p = dot(d, [x, y, z]);
        lo = Math.min(lo, p);
        hi = Math.max(hi, p);
      }
    }
  }
  return [lo, hi];
}

/** A twentieth of `extent`, rounded to 1, 2 or 5 of a power of ten: a Section's first step. */
export function niceStep(extent: number): number {
  const raw = Math.abs(extent) / 20;
  if (!Number.isFinite(raw) || raw <= 0) return 10;
  const p = 10 ** Math.floor(Math.log10(raw));
  const m = raw / p;
  return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p;
}

/**
 * Where a mesh crosses a plane, as line segments: xyz pairs interleaved. A
 * vertex exactly on the plane counts as in front of it, so a triangle
 * touching the plane at one corner gives no segment of zero length, and one
 * lying in it gives none at all.
 */
export function planeCrossing(
  vertices: Float32Array,
  faces: Uint32Array,
  plane: SectionPlane,
): Float32Array {
  const [a, b, c] = plane.normal;
  // each vertex's side once, then the faces counted, then the output filled
  // to its exact size: no growing array, no second copy
  const nv = Math.floor(vertices.length / 3);
  const side = new Float32Array(nv);
  for (let v = 0; v < nv; v++)
    side[v] =
      a * (vertices[v * 3] ?? 0) +
      b * (vertices[v * 3 + 1] ?? 0) +
      c * (vertices[v * 3 + 2] ?? 0) +
      plane.distance;
  const crossed = (f: number): boolean => {
    const s0 = (side[faces[f] ?? 0] ?? 0) >= 0;
    const s1 = (side[faces[f + 1] ?? 0] ?? 0) >= 0;
    const s2 = (side[faces[f + 2] ?? 0] ?? 0) >= 0;
    // a triangle is crossed on exactly two edges, or none
    return !(s0 === s1 && s1 === s2);
  };
  let n = 0;
  for (let f = 0; f + 2 < faces.length; f += 3) if (crossed(f)) n++;
  const out = new Float32Array(n * 6);
  let o = 0;
  const at = (i: number, j: number) => {
    const si = side[i] ?? 0;
    const t = si / (si - (side[j] ?? 0));
    for (let k = 0; k < 3; k++) {
      const p = vertices[i * 3 + k] ?? 0;
      out[o++] = p + t * ((vertices[j * 3 + k] ?? 0) - p);
    }
  };
  for (let f = 0; f + 2 < faces.length; f += 3) {
    if (!crossed(f)) continue;
    const v = [faces[f] ?? 0, faces[f + 1] ?? 0, faces[f + 2] ?? 0] as const;
    for (let e = 0; e < 3; e++) {
      const i = v[e] ?? 0;
      const j = v[(e + 1) % 3] ?? 0;
      if ((side[i] ?? 0) >= 0 !== (side[j] ?? 0) >= 0) at(i, j);
    }
  }
  return out;
}

/**
 * What a layer host clips and cuts by. `planes` clip what lies behind any
 * one of them (n·p + d < 0); with `intersect` they clip only what lies behind
 * all of them at once, so a box's planes cut the box out instead of
 * keeping it. `cut` is the plane a Mesh is drawn crossing, in Section view.
 */
export interface SectionSpec {
  planes: SectionPlane[];
  intersect: boolean;
  cut: SectionPlane | null;
}

/** A Section's spec: its planes for what it keeps, and itself as the cut. */
export function sectionSpec(g: SectionGeometry, keep: SectionKeep): SectionSpec {
  return { planes: sectionPlanes(g, keep), intersect: false, cut: sectionPlane(g) };
}

/**
 * The six planes of a box, normals pointing in, so what is inside is kept; or
 * pointing out (`outward`), so what is behind all six at once is the box.
 */
export function boxPlanes(box: Bounds, outward = false): SectionPlane[] {
  const { min, max } = box;
  const planes: SectionPlane[] = [
    { normal: [1, 0, 0], distance: -min[0] },
    { normal: [-1, 0, 0], distance: max[0] },
    { normal: [0, 1, 0], distance: -min[1] },
    { normal: [0, -1, 0], distance: max[1] },
    { normal: [0, 0, 1], distance: -min[2] },
    { normal: [0, 0, -1], distance: max[2] },
  ];
  return outward
    ? planes.map((p) => ({
        normal: [-p.normal[0], -p.normal[1], -p.normal[2]],
        distance: -p.distance,
      }))
    : planes;
}

/** A clip box: only what is inside it drawn, or only what is outside. No Mesh cut. */
export function clipBox(box: Bounds, keep: "inside" | "outside"): SectionSpec {
  // outside: the box is what lies behind all six outward planes, and only that is clipped
  return { planes: boxPlanes(box, keep === "outside"), intersect: keep === "outside", cut: null };
}

/** Whether a point is drawn under a spec, as the GPU will decide it. */
export function keeps(spec: Pick<SectionSpec, "planes" | "intersect">, p: Vec3): boolean {
  const behind = spec.planes.map((q) => dot(q.normal, p) + q.distance < 0);
  return spec.intersect ? !behind.every(Boolean) : !behind.some(Boolean);
}
