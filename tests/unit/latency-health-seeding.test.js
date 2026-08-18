import { beforeEach, describe, it, expect, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getAdapter: vi.fn() }));

vi.mock("@/lib/db/driver", () => ({ getAdapter: mocks.getAdapter }));
vi.mock("@/lib/localDb", () => ({ getSettings: vi.fn() }));
vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: vi.fn(async () => ({
    connectionProxyEnabled: false,
    connectionProxyUrl: "",
    connectionNoProxy: "",
    proxyPoolId: null,
    vercelRelayUrl: "",
  })),
  pickProxyPoolId: vi.fn(() => null),
}));
vi.mock("@/shared/constants/providers.js", () => ({
  resolveProviderId: (p) => p,
  FREE_PROVIDERS: {},
}));
vi.mock("@/sse/utils/logger.js", () => ({
  info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), request: vi.fn(),
  maskKey: vi.fn(() => "masked"),
}));

import {
  seedFromHistory,
  warmConnectionHistory,
  resetHealthStats,
  recordOutcome,
  getConnectionHealth,
  resolveHealthConfig,
} from "open-sse/services/healthTracker.js";

function makeDbRows(results) {
  return results.map((r) => ({ totalLatency: r.latency, status: r.status ?? null }));
}

function buildMockAdapter(rows) {
  const db = {
    all: vi.fn(() => rows),
    get: vi.fn(),
    run: vi.fn(),
    transaction: vi.fn(),
  };
  return db;
}

describe("seedFromHistory", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetHealthStats();
  });

  it("creates prior samples from DB when no live samples exist", async () => {
    const rows = Array.from({ length: 15 }, (_, i) => ({ totalLatency: String(100 + i * 10), status: "200" }));
    const adapter = buildMockAdapter(rows);
    mocks.getAdapter.mockResolvedValue(adapter);

    const result = await seedFromHistory("conn-1", "claude", null, adapter, resolveHealthConfig({ minSamples: 3 }));
    expect(result).toBe(true);

    const stats = getConnectionHealth("conn-1");
    expect(stats.samples).toBeGreaterThan(0);
  });

  it("uses getAdapter when injectedDb is missing", async () => {
    mocks.getAdapter.mockReturnValue(undefined);
    const result = await seedFromHistory("conn-empty", "claude", null, null);
    // debug removed
    expect(result).toBe(false); // still fails because adapter is undefined
  });

  it("returns true (no-op) when DB returns insufficient history", async () => {
    const rows = Array.from({ length: 2 }, (_, i) => ({ totalLatency: String(100 + i * 10), status: "200" }));
    const adapter = buildMockAdapter(rows);
    mocks.getAdapter.mockResolvedValue(adapter);

    const result = await seedFromHistory("conn-thin", "claude", null, adapter, resolveHealthConfig({ minSamples: 10 }));
    expect(result).toBe(true);

    const stats = getConnectionHealth("conn-thin");
    expect(stats.samples).toBe(0);
  });

  it("seeds real failure samples from DB (no synthetic mixing)", async () => {
    const rows = Array.from({ length: 15 }, () => ({ totalLatency: "1000", status: "500" }));
    const adapter = buildMockAdapter(rows);
    mocks.getAdapter.mockResolvedValue(adapter);

    const result = await seedFromHistory("conn-bad", "claude", null, adapter, resolveHealthConfig({ minSamples: 3 }));
    expect(result).toBe(true);

    const stats = getConnectionHealth("conn-bad");
    expect(stats.samples).toBeGreaterThan(0);
    expect(stats.failures).toBe(stats.samples);
    expect(stats.errorRate).toBe(1.0);
  });

  it("does not seed when live samples already exist", async () => {
    recordOutcome({ connectionId: "conn-existing", ok: true, latencyMs: 50 });
    const rows = Array.from({ length: 20 }, () => ({ totalLatency: "1000", status: "200" }));
    const adapter = buildMockAdapter(rows);
    mocks.getAdapter.mockResolvedValue(adapter);

    const result = await seedFromHistory("conn-existing", "claude", null, adapter, resolveHealthConfig({ minSamples: 3 }));
    expect(result).toBe(true);

    const stats = getConnectionHealth("conn-existing");
    expect(stats.samples).toBe(1);
  });

  it("sets _prior=true so first live record flips it", async () => {
    const rows = Array.from({ length: 15 }, (_, i) => ({ totalLatency: String(80 + i * 5), status: "200" })); // 80-152ms, avg ~116
    const adapter = buildMockAdapter(rows);
    mocks.getAdapter.mockResolvedValue(adapter);

    await seedFromHistory("conn-prior", "claude", null, adapter, resolveHealthConfig({ minSamples: 3 }));

    const before = getConnectionHealth("conn-prior");
    expect(before.samples).toBeGreaterThan(0);

    recordOutcome({ connectionId: "conn-prior", ok: true, latencyMs: 50 });
    const after = getConnectionHealth("conn-prior");
    expect(after.avgLatencyMs).toBeLessThan(120);
  });
});

describe("warmConnectionHistory", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetHealthStats();
  });

  it("calls seedFromHistory once per unique connection", async () => {
    const rows = Array.from({ length: 15 }, () => ({ totalLatency: "200", status: "200" }));
    const adapter = buildMockAdapter(rows);
    mocks.getAdapter.mockResolvedValue(adapter);

    const connections = [
      { id: "c1", provider: "claude" },
      { id: "c2", provider: "gemini" },
      { id: "c3", provider: "groq" },
    ];

    await warmConnectionHistory(connections, null, adapter, resolveHealthConfig({ minSamples: 3 }));

    expect(adapter.all).toHaveBeenCalledTimes(3);
    expect(getConnectionHealth("c1").samples).toBeGreaterThan(0);
    expect(getConnectionHealth("c2").samples).toBeGreaterThan(0);
    expect(getConnectionHealth("c3").samples).toBeGreaterThan(0);
  });

  it("skips null/invalid connections", async () => {
    const rows = Array.from({ length: 15 }, () => ({ totalLatency: "200", status: "200" }));
    const adapter = buildMockAdapter(rows);
    mocks.getAdapter.mockResolvedValue(adapter);

    await warmConnectionHistory([null, { id: null }, { id: "c1" }], null, adapter, resolveHealthConfig({ minSamples: 3 }));
    expect(adapter.all).toHaveBeenCalledTimes(1);
  });

  it("skips duplicates in input list", async () => {
    const rows = Array.from({ length: 15 }, () => ({ totalLatency: "200", status: "200" }));
    const adapter = buildMockAdapter(rows);
    mocks.getAdapter.mockResolvedValue(adapter);

    await warmConnectionHistory([{ id: "c1" }, { id: "c1" }, { id: "c1" }], null, adapter, resolveHealthConfig({ minSamples: 3 }));
    expect(adapter.all).toHaveBeenCalledTimes(1);
  });
});
