// A missing value reaches the GPU as a finite sentinel, never as NaN: ANGLE's
// Direct3D backend does not reliably keep `v != v`. A GPU cannot be run here,
// so these pin the conversion and that no shader asks the NaN test again.

import { describe, expect, it } from "vitest";
import {
  gpuValue,
  gpuValues,
  MISSING_BELOW,
  MISSING_GLSL,
  MISSING_ON_GPU,
  VALUE_HEAD,
  VALUE_PICK_HEAD,
} from "./value";

describe("a column as the GPU gets it", () => {
  it("replaces each NaN by one finite sentinel below the missing threshold", () => {
    const out = gpuValues([1.5, Number.NaN, -2, Number.NaN]);
    expect(Number.isFinite(MISSING_ON_GPU)).toBe(true);
    expect(MISSING_ON_GPU).toBeLessThan(MISSING_BELOW);
    expect(Math.fround(MISSING_ON_GPU)).toBeLessThan(MISSING_BELOW);
    expect([...out]).toEqual([1.5, Math.fround(MISSING_ON_GPU), -2, Math.fround(MISSING_ON_GPU)]);
    expect(out.some(Number.isNaN)).toBe(false);
  });

  it("keeps real values, including infinities and zero, as they are", () => {
    expect([...gpuValues([0, -0, 0.5, -1024, Infinity])]).toEqual([0, -0, 0.5, -1024, Infinity]);
    expect(gpuValue(3)).toBe(3);
    expect(gpuValue(Number.NaN)).toBe(MISSING_ON_GPU);
  });

  it("leaves the array it was given alone", () => {
    const given = Float64Array.of(1, Number.NaN);
    gpuValues(given);
    expect(Number.isNaN(given[1])).toBe(true);
  });

  it("is a threshold a half-missing face still crosses", () => {
    // a corner of weight 1e-8 on the sentinel, the rest real and small
    expect(MISSING_ON_GPU * 1e-8 + 100).toBeLessThan(MISSING_BELOW);
  });
});

describe("the shaders", () => {
  it("test missing by the sentinel, not by comparing a value with itself", () => {
    expect(MISSING_GLSL).toContain("isMissing");
    for (const src of [VALUE_HEAD, VALUE_PICK_HEAD]) {
      expect(src).toContain("bool isMissing");
      expect(src).not.toMatch(/\b(\w+) != \1\b/);
    }
  });

  it("never asks a value whether it is itself, in the layers' shader sources", async () => {
    const { readFileSync } = await import("node:fs");
    for (const file of ["cloud.ts", "mesh.ts", "value.ts"]) {
      const src = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
      expect(src, file).not.toMatch(/\b(v|value|sizeValue|vValue) != (v|value|sizeValue|vValue)\b/);
      expect(src, file).not.toMatch(/\bvalue == value\b/);
    }
  });
});
