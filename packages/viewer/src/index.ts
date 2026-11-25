// three.js layers the apps share: a point cloud, a mesh, blocks, the value
// shader they colour through, GPU picking, section planes, a layer host that
// ties them together, a legend and a measurement. Framework-free, and named
// for no app's domain. The Viewer that draws them is each app's own.
//
// This file is the whole public surface (`index.test.ts` pins it). The
// package's subpaths — `./value`, `./picking`, `./section`, `./direction`,
// `./host`, `./legend`, `./measure`, `./colormap` — are views of the same
// names, never more.

export const PACKAGE = "@geokit/viewer" as const;

export {
  BLUE_ORANGE,
  buildLut,
  type Colormap,
  CYCLE,
  EMBER,
  luminance,
  OKABE_ITO,
  sampleColormap,
  symmetricRange,
  unpackHex,
  VIRIDIS,
} from "./colormap";
export { directionAngles, planeAttitude, planeNormal, sectionDirection } from "./direction";
export {
  type HostRenderer,
  type Layer,
  LayerHost,
  type LayerHostOptions,
  type PickHit,
  type PickRead,
} from "./host";
export { BlockLayer, type BlockSource } from "./layers/blocks";
export {
  type ChoosableNode,
  type CloudColour,
  type CloudNodePoints,
  type CloudNodeState,
  type CloudSource,
  type CloudView,
  chooseNodes,
  PointCloudLayer,
} from "./layers/cloud";
export {
  MeshLayer,
  type MeshMode,
  type MeshPlace,
  type MeshSource,
  type MeshView,
} from "./layers/mesh";
export {
  applyValue,
  CONTINUOUS_LUT_SIZE,
  gpuValue,
  gpuValues,
  isMissing,
  KEEP_TEST,
  Luts,
  lutTexture,
  MAX_BREAKS,
  MISSING_BELOW,
  MISSING_GLSL,
  MISSING_ON_GPU,
  MISSING_RGB,
  NO_CLASS_ABOVE,
  setUniform,
  type Uniforms,
  VALUE_HEAD,
  VALUE_HIDDEN_VERT,
  VALUE_PICK_HEAD,
  type ValueUniforms,
  type ValueView,
  valueColour,
  valueHidden,
  valueUniforms,
} from "./layers/value";
export {
  buildLegend,
  formatTick,
  gradientCss,
  type LegendDocument,
  type LegendInput,
  type LegendModel,
  type LegendOptions,
  legendModel,
  linearTicks,
  logTicks,
  type Swatch,
  type Tick,
} from "./legend";
export { type Leg, MeasureLine, type Measurement, measure, nearestVertex } from "./measure";
export {
  applyClip,
  CLIP_FRAG,
  CLIP_FRAG_PARS,
  CLIP_VERT,
  CLIP_VERT_PARS,
  decodePick,
  encodePick,
  hideWhatHasNoIds,
  NO_PICK_IDS,
  PICK_ENCODE,
  type Pickable,
  PickIdPool,
  type PickIds,
  type PickMaterialOptions,
  type PickPass,
  type PickTarget,
  pickMaterial,
  toClipPlane,
} from "./picking";
export { Problem, type ProblemParam } from "./problem";
export {
  atPosition,
  boxPlanes,
  clipBox,
  dot,
  keeps,
  niceStep,
  originAlong,
  planeCrossing,
  positionRange,
  readingSign,
  type SectionGeometry,
  type SectionKeep,
  type SectionSpec,
  sectionPlane,
  sectionPlanes,
  sectionPosition,
  sectionRight,
  sectionSpec,
  sectionUp,
} from "./section";
export type { Bounds, SectionPlane, Vec3 } from "./types";
