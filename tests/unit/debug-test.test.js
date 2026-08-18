import { beforeEach, describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";

const FIXTURES = {
  bigPickleOk: JSON.parse(readFileSync(new URL("../fixtures/opencode-big-pickle.json", import.meta.url), "utf8")),
};

function makeDb(rows) {
  return { all: vi.fn(() => rows) };
}

import {
  seedFromHistory,
  resetHealthStats,
  getConnectionHealth,
  resolveHealthConfig,
} from "open-sse/services/healthTracker.js";

describe("debug store", () => {
  beforeEach(() => {
    resetHealthStats();
  });

  it("debug: check store after seedFromHistory", async () => {
    const result = await seedFromHistory("conn-1", "opencode", "big-pickle", makeDb(FIXTURES.bigPickleOk.slice(0, 15)), resolveHealthConfig({ minSamples: 3 }));
    expect(result).toBe(true);

    const stats = getConnectionHealth("conn-1", "big-pickle");
    console.log("stats:", JSON.stringify(stats));
    expect(stats.samples).toBeGreaterThan(0);
  });
});
