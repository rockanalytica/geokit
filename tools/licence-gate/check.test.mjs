import assert from "node:assert/strict";
import { test } from "node:test";
import { permitted, violations } from "./check.mjs";

test("plain permissive identifiers pass", () => {
  assert.equal(permitted("MIT"), true);
  assert.equal(permitted("Apache-2.0"), true);
});

test("copyleft fails", () => {
  assert.equal(permitted("GPL-3.0"), false);
  assert.equal(permitted("LGPL-3.0-or-later"), false);
  assert.equal(permitted("MPL-2.0"), false);
});

test("OR needs one permitted branch, AND needs all", () => {
  assert.equal(permitted("(MIT OR GPL-3.0)"), true);
  assert.equal(permitted("MIT AND GPL-3.0"), false);
  assert.equal(permitted("(MIT AND BSD-3-Clause)"), true);
});

test("guessed licences (asterisk) are judged on the identifier", () => {
  assert.equal(permitted("MIT*"), true);
  assert.equal(permitted("UNKNOWN"), false);
});

test("violations reports the offenders", () => {
  const packages = [
    { id: "ok@1.0.0", licence: "MIT", paths: [], homepage: "" },
    { id: "bad@2.0.0", licence: "GPL-2.0", paths: [], homepage: "https://example.invalid" },
  ];
  assert.deepEqual(
    violations(packages).map((b) => b.id),
    ["bad@2.0.0"],
  );
});

test("a crate's licence: cargo's old slash is an OR, and the kit's own crates are not judged", async () => {
  const { cargoExpression, crateViolations } = await import("./check_cargo.mjs");
  assert.equal(cargoExpression("MIT/Apache-2.0"), "MIT OR Apache-2.0");
  const bad = crateViolations([
    { name: "a", version: "1.0.0", license: "MIT/Apache-2.0", source: "registry" },
    { name: "b", version: "1.0.0", license: "MPL-2.0", source: "registry" },
    { name: "own", version: "0.1.0", license: "LicenseRef-Proprietary", source: null },
  ]);
  assert.deepEqual(
    bad.map((p) => p.name),
    ["b"],
  );
});
