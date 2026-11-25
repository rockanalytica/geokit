// The shapes the layers share with whatever Viewer draws them.

/** x, y, z, scene-local unless said otherwise. Z up, Y north. */
export type Vec3 = [number, number, number];

/** A box, scene-local: min xyz, then max xyz. */
export interface Bounds {
  min: Vec3;
  max: Vec3;
}

export interface SectionPlane {
  /** Unit normal, scene-local. Points on the kept side satisfy n·p + d ≥ 0. */
  normal: Vec3;
  distance: number;
}
