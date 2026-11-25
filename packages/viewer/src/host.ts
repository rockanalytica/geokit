// The layer host: what the apps' own Viewers each glued by hand. An app's
// Viewer owns the camera, its controls and the render loop; it hands the host
// a renderer and a scene, and the host owns what the layers have in common —
// which layers there are, the id pool, the pick pass and its readback, and
// the Section's clipping planes and cuts.

import {
  type Camera,
  Color,
  type Object3D,
  type OrthographicCamera,
  type PerspectiveCamera,
  Plane,
  type Scene,
  Vector2,
  WebGLRenderTarget,
} from "three";
import {
  decodePick,
  hideWhatHasNoIds,
  type Pickable,
  PickIdPool,
  type PickPass,
  type PickTarget,
  toClipPlane,
} from "./picking";
import type { SectionSpec } from "./section";
import type { SectionPlane } from "./types";

/** What a layer gives the host. Everything beyond the object, `apply` and `dispose` is optional. */
export interface Layer<V = never> extends Partial<Omit<Pickable, "object">> {
  readonly object: Object3D;
  /** Choose and set what a Viewport draws of the layer: its view, the camera, the Viewport's height in px. */
  apply(view: V, camera: Camera, heightPx: number): void;
  dispose(): void;
  /** Draw only where the layer crosses this plane, or whole again (null). */
  setCut?(plane: SectionPlane | null): void;
  /** Clip by these planes in the layer's own materials; see `applyClip`. */
  setClip?(planes: readonly Plane[], intersect: boolean): void;
}

/** The parts of `WebGLRenderer` the host uses: a renderer, or a stand-in in a test. */
export interface HostRenderer {
  clippingPlanes: Plane[];
  localClippingEnabled: boolean;
  getSize(target: Vector2): Vector2;
  getRenderTarget(): WebGLRenderTarget | null;
  setRenderTarget(target: WebGLRenderTarget | null): void;
  render(scene: Scene, camera: Camera): void;
  getClearColor(target: Color): Color;
  getClearAlpha(): number;
  setClearColor(colour: Color, alpha?: number): void;
  readRenderTargetPixels(
    target: WebGLRenderTarget,
    x: number,
    y: number,
    w: number,
    h: number,
    buffer: Uint8Array,
  ): void;
}

/**
 * Where a pick's pixel comes from, after the pass has been rendered: RGBA of
 * the pixel at (x, y) on screen, in CSS px from the top left. The default
 * reads the one-pixel target; a test gives it a table instead of a GPU.
 */
export type PickRead = (x: number, y: number, pass: PickPass) => Uint8Array;

export interface PickHit {
  layer: Layer;
  /** The id the id pass read. */
  id: number;
  target: PickTarget;
}

export interface LayerHostOptions {
  read?: PickRead;
  /** Ids shared with layers built elsewhere; default: a pool of its own. */
  ids?: PickIdPool;
}

const isPickable = (l: Layer): l is Layer & Pickable =>
  l.enterPick !== undefined && l.exitPick !== undefined && l.resolvePick !== undefined;

export class LayerHost {
  /** Hand this to a layer's constructor: ids unique among the layers added to this host. */
  readonly ids: PickIdPool;
  private readonly members: Layer[] = [];
  private target: WebGLRenderTarget | null = null;
  private readonly pixel = new Uint8Array(4);
  private readonly size = new Vector2();
  private readonly read: PickRead;
  private section: SectionSpec | null = null;
  private planes: Plane[] = [];

  constructor(
    private readonly renderer: HostRenderer,
    private readonly scene: Scene,
    options: LayerHostOptions = {},
  ) {
    this.ids = options.ids ?? new PickIdPool();
    this.read =
      options.read ??
      (() => {
        if (!this.target) return new Uint8Array(4);
        this.renderer.readRenderTargetPixels(this.target, 0, 0, 1, 1, this.pixel);
        return this.pixel;
      });
  }

  get layers(): readonly Layer[] {
    return this.members;
  }

  /** Put a layer in the scene, under the section set now. */
  add<L extends Layer>(layer: L): L {
    if (this.members.includes(layer)) return layer;
    this.members.push(layer);
    this.scene.add(layer.object);
    if (this.section) this.applySection(layer);
    return layer;
  }

  /** Take it out of the scene. It is not disposed: it may be added again. */
  remove(layer: Layer): void {
    const i = this.members.indexOf(layer);
    if (i < 0) return;
    this.members.splice(i, 1);
    this.scene.remove(layer.object);
  }

  /**
   * Clip every layer by a Section's planes and cut those that draw a cut. The
   * renderer's own planes serve what is kept where *all* planes agree; planes
   * that cut a box out are given to each layer's materials instead, since only
   * a material can clip by "behind all of them". Null shows everything.
   */
  setSection(spec: SectionSpec | null): void {
    this.section = spec;
    this.planes = spec ? spec.planes.map((p) => toClipPlane(p, new Plane())) : [];
    const intersect = spec?.intersect ?? false;
    this.renderer.clippingPlanes = intersect ? [] : this.planes;
    this.renderer.localClippingEnabled = intersect;
    for (const l of this.members) this.applySection(l);
  }

  private applySection(layer: Layer) {
    layer.setClip?.(this.planes, this.section?.intersect ?? false);
    layer.setCut?.(this.section?.cut ?? null);
  }

  /**
   * What is under the pixel (x, y), in CSS px from the top left of the
   * renderer's canvas, or null for the background. Renders the pickable layers'
   * ids into a one-pixel target — what the layers do not draw ids for is
   * hidden — and reads, decodes and resolves it. A layer with too many
   * elements for an id each (a Point Cloud) is then drawn alone, for the index
   * within what its id named.
   */
  pickAt(x: number, y: number, camera: PerspectiveCamera | OrthographicCamera): PickHit | null {
    const { renderer, scene } = this;
    renderer.getSize(this.size);
    const [w, h] = [this.size.x, this.size.y];
    const px = Math.floor(x);
    const py = Math.floor(y);
    if (!(px >= 0 && py >= 0 && px < w && py < h)) return null;
    const pickable = this.members.filter(isPickable);
    if (pickable.length === 0) return null;
    this.target ??= new WebGLRenderTarget(1, 1);
    const target = this.target;

    const before = {
      target: renderer.getRenderTarget(),
      colour: renderer.getClearColor(new Color()),
      alpha: renderer.getClearAlpha(),
      background: scene.background,
      view: camera.view ? { ...camera.view } : null,
    };
    // the camera sees only the one pixel, stretched over the target
    camera.setViewOffset(w, h, px, py, 1, 1);
    try {
      renderer.setRenderTarget(target);
      renderer.setClearColor(new Color(0, 0, 0), 0);
      scene.background = null;

      const pass = (layers: (Layer & Pickable)[], which: PickPass): number => {
        for (const l of layers) l.enterPick(which);
        const show = hideWhatHasNoIds(scene, layers);
        try {
          renderer.render(scene, camera);
          return decodePick(this.read(px, py, which));
        } finally {
          show();
          for (const l of layers) l.exitPick();
        }
      };

      const id = pass(pickable, "id");
      if (id === 0) return null;
      // ids are unique among the layers, so exactly one of them names it
      const owner = pickable.find((l) => l.resolvePick(id) !== null);
      if (!owner) return null;
      const detail = owner.needsDetail ? pass([owner], "detail") : undefined;
      const hit = owner.resolvePick(id, detail);
      return hit ? { layer: owner, id, target: hit } : null;
    } finally {
      renderer.setRenderTarget(before.target);
      renderer.setClearColor(before.colour, before.alpha);
      scene.background = before.background;
      if (before.view) camera.view = before.view;
      else camera.clearViewOffset();
      camera.updateProjectionMatrix();
    }
  }

  dispose(): void {
    this.target?.dispose();
    this.target = null;
    for (const l of [...this.members]) this.remove(l);
  }
}
