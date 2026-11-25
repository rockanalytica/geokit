// Mesh / surface layer: vertex and face arrays straight from the source
// data, in scene-local coordinates. How it is drawn — colour, opacity,
// smooth or flat shading, wireframe — is a Viewport's choice applied per
// frame; the three materials are built once and swapped, so a change never
// recompiles a shader mid-frame. For picking the whole mesh is one id.
//
// In Section view a mesh is only the line where it crosses the
// plane, in its own colour. The line is worked out when the plane changes
// and kept for as long as it does not.

import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  ShaderMaterial,
  Vector3,
} from "three";
import { NO_PICK_IDS, type Pickable, type PickIds, type PickTarget } from "../picking";
import { planeCrossing } from "../section";
import type { SectionPlane } from "../types";

/** A see-through mesh's own share of its colour, lit by nothing. */
const OWN_SHARE = 0.55;
/** What of its colour the lights shade, on a see-through mesh. */
const SHADED_SHARE = 0.8;

export interface MeshSource {
  /** xyz interleaved, scene-local. */
  vertices: Float32Array;
  /** index triples. */
  faces: Uint32Array;
  /** A unit normal at each vertex, where they were worked out already; else worked out here. */
  normals?: Float32Array;
}

export type MeshMode = "smooth" | "flat" | "wireframe";

export interface MeshView {
  /** CSS hex colour. */
  colour: string;
  opacity: number;
  mode: MeshMode;
  /**
   * A colour at each vertex, rgb from 0 to 1, blended across each triangle:
   * a mesh coloured by a value at its vertices. Absent or null, `colour` alone.
   */
  vertexColours?: Float32Array | null;
}

const PICK_VERT = /* glsl */ `
  #include <clipping_planes_pars_vertex>
  void main() {
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    #include <clipping_planes_vertex>
  }
`;
const PICK_FRAG = /* glsl */ `
  precision highp float;
  uniform vec3 uId;
  #include <clipping_planes_pars_fragment>
  void main() {
    #include <clipping_planes_fragment>
    gl_FragColor = vec4(uId, 1.0);
  }
`;

/** Where a mesh lies: its surface's centre of mass and its box, in the scene's units. */
export interface MeshPlace {
  centre: [number, number, number];
  min: [number, number, number];
  max: [number, number, number];
}

export class MeshLayer implements Pickable {
  readonly object = new Group();
  private readonly surface: Mesh;
  /** Where the mesh crosses the plane faced, drawn instead of it in Section view. */
  private readonly crossing: LineSegments;
  private readonly lineMaterial = new LineBasicMaterial();
  private crossed: string | null = null;
  private readonly materials: Record<MeshMode, MeshLambertMaterial | MeshBasicMaterial>;
  private readonly pickMaterial: ShaderMaterial;
  private readonly pickId: number;
  private drawn: MeshLambertMaterial | MeshBasicMaterial;
  /** The vertex colours the geometry holds now, so they are given again only when others are asked. */
  private coloured: Float32Array | null = null;

  constructor(
    private readonly source: MeshSource,
    view: MeshView,
    private readonly pickIds: PickIds = NO_PICK_IDS,
  ) {
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new Float32BufferAttribute(source.vertices, 3));
    // the indices as they are: a plain array of a large body's is a copy many times its size
    geometry.setIndex(new BufferAttribute(source.faces, 1));
    if (source.normals) geometry.setAttribute("normal", new BufferAttribute(source.normals, 3));
    else geometry.computeVertexNormals();
    this.materials = {
      smooth: new MeshLambertMaterial({ side: DoubleSide }),
      flat: new MeshLambertMaterial({ side: DoubleSide, flatShading: true }),
      wireframe: new MeshBasicMaterial({ wireframe: true }),
    };
    this.pickId = pickIds.take(1);
    const id = this.pickId;
    this.pickMaterial = new ShaderMaterial({
      vertexShader: PICK_VERT,
      fragmentShader: PICK_FRAG,
      uniforms: {
        uId: {
          value: new Vector3((id & 255) / 255, ((id >> 8) & 255) / 255, ((id >> 16) & 255) / 255),
        },
      },
      side: DoubleSide,
      clipping: true,
    });
    this.drawn = this.materials.smooth;
    this.surface = new Mesh(geometry, this.drawn);
    this.crossing = new LineSegments(new BufferGeometry(), this.lineMaterial);
    this.crossing.visible = false;
    this.crossing.frustumCulled = false;
    this.object.add(this.surface, this.crossing);
    this.object.name = "Mesh";
    this.apply(view);
  }

  apply(view: MeshView) {
    const material = this.materials[view.mode];
    this.drawn = material;
    if (this.surface.material !== material) this.surface.material = material;
    const colours = view.vertexColours ?? null;
    if (colours !== this.coloured) {
      this.coloured = colours;
      if (colours)
        this.surface.geometry.setAttribute("color", new Float32BufferAttribute(colours, 3));
      else this.surface.geometry.deleteAttribute("color");
    }
    for (const m of Object.values(this.materials)) {
      if (m.vertexColors !== (colours !== null)) {
        m.vertexColors = colours !== null;
        m.needsUpdate = true;
      }
    }
    // a see-through mesh reads by its colour: most of it is its own, and the
    // light only shapes it. Shaded wholly, its colour would follow the angle
    // each face turns to the headlight — darker, redder, as the camera moves
    // — and nested shells, each shaded, compound it
    const seeThrough = view.opacity < 1 && material instanceof MeshLambertMaterial;
    // coloured by its vertices, the material's own colour is white: it multiplies them
    const own = colours ? "#ffffff" : view.colour;
    material.color = new Color(own).multiplyScalar(seeThrough ? SHADED_SHARE : 1);
    if (material instanceof MeshLambertMaterial)
      material.emissive =
        seeThrough && !colours
          ? new Color(view.colour).multiplyScalar(OWN_SHARE)
          : new Color(0x000000);
    material.opacity = view.opacity;
    material.transparent = view.opacity < 1;
    // a see-through surface hides nothing behind it, from any side
    material.depthWrite = view.opacity >= 1;
    this.lineMaterial.color = new Color(view.colour);
  }

  /** In Section view, the plane faced: the mesh is drawn as where it crosses it. Null draws it whole. */
  private placed: MeshPlace | null = null;

  /**
   * Where it lies, in the scene's units, for an exploded view: the centre of
   * mass of its surface — each triangle's middle weighed by its area, which
   * tells nested shells apart where the middle of their boxes does not — and
   * the box it fills. Worked out once.
   */
  place(): MeshPlace {
    if (this.placed) return this.placed;
    const g = this.surface.geometry;
    if (!g.boundingBox) g.computeBoundingBox();
    const b = g.boundingBox;
    const min: [number, number, number] = b ? [b.min.x, b.min.y, b.min.z] : [0, 0, 0];
    const max: [number, number, number] = b ? [b.max.x, b.max.y, b.max.z] : [0, 0, 0];
    const xyz = g.getAttribute("position")?.array as ArrayLike<number> | undefined;
    const index = g.getIndex()?.array;
    const corners = index ? index.length : xyz ? xyz.length / 3 : 0;
    let [sx, sy, sz, area] = [0, 0, 0, 0];
    if (xyz)
      for (let t = 0; t + 2 < corners; t += 3) {
        const a = (index ? (index[t] ?? 0) : t) * 3;
        const c = (index ? (index[t + 1] ?? 0) : t + 1) * 3;
        const d = (index ? (index[t + 2] ?? 0) : t + 2) * 3;
        const [ax, ay, az] = [xyz[a] ?? 0, xyz[a + 1] ?? 0, xyz[a + 2] ?? 0];
        const [ux, uy, uz] = [(xyz[c] ?? 0) - ax, (xyz[c + 1] ?? 0) - ay, (xyz[c + 2] ?? 0) - az];
        const [vx, vy, vz] = [(xyz[d] ?? 0) - ax, (xyz[d + 1] ?? 0) - ay, (xyz[d + 2] ?? 0) - az];
        const w = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
        area += w;
        sx += w * (ax + (ux + vx) / 3);
        sy += w * (ay + (uy + vy) / 3);
        sz += w * (az + (uz + vz) / 3);
      }
    const centre: [number, number, number] =
      area > 0
        ? [sx / area, sy / area, sz / area]
        : [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
    this.placed = { centre, min, max };
    return this.placed;
  }

  /** Drawn moved by this much (an exploded view); its geometry stays where it is. */
  setOffset([x, y, z]: readonly [number, number, number]) {
    this.object.position.set(x, y, z);
  }

  setCut(plane: SectionPlane | null) {
    this.surface.visible = plane === null;
    this.crossing.visible = plane !== null;
    if (!plane) return;
    const key = `${plane.normal.join(",")}|${plane.distance}`;
    if (key === this.crossed) return;
    this.crossed = key;
    const segments = planeCrossing(this.source.vertices, this.source.faces, plane);
    this.crossing.geometry.dispose();
    this.crossing.geometry = new BufferGeometry();
    this.crossing.geometry.setAttribute("position", new Float32BufferAttribute(segments, 3));
  }

  enterPick() {
    this.surface.material = this.pickMaterial;
    this.crossing.material = this.pickMaterial;
  }

  exitPick() {
    this.surface.material = this.drawn;
    this.crossing.material = this.lineMaterial;
  }

  resolvePick(id: number): PickTarget | null {
    return id === this.pickId ? { kind: "mesh" } : null;
  }

  dispose() {
    this.pickIds.give(this.pickId, 1);
    this.surface.geometry.dispose();
    this.crossing.geometry.dispose();
    this.lineMaterial.dispose();
    for (const m of Object.values(this.materials)) m.dispose();
    this.pickMaterial.dispose();
  }
}
