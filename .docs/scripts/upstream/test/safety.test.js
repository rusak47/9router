import test from "node:test";
import assert from "node:assert/strict";
import { assertPushRemote } from "../lib.js";

test("push guard rejects upstream", () => {
  assert.throws(() => assertPushRemote("upstream"), /forbidden/);
  assert.equal(assertPushRemote("origin"), "origin");
});
