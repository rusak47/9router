import crypto from "crypto";
import https from "https";
import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import { getThinkingLevels } from "../providers/thinkingLevels.js";
import { injectReasoningContent } from "../utils/reasoningContentInjector.js";
import { resolveSessionId } from "../utils/sessionManager.js";
import { isMuseSparkModel } from "../providers/models/helpers.js";

// Machine's real public IPv4, discovered once (direct https — intentionally
// NOT patched proxy-aware fetch, so we learn home/public egress even
// while outbound proxy enabled).
let _publicIp = null;
let _publicIpFetching = false;
const PUBLIC_IP_PROBES = ["https://4.icanhazip.com", "https://ip.sb", "https://ifconfig.me/ip"];

function discoverPublicIp() {
  if (_publicIp || _publicIpFetching) return _publicIp;
  _publicIpFetching = true;
  const probe = (url, cb) => {
    https.get(url, { timeout: 4000 }, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => cb(d.trim()));
    }).on("error", () => cb(""));
  };
  const accept = (v) => /^(\d{1,3}\.){3}\d{1,3}$/.test(v);
  probe(PUBLIC_IP_PROBES[0], (v) => {
    if (accept(v)) {
      _publicIp = v;
      _publicIpFetching = false;
      return;
    }
    probe(PUBLIC_IP_PROBES[1], (v2) => {
      if (accept(v2)) {
        _publicIp = v2;
        _publicIpFetching = false;
        return;
      }
      probe(PUBLIC_IP_PROBES[2], (v3) => {
        _publicIp = accept(v3) ? v3 : "";
        _publicIpFetching = false;
      });
    });
  });
  return _publicIp;
}

// Private/loopback IPs that should NOT be forwarded as x-real-ip
function isPrivateIp(ip) {
  if (!ip || typeof ip !== "string") return true;
  const clean = ip.replace(/^::ffff:/, "").trim();
  if (clean === "127.0.0.1" || clean === "::1" || clean === "localhost") return true;
  if (clean.startsWith("10.") || clean.startsWith("192.168.")) return true;
  if (/^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(clean)) return true;
  if (clean.startsWith("fc00:") || clean.startsWith("fe80:")) return true;
  return false;
}

const OPENCODE_UA = "opencode/latest/1.18.18/cli";
// Models served by /zen/v1/responses; every other model stays on /chat/completions.
const RESPONSES_MODELS = new Set([
  "muse-spark-1.2-contributor-free",
  "muse-spark-1.3-contributor-free",
]);

function generateRequestId() {
  return `msg_${crypto.randomUUID().replace(/-/g, "")}`;
}

function generateSessionId() {
  return `ses_${crypto.randomUUID().replace(/-/g, "")}`;
}

// Strip the thinking suffix "model(level)" so registry lookups hit the base id.
function baseModelId(model) {
  return String(model || "").replace(/\([^()]+\)\s*$/, "").trim();
}

function isResponsesModel(model) {
  const base = baseModelId(model);
  return RESPONSES_MODELS.has(base) || isMuseSparkModel(base);
}

function resolveOpencodeSession(body, credentials) {
  // Try to get session from client headers first (conversation continuity)
  const raw = credentials?.rawHeaders || {};
  const clientSession = raw["x-client-session-id"] || raw["x-opencode-session"];
  if (clientSession) return clientSession;

  // Fallback: derive from request body conversation pattern (stable for same convo)
  const messages = body?.messages || [];
  const firstUser = messages.find((m) => m?.role === "user");
  if (firstUser?.content) {
    return `ses_${crypto.createHash("sha256").update(String(firstUser.content)).digest("hex").slice(0, 12)}`;
  }
  // Ultimate fallback: use upstream session manager
  return resolveSessionId({
    headers,
    body,
    connectionId: credentials?.connectionId,
    scope: "opencode",
    generate: generateSessionId,
  });
}

function normalizeOpencodeReasoning(model, body) {
  const current = body.reasoning;
  const currentReasoning = current && typeof current === "object" && !Array.isArray(current)
    ? current
    : null;
  const requestedEffort = typeof body.reasoning_effort === "string"
    ? body.reasoning_effort
    : currentReasoning?.effort;
  if (typeof requestedEffort !== "string") return;

  const cleanModel = baseModelId(model || body.model);
  const supportedLevels = getThinkingLevels("opencode", cleanModel);
  let effort = requestedEffort.toLowerCase().trim();
  if ((effort === "max" || effort === "ultra") && supportedLevels?.length && !supportedLevels.includes(effort)) {
    if (effort === "ultra" && supportedLevels.includes("max")) effort = "max";
    else if (supportedLevels.includes("xhigh")) effort = "xhigh";
  }

  body.reasoning = { ...currentReasoning, effort };
  if (!body.reasoning.summary) body.reasoning.summary = "auto";
  delete body.reasoning_effort;
}

export class OpenCodeExecutor extends BaseExecutor {
  constructor() {
    super("opencode", PROVIDERS.opencode);
    this._currentSessionId = null;
  }

  transformRequest(model, body, stream = true, credentials) {
    // Stash resolved session on per-request credentials object instead
    // of instance field: OpenCodeExecutor is a module-level singleton,
    // concurrent requests would overwrite _currentSessionId between
    // transformRequest and buildHeaders, bleeding sessions across requests.
    if (credentials) credentials._ocSession = resolveOpencodeSession(body, credentials);
    if (isResponsesModel(model)) {
      // Responses API names the output cap max_output_tokens and takes thinking
      // as reasoning:{effort,summary} — normalize the Chat fields at this boundary.
      if (body.max_output_tokens === undefined) {
        if (body.max_completion_tokens !== undefined) body.max_output_tokens = body.max_completion_tokens;
        else if (body.max_tokens !== undefined) body.max_output_tokens = body.max_tokens;
      }
      delete body.max_tokens;
      delete body.max_completion_tokens;
      normalizeOpencodeReasoning(model, body);
    }
    return injectReasoningContent({ provider: this.provider, model, body });
  }

  buildUrl(model) {
    const base = this.config.baseUrl;
    return isResponsesModel(model)
      ? `${base}/zen/v1/responses`
      : `${base}/zen/v1/chat/completions`;
  }

  // OpenCode Zen's free tier rate-limits per real egress IP (daily
  // budget per IP, reset at UTC midnight). No automatic switching:
  // when current IP's budget is exhausted gateway answers
  // 429 FreeUsageLimitError — user picks another node/egress manually.
  async execute(args) {
    return super.execute(args);
  }

  buildHeaders(credentials, stream = true) {
    const raw = credentials?.rawHeaders || {};
    const lower = {};
    for (const [k, v] of Object.entries(raw)) lower[k.toLowerCase()] = v;

    const downstreamUa = lower["user-agent"] || "";
    const isOpencodeDownstream = downstreamUa.toLowerCase().includes("opencode");

    const key = credentials?.apiKey;

    // OpenCode Zen's free tier is IP-based (ipRateLimiter.ts: headers.get("x-real-ip")
    // reads the real egress IP). CDN sets x-real-ip to TCP client-supplied IP so
    // header is best-effort — reliable per-user isolation comes from
    // real egress IPs. Only real PUBLIC IPs are forwarded: custom-server.js stamps
    // unspoofable TCP peer as x-9r-real-ip, which is 127.0.0.1 for local clients —
    // forwarding would put every local 9router user into one shared loopback bucket.
    // For loopback/private peers we fall back to machine's own public IP.
    const rawIp = (lower["x-9r-real-ip"] || lower["x-real-ip"] || "").trim();
    const clientIp = rawIp && !isPrivateIp(rawIp) ? rawIp : (rawIp ? discoverPublicIp() : "");

    return {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${key || "public"}`,
      "User-Agent": isOpencodeDownstream ? downstreamUa : OPENCODE_UA,
      "x-opencode-client": lower["x-opencode-client"] || "desktop",
      "x-opencode-session": lower["x-opencode-session"] || credentials?._ocSession || generateSessionId(),
      "x-opencode-request": lower["x-opencode-request"] || generateRequestId(),
      "x-opencode-project": lower["x-opencode-project"] || "global",
      ...(clientIp ? { "x-real-ip": clientIp } : {}),
      "Accept": stream ? "text/event-stream" : "*/*",      
    };
  }
}
