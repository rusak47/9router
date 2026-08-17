import { describe, it, expect } from "vitest";
import { OpenCodeExecutor } from "../../open-sse/executors/opencode.js";

describe("OpenCodeExecutor cherry-pick (PR #3321)", () => {
  const ex = new OpenCodeExecutor();

  it("sends versioned official User-Agent", () => {
    const h = ex.buildHeaders({ rawHeaders: {} });
    expect(h["User-Agent"]).toBe("opencode/latest/1.18.18/cli");
  });

  it("passes through downstream opencode UA untouched", () => {
    const h = ex.buildHeaders({ rawHeaders: { "user-agent": "opencode/1.18.18" } });
    expect(h["User-Agent"]).toBe("opencode/1.18.18");
  });

  it("forwards public x-real-ip from request", () => {
    const h = ex.buildHeaders({ rawHeaders: { "x-9r-real-ip": "203.0.113.7" } });
    expect(h["x-real-ip"]).toBe("203.0.113.7");
  });

  it("omits x-real-ip for loopback IPs", () => {
    const h = ex.buildHeaders({ rawHeaders: { "x-9r-real-ip": "127.0.0.1" } });
    expect(h["x-real-ip"]).toBeUndefined();
    const h2 = ex.buildHeaders({ rawHeaders: { "x-9r-real-ip": "::1" } });
    expect(h2["x-real-ip"]).toBeUndefined();
    const h3 = ex.buildHeaders({ rawHeaders: { "x-9r-real-ip": "::ffff:127.0.0.1" } });
    expect(h3["x-real-ip"]).toBeUndefined();
  });

  it("omits x-real-ip for private LAN IPs", () => {
    const h = ex.buildHeaders({ rawHeaders: { "x-9r-real-ip": "10.0.0.1" } });
    expect(h["x-real-ip"]).toBeUndefined();
    const h2 = ex.buildHeaders({ rawHeaders: { "x-9r-real-ip": "192.168.1.1" } });
    expect(h2["x-real-ip"]).toBeUndefined();
    const h3 = ex.buildHeaders({ rawHeaders: { "x-9r-real-ip": "172.16.0.1" } });
    expect(h3["x-real-ip"]).toBeUndefined();
  });

  it("keeps sessions per-request under concurrency (no singleton bleed)", () => {
    const body = { messages: [{ role: "user", content: "hi" }] };
    const credA = { rawHeaders: { "x-client-session-id": "conv-a" } };
    const credB = { rawHeaders: { "x-client-session-id": "conv-b" } };

    ex.transformRequest("deepseek-v4-flash-free", body, true, credA);
    const hA = ex.buildHeaders(credA);

    ex.transformRequest("deepseek-v4-flash-free", body, true, credB);
    const hB = ex.buildHeaders(credB);

    ex.transformRequest("deepseek-v4-flash-free", body, true, credA);
    const hA2 = ex.buildHeaders(credA);

    expect(hA["x-opencode-session"]).toBe(hA2["x-opencode-session"]);
    expect(hA["x-opencode-session"]).not.toBe(hB["x-opencode-session"]);
  });

  it("keeps stable session per conversation via client headers", () => {
    const body = { messages: [{ role: "user", content: "hello" }] };
    const cred = { rawHeaders: { "x-client-session-id": "stable-conv" } };

    ex.transformRequest("deepseek-v4-flash-free", body, true, cred);
    const h1 = ex.buildHeaders(cred);
    ex.transformRequest("deepseek-v4-flash-free", body, true, cred);
    const h2 = ex.buildHeaders(cred);

    expect(h1["x-opencode-session"]).toBe(h2["x-opencode-session"]);
    expect(h1["x-opencode-session"]).toBe("stable-conv");
  });

  it("generates deterministic session from first user message", () => {
    const body = { messages: [{ role: "user", content: "repeat test" }] };
    const cred1 = { rawHeaders: {} };
    const cred2 = { rawHeaders: {} };

    ex.transformRequest("deepseek-v4-flash-free", body, true, cred1);
    const h1 = ex.buildHeaders(cred1);
    ex.transformRequest("deepseek-v4-flash-free", body, true, cred2);
    const h2 = ex.buildHeaders(cred2);

    expect(h1["x-opencode-session"]).toBe(h2["x-opencode-session"]);
    expect(h1["x-opencode-session"]).toMatch(/^ses_/);
  });
});