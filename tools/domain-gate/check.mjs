// Domain gate (ADR-0001 of the apps that use the kit): the kit names no
// domain from either app. Every source file under packages/ and crates/ is
// read, tests included, and any of the words below fails the gate. A word
// added here is a decision; a word removed from here is one too.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "..");

/** Each app's own name and words, matched whole and in any case. */
export const FORBIDDEN = [
  // the apps and what they bring with them
  "geoscape",
  "cloudlabeller",
  "geoml",
  // GeoScape's domain
  "drillholes?",
  "holes?",
  "collars?",
  "desurvey\\w*",
  "realizations?",
  "containers?",
  "gauges?",
  "networks?",
  "exchanges?",
  // CloudLabeller's domain
  "labels?",
  "labell?(ed|ing|er)",
  "outcrops?",
  "photogrammetr\\w*",
  "colmap",
];

const pattern = new RegExp(`\\b(${FORBIDDEN.join("|")})\\b`, "i");
const SOURCE = /\.(ts|tsx|css|rs|mjs|js)$/;
const SKIP = new Set(["node_modules", "target", "dist"]);

/** The forbidden words in `text`, one finding per line that has one. */
export function findings(text) {
  const out = [];
  for (const [i, line] of text.split("\n").entries()) {
    const m = line.match(pattern);
    if (m) out.push({ line: i + 1, word: m[1], text: line.trim() });
  }
  return out;
}

function* files(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* files(path);
    else if (SOURCE.test(name)) yield path;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let bad = 0;
  let read = 0;
  for (const top of ["packages", "crates"]) {
    for (const file of files(resolve(root, top))) {
      read++;
      for (const f of findings(readFileSync(file, "utf8"))) {
        bad++;
        console.error(`  ${relative(root, file)}:${f.line}\t${f.word}\t${f.text}`);
      }
    }
  }
  if (bad === 0) {
    console.log(`domain gate: ${read} files, no app's domain named.`);
    process.exit(0);
  }
  console.error(`\ndomain gate: ${bad} lines name an app's domain. Word them generically.`);
  process.exit(1);
}
