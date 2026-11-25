// The shapes the layers share with whatever Viewer draws them.

/** A box, scene-local: min xyz, then max xyz. */
export interface Bounds {
  min: [number, number, number];
  max: [number, number, number];
}

export interface SectionPlane {
  /** Unit normal, scene-local. Points on the kept side satisfy n·p + d ≥ 0. */
  normal: [number, number, number];
  distance: number;
}
