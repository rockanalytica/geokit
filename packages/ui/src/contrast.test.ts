// WCAG contrast of the tokens, computed from tokens.css in both themes: the
// text tokens against the surface tokens they are set on. Body text must reach
// 4.5:1 (AA); the accent, state and quieter text tokens are measured and held to what they are
// for. Nothing here changes a token: a pair that falls short is a finding for
// the design, pinned below with its ratio.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./tokens.css", import.meta.url), "utf8");

/** The text of the `{ … }` block that opens after `marker`. */
function blockAfter(marker: string): string {
  const start = css.indexOf(marker);
  if (start < 0) throw new Error(`no ${marker} in tokens.css`);
  const open = css.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    if (css[i] === "}" && --depth === 0) return css.slice(open + 1, i);
  }
  throw new Error(`unclosed block after ${marker}`);
}

/** `--gk-name: value;` pairs of a block's own declarations. */
function declarations(block: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const [, name, value] of block.matchAll(/(--gk-[a-z0-9-]+)\s*:\s*([^;]+);/g))
    out.set(name as string, (value as string).trim());
  return out;
}

const brand = declarations(blockAfter("/* ---- Brand slots"));
const themes = {
  dark: new Map([...brand, ...declarations(blockAfter("/* ---- Dark theme"))]),
  light: new Map([
    ...brand,
    ...declarations(blockAfter("/* ---- Dark theme")),
    ...declarations(blockAfter(':root[data-theme="light"]')),
  ]),
};

/** A token's colour as [r, g, b] 0–255, following `var()` to a hex value. */
function colour(theme: keyof typeof themes, name: string, depth = 0): [number, number, number] {
  const value = themes[theme].get(name);
  if (value === undefined || depth > 8) throw new Error(`${theme}: ${name} has no value`);
  const ref = value.match(/^var\((--gk-[a-z0-9-]+)\)$/);
  if (ref) return colour(theme, ref[1] as string, depth + 1);
  const hex = value.match(/^#([0-9a-f]{6})$/i);
  if (!hex) throw new Error(`${theme}: ${name} is ${value}, not a #rrggbb`);
  const n = Number.parseInt(hex[1] as string, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const channel = (c: number) => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const luminance = ([r, g, b]: [number, number, number]) =>
  0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);

/** WCAG 2 contrast ratio, 1 to 21. */
function ratio(a: [number, number, number], b: [number, number, number]): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const SURFACES = ["--gk-surface-0", "--gk-surface-1", "--gk-surface-2", "--gk-surface-3"];
/** Body text. */
const BODY = ["--gk-fg", "--gk-fg-muted"];
/** Text a UI sets in a state or an accent colour, on a plain surface. */
const STATE = ["--gk-accent", "--gk-danger", "--gk-ok"];

const table = (names: string[], min: number) => {
  const failing: string[] = [];
  for (const theme of ["dark", "light"] as const) {
    for (const t of names) {
      for (const s of SURFACES) {
        const r = ratio(colour(theme, t), colour(theme, s));
        if (r < min) failing.push(`${theme}: ${t} on ${s} is ${r.toFixed(2)}:1, under ${min}:1`);
      }
    }
  }
  return failing;
};

describe("contrast of the tokens", () => {
  it("parses both themes, the light one over the dark", () => {
    expect(colour("dark", "--gk-fg")).toEqual([0xee, 0xf0, 0xf6]);
    // the light theme's text is the brand ink
    expect(colour("light", "--gk-fg")).toEqual(colour("light", "--gk-brand-ink"));
    expect(ratio([0, 0, 0], [255, 255, 255])).toBeCloseTo(21);
    expect(ratio([255, 255, 255], [255, 255, 255])).toBe(1);
  });

  it("gives body text 4.5:1 on every surface, in both themes", () => {
    expect(table(BODY, 4.5)).toEqual([]);
  });

  // Findings, pinned: these pairs fall short of the bar they are measured by.
  // Changing a token so one passes (or fails) makes this list differ, which
  // is the moment to decide it, not to find out later. They are not asserted away.
  it("pins the accent and state colours that fall short of 4.5:1 as text", () => {
    expect(table(STATE, 4.5)).toEqual([
      "dark: --gk-accent on --gk-surface-0 is 4.23:1, under 4.5:1",
      "dark: --gk-accent on --gk-surface-1 is 3.92:1, under 4.5:1",
      "dark: --gk-accent on --gk-surface-2 is 3.60:1, under 4.5:1",
      "dark: --gk-accent on --gk-surface-3 is 3.23:1, under 4.5:1",
      "dark: --gk-danger on --gk-surface-2 is 4.20:1, under 4.5:1",
      "dark: --gk-danger on --gk-surface-3 is 3.76:1, under 4.5:1",
      "light: --gk-accent on --gk-surface-3 is 4.46:1, under 4.5:1",
      "light: --gk-ok on --gk-surface-2 is 4.43:1, under 4.5:1",
      "light: --gk-ok on --gk-surface-3 is 4.04:1, under 4.5:1",
    ]);
  });

  it("holds the accent and state colours to 3:1 on every surface, and the icon tone to 3:1", () => {
    expect(table(STATE, 3)).toEqual([]);
    expect(table(["--gk-fg-icon"], 3)).toEqual([]);
  });

  it("pins the faintest text, short of 3:1 on the deeper surfaces", () => {
    expect(table(["--gk-fg-faint"], 3)).toEqual([
      "dark: --gk-fg-faint on --gk-surface-3 is 2.78:1, under 3:1",
      "light: --gk-fg-faint on --gk-surface-2 is 2.90:1, under 3:1",
      "light: --gk-fg-faint on --gk-surface-3 is 2.64:1, under 3:1",
    ]);
  });

  it("sets the accent's own text on the accent", () => {
    for (const theme of ["dark", "light"] as const) {
      const r = ratio(colour(theme, "--gk-accent-fg"), colour(theme, "--gk-accent"));
      expect(r, `${theme}: accent-fg on accent`).toBeGreaterThanOrEqual(3);
    }
  });
});
