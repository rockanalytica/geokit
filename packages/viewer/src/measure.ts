// Measuring along a polyline of picked points: each leg's length and
// direction, in the conventions of `direction.ts` (Z up, Y north, azimuth
// clockwise from north, plunge below the horizontal, down positive), and the
// total length. Pure maths, plus a small three.js object that draws the line.

import {
  BufferGeometry,
  Float32BufferAttribute,
  Group,
  Line,
  LineBasicMaterial,
  Points,
  PointsMaterial,
} from "three";
import { directionAngles } from "./direction";
import type { Vec3 } from "./types";
import { length, sub } from "./vec";

export interface Leg {
  from: Vec3;
  to: Vec3;
  length: number;
  /** Degrees clockwise from north, 0–360; 0 for a leg of no length or a vertical one. */
  azimuth: number;
  /** Degrees below the horizontal, −90 (straight up) to 90 (straight down); 0 for no length. */
  plunge: number;
  /** How far along the line this leg ends: the running total. */
  along: number;
}

export interface Measurement {
  legs: Leg[];
  /** The length of the whole line. */
  total: number;
}

/** Each leg of the line through `points` in order, and the total. Fewer than two points: no legs, 0. */
export function measure(points: readonly Vec3[]): Measurement {
  const legs: Leg[] = [];
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const from = points[i - 1] as Vec3;
    const to = points[i] as Vec3;
    const d = sub(to, from);
    const len = length(d);
    total += len;
    const { azimuth, plunge } = len > 0 ? directionAngles(d) : { azimuth: 0, plunge: 0 };
    legs.push({ from, to, length: len, azimuth, plunge, along: total });
  }
  return { legs, total };
}

/**
 * The vertex nearest to `p` among xyz triples interleaved in `vertices`,
 * within `maxDistance` if one is given; null if none is. A straight scan:
 * for a mesh of millions, snap on a decimated copy or a pick's own node.
 */
export function nearestVertex(
  vertices: ArrayLike<number>,
  p: Vec3,
  maxDistance = Number.POSITIVE_INFINITY,
): { index: number; position: Vec3; distance: number } | null {
  let best = -1;
  let bestSq = maxDistance * maxDistance;
  for (let i = 0; i + 2 < vertices.length; i += 3) {
    const dx = (vertices[i] ?? 0) - p[0];
    const dy = (vertices[i + 1] ?? 0) - p[1];
    const dz = (vertices[i + 2] ?? 0) - p[2];
    const sq = dx * dx + dy * dy + dz * dz;
    if (sq <= bestSq) {
      bestSq = sq;
      best = i / 3;
    }
  }
  if (best < 0) return null;
  const i = best * 3;
  return {
    index: best,
    position: [vertices[i] ?? 0, vertices[i + 1] ?? 0, vertices[i + 2] ?? 0],
    distance: Math.sqrt(bestSq),
  };
}

/** The line drawn: segments between the points and a dot at each, over everything else. */
export class MeasureLine {
  readonly object = new Group();
  private readonly line = new Line(
    new BufferGeometry(),
    new LineBasicMaterial({ depthTest: false }),
  );
  private readonly dots = new Points(
    new BufferGeometry(),
    new PointsMaterial({ size: 6, sizeAttenuation: false, depthTest: false }),
  );

  constructor(colour = "#ffd400") {
    this.object.name = "Measurement";
    for (const o of [this.line, this.dots]) {
      o.frustumCulled = false;
      o.renderOrder = 999;
    }
    this.object.add(this.line, this.dots);
    this.setColour(colour);
  }

  setColour(colour: string) {
    (this.line.material as LineBasicMaterial).color.set(colour);
    (this.dots.material as PointsMaterial).color.set(colour);
  }

  /** Draw the line through these points; none draws nothing. */
  set(points: readonly Vec3[]) {
    const xyz = new Float32Array(points.length * 3);
    for (const [i, p] of points.entries()) xyz.set(p, i * 3);
    for (const o of [this.line, this.dots]) {
      o.geometry.dispose();
      o.geometry = new BufferGeometry();
      o.geometry.setAttribute("position", new Float32BufferAttribute(xyz, 3));
    }
    this.object.visible = points.length > 0;
  }

  dispose() {
    for (const o of [this.line, this.dots]) {
      o.geometry.dispose();
      (o.material as LineBasicMaterial | PointsMaterial).dispose();
    }
  }
}
