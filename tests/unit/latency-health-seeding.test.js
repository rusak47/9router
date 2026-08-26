import { beforeEach, describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";

const FIXTURES = {
  bigPickleOk: JSON.parse(readFileSync(new URL("../fixtures/opencode-big-pickle.json", import.meta.url), "utf8")),
  bigPickleBad: JSON.parse(readFileSync(new URL("../fixtures/opencode-bad-pickle.json", import.meta.url), "utf8")),
  bigPickleThin: JSON.parse(readFileSync(new URL("../fixtures/opencode-thin-pickle.json", import.meta.url), "utf8")),
};

function makeDb(rows) {
  return { all: vi.fn(() => rows) };
}

import {
  seedFromHistory,
  warmConnectionHistory,
  resetHealthStats,
  recordOutcome,
  getConnectionHealth,
  resolveHealthConfig,
} from "open-sse/services/healthTracker.js";

describe("seedFromHistory", () => {
  beforeEach(() => {
    resetHealthStats();
  });

  it("creates prior samples from DB when no live samples exist", async () => {
    const result = await seedFromHistory("conn-1", "opencode", "big-pickle", makeDb(FIXTURES.bigPickleOk.slice(0, 15)), resolveHealthConfig({ minSamples: 3 }));
    expect(result).toBe(true);

    const stats = getConnectionHealth("conn-1", "big-pickle");
    expect(stats.samples).toBeGreaterThan(0);
  });

  it("returns false when connectionId is null", async () => {
    const result = await seedFromHistory(null, "opencode", "big-pickle");
    expect(result).toBe(false);
  });

  it("returns true (no-op) when DB returns insufficient history", async () => {
    const result = await seedFromHistory("conn-thin", "opencode", "big-pickle", makeDb(FIXTURES.bigPickleThin), resolveHealthConfig({ minSamples: 10 }));
    expect(result).toBe(true);

    const stats = getConnectionHealth("conn-thin", "big-pickle");
    expect(stats.samples).toBe(0);
  });

  it("seeds real failure samples from DB (no synthetic mixing)", async () => {
    const result = await seedFromHistory("conn-bad", "opencode", "big-pickle", makeDb(FIXTURES.bigPickleBad), resolveHealthConfig({ minSamples: 3 }));
    expect(result).toBe(true);

    const stats = getConnectionHealth("conn-bad", "big-pickle");
    expect(stats.samples).toBeGreaterThan(0);
    expect(stats.failures).toBe(stats.samples);
    expect(stats.errorRate).toBe(1.0);
  });

  it("does not seed when live samples already exist", async () => {
    recordOutcome({ connectionId: "conn-existing", ok: true, latencyMs: 50 });
    const rows = Array.from({ length: 20 }, () => ({ totalLatency: "1000", status: "200" }));
    const adapter = makeDb(rows);
    const result = await seedFromHistory("conn-existing", "claude", null, adapter, resolveHealthConfig({ minSamples: 3 }));
    expect(result).toBe(true);

    const stats = getConnectionHealth("conn-existing");
    expect(stats.samples).toBe(1);
  });

  it("sets _prior=true so first live record flips it", async () => {
    await seedFromHistory("conn-prior", "opencode", "big-pickle", makeDb(FIXTURES.bigPickleOk.slice(0, 15)), resolveHealthConfig({ minSamples: 3 }));

    const before = getConnectionHealth("conn-prior", "big-pickle");
    expect(before.samples).toBeGreaterThan(0);
    expect(before.scoped).toBe(true);

    recordOutcome({ connectionId: "conn-prior", ok: true, latencyMs: 50 });
    const after = getConnectionHealth("conn-prior", "big-pickle");
    expect(after.samples).toBeGreaterThanOrEqual(before.samples);
  });
});

describe("warmConnectionHistory", () => {
  beforeEach(() => {
    resetHealthStats();
  });

  it("calls seedFromHistory once per unique connection", async () => {
    const rows = FIXTURES.bigPickleOk.slice(0, 15);
    const adapter = makeDb(rows);

    const connections = [
      { id: "c1", provider: "opencode" },
      { id: "c2", provider: "opencode" },
      { id: "c3", provider: "opencode" },
    ];

    await warmConnectionHistory(connections, null, adapter, resolveHealthConfig({ minSamples: 3 }));

    expect(adapter.all).toHaveBeenCalledTimes(3);
    expect(getConnectionHealth("c1", "acct").samples).toBeGreaterThan(0);
    expect(getConnectionHealth("c2", "acct").samples).toBeGreaterThan(0);
    expect(getConnectionHealth("c3", "acct").samples).toBeGreaterThan(0);
  });

  it("skips null/invalid connections", async () => {
    const rows = FIXTURES.bigPickleOk.slice(0, 15);
    const adapter = makeDb(rows);

    await warmConnectionHistory([null, { id: null }, { id: "c1" }], null, adapter, resolveHealthConfig({ minSamples: 3 }));
    expect(adapter.all).toHaveBeenCalledTimes(1);
  });

  it("skips duplicates in input list", async () => {
    const rows = FIXTURES.bigPickleOk.slice(0, 15);
    const adapter = makeDb(rows);

    await warmConnectionHistory([{ id: "c1" }, { id: "c1" }, { id: "c1" }], null, adapter, resolveHealthConfig({ minSamples: 3 }));
    expect(adapter.all).toHaveBeenCalledTimes(1);
  });
});
