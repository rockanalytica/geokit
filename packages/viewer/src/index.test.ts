// The public surface, written out. A name added or removed here is a decision
// about the package's API (and its version), not a side effect of a refactor.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const SURFACE = [
  "BLUE_ORANGE",
  "BlockLayer",
  "CLIP_FRAG",
  "CLIP_FRAG_PARS",
  "CLIP_VERT",
  "CLIP_VERT_PARS",
  "CONTINUOUS_LUT_SIZE",
  "CYCLE",
  "EMBER",
  "KEEP_TEST",
  "LayerHost",
  "Luts",
  "MAX_BREAKS",
  "MISSING_BELOW",
  "MISSING_GLSL",
  "MISSING_ON_GPU",
  "MISSING_RGB",
  "MeasureLine",
  "MeshLayer",
  "NO_CLASS_ABOVE",
  "NO_PICK_IDS",
  "OKABE_ITO",
  "PACKAGE",
  "PICK_ENCODE",
  "PickIdPool",
  "PointCloudLayer",
  "Problem",
  "VALUE_HEAD",
  "VALUE_HIDDEN_VERT",
  "VALUE_PICK_HEAD",
  "VIRIDIS",
  "applyClip",
  "applyValue",
  "atPosition",
  "boxPlanes",
  "buildLegend",
  "buildLut",
  "chooseNodes",
  "clipBox",
  "decodePick",
  "directionAngles",
  "dot",
  "encodePick",
  "formatTick",
  "gpuValue",
  "gpuValues",
  "gradientCss",
  "hideWhatHasNoIds",
  "isMissing",
  "keeps",
  "legendModel",
  "linearTicks",
  "logTicks",
  "luminance",
  "lutTexture",
  "measure",
  "nearestVertex",
  "niceStep",
  "originAlong",
  "pickMaterial",
  "planeAttitude",
  "planeCrossing",
  "planeNormal",
  "positionRange",
  "readingSign",
  "sampleColormap",
  "sectionDirection",
  "sectionPlane",
  "sectionPlanes",
  "sectionPosition",
  "sectionRight",
  "sectionSpec",
  "sectionUp",
  "setUniform",
  "symmetricRange",
  "toClipPlane",
  "unpackHex",
  "valueColour",
  "valueHidden",
  "valueUniforms",
];

describe("the public surface", () => {
  it("is exactly this", async () => {
    expect(Object.keys(await import("./index")).sort()).toEqual([...SURFACE].sort());
  });

  it("holds every name a subpath export holds, so a subpath is only a shorter way in", async () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      exports: Record<string, string>;
    };
    const index = new Set(Object.keys(await import("./index")));
    const subpaths = Object.entries(pkg.exports).filter(([k]) => k !== ".");
    expect(subpaths.length).toBeGreaterThanOrEqual(8);
    for (const [path, file] of subpaths) {
      const mod = (await import(
        /* @vite-ignore */ new URL(`../${file}`, import.meta.url).href
      )) as Record<string, unknown>;
      for (const name of Object.keys(mod)) expect(index.has(name), `${path}: ${name}`).toBe(true);
    }
  });

  it("is reachable by every subpath the package says", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      exports: Record<string, string>;
    };
    expect(Object.keys(pkg.exports).sort()).toEqual(
      [
        ".",
        "./colormap",
        "./direction",
        "./host",
        "./legend",
        "./measure",
        "./picking",
        "./section",
        "./value",
      ].sort(),
    );
  });
});
