// The shader plumbing the layers share, read as text: one id encoding, one
// clipping chunk set, one pick material factory. A GPU is not needed to see
// that no layer writes these by hand any more.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BlockLayer } from "./layers/blocks";
import { MeshLayer } from "./layers/mesh";
import {
  applyClip,
  CLIP_FRAG,
  CLIP_VERT,
  decodePick,
  encodePick,
  PICK_ENCODE,
  pickMaterial,
} from "./picking";

/** The GLSL `pickColour`, evaluated in TypeScript with GLSL's own `mod`, `floor` and rounding to a byte. */
function glslPickColour(id: number): Uint8Array {
  const mod = (x: number, y: number) => x - y * Math.floor(x / y);
  const v = [mod(id, 256), mod(Math.floor(id / 256), 256), Math.floor(id / 65536)];
  return Uint8Array.from(v.map((c) => Math.round(Math.fround(c / 255) * 255)));
}

describe("the id encoding", () => {
  it("is the same in GLSL and in JS, for every kind of id", () => {
    expect(PICK_ENCODE).toContain("mod(id, 256.0)");
    expect(PICK_ENCODE).toContain("floor(id / 65536.0)");
    for (const id of [0, 1, 255, 256, 257, 65535, 65536, 65537, 123456, 0xfffffe, 0xffffff]) {
      const bytes = Uint8Array.from(encodePick(id));
      expect(glslPickColour(id), String(id)).toEqual(bytes);
      expect(decodePick(Uint8Array.of(...bytes, 255)), String(id)).toBe(id);
    }
  });
});

describe("pickMaterial", () => {
  it("clips, encodes and rounds its id in every material it makes", () => {
    const m = pickMaterial();
    expect(m.vertexShader).toContain(CLIP_VERT);
    expect(m.fragmentShader).toContain(CLIP_FRAG);
    expect(m.fragmentShader).toContain(PICK_ENCODE);
    expect(m.fragmentShader).toContain("pickColour(floor((uId) + 0.5))");
    expect(m.clipping).toBe(true);
    expect(m.uniforms.uId?.value).toBe(0);
  });

  it("lets a layer place its vertices and discard what is hidden, and keep its own uniforms shared", () => {
    const shared = { uFoo: { value: 3 } };
    const m = pickMaterial({
      vertexHead: "attribute float aX;",
      vertexMain: "vec4 mvPosition = vec4(aX); gl_Position = mvPosition;",
      fragmentMain: "if (uFoo > 1.0) discard;",
      idExpr: "vId",
      uniforms: shared,
    });
    expect(m.vertexShader).toContain("attribute float aX;");
    expect(m.vertexShader).not.toContain("modelViewMatrix * vec4(position");
    expect(m.fragmentShader).toContain("if (uFoo > 1.0) discard;");
    expect(m.fragmentShader).toContain("floor((vId) + 0.5)");
    expect(m.uniforms.uFoo).toBe(shared.uFoo);
  });
});

describe("applyClip", () => {
  it("puts planes on a material only to clip by all of them, and takes them off again", () => {
    const m = pickMaterial();
    const planes = [{}, {}] as never[];
    applyClip([m], planes, true);
    expect(m.clippingPlanes).toHaveLength(2);
    expect(m.clipIntersection).toBe(true);
    applyClip([m], planes, false);
    expect(m.clippingPlanes).toBeNull();
    expect(m.clipIntersection).toBe(false);
    applyClip([m], [], true);
    expect(m.clippingPlanes).toBeNull();
  });
});

describe("the layers", () => {
  it("write no clipping chunk, id encoding or pick shader of their own", () => {
    for (const file of ["layers/cloud.ts", "layers/mesh.ts", "layers/blocks.ts"]) {
      const src = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
      expect(src, file).not.toContain("#include <clipping_planes");
      expect(src, file).not.toContain("pickColour");
      expect(src, file).not.toMatch(/gl_FragColor = vec4\(uId/);
    }
  });

  it("build their id material from the factory", () => {
    const mesh = new MeshLayer(
      { vertices: Float32Array.of(0, 0, 0, 1, 0, 0, 0, 1, 0), faces: Uint32Array.of(0, 1, 2) },
      { colour: "#fff", opacity: 1, mode: "smooth" },
    );
    mesh.enterPick();
    const surface = mesh.object.children[0] as unknown as {
      material: { fragmentShader: string; vertexShader: string };
    };
    expect(surface.material.fragmentShader).toContain(PICK_ENCODE);
    expect(surface.material.vertexShader).toContain(CLIP_VERT);
    mesh.exitPick();
    const blocks = new BlockLayer(
      {
        centres: Float32Array.of(0, 0, 0),
        sizes: [1, 1, 1],
        values: [1],
        kind: "continuous",
      },
      {
        column: "",
        colourRange: [0, 1],
        filterRange: [-Infinity, Infinity],
        classMask: [],
        mip: false,
      },
    );
    blocks.enterPick();
    const m = blocks.object.material as unknown as { fragmentShader: string };
    expect(m.fragmentShader).toContain(PICK_ENCODE);
    expect(m.fragmentShader).toContain("valueHidden(vValue)");
    mesh.dispose();
    blocks.dispose();
  });
});
