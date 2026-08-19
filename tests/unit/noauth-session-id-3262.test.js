// #3262 — no-auth free providers (opencode, mimo-free, mmf, ...) were minting a fresh
// random session id per turn, causing FreeUsageLimitError on the first tool call.
// fix: virtual connection carries a stable connectionId="noauth" sentinel so deriveSessionId
// is stable across turns.

import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  getSettings: vi.fn(),
  getProxyPools: vi.fn(),
  getProviderConnections: vi.fn(),
  updateProviderConnection: vi.fn(),
  resolveConnectionProxyConfig: vi.fn(),
  pickProxyPoolId: vi.fn(),
  getAntigravityQuotaCache: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getSettings: mocks.getSettings,
  getProxyPools: mocks.getProxyPools,
  getProviderConnections: mocks.getProviderConnections,
  updateProviderConnection: mocks.updateProviderConnection,
}));

vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: mocks.resolveConnectionProxyConfig,
  pickProxyPoolId: mocks.pickProxyPoolId,
}));

vi.mock("./antigravityQuota.js", () => ({
  getAntigravityQuotaCache: mocks.getAntigravityQuotaCache,
}));

const { getProviderCredentials, markAccountUnavailable, clearAccountError } = await import(
  "../../src/sse/services/auth.js"
);

describe("no-auth free provider virtual connection (#3262)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSettings.mockResolvedValue({});
    mocks.getProxyPools.mockResolvedValue([]);
    mocks.resolveConnectionProxyConfig.mockResolvedValue({ connectionProxyEnabled: false, connectionProxyUrl: "", connectionNoProxy: [], proxyPoolId: null, vercelRelayUrl: "" });
    mocks.pickProxyPoolId.mockReturnValue(null);
  });

  it("returns stable noauth connection for free providers with no credentials stored", async () => {
    const conn = await getProviderCredentials("opencode");

    expect(conn).not.toBeNull();
    expect(conn.id).toBe("noauth");
    expect(conn.connectionId).toBe("noauth");
    expect(conn.accessToken).toBe("public");
    expect(conn.isActive).toBe(true);
  });

  it("does not query stored provider connections on no-auth path", async () => {
    mocks.getProviderConnections.mockResolvedValue([]);
    await getProviderCredentials("opencode");
    expect(mocks.getProviderConnections).not.toHaveBeenCalled();
  });

  it("markAccountUnavailable is a no-op safe sentinel for noauth", async () => {
    const res = await markAccountUnavailable("noauth", 429, "rate limited", "opencode");
    expect(res).toEqual({ shouldFallback: false, cooldownMs: 0 });
    expect(mocks.updateProviderConnection).not.toHaveBeenCalled();
  });

  it("clearAccountError is a no-op safe sentinel for noauth", async () => {
    const res = await clearAccountError("noauth", { id: "noauth" }, null);
    expect(res).toBeUndefined();
    expect(mocks.updateProviderConnection).not.toHaveBeenCalled();
  });
});
