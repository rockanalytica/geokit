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

// "MIT", "(MIT OR Apache-2.0)", "MIT AND BSD-3-Clause", "MIT*" (guessed).
export function permitted(expression) {
  const clean = String(expression).replace(/[()]/g, "").replace(/\*/g, "").trim();
  if (!clean) return false;
  const orParts = clean.split(/\s+OR\s+/i);
  return orParts.some((part) => part.split(/\s+AND\s+/i).every((id) => allow.has(id.trim())));
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
