// The small vector helpers the viewer's modules share. Internal: the kit's
// public surface exports `Vec3` (a type) and `dot` only.

import type { Vec3 } from "./types";

export const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

export const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

export const length = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);

/** The vector scaled to length 1; a zero vector stays zero. */
export const unit = (a: Vec3): Vec3 => {
  const n = length(a) || 1;
  return [a[0] / n, a[1] / n, a[2] / n];
};

export const rad = (deg: number): number => (deg * Math.PI) / 180;
export const deg = (r: number): number => (r * 180) / Math.PI;
