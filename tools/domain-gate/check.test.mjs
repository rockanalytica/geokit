import assert from "node:assert/strict";
import { test } from "node:test";
import { findings } from "./check.mjs";

test("an app's name or domain word is found, in any case", () => {
  assert.deepEqual(
    findings("ok\n// a Drillhole Set\nconst geoML = 1;").map((f) => [f.line, f.word]),
    [
      [2, "Drillhole"],
      [3, "geoML"],
    ],
  );
  assert.equal(findings("labels painted on photos").length, 1);
  assert.equal(findings("Labelling on the cloud").length, 1);
});

test("only whole words: generic words that contain one pass", () => {
  assert.deepEqual(findings("a threshold, a whole, a gaugeless... no: labelled"), [
    { line: 1, word: "labelled", text: "a threshold, a whole, a gaugeless... no: labelled" },
  ]);
  assert.deepEqual(findings("filterRange, projectionMatrix, containerless"), []);
});
