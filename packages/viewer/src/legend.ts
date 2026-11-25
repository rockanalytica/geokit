// A legend for a coloured column, from the same Colormap and value view that
// colour it: ticks for a colour bar, a CSS gradient for the bar itself,
// swatches for classes. The model is plain data; `buildLegend` makes a small
// DOM from it with no framework, styled with the `--gk-*` tokens of
// @geokit/ui (which an app has loaded) so it follows the theme.

import { type Colormap, EMBER, OKABE_ITO, sampleColormap } from "./colormap";
import type { ValueView } from "./layers/value";
import { niceStep } from "./section";

type Rgb = [number, number, number];

export interface Tick {
  value: number;
  /** Where it sits along the bar, 0 at the low end, 1 at the high. */
  position: number;
  /** The tick text. */
  text: string;
}

export interface Swatch {
  /** The class number. */
  index: number;
  name: string;
  /** A CSS colour. */
  colour: string;
  /** Whether the view shows this class. */
  shown: boolean;
}

export type LegendModel =
  | {
      kind: "continuous";
      /** A CSS `background` for the bar, low to high along `direction`. */
      gradient: string;
      ticks: Tick[];
      range: [number, number];
      log: boolean;
    }
  | { kind: "categorical"; swatches: Swatch[] };

const css = (c: Rgb) => `rgb(${Math.round(c[0])}, ${Math.round(c[1])}, ${Math.round(c[2])})`;

/** The decimals that show a step: 0.25 needs 2, 5 needs 0, 500 needs 0. */
function decimals(step: number): number {
  if (!(step > 0) || !Number.isFinite(step)) return 0;
  return Math.min(12, Math.max(0, -Math.floor(Math.log10(step) + 1e-9)));
}

/** A tick's text for a value on a scale of this step; no "-0", no stray digits. */
export function formatTick(value: number, step: number): string {
  const d = decimals(step);
  const text = value.toFixed(d);
  return Number(text) === 0 ? (0).toFixed(d) : text;
}

/**
 * Ticks for a linear range: multiples of a 1, 2 or 5 step (`niceStep`) that
 * fall inside it, about `count` of them. A degenerate range has one tick.
 */
export function linearTicks(range: [number, number], count = 5): Tick[] {
  const [lo, hi] = range;
  const extent = hi - lo;
  if (!(extent > 0)) return [{ value: lo, position: 0, text: formatTick(lo, 1) }];
  const step = niceStep((extent * 20) / Math.max(1, count));
  const out: Tick[] = [];
  const first = Math.ceil(lo / step - 1e-9);
  for (let k = first; k * step <= hi + step * 1e-9; k++) {
    // + 0: the tick at zero is 0, not -0
    const value = k * step + 0;
    out.push({ value, position: (value - lo) / extent, text: formatTick(value, step) });
  }
  return out;
}

/** Ticks for a logarithmic range (both ends above zero): 1, 2 and 5 of each power of ten inside it. */
export function logTicks(range: [number, number]): Tick[] {
  const [lo, hi] = range;
  if (!(lo > 0 && hi > lo)) return linearTicks(range);
  const out: Tick[] = [];
  const span = Math.log(hi) - Math.log(lo);
  const p0 = Math.floor(Math.log10(lo));
  const p1 = Math.ceil(Math.log10(hi));
  // all of 1, 2, 5 when the range is a few decades, else only the powers
  const mantissas = p1 - p0 <= 4 ? [1, 2, 5] : [1];
  for (let p = p0; p <= p1; p++) {
    for (const m of mantissas) {
      const value = m * 10 ** p;
      if (value < lo * (1 - 1e-9) || value > hi * (1 + 1e-9)) continue;
      out.push({
        value,
        position: (Math.log(value) - Math.log(lo)) / span,
        text: formatTick(value, 10 ** Math.min(0, p)),
      });
    }
  }
  return out;
}

/**
 * A CSS gradient through a Colormap, or through these stops: low to high
 * along `direction` ("to right" for a horizontal bar, "to top" for a vertical
 * one). With `steps` above 1 the bar is that many hard bands, as the shader
 * draws them. At most `stops` colour stops are written.
 */
export function gradientCss(
  colours: Colormap | readonly Rgb[],
  options: { direction?: string; steps?: number; stops?: number } = {},
): string {
  const map: Colormap = Array.isArray(colours)
    ? { name: "", kind: "sequential", colors: [...(colours as readonly Rgb[])] }
    : (colours as Colormap);
  const direction = options.direction ?? "to right";
  const steps = options.steps ?? 0;
  if (map.colors.length === 0) return "none";
  if (steps > 1) {
    const bands: string[] = [];
    for (let i = 0; i < steps; i++) {
      const c = css(sampleColormap(map, (i + 0.5) / steps));
      bands.push(`${c} ${(i / steps) * 100}%`, `${c} ${((i + 1) / steps) * 100}%`);
    }
    return `linear-gradient(${direction}, ${bands.join(", ")})`;
  }
  const n = Math.max(2, Math.min(options.stops ?? 32, map.colors.length));
  const stops: string[] = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    stops.push(`${css(sampleColormap(map, t))} ${(t * 100).toFixed(2).replace(/\.?0+$/, "")}%`);
  }
  return `linear-gradient(${direction}, ${stops.join(", ")})`;
}

/**
 * Equal bands of the bar, one per class that breaks cut (count + 1), each in
 * the colour the shader gives it.
 */
function bandsCss(map: Colormap, breaks: number, direction: string): string {
  const n = breaks + 1;
  const bands: string[] = [];
  for (let i = 0; i < n; i++) {
    const c = css(sampleColormap(map, (i + 0.5) / n));
    bands.push(`${c} ${(i / n) * 100}%`, `${c} ${((i + 1) / n) * 100}%`);
  }
  return `linear-gradient(${direction}, ${bands.join(", ")})`;
}

export interface LegendInput {
  kind: "continuous" | "categorical";
  view: ValueView;
  /** Names of the classes, by number; absent: "Class 0", … */
  classNames?: readonly string[];
  /** Approximate number of ticks on the bar. */
  tickCount?: number;
  /** "to right" for a horizontal bar, "to top" for a vertical one. */
  direction?: string;
}

/** What a legend shows of a view: the bar and its ticks, or the classes. */
export function legendModel(input: LegendInput): LegendModel {
  const { view } = input;
  if (input.kind === "categorical") {
    const colours = view.classColours ?? OKABE_ITO.colors;
    const n = Math.max(view.classMask.length, view.classColours?.length ?? 0);
    const swatches: Swatch[] = [];
    for (let i = 0; i < n; i++) {
      swatches.push({
        index: i,
        name: input.classNames?.[i] ?? `Class ${i}`,
        colour: css(colours[i % Math.max(1, colours.length)] ?? [0, 0, 0]),
        shown: view.classMask[i] ?? true,
      });
    }
    return { kind: "categorical", swatches };
  }
  const direction = input.direction ?? "to right";
  const map: Colormap = {
    name: "",
    kind: "sequential",
    colors: view.colours ?? EMBER.colors,
  };
  const [lo, hi] = view.colourRange;
  const log = Boolean(view.log) && lo > 0 && hi > lo;
  const breaks = (view.breaks ?? []).slice(0, 16);
  if (breaks.length > 0) {
    // the bands are equal on the bar, whatever the breaks' values
    const ticks = breaks.map((value, i) => ({
      value,
      position: (i + 1) / (breaks.length + 1),
      text: formatTick(value, niceStep(Math.abs(hi - lo) || 1)),
    }));
    return {
      kind: "continuous",
      gradient: bandsCss(map, breaks.length, direction),
      ticks,
      range: [lo, hi],
      log,
    };
  }
  const ticks = log ? logTicks([lo, hi]) : linearTicks([lo, hi], input.tickCount ?? 5);
  return {
    kind: "continuous",
    gradient: gradientCss(map, { direction, steps: view.steps ?? 0 }),
    ticks,
    range: [lo, hi],
    log,
  };
}

/** What `buildLegend` needs of a document: `document`, or a stand-in in a test. */
export interface LegendDocument {
  createElement(tag: string): HTMLElement;
}

export interface LegendOptions {
  /** The legend's caption: usually the column's name. */
  caption?: string;
  /** Bar length and thickness, px; a horizontal bar. */
  width?: number;
  height?: number;
  /** An id for the caption, which names the bar to assistive technology. */
  id?: string;
}

const el = (doc: LegendDocument, tag: string, style: Partial<CSSStyleDeclaration>) => {
  const e = doc.createElement(tag);
  Object.assign(e.style, style);
  return e;
};

/**
 * A legend as DOM: a caption, then a colour bar with its ticks, or a column
 * of swatches with the classes' names. Styled with `--gk-*` tokens; the app
 * places it. Rebuild it when the view changes.
 */
export function buildLegend(
  doc: LegendDocument,
  model: LegendModel,
  options: LegendOptions = {},
): HTMLElement {
  const root = el(doc, "div", {
    display: "inline-flex",
    flexDirection: "column",
    gap: "4px",
    padding: "8px",
    background: "var(--gk-surface-1)",
    color: "var(--gk-fg)",
    border: "1px solid var(--gk-border)",
    borderRadius: "4px",
    font: "12px/1.3 var(--font-sans, ui-sans-serif, system-ui, sans-serif)",
  });
  const captionId = options.id ?? "gk-legend-caption";
  if (options.caption) {
    const c = el(doc, "div", { color: "var(--gk-fg-muted)" });
    c.id = captionId;
    c.textContent = options.caption;
    root.append(c);
  }
  if (model.kind === "categorical") {
    for (const s of model.swatches) {
      const row = el(doc, "div", {
        display: "flex",
        alignItems: "center",
        gap: "6px",
        opacity: s.shown ? "1" : "0.4",
      });
      const chip = el(doc, "span", {
        width: "12px",
        height: "12px",
        background: s.colour,
        border: "1px solid var(--gk-border-strong)",
        flex: "none",
      });
      const name = el(doc, "span", {});
      name.textContent = s.name;
      row.append(chip, name);
      root.append(row);
    }
    return root;
  }
  const width = options.width ?? 180;
  const height = options.height ?? 12;
  const bar = el(doc, "div", {
    width: `${width}px`,
    height: `${height}px`,
    background: model.gradient,
    border: "1px solid var(--gk-border-strong)",
  });
  bar.setAttribute("role", "img");
  if (options.caption) bar.setAttribute("aria-labelledby", captionId);
  const ticks = el(doc, "div", {
    position: "relative",
    width: `${width}px`,
    height: "16px",
    color: "var(--gk-fg-muted)",
  });
  for (const t of model.ticks) {
    const mark = el(doc, "span", {
      position: "absolute",
      left: `${(t.position * 100).toFixed(2)}%`,
      transform: "translateX(-50%)",
      whiteSpace: "nowrap",
    });
    mark.textContent = t.text;
    ticks.append(mark);
  }
  root.append(bar, ticks);
  return root;
}
