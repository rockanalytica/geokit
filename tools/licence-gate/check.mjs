// Licence gate for the pnpm workspace (LICENSES.md).
// Every package in the lockfile — all workspace projects, dev and production —
// must carry a licence expression whose every required part is on the
// allowlist, unless the exact name@version is pinned in exceptions.json with a
// reason. Reads `pnpm licenses list --json`, which covers the whole tree.

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "..");
const allow = new Set(JSON.parse(readFileSync(resolve(here, "allowlist.json"), "utf8")).spdx);
const exceptions = JSON.parse(readFileSync(resolve(here, "exceptions.json"), "utf8")).npm;

/** @returns {Array<{id: string, licence: string, paths: string[], homepage: string}>} */
export function readTree() {
  const json = execSync("pnpm licenses list --json", {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const byLicence = JSON.parse(json);
  const packages = [];
  for (const entries of Object.values(byLicence)) {
    for (const entry of entries) {
      for (const version of entry.versions ?? []) {
        packages.push({
          id: `${entry.name}@${version}`,
          licence: entry.license ?? "UNKNOWN",
          paths: entry.paths ?? [],
          homepage: entry.homepage ?? "",
        });
      }
    }
  }
  return packages;
}

// "MIT", "(MIT OR Apache-2.0)", "MIT AND BSD-3-Clause", "MIT*" (guessed),
// "(MIT AND Zlib) OR GPL-3.0". AND binds tighter than OR, and parentheses
// group, as SPDX says. "X WITH Y" is judged whole, so it passes only if the
// allowlist names it whole. An expression that does not parse fails.
export function permitted(expression) {
  const tokens = String(expression)
    .replace(/\*/g, "")
    .replace(/([()])/g, " $1 ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (tokens.length === 0) return false;
  let at = 0;
  const peek = () => tokens[at]?.toUpperCase();
  const isWord = (t) => t !== undefined && !["(", ")", "AND", "OR", "WITH"].includes(t);

  // Each returns whether its part is permitted, or null where it does not parse.
  function anyOf() {
    let ok = allOf();
    while (ok !== null && peek() === "OR") {
      at++;
      const next = allOf();
      ok = next === null ? null : ok || next;
    }
    return ok;
  }
  function allOf() {
    let ok = one();
    while (ok !== null && peek() === "AND") {
      at++;
      const next = one();
      ok = next === null ? null : ok && next;
    }
    return ok;
  }
  function one() {
    if (peek() === "(") {
      at++;
      const ok = anyOf();
      if (peek() !== ")") return null;
      at++;
      return ok;
    }
    const id = tokens[at];
    if (!isWord(id?.toUpperCase())) return null;
    at++;
    if (peek() === "WITH") {
      at++;
      const exception = tokens[at];
      if (!isWord(exception?.toUpperCase())) return null;
      at++;
      return allow.has(`${id} WITH ${exception}`);
    }
    return allow.has(id);
  }

  const ok = anyOf();
  return ok === true && at === tokens.length;
}

// Exception keys are exact "name@version", with "*" allowed as a wildcard so
// one entry covers a package's per-platform binaries ("lightningcss*@1.32.0").
const exceptionPatterns = Object.keys(exceptions).map(
  (key) => new RegExp(`^${key.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`),
);

export function excepted(id) {
  return exceptionPatterns.some((re) => re.test(id));
}

export function violations(packages) {
  return packages.filter((p) => !permitted(p.licence) && !excepted(p.id));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const packages = readTree();
  const bad = violations(packages);
  if (bad.length === 0) {
    console.log(`licence gate: ${packages.length} packages, all permitted.`);
    process.exit(0);
  }
  console.error(`licence gate: ${bad.length} of ${packages.length} packages not permitted:\n`);
  for (const b of bad) console.error(`  ${b.id}\t${b.licence}\t${b.homepage}`);
  console.error(
    "\nReview each, then either replace it or pin it in tools/licence-gate/exceptions.json.",
  );
  process.exit(1);
}
