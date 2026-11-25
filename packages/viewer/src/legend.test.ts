import { describe, expect, it } from "vitest";
import { EMBER, OKABE_ITO } from "./colormap";
import type { ValueView } from "./layers/value";
import {
  buildLegend,
  formatTick,
  gradientCss,
  type LegendDocument,
  legendModel,
  linearTicks,
  logTicks,
} from "./legend";

const view = (over: Partial<ValueView> = {}): ValueView => ({
  column: "",
  colourRange: [0, 100],
  filterRange: [Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY],
  classMask: [],
  mip: false,
  ...over,
});

describe("ticks", () => {
  it("fall on multiples of a 1, 2 or 5 step inside the range", () => {
    expect(linearTicks([0, 100]).map((t) => t.value)).toEqual([0, 20, 40, 60, 80, 100]);
    expect(linearTicks([0, 100]).map((t) => t.position)).toEqual([0, 0.2, 0.4, 0.6, 0.8, 1]);
    expect(linearTicks([3, 7.2], 4).map((t) => t.text)).toEqual(["3", "4", "5", "6", "7"]);
    expect(linearTicks([-1, 1], 4).map((t) => t.text)).toContain("0.0");
    // only those inside
    for (const t of linearTicks([13, 87])) {
      expect(t.value).toBeGreaterThanOrEqual(13);
      expect(t.value).toBeLessThanOrEqual(87);
    }
  });

  it("has one tick for a range that is a point, and none of -0", () => {
    expect(linearTicks([5, 5])).toHaveLength(1);
    expect(formatTick(-0, 1)).toBe("0");
    expect(formatTick(-0.0001, 0.5)).toBe("0.0");
    expect(formatTick(2500, 500)).toBe("2500");
    expect(formatTick(0.25, 0.05)).toBe("0.25");
  });

  it("go by powers of ten on a log scale, more of them when the range is short", () => {
    expect(logTicks([1, 1000]).map((t) => t.value)).toEqual([
      1, 2, 5, 10, 20, 50, 100, 200, 500, 1000,
    ]);
    const t = logTicks([1, 100]);
    expect(t.find((x) => x.value === 10)?.position).toBeCloseTo(0.5);
    expect(logTicks([1, 1e8]).map((x) => x.value)).toEqual([
      1, 10, 100, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8,
    ]);
    expect(logTicks([0.01, 1]).map((x) => x.text)).toContain("0.01");
    // not a log range: linear
    expect(logTicks([0, 10]).length).toBeGreaterThan(1);
  });
});

describe("gradientCss", () => {
  it("runs a Colormap's stops low to high along a direction", () => {
    const g = gradientCss(EMBER, { stops: 3 });
    const [r, gr, b] = EMBER.colors[0] ?? [0, 0, 0];
    expect(g.startsWith(`linear-gradient(to right, rgb(${r}, ${gr}, ${b}) 0%, `)).toBe(true);
    expect(g.endsWith(" 100%)")).toBe(true);
    expect(g).toMatch(/^linear-gradient\(to right, (rgb\(\d+, \d+, \d+\) [\d.]+%(, )?){3}\)$/);
    expect(gradientCss(EMBER, { direction: "to top" })).toMatch(/^linear-gradient\(to top, /);
  });

  it("draws steps as hard bands", () => {
    const g = gradientCss(EMBER, { steps: 2 });
    expect(g).toContain("50%");
    // each band is one colour from its start to its end
    const colours = [...g.matchAll(/rgb\([^)]*\)/g)].map((m) => m[0]);
    expect(colours[0]).toBe(colours[1]);
    expect(colours[2]).toBe(colours[3]);
    expect(colours[0]).not.toBe(colours[2]);
  });

  it("takes plain stops, and says none for none", () => {
    expect(
      gradientCss(
        [
          [255, 0, 0],
          [0, 0, 255],
        ],
        { stops: 2 },
      ),
    ).toBe("linear-gradient(to right, rgb(255, 0, 0) 0%, rgb(0, 0, 255) 100%)");
    expect(gradientCss([])).toBe("none");
  });
});

describe("legendModel", () => {
  it("makes a bar of the colours the view colours by, with ticks on its range", () => {
    const m = legendModel({
      kind: "continuous",
      view: view({
        colours: [
          [255, 0, 0],
          [0, 0, 255],
        ],
      }),
    });
    expect(m.kind).toBe("continuous");
    if (m.kind !== "continuous") return;
    expect(m.gradient).toContain("rgb(255, 0, 0) 0%");
    expect(m.gradient).toContain("rgb(0, 0, 255) 100%");
    expect(m.ticks[0]?.value).toBe(0);
    expect(m.log).toBe(false);
  });

  it("uses the default Colormap, a log scale where the view has one, and ignores log at zero", () => {
    const m = legendModel({
      kind: "continuous",
      view: view({ colourRange: [1, 1000], log: true }),
    });
    if (m.kind !== "continuous") throw new Error("kind");
    expect(m.log).toBe(true);
    expect(m.ticks.find((t) => t.value === 10)?.position).toBeCloseTo(1 / 3);
    const z = legendModel({
      kind: "continuous",
      view: view({ colourRange: [0, 1000], log: true }),
    });
    if (z.kind !== "continuous") throw new Error("kind");
    expect(z.log).toBe(false);
  });

  it("shows breaks as equal bands with a tick at each cut", () => {
    const m = legendModel({ kind: "continuous", view: view({ breaks: [10, 50] }) });
    if (m.kind !== "continuous") throw new Error("kind");
    expect(m.ticks.map((t) => [t.value, +t.position.toFixed(3)])).toEqual([
      [10, 0.333],
      [50, 0.667],
    ]);
    expect(m.gradient.match(/rgb\(/g)).toHaveLength(6);
  });

  it("gives each class a swatch, named, shown or not, round the default colours", () => {
    const m = legendModel({
      kind: "categorical",
      view: view({ classMask: [true, false, true, true, true, true, true, true, true] }),
      classNames: ["a", "b"],
    });
    if (m.kind !== "categorical") throw new Error("kind");
    expect(m.swatches).toHaveLength(9);
    expect(m.swatches[0]).toEqual({ index: 0, name: "a", colour: "rgb(230, 159, 0)", shown: true });
    expect(m.swatches[1]?.shown).toBe(false);
    expect(m.swatches[2]?.name).toBe("Class 2");
    // the ninth is the first again
    expect(m.swatches[8]?.colour).toBe(m.swatches[0]?.colour);
    expect(OKABE_ITO.colors).toHaveLength(8);
  });
});

// A document stand-in: elements that keep what the builder gives them.
class El {
  style: Record<string, string> = {};
  attrs: Record<string, string> = {};
  children: El[] = [];
  id = "";
  textContent = "";
  constructor(readonly tag: string) {}
  append(...c: El[]) {
    this.children.push(...c);
  }
  setAttribute(k: string, v: string) {
    this.attrs[k] = v;
  }
}
const doc = { createElement: (tag: string) => new El(tag) } as unknown as LegendDocument;
const text = (e: El): string => [e.textContent, ...e.children.map(text)].join("|");

describe("buildLegend", () => {
  it("builds a caption, a bar of the gradient and its ticks, styled by tokens", () => {
    const m = legendModel({ kind: "continuous", view: view() });
    const root = buildLegend(doc, m, { caption: "Grade" }) as unknown as El;
    expect(root.children).toHaveLength(3);
    const [caption, bar, ticks] = root.children;
    expect(caption?.textContent).toBe("Grade");
    expect(bar?.style.background).toContain("linear-gradient");
    expect(bar?.attrs["aria-labelledby"]).toBe(caption?.id);
    expect(ticks?.children.map((t) => t.textContent)).toEqual(["0", "20", "40", "60", "80", "100"]);
    expect(ticks?.children[1]?.style.left).toBe("20.00%");
    expect(root.style.background).toBe("var(--gk-surface-1)");
    expect(root.style.color).toBe("var(--gk-fg)");
  });

  it("builds a swatch and a name for each class, the hidden ones faded", () => {
    const m = legendModel({
      kind: "categorical",
      view: view({ classMask: [true, false] }),
      classNames: ["Sand", "Clay"],
    });
    const root = buildLegend(doc, m) as unknown as El;
    expect(text(root)).toContain("Sand");
    expect(root.children).toHaveLength(2);
    expect(root.children[0]?.style.opacity).toBe("1");
    expect(root.children[1]?.style.opacity).toBe("0.4");
    expect(root.children[0]?.children[0]?.style.background).toBe("rgb(230, 159, 0)");
  });
});
