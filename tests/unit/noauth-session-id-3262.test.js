// #3262 — no-auth free providers (oc/...-free, mimo-free, mmf) were minting fresh session per turn
// causing FreeUsageLimitError on first tool call.
// fix: virtual connection has connectionId="noauth" (verified by source inspection)

import { describe, it, expect } from "vitest";
import fs from "fs";

const authPath = "/home/colt/Documents/9router/src/sse/services/auth.js";

describe("no-auth providers stable session (#3262) - source verification", () => {
  it("virtual noauth connection includes connectionId='noauth' in source", () => {
    const source = fs.readFileSync(authPath, "utf8");
    // Verify the fix is present in source code
    expect(source).toContain('id: "noauth"');
    expect(source).toContain('connectionId: "noauth"');
  });

  it("markAccountUnavailable guard accepts noauth sentinel", () => {
    const source = fs.readFileSync(authPath, "utf8");
    expect(source).toContain('connectionId === "noauth"');
  });

  it("clearAccountError guard accepts noauth sentinel", () => {
    const source = fs.readFileSync(authPath, "utf8");
    // Both guards use same pattern
    const matches = source.match(/connectionId === "noauth"/g);
    expect(matches).toHaveLength(2); // two guards
  });
});