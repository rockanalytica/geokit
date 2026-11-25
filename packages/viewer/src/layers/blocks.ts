// Blocks: boxes of any size, one instance each, coloured by a value column
// through the shared value shader, picked by one id per block and clipped by
// the Section as every layer is. Each block is a centre, a size and a value;
// the GPU makes the box (24 vertices) once and places it per instance, so a
// few million blocks are a few tens of megabytes.
//
// A block that the view hides (a filter, a masked class, a blank switched
// off) is not drawn and cannot be picked.

import {
  BoxGeometry,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  type Material,
  Mesh,
  type Plane,
  ShaderMaterial,
} from "three";
import {
  applyClip,
  CLIP_FRAG,
  CLIP_FRAG_PARS,
  CLIP_VERT,
  CLIP_VERT_PARS,
  NO_PICK_IDS,
  type Pickable,
  type PickIds,
  type PickPass,
  type PickTarget,
  pickMaterial,
} from "../picking";
import { Problem } from "../problem";
import type { Vec3 } from "../types";
import {
  applyValue,
  gpuValues,
  Luts,
  VALUE_HEAD,
  VALUE_PICK_HEAD,
  type ValueUniforms,
  type ValueView,
  valueUniforms,
} from "./value";

export interface BlockSource {
  /** xyz of each block's centre, interleaved, scene-local. */
  centres: Float32Array;
  /** The edge lengths along x, y and z: one triple for every block, or a triple each, interleaved. */
  sizes: Vec3 | Float32Array;
  /** A value per block. NaN is missing. A categorical column holds class numbers. */
  values: ArrayLike<number>;
  kind: "continuous" | "categorical";
}

// What the colour pass and the id pass share of the vertex shader.
const BLOCK_ATTRIBUTES = /* glsl */ `
  attribute vec3 aCentre;
  attribute vec3 aSize;
  attribute float aValue;
  varying float vValue;
`;
const BLOCK_PLACE = /* glsl */ `
  vValue = aValue;
  vec4 mvPosition = modelViewMatrix * vec4(aCentre + position * aSize, 1.0);
  gl_Position = projectionMatrix * mvPosition;
`;

const VERT = /* glsl */ `
  ${BLOCK_ATTRIBUTES}
  varying float vShade;
  ${CLIP_VERT_PARS}
  void main() {
    ${BLOCK_PLACE}
    // a headlight: faces turned to the camera are light, edge-on ones darker
    vShade = 0.55 + 0.45 * abs(normalize(normalMatrix * normal).z);
    ${CLIP_VERT}
  }
`;

const FRAG = /* glsl */ `
  precision highp float;
  ${VALUE_HEAD}
  varying float vValue;
  varying float vShade;
  ${CLIP_FRAG_PARS}
  void main() {
    ${CLIP_FRAG}
    if (valueHidden(vValue)) discard;
    gl_FragColor = vec4(valueColour(vValue).rgb * vShade, 1.0);
  }
`;

export class BlockLayer implements Pickable {
  readonly object: Mesh;
  /** How many blocks. */
  readonly count: number;
  private readonly luts = new Luts();
  private readonly uniforms: ValueUniforms;
  private readonly material: ShaderMaterial;
  private readonly idMaterial: ShaderMaterial;
  private readonly base: number;

  constructor(
    private readonly source: BlockSource,
    view: ValueView,
    private readonly pickIds: PickIds = NO_PICK_IDS,
  ) {
    const n = Math.floor(source.centres.length / 3);
    const perBlock = !Array.isArray(source.sizes);
    if (source.centres.length !== n * 3)
      throw new Problem("blocks.bad_source", "block centres are not whole xyz triples");
    if (perBlock && (source.sizes as Float32Array).length !== n * 3)
      throw new Problem("blocks.bad_source", "block sizes are not one triple per block", {
        blocks: n,
      });
    if (source.values.length !== n)
      throw new Problem("blocks.bad_source", "block values are not one per block", { blocks: n });
    this.count = n;

    const box = new BoxGeometry(1, 1, 1);
    const g = new InstancedBufferGeometry();
    g.index = box.index;
    g.setAttribute("position", box.getAttribute("position"));
    g.setAttribute("normal", box.getAttribute("normal"));
    g.instanceCount = n;
    g.setAttribute("aCentre", new InstancedBufferAttribute(source.centres, 3));
    const sizes = perBlock ? (source.sizes as Float32Array) : new Float32Array(n * 3);
    if (!perBlock) {
      const s = source.sizes as Vec3;
      for (let i = 0; i < n; i++) sizes.set(s, i * 3);
    }
    g.setAttribute("aSize", new InstancedBufferAttribute(sizes, 3));
    g.setAttribute("aValue", new InstancedBufferAttribute(gpuValues(source.values), 1));

    this.uniforms = valueUniforms(this.luts);
    this.material = new ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: this.uniforms,
      clipping: true,
    });
    this.base = pickIds.take(n);
    this.idMaterial = pickMaterial({
      vertexHead: `${BLOCK_ATTRIBUTES} uniform float uBase; flat varying float vId;`,
      vertexMain: `vId = uBase + float(gl_InstanceID); ${BLOCK_PLACE}`,
      fragmentHead: `${VALUE_PICK_HEAD} varying float vValue; flat varying float vId;`,
      fragmentMain: "if (valueHidden(vValue)) discard;",
      idExpr: "vId",
      uniforms: { ...this.uniforms, uBase: { value: this.base } },
    });
    this.object = new Mesh(g, this.material);
    this.object.name = "Blocks";
    this.object.frustumCulled = false;
    this.apply(view);
  }

  /** Colour the blocks as this view says. */
  apply(view: ValueView) {
    applyValue(this.uniforms, this.source.kind, view, this.luts);
  }

  /** Where block `index` is: its centre and size, scene-local. */
  block(index: number): { centre: Vec3; size: Vec3 } | null {
    if (!(index >= 0 && index < this.count)) return null;
    const c = this.source.centres;
    const s = this.source.sizes;
    const i = index * 3;
    return {
      centre: [c[i] ?? 0, c[i + 1] ?? 0, c[i + 2] ?? 0],
      size: Array.isArray(s) ? (s as Vec3) : [s[i] ?? 0, s[i + 1] ?? 0, s[i + 2] ?? 0],
    };
  }

  /** Clip by these planes in the layer's own materials; see `applyClip`. */
  setClip(planes: readonly Plane[] | null, intersect: boolean) {
    applyClip([this.material, this.idMaterial] as Material[], planes, intersect);
  }

  enterPick(_pass: PickPass = "id") {
    this.object.material = this.idMaterial;
  }

  exitPick() {
    this.object.material = this.material;
  }

  resolvePick(id: number): PickTarget | null {
    const i = id - this.base;
    return i >= 0 && i < this.count ? { kind: "element", index: i } : null;
  }

  dispose() {
    this.pickIds.give(this.base, this.count);
    this.object.geometry.dispose();
    this.material.dispose();
    this.idMaterial.dispose();
    this.luts.dispose();
  }
}
