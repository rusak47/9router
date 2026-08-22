import test from "node:test";
import assert from "node:assert/strict";
import { parseArgs } from "../lib.js";
test("parses flags and positional arguments", () => {
  assert.deepEqual(parseArgs(["analyze", "v1", "--apply", "--target", "v2"]), { _: ["analyze", "v1"], apply: true, target: "v2" });
});
