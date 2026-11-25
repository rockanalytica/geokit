// The tokens file holds itself together: both themes set the same tokens,
// every Tailwind colour names a token that exists, and the brand is reached
// only through its slots, so an app that fills them restyles everything.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./tokens.css", import.meta.url), "utf8");

/** The `--gk-*` names a block of the file sets. */
const setIn = (block: string) =>
  new Set([...block.matchAll(/(--gk-[a-z0-9-]+)\s*:/g)].map((m) => m[1] as string));

const blockAfter = (marker: string) => {
  const start = css.indexOf(marker);
  expect(start, marker).toBeGreaterThanOrEqual(0);
  const open = css.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    if (css[i] === "}" && --depth === 0) return css.slice(open, i + 1);
  }
  throw new Error(`unclosed block after ${marker}`);
};

describe("tokens.css", () => {
  const defined = setIn(css);
  const dark = setIn(blockAfter("/* ---- Dark theme"));
  const lightByOs = setIn(blockAfter("@media (prefers-color-scheme: light)"));
  const lightByAttr = setIn(blockAfter(':root[data-theme="light"]'));

  it("sets the same tokens in the light theme, by the OS or by the attribute", () => {
    expect([...lightByOs].sort()).toEqual([...lightByAttr].sort());
  });

  it("gives every token the light theme changes a dark value first", () => {
    for (const name of lightByAttr) expect(dark.has(name), name).toBe(true);
  });

  it("names only defined tokens, wherever one is used", () => {
    for (const [, name] of css.matchAll(/var\((--gk-[a-z0-9-]+)\)/g)) {
      expect(defined.has(name as string), name).toBe(true);
    }
  });

  it("maps each Tailwind colour onto a token", () => {
    const theme = blockAfter("@theme inline");
    const colours = [...theme.matchAll(/--color-([a-z0-9-]+):\s*([^;]+);/g)];
    expect(colours.length).toBeGreaterThan(10);
    for (const [, name, value] of colours) {
      expect(value, name).toMatch(/^var\(--gk-[a-z0-9-]+\)$/);
    }
  });

  it("takes the accent from the brand slots in both themes", () => {
    expect(blockAfter("/* ---- Dark theme")).toContain("--gk-accent: var(--gk-brand-primary)");
    expect(blockAfter(':root[data-theme="light"]')).toContain(
      "--gk-accent: var(--gk-brand-primary-deep)",
    );
  });
});
