import crypto from "crypto";
import https from "https";
import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import { injectReasoningContent } from "../utils/reasoningContentInjector.js";
import { resolveSessionId } from "../utils/sessionManager.js";

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

function generateSessionId() {
  return `ses_${Date.now()}_${crypto.randomBytes(6).toString("hex")}`;
}

function generateRequestId() {
  return `req_${Date.now()}_${crypto.randomBytes(6).toString("hex")}`;
}

function resolveOpencodeSession(body, credentials) {
  // Try to get session from client headers first (conversation continuity)
  const raw = credentials?.rawHeaders || {};
  const clientSession = raw["x-client-session-id"] || raw["x-opencode-session"];
  if (clientSession) return clientSession;

  // Fallback: derive from request body conversation pattern
  const messages = body?.messages || [];
  const firstUser = messages.find((m) => m?.role === "user");
  if (firstUser?.content) {
    return `ses_${crypto.createHash("sha256").update(String(firstUser.content)).digest("hex").slice(0, 12)}`;
  }
  return generateSessionId();
}

// Models that use /zen/v1/messages (claude format)
const MESSAGES_MODELS = new Set();

// OpenCode free-tier ("-free") requires versioned UA; bare "opencode" gets 429.
const OPENCODE_UA = "opencode/latest/1.18.18/cli";

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
    return injectReasoningContent({ provider: this.provider, model, body });
  }

  buildUrl(model) {
    const base = this.config.baseUrl;
    return MESSAGES_MODELS.has(model)
      ? `${base}/zen/v1/messages`
      : `${base}/zen/v1/chat/completions`;
  }

  // OpenCode Zen's free tier rate-limits per real egress IP (daily
  // budget per IP, reset at UTC midnight). No automatic switching:
  // when current IP's budget is exhausted gateway answers
  // 429 FreeUsageLimitError — user picks another node/egress manually.
  // applyOcEgress() only honors manually chosen mode from state file
  // (<APPDATA>/9router/oc-egress.json) so manual switch works without
  // restarting 9router. Errors propagate untouched.
  async execute(args) {
    return super.execute(args);
  }

  buildHeaders(credentials, stream = true) {
    const raw = credentials?.rawHeaders || {};
    const lower = {};
    for (const [k, v] of Object.entries(raw)) lower[k.toLowerCase()] = v;

    const key = credentials?.apiKey;

    // Detect if downstream is opencode CLI (e.g. opencode/1.18.18).
    // OpenCode free-tier ("-free") non-opencode UA still classified
    // unidentified gets FreeUsageLimitError/429 immediately.
    const downstreamUa = lower["user-agent"] || "";
    const isOpencodeDownstream = downstreamUa.toLowerCase().includes("opencode");

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