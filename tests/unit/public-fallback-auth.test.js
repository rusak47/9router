import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  getSettings: vi.fn(),
  resolveConnectionProxyConfig: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getProviderConnections: mocks.getProviderConnections,
  getSettings: mocks.getSettings,
  getProxyPools: vi.fn(),
  validateApiKey: vi.fn(),
  updateProviderConnection: vi.fn(),
}));
vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: mocks.resolveConnectionProxyConfig,
  pickProxyPoolId: vi.fn(),
}));
vi.mock("@/sse/utils/logger.js", () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn() }));

// Use the REAL providers.js (no mock) so AI_PROVIDERS reflects real registry entries:
// opencode (category apikey, publicFallback: true) and morph (category apikey, no flag).
const { getProviderCredentials } = await import("@/sse/services/auth.js");

describe("publicFallback credential handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSettings.mockResolvedValue({});
    mocks.resolveConnectionProxyConfig.mockResolvedValue({});
  });

  it("returns a public connection for opencode (publicFallback) when no key stored", async () => {
    mocks.getProviderConnections.mockResolvedValue([]);
    const creds = await getProviderCredentials("opencode");
    expect(creds).toMatchObject({
      id: "noauth",
      connectionName: "Public",
      accessToken: "public",
      apiKey: null,
    });
  });

  it("returns null for an apikey provider without the flag (morph) when no key stored", async () => {
    mocks.getProviderConnections.mockResolvedValue([]);
    const creds = await getProviderCredentials("morph");
    expect(creds).toBeNull();
  });

  it("prefers a real stored key over the public fallback for opencode", async () => {
    mocks.getProviderConnections.mockResolvedValue([
      { id: "oc-1", apiKey: "sk-live", isActive: true, providerSpecificData: {} },
    ]);
    const creds = await getProviderCredentials("opencode");
    expect(creds).toMatchObject({ apiKey: "sk-live", connectionId: "oc-1" });
  });
});
