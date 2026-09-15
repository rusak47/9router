import { beforeEach, describe, it, expect } from "vitest";
import {
  recordOutcome,
  resetHealthStats,
  getConnectionHealth,
  resolveHealthConfig,
} from "open-sse/services/healthTracker.js";
import * as hc from "open-sse/config/healthConfig.js";

/** Seed entry with enough failures to trip the breaker. */
function seedTripped(connectionId, sampleCount = 10, failureRatio = 0.8, injectedDb = null) {
  const samples = Array.from({ length: sampleCount }, (_, i) => ({
    ok: Math.random() > failureRatio,
    latencyMs: 100,
    status: null,
    at: Date.now() - (sampleCount - i) * 1000,
  }));
  const entry = {
    samples,
    lastFailureAt: Date.now(),
    provider: null,
    connectionName: null,
    consecutiveTrips: 0,
    circuitCooldownUntil: 0,
    circuitHalfOpen: false,
    probeSucceeded: false,
  };
  globalThis.__9routerHealthStore ||= new Map();
  const key = `^@${connectionId}`;
  // Use account-wide key (no model)
  globalThis.__9routerHealthStore.set(connectionId, entry);
  return entry;
}

describe("circuit cooldown cap", () => {
  beforeEach(() => {
    resetHealthStats();
    globalThis.__9routerHealthStore = new Map();
  });

  it("clamps escalated cooldown to circuitCooldownMaxMs on default config", () => {
    const cfg = hc.resolveHealthConfig();
    expect(cfg.circuitCooldownMaxMs).toBe(60 * 60 * 1000);

    const conn = "conn-default-cap";
    // Seed many failures to trip
    seedTripped(conn, 10, 0.8);
    // Manually put into half-open with cooldown just expired
    const entry = globalThis.__9routerHealthStore.get(conn);
    entry.circuitHalfOpen = true;
    entry.circuitCooldownUntil = 0;
    entry.consecutiveTrips = 5; // already tripped 5 times

    // Probe fails repeatedly — each time should re-trip with escalation capped
    for (let i = 0; i < 10; i++) {
      recordOutcome({ connectionId: conn, ok: false, latencyMs: 200, config: cfg });
    }

    const finalEntry = globalThis.__9routerHealthStore.get(conn);
    const cooldownRemain = finalEntry.circuitCooldownUntil - Date.now();
    // Should never exceed the max + a small epsilon (in-flight drift)
    expect(cooldownRemain).toBeLessThanOrEqual(cfg.circuitCooldownMaxMs + 1000);
    // But also be positive (still in cooldown)
    expect(cooldownRemain).toBeGreaterThan(0);
  });

  it("respects a user-supplied circuitCooldownMaxMs override", () => {
    const customConfig = {
      circuitCooldownMs: 1000,
      circuitBackoffFactor: 2.0,
      circuitCooldownMaxMs: 5000,
    };
    const resolved = hc.resolveHealthConfig(customConfig);
    expect(resolved.circuitCooldownMaxMs).toBe(5000);

    const conn = "conn-custom-cap";
    seedTripped(conn, 10, 0.8);
    const entry = globalThis.__9routerHealthStore.get(conn);
    entry.circuitHalfOpen = true;
    entry.circuitCooldownUntil = 0;
    entry.consecutiveTrips = 0;

    for (let i = 0; i < 20; i++) {
      recordOutcome({ connectionId: conn, ok: false, latencyMs: 50, config: resolved });
    }

    const finalEntry = globalThis.__9routerHealthStore.get(conn);
    const cooldownRemain = finalEntry.circuitCooldownUntil - Date.now();
    expect(cooldownRemain).toBeLessThanOrEqual(5000 + 1000);
  });

  it("stays within cap even with very large backoffFactor", () => {
    const cfg = hc.resolveHealthConfig({
      circuitCooldownMs: 1000,
      circuitBackoffFactor: 10.0,
      circuitCooldownMaxMs: 3_600_000,
    });

    const conn = "conn-huge-backoff";
    seedTripped(conn, 10, 0.8);
    const entry = globalThis.__9routerHealthStore.get(conn);
    entry.circuitHalfOpen = true;
    entry.circuitCooldownUntil = 0;
    entry.consecutiveTrips = 10;

    for (let i = 0; i < 5; i++) {
      recordOutcome({ connectionId: conn, ok: false, latencyMs: 50, config: cfg });
    }

    const finalEntry = globalThis.__9routerHealthStore.get(conn);
    const cooldownRemain = finalEntry.circuitCooldownUntil - Date.now();
    expect(cooldownRemain).toBeLessThanOrEqual(cfg.circuitCooldownMaxMs + 1000);
  });

  it("clamp circuitCooldownMaxMs out-of-range via resolveHealthConfig", () => {
    const under = hc.resolveHealthConfig({ circuitCooldownMaxMs: 0 });
    expect(under.circuitCooldownMaxMs).toBe(hc.HEALTH_LIMITS.circuitCooldownMaxMs.min);

    const over = hc.resolveHealthConfig({ circuitCooldownMaxMs: 999_999_999 });
    expect(over.circuitCooldownMaxMs).toBe(hc.HEALTH_LIMITS.circuitCooldownMaxMs.max);
  });
});
