// Licence gate for the Rust workspace (LICENSES.md): every crate `cargo
// metadata` resolves for it — on every platform, build and dev ones too — must
// carry a licence expression whose every required part is on the allowlist,
// unless the exact name@version is pinned in exceptions.json under "cargo"
// with a reason. The kit's own crates are not judged. Where cargo is not
// installed the gate says so and passes.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { permitted } from "./check.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "..");
const manifest = resolve(root, "Cargo.toml");
const exceptions = JSON.parse(readFileSync(resolve(here, "exceptions.json"), "utf8")).cargo ?? {};

/** Cargo's older "MIT/Apache-2.0" means "MIT OR Apache-2.0". */
export const cargoExpression = (licence) => String(licence ?? "").replaceAll("/", " OR ");

export function crateViolations(packages) {
  return packages.filter(
    (p) =>
      p.source !== null &&
      p.source !== undefined &&
      !permitted(cargoExpression(p.license)) &&
      !(`${p.name}@${p.version}` in exceptions),
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let json;
  try {
    json = execFileSync(
      "cargo",
      ["metadata", "--format-version", "1", "--locked", "--manifest-path", manifest],
      { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (e) {
    if (e.code === "ENOENT") {
      console.log("licence gate (cargo): cargo is not installed here.");
      process.exit(0);
    }
    throw e;
  }
  const packages = JSON.parse(json).packages;
  const bad = crateViolations(packages);
  if (bad.length === 0) {
    console.log(`licence gate (cargo): ${packages.length} crates, all permitted.`);
    process.exit(0);
  }
  console.error(
    `licence gate (cargo): ${bad.length} of ${packages.length} crates not permitted:\n`,
  );
  for (const b of bad)
    console.error(`  ${b.name}@${b.version}\t${b.license ?? "NONE"}\t${b.repository ?? ""}`);
  console.error(
    '\nReview each, then either replace it or pin it in tools/licence-gate/exceptions.json under "cargo".',
  );
  process.exit(1);
}
