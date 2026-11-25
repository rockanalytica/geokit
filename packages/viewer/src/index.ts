// three.js layers the apps share: a point cloud, a mesh, the value shader
// they colour through, GPU picking and section planes. Framework-free, and
// named for no app's domain. The Viewer that draws them is each app's own.

export const PACKAGE = "@geokit/viewer" as const;

export {
  buildLut,
  type Colormap,
  EMBER,
  luminance,
  OKABE_ITO,
  unpackHex,
} from "./colormap";
export { directionAngles, planeAttitude, planeNormal, sectionDirection } from "./direction";
export {
  type CloudColour,
  type CloudNodePoints,
  type CloudSource,
  type CloudView,
  PointCloudLayer,
} from "./layers/cloud";
export { MeshLayer, type MeshMode, type MeshSource, type MeshView } from "./layers/mesh";
export { MISSING_RGB, type ValueView } from "./layers/value";
export {
  decodePick,
  hideWhatHasNoIds,
  NO_PICK_IDS,
  type Pickable,
  PickIdPool,
  type PickIds,
  type PickTarget,
} from "./picking";
export { Problem, type ProblemParam } from "./problem";
export {
  atPosition,
  niceStep,
  originAlong,
  planeCrossing,
  positionRange,
  readingSign,
  type SectionGeometry,
  type SectionKeep,
  sectionPlane,
  sectionPlanes,
  sectionPosition,
  sectionRight,
  sectionUp,
  type Vec3,
} from "./section";
export type { Bounds, SectionPlane } from "./types";
