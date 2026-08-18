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
    entry = { samples: [], lastFailureAt: 0, provider: null, connectionName: null };
    store.set(key, entry);
  }
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
    // Log outcome once per call (on account-wide key only) to avoid noise
    if (!model) {
      const entry0 = getEntry(store, buildHealthKey(connectionId));
      const s0 = summarize(entry0, cfg);
      console.log("[HEALTH]", `recordOutcome conn=${connectionId} ok=${ok} status=${status} model=${model ?? "acct"} samples=${s0.samples} failures=${s0.failures} errorRate=${s0.errorRate.toFixed(3)} lastFail=${s0.lastFailureAt ? Math.round((Date.now() - s0.lastFailureAt) / 1000) + "s" : "none"}`);
      // Log circuit state change after recording
      if (s0.lastFailureAt > 0) {
        const remaining = cfg.circuitCooldownMs - (Date.now() - s0.lastFailureAt);
        console.log("[HEALTH]", `recordOutcome conn=${connectionId} circuitCooldownRemaining=${Math.round(remaining/1000)}s ok=${s0.samples >= cfg.circuitMinSamples && s0.errorRate >= cfg.circuitErrorRate ? "TRIPPED" : "OK"}`);
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

  return { ...stats, scoped, circuitOpen: isCircuitOpen(stats, cfg) };
}

/**
 * A circuit is open when a connection failed often enough recently.
 * It re-closes automatically once the cooldown passes since the last failure.
 */
export function isCircuitOpen(stats, config = null) {
  const cfg = resolveHealthConfig(config);
  if (!stats || stats.samples < cfg.circuitMinSamples) {
    console.log("[HEALTH]", `isCircuitOpen samples=${stats?.samples ?? 0} < min=${cfg.circuitMinSamples} → closed ${JSON.stringify(stats)}`);
    return false;
  }
  if (stats.errorRate < cfg.circuitErrorRate) {
    console.log("[HEALTH]", `isCircuitOpen errorRate=${stats.errorRate.toFixed(3)} < threshold=${cfg.circuitErrorRate} → closed`);
    return false;
  }
  if (!stats.lastFailureAt) return false;
  const remaining = cfg.circuitCooldownMs - (Date.now() - stats.lastFailureAt); //TODO why backoff is missing here? 
  const open = remaining > 0;
  console.log("[HEALTH]", `isCircuitOpen errorRate=${stats.errorRate.toFixed(3)} samples=${stats.samples} cooldownRemain=${Math.round(remaining/1000)}s → ${open ? "OPEN" : "closed (expired)"}`);
  return open;
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
    reason = "all-circuits-open";
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
    rows.push({
      connectionId,
      model,
      provider: entry.provider || null,
      connectionName: entry.connectionName || null,
      ...stats,
      circuitOpen: isCircuitOpen(stats, cfg),
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

      const sorted = okLatencies.sort((a, b) => a - b);
      const median = sorted.length > 0 ? sorted[Math.floor(sorted.length / 2)] : 5000; // fallback 5s when no ok latencies

      const weight = Math.max(1, Math.floor(cfg.minSamples * 0.7));
      const entryNew = getEntry(store, key);
      if (provider) entryNew.provider = provider;
      entryNew._prior = true;
      entryNew.lastFailureAt = latestFailureAt > 0 ? latestFailureAt : (entryNew.lastFailureAt || 0);
      entryNew.samples = [];

      const okCount = Math.max(1, Math.round(weight * (1 - failures / rows.length)));
      for (let i = 0; i < okCount; i++) {
        entryNew.samples.push({ ok: true, latencyMs: sorted.length > 0 ? sorted[i % sorted.length] : median, at: Date.now() });
      }
      const failCount = weight - okCount;
      for (let i = 0; i < failCount; i++) {
        entryNew.samples.push({ ok: false, latencyMs: median, at: Date.now() });
      }

      console.debug(`[seedFromHistory] connection=${connectionId} model=${model || "acct"} provider=${provider} samples=${entryNew.samples.length} ok=${entryNew.samples.filter(s=>s.ok).length} failures=${entryNew.samples.filter(s=>!s.ok).length} provider=${entryNew.provider||"?"} lastFailure=${new Date(entryNew.lastFailureAt||0).toISOString()}`);
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
