import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("refresh defaults to a read-only origin update plan", () => {
  const root = fileURLToPath(new URL("../../../../", import.meta.url));
  const output = execFileSync(process.execPath, [".docs/scripts/upstream/cli.js", "refresh", "--json"], { cwd: root, encoding: "utf8" });
  const plan = JSON.parse(output);
  assert.equal(plan.dryRun, true);
  assert.match(plan.remoteRef, /^origin\//);
  assert.match(plan.action, /^(up-to-date|fast-forward|rebase)$/);
  assert.ok(Array.isArray(plan.kept));
  assert.ok(Array.isArray(plan.dropped));
});
