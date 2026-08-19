/**
 * Rolling health/latency tracker used by the `latency-aware` routing strategy.
 *
 * Every completed upstream call reports its outcome here. The tracker keeps a
 * short, time-bounded window per connection (and per connection+model) so the
 * router can score accounts on *current* conditions rather than a static order.
 *
 * Fail-open by contract: nothing in this module may throw into the request
 * path. Recording errors are swallowed; scoring always returns a candidate.
 */

import {
  HEALTH_DEFAULTS,
  HEALTH_MAX_KEYS,
  resolveHealthConfig,
} from "../config/healthConfig.js";
import { getAdapter } from "@/lib/db/driver";

const KEY_SEP = "\0";

// Single store per process. `globalThis` survives Next.js dev module reloads so
// the dashboard API route reads the same data the router writes.
function getStore() {
  if (!globalThis.__9routerHealthStore) {
    globalThis.__9routerHealthStore = new Map();
  }
  return globalThis.__9routerHealthStore;
}

/** Build the store key for a connection, optionally scoped to a model. */
export function buildHealthKey(connectionId, model = null) {
  return model ? `${connectionId}${KEY_SEP}${model}` : String(connectionId);
}

function parseHealthKey(key) {
  const idx = key.indexOf(KEY_SEP);
  if (idx === -1) return { connectionId: key, model: null };
  return { connectionId: key.slice(0, idx), model: key.slice(idx + 1) };
}

function getEntry(store, key) {
  let entry = store.get(key);
  if (!entry) {
    entry = { samples: [], lastFailureAt: 0, provider: null, connectionName: null, consecutiveTrips: 0, circuitCooldownUntil: 0, circuitHalfOpen: false, probeSucceeded: false };
    store.set(key, entry);
  }
  if (entry.consecutiveTrips === undefined) entry.consecutiveTrips = 0;
  if (entry.circuitCooldownUntil === undefined) entry.circuitCooldownUntil = 0;
  if (entry.circuitHalfOpen === undefined) entry.circuitHalfOpen = false;
  if (entry.probeSucceeded === undefined) entry.probeSucceeded = false;
  return entry;
}

/** Drop samples outside the TTL window. Mutates and returns the live array. */
function pruneSamples(entry, cfg) {
  const cutoff = Date.now() - cfg.sampleTtlMs;
  const { samples } = entry;
  // Samples are appended in time order, so trimming the head is enough.
  let firstValid = 0;
  while (firstValid < samples.length && samples[firstValid].at < cutoff) firstValid++;
  if (firstValid > 0) samples.splice(0, firstValid);
  return samples;
}

/** Evict least-recently-written keys once the store grows past its cap. */
function evictIfNeeded(store) {
  if (store.size <= HEALTH_MAX_KEYS) return;
  const overflow = store.size - HEALTH_MAX_KEYS;
  let removed = 0;
  // Map iterates in insertion order; re-inserting on write keeps it LRU-ish.
  for (const key of store.keys()) {
    store.delete(key);
    if (++removed >= overflow) break;
  }
}

/**
 * Record one completed upstream attempt.
 * Writes both a model-scoped and an account-wide entry so scoring can fall back
 * to account-level data when a specific model has too little history.
 *
 * @param {object} outcome
 * @param {string} outcome.connectionId
 * @param {boolean} outcome.ok - true when the provider returned a usable response
 * @param {number} outcome.latencyMs - time to upstream response headers
 * @param {string|null} [outcome.provider]
 * @param {string|null} [outcome.model]
 * @param {number|null} [outcome.status] - upstream HTTP status, for display only
 * @param {string|null} [outcome.connectionName]
 * @param {object|null} [outcome.config]
 */
export function recordOutcome({
  connectionId,
  ok,
  latencyMs,
  provider = null,
  model = null,
  status = null,
  connectionName = null,
  config = null,
} = {}) {
  try {
    if (!connectionId || connectionId === "noauth") return;
    const cfg = resolveHealthConfig(config);
    const store = getStore();
    const at = Date.now();
    const sample = {
      ok: !!ok,
      latencyMs: Number.isFinite(latencyMs) && latencyMs >= 0 ? latencyMs : 0,
      status: status ?? null,
      at,
    };

    const keys = [buildHealthKey(connectionId)]; //TODO why recording provider only if model passed?
    if (model) keys.push(buildHealthKey(connectionId, model));

    console.log("[healthTracker:recordOutcome] ", `connectionId: ${connectionId} model: ${model}`);

    for (const key of keys) {
      const entry = getEntry(store, key);
      if (provider) entry.provider = provider;
      if (connectionName) entry.connectionName = connectionName;
      if (entry._prior) entry._prior = false;
      const beforeLen = entry.samples.length;
      entry.samples.push(sample);
      if (!sample.ok) entry.lastFailureAt = at;
      pruneSamples(entry, cfg);
      if (entry.samples.length > cfg.windowSize) {
        entry.samples.splice(0, entry.samples.length - cfg.windowSize);
      }
      // Refresh insertion order so active keys survive eviction.
      store.delete(key);
      store.set(key, entry);
    }
    // Evaluate circuit breaker on connection-level entry (always, not just when model is null)
    const connKey = buildHealthKey(connectionId);
    const entry0 = store.get(connKey);
    if (entry0) {
      const s0 = summarize(entry0, cfg);
      // Log outcome once per call (on account-wide key only) to avoid noise
      if (!model) {
        console.log("[HEALTH]", `recordOutcome conn=${connectionId} ok=${ok} status=${status} model=${model ?? "acct"} samples=${s0.samples} failures=${s0.failures} errorRate=${s0.errorRate.toFixed(3)} lastFail=${s0.lastFailureAt ? Math.round((Date.now() - s0.lastFailureAt) / 1000) + "s" : "none"}`);
      }
      // Log circuit state change after recording
      if (s0.lastFailureAt > 0) {
        const wasHalfOpen = entry0?.circuitHalfOpen;
        const nowTripped = s0.samples >= cfg.circuitMinSamples && s0.errorRate >= cfg.circuitErrorRate;

        if (wasHalfOpen && !ok) {
          // Probe failed while half-open — re-trip with escalated backoff
          const prevTrips = entry0?.consecutiveTrips || 0;
          const newTrips = prevTrips + 1;
          const backoffMultiplier = Math.pow(cfg.circuitBackoffFactor, Math.max(0, prevTrips));
          const effectiveCooldownMs = cfg.circuitCooldownMs * backoffMultiplier;
          for (const key of keys) {
            const e = store.get(key);
            if (e) {
              e.consecutiveTrips = newTrips;
              e.circuitCooldownUntil = Date.now() + effectiveCooldownMs;
              e.circuitHalfOpen = false;
            }
          }
        } else if (wasHalfOpen && ok) {
          // Probe succeeded — flag for isCircuitOpen AND clear old failures
          // so error rate drops below threshold immediately
          for (const key of keys) {
            const e = store.get(key);
            if (e) {
              e.probeSucceeded = true;
              e.circuitHalfOpen = false;
              e.consecutiveTrips = 0;
              e.circuitCooldownUntil = 0;
              // Clear old failure samples — the probe proves connection works
              e.samples = e.samples.filter(s => s.ok);
            }
          }
        } else if (nowTripped && !(entry0?.circuitCooldownUntil > Date.now())) {
          // First trip — set initial cooldown (circuit not already in cooldown)
          for (const key of keys) {
            const e = store.get(key);
            if (e) {
              e.consecutiveTrips = (e.consecutiveTrips || 0) + 1;
              e.circuitCooldownUntil = Date.now() + cfg.circuitCooldownMs;
            }
          }
        }

        const trips = entry0?.consecutiveTrips || 0;
        const cooldownRemain = (entry0?.circuitCooldownUntil || 0) - Date.now();
        console.log("[HEALTH]", `recordOutcome conn=${connectionId} trips=${trips} cooldownRemain=${Math.round(Math.max(0, cooldownRemain)/1000)}s halfOpen=${entry0?.circuitHalfOpen || false} ok=${ok ? "OK" : "FAIL"}`);
      }
    }

    evictIfNeeded(store);
  } catch {
    // never break routing on telemetry failure
  }
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

function summarize(entry, cfg) {
  const samples = entry ? pruneSamples(entry, cfg) : [];
  const total = samples.length;
  if (total === 0) {
    return {
      samples: 0,
      successes: 0,
      failures: 0,
      errorRate: 0,
      avgLatencyMs: 0,
      p95LatencyMs: 0,
      lastFailureAt: entry?.lastFailureAt || 0,
      lastSampleAt: 0,
    };
  }

  let failures = 0;
  const okLatencies = [];
  for (const s of samples) {
    if (s.ok) okLatencies.push(s.latencyMs);
    else failures++;
  }

  // Latency is measured on successful calls only — a fast 401 is not "healthy".
  const successes = okLatencies.length;
  const avg = successes > 0 ? okLatencies.reduce((a, b) => a + b, 0) / successes : 0;
  const sorted = [...okLatencies].sort((a, b) => a - b);

  return {
    samples: total,
    successes,
    failures,
    errorRate: failures / total,
    avgLatencyMs: Math.round(avg),
    p95LatencyMs: Math.round(percentile(sorted, 95)),
    lastFailureAt: entry.lastFailureAt || 0,
    lastSampleAt: samples[samples.length - 1].at,
  };
}

/**
 * Health summary for a connection.
 * Prefers model-scoped history; falls back to account-wide once the
 * model-scoped window is too thin to be meaningful.
 *
 * @returns {{samples:number, errorRate:number, avgLatencyMs:number, p95LatencyMs:number,
 *            scoped:boolean, circuitOpen:boolean, lastFailureAt:number}}
 */
export function getConnectionHealth(connectionId, model = null, config = null) {
  const cfg = resolveHealthConfig(config);
  const store = getStore();

  let stats = null;
  let scoped = false;
  if (model) {
    const scopedStats = summarize(store.get(buildHealthKey(connectionId, model)), cfg);
    if (scopedStats.samples >= cfg.minSamples) {
      stats = scopedStats;
      scoped = true;
    }
  }
  if (!stats) stats = summarize(store.get(buildHealthKey(connectionId)), cfg);

  const entry = store.get(buildHealthKey(connectionId, model)) || store.get(buildHealthKey(connectionId));
  const healthLabel = entry?.provider ? `provider=${entry.provider} model=${model || "acct"} conn=${connectionId?.slice(0, 8)}` : null;
  return { ...stats, scoped, circuitOpen: isCircuitOpen(stats, cfg, healthLabel, entry), circuitCooldownUntil: entry?.circuitCooldownUntil || 0, circuitHalfOpen: entry?.circuitHalfOpen || false, consecutiveTrips: entry?.consecutiveTrips || 0 };
}

/**
 * A circuit is open when a connection failed often enough recently.
 * It re-closes automatically once the cooldown passes since the last failure.
 */
export function isCircuitOpen(stats, config = null, label = null, entry = null) {
  const cfg = resolveHealthConfig(config);

  // 1) Active cooldown — stay OPEN. circuitCooldownUntil is a standalone
  //    timestamp that TTL pruning cannot erase.
  if (entry?.circuitCooldownUntil && Date.now() < entry.circuitCooldownUntil) {
    const remaining = entry.circuitCooldownUntil - Date.now();
    console.log("[HEALTH]", `isCircuitOpen${label ? " " + label : ""} trips=${entry.consecutiveTrips || 0} in-cooldown cooldownRemain=${Math.round(remaining/1000)}s → OPEN`);
    return true;
  }

  // 2) In HALF_OPEN — allow exactly one probe request. Do not escalate
  //    based on stale samples from before the cooldown.
  if (entry?.circuitHalfOpen) {
    console.log("[HEALTH]", `isCircuitOpen${label ? " " + label : ""} half-open (probe allowed)`);
    return false;
  }

  // 2.5) Successful probe just arrived — treat as full recovery
  if (entry?.probeSucceeded) {
    entry.consecutiveTrips = 0;
    entry.circuitCooldownUntil = 0;
    entry.circuitHalfOpen = false;
    entry.probeSucceeded = false;
    console.log("[HEALTH]", `isCircuitOpen${label ? " " + label : ""} probe-success → closed`);
    return false;
  }

  // 3) Cooldown expired (or never set) — evaluate error rate from samples
  if (!stats || stats.samples < cfg.circuitMinSamples) {
    console.log("[HEALTH]", `isCircuitOpen${label ? " " + label : ""} samples=${stats?.samples ?? 0} < min=${cfg.circuitMinSamples} → closed`);
    return false;
  }
  if (stats.errorRate < cfg.circuitErrorRate) {
    // Actual recovery — error rate improved, reset trips
    if (entry) {
      entry.consecutiveTrips = 0;
      entry.circuitCooldownUntil = 0;
    }
    console.log("[HEALTH]", `isCircuitOpen${label ? " " + label : ""} errorRate=${stats.errorRate.toFixed(3)} < threshold=${cfg.circuitErrorRate} → closed`);
    return false;
  }
  if (!stats.lastFailureAt) {
    return false;
  }

  // 4) Cooldown expired but error rate still high — enter HALF_OPEN.
  //    Return false so one probe request can test the connection.
  //    Escalation happens in recordOutcome when the probe result arrives.
  if (entry) {
    entry.circuitHalfOpen = true;
  }
  console.log("[HEALTH]", `isCircuitOpen${label ? " " + label : ""} errorRate=${stats.errorRate.toFixed(3)} samples=${stats.samples} trips=${entry?.consecutiveTrips || 0} cooldown-expired → half-open (probe allowed)`);
  return false;
}

/**
 * Score a candidate — lower is better.
 *
 * Latency is normalized as a *ratio* against the fastest candidate, not min-max
 * across the set: min-max would score a 110ms account as maximally slow just
 * because its peer sits at 100ms, letting trivial gaps outweigh real failures.
 */
function scoreCandidate(stats, minLatency, cfg) {
  let latNorm = 0;
  if (minLatency > 0 && stats.avgLatencyMs > minLatency) {
    const ratio = stats.avgLatencyMs / minLatency;
    latNorm = Math.min(1, (ratio - 1) / cfg.latencyToleranceRatio);
  }
  const weightSum = cfg.latencyWeight + cfg.errorWeight;
  if (weightSum <= 0) return 0;
  return (cfg.latencyWeight * latNorm + cfg.errorWeight * stats.errorRate) / weightSum;
}

/**
 * Pick the healthiest connection for the current conditions.
 *
 * Order of preference:
 *  1. Unproven candidates (too few samples) — probed first so every account
 *     earns real data before it can be ranked or skipped.
 *  2. Closed-circuit candidates ranked by score, with an exploration chance.
 *  3. If every candidate has an open circuit, the breaker is ignored rather
 *     than failing the request.
 *
 * @param {Array<object>} candidates - connection records (need `.id`)
 * @param {object} [opts]
 * @param {string|null} [opts.model]
 * @param {object|null} [opts.config]
 * @param {function} [opts.random] - injectable RNG for deterministic tests
 * @returns {{connection: object|null, reason: string, scored: Array}}
 */
export function selectHealthiestConnection(candidates, { model = null, config = null, random = Math.random } = {}) {
  const list = Array.isArray(candidates) ? candidates.filter(Boolean) : [];
  if (list.length === 0) return { connection: null, reason: "no-candidates", scored: [] };
  if (list.length === 1) return { connection: list[0], reason: "only-candidate", scored: [] };

  const cfg = resolveHealthConfig(config);
  const scored = list.map((connection) => {
    const h = getConnectionHealth(connection.id, model, cfg);
    console.log("[HEALTH]", `selectHealthiest conn=${connection.id} name=${connection.name} model=${model} samples=${h.samples} errorRate=${h.errorRate.toFixed(3)} circuitOpen=${h.circuitOpen} reason=pick`);
    return { connection, health: h };
  });

  // 1) Probe anything we don't know enough about yet (lowest priority number first).
  const unproven = scored.filter((s) => s.health.samples < cfg.minSamples);
  if (unproven.length > 0) {
    const pick = unproven.sort(
      (a, b) =>
        a.health.samples - b.health.samples ||
        (a.connection.priority || 999) - (b.connection.priority || 999)
    )[0];
    return { connection: pick.connection, reason: "probe-unproven", scored };
  }

  // 2) Rank the rest, skipping tripped circuits.
  let pool = scored.filter((s) => !s.health.circuitOpen);
  let reason = "best-score";
  if (pool.length === 0) {
    // Everything is unhealthy — degrade gracefully instead of erroring out.
    pool = scored;
    // Show shortest cooldown remaining so UI can display "retry in Xs"
    const minCooldown = Math.min(...scored.map(s => {
      const h = s.health;
      const remaining = (h.circuitCooldownUntil || 0) - Date.now();
      return h.circuitOpen && remaining > 0 ? remaining : Infinity;
    }));
    if (minCooldown !== Infinity && minCooldown > 0) {
      reason = `all-circuits-open (retry in ${Math.ceil(minCooldown / 1000)}s)`;
    } else {
      reason = "all-circuits-open";
    }
  }

  const positiveLatencies = pool.map((s) => s.health.avgLatencyMs).filter((v) => v > 0);
  const minLatency = positiveLatencies.length > 0 ? Math.min(...positiveLatencies) : 0;
  for (const s of pool) s.score = scoreCandidate(s.health, minLatency, cfg);

  const ranked = [...pool].sort(
    (a, b) => a.score - b.score || (a.connection.priority || 999) - (b.connection.priority || 999)
  );

  // 3) Occasionally try a non-best candidate so stale scores get refreshed.
  if (ranked.length > 1 && cfg.explorationRate > 0 && random() < cfg.explorationRate) {
    const alternatives = ranked.slice(1);
    const pick = alternatives[Math.floor(random() * alternatives.length) % alternatives.length];
    return { connection: pick.connection, reason: "explore", scored };
  }

  return { connection: ranked[0].connection, reason, scored };
}

/**
 * All tracked stats, for the dashboard.
 * @returns {Array<object>} one row per connection (+ per model breakdown)
 */
export function getAllHealthStats(config = null) {
  const cfg = resolveHealthConfig(config);
  const store = getStore();
  const rows = [];
  for (const [key, entry] of store.entries()) {
    const { connectionId, model } = parseHealthKey(key);
    const stats = summarize(entry, cfg);
    if (stats.samples === 0 && !stats.circuitOpen && (!stats.lastFailureAt || Date.now() - stats.lastFailureAt > cfg.sampleTtlMs)) continue;
    const circuitOpen = isCircuitOpen(stats, cfg, `provider=${entry?.provider || "?"} model=${model || "acct"} conn=${connectionId?.slice(0, 8)}`, entry);
    let cooldownRemainingMs = 0;
    if (entry?.circuitCooldownUntil) {
      cooldownRemainingMs = Math.max(0, (entry.circuitCooldownUntil || 0) - Date.now());
    }
    rows.push({
      connectionId,
      model,
      provider: entry.provider || null,
      circuitCooldownUntil: entry.circuitCooldownUntil || 0,
      circuitHalfOpen: entry.circuitHalfOpen || false,
      connectionName: entry.connectionName || null,
      ...stats,
      circuitOpen,
      cooldownRemainingMs,
    });
  }
  // Account-wide rows first, then per-model, worst health on top.
  return rows.sort(
    (a, b) =>
      (a.model ? 1 : 0) - (b.model ? 1 : 0) ||
      b.errorRate - a.errorRate ||
      b.avgLatencyMs - a.avgLatencyMs
  );
}

/**
 * Clear tracked history.
 * @param {string|null} connectionId - clear one connection, or all when null
 */
export function resetHealthStats(connectionId = null) {
  const store = getStore();
  if (!connectionId) {
    store.clear();
    return;
  }
  for (const key of [...store.keys()]) {
    if (parseHealthKey(key).connectionId === connectionId) store.delete(key);
  }
}


async function seedFromHistory(connectionId, provider = null, model = null, injectedDb = null, config = null) {
  try {
    if (!connectionId) return false;
    const cfg = resolveHealthConfig(config);
    const store = getStore();

    const keys = [buildHealthKey(connectionId)];
    if (model) keys.push(buildHealthKey(connectionId, model));
    
    if (!injectedDb) {
      console.debug(`[seedFromHistory] not passed DB`);
      try {
        injectedDb = await getAdapter();
      } catch (e) {
        console.debug(`[seedFromHistory] skip DB - error connection=${connectionId} err=${e.message}`);
        return false;
      }
      if (!injectedDb){
        console.debug(`[seedFromHistory] skip DB - await returned nothing`);          
        return false;
      } 
    }

    for (const key of keys) {
      const entry = store.get(key);
      if (entry && entry.samples && entry.samples.length > 0) {
        console.debug(`[seedFromHistory] skip - already has samples connection=${connectionId} model=${model} samples: ${entry.samples.length}`);
        continue;
      }

      const sql = model
        ? "SELECT totalLatency, status, timestamp FROM usageHistory WHERE provider = ? AND model = ? AND totalLatency IS NOT NULL ORDER BY timestamp DESC LIMIT ?"
        : "SELECT totalLatency, status, timestamp FROM usageHistory WHERE provider = ? AND totalLatency IS NOT NULL ORDER BY timestamp DESC LIMIT ?";
      const params = model ? [provider, model, cfg.windowSize] : [provider, cfg.windowSize];
      const rows = injectedDb.all(sql, params);

      if (!rows || rows.length < cfg.minSamples) {
        console.debug(`[seedFromHistory] connection=${connectionId} model=${model || "acct"} provider=${provider} rows=${rows?.length ?? 0} < minSamples=${cfg.minSamples}`);
        continue;
      }

      const okLatencies = [];
      let failures = 0;
      let latestFailureAt = 0;
      for (const r of rows) {
        const status = Number(r.status);
        const isFailure = r.status === "error" || (status >= 400 && status < 600) || status === 0;
        if (isFailure) {
          failures++;
          const t = Date.parse(r.timestamp);
          if (t > latestFailureAt) latestFailureAt = t;
        }
        else okLatencies.push(Number(r.totalLatency));
      }

      const entryNew = getEntry(store, key);
      if (provider) entryNew.provider = provider;
      entryNew._prior = true;
      entryNew.lastFailureAt = latestFailureAt > 0 ? latestFailureAt : (entryNew.lastFailureAt || 0);
      entryNew.samples = [];

      const sampleCount = Math.min(rows.length, cfg.windowSize);
      for (let i = 0; i < sampleCount; i++) {
        const r = rows[i];
        const statusNum = Number(r.status);
        const isFailure = r.status === "error" || (statusNum >= 400 && statusNum < 600) || statusNum === 0;
        const sample = {
          ok: !isFailure,
          latencyMs: Number(r.totalLatency) || 0,
          at: Date.now() - (sampleCount - i) * 30000,
        };
        entryNew.samples.push(sample);
      }

      console.debug(`[seedFromHistory] connection=${connectionId} model=${model || "acct"} provider=${provider} samples=${entryNew.samples.length} ok=${entryNew.samples.filter(s=>s.ok).length} failures=${entryNew.samples.filter(s=>!s.ok).length} lastFailure=${new Date(entryNew.lastFailureAt||0).toISOString()}`);
      store.delete(key);
      store.set(key, entryNew);
    }
    return true;
  } catch {
    return false;
  }
}

async function warmConnectionHistory(connections, model = null, injectedDb = null, config = null) {
  console.debug(`[warmConnectionHistory] seeding ${connections.length} connections`);
  const list = Array.isArray(connections) ? connections : [];
  const seen = new Set();
  if (!injectedDb) {
    try {
      injectedDb = await getAdapter();
    } catch (e) {
      console.debug(`[warmConnectionHistory] skip DB - error err=${e.message}`);
      return;
    }
    if (!injectedDb) {
      console.debug(`[warmConnectionHistory] skip DB - await returned nothing`);
      return;
    }
  }
  for (const conn of list) {
    if (!conn || !conn.id || seen.has(conn.id)) continue;
    seen.add(conn.id);
    await seedFromHistory(conn.id, conn.provider, model, injectedDb, config);
  }
}


export { HEALTH_DEFAULTS, resolveHealthConfig, seedFromHistory, warmConnectionHistory };
