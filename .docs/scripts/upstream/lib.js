import { execFileSync } from "node:child_process";
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { config } from "./config.js";
export { config };

export const git = (args, options = {}) => execFileSync("git", args, {
  encoding: "utf8", stdio: ["ignore", "pipe", options.allowStderr ? "pipe" : "pipe"], ...options
}).trim();
export const gitLines = args => git(args).split("\n").filter(Boolean);
export function ref(value, label = "ref") {
  if (!value || value.startsWith("-") || /[\s;&|`$]/.test(value)) throw new Error(`Invalid ${label}`);
  const resolved = git(["rev-parse", "--verify", `${value}^{commit}`]);
  if (!resolved) throw new Error(`Unknown ${label}: ${value}`);
  return resolved;
}
export function ancestor(older, newer) {
  try { git(["merge-base", "--is-ancestor", older, newer]); return true; } catch { return false; }
}
export function mergeBase(left, right) {
  return ref(git(["merge-base", left, right]), "merge base");
}
export function cleanTree() {
  return git(["status", "--porcelain", "--untracked-files=all"]) === "";
}
export function requireClean(apply = false) {
  if (apply && !cleanTree()) throw new Error("Refusing to apply with a dirty working tree");
}
export function assertPushRemote(remote) {
  if (!remote || remote === config.upstreamRemote) throw new Error("Upstream push is forbidden");
  return remote;
}
export function range(base, tip = "HEAD") {
  ref(base, "base"); ref(tip, "tip");
  return gitLines(["rev-list", "--reverse", `${base}..${tip}`]);
}
export function patchIds(commits) {
  return new Map(commits.map(sha => {
    const out = execFileSync("git", ["show", "--pretty=format:", sha], { encoding: "utf8" });
    const line = execFileSync("git", ["patch-id", "--stable"], { input: out, encoding: "utf8" }).trim();
    return [sha, line ? line.split(/\s+/)[0] : ""];
  }));
}
export async function loadLedger() {
  try { return JSON.parse(await readFile(config.ledger, "utf8")); }
  catch (e) { if (e.code === "ENOENT") return { schemaVersion: 1, ...config, commits: [] }; throw e; }
}
export async function saveLedger(data) {
  const target = config.ledger.pathname, tmp = `${target}.tmp-${process.pid}`;
  await mkdir(dirname(target), { recursive: true });
  await writeFile(tmp, `${JSON.stringify({ schemaVersion: 1, ...data }, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, target);
}
export function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i]; if (!x.startsWith("--")) { out._.push(x); continue; }
    const [k, v] = x.slice(2).split("=", 2);
    out[k] = v ?? (argv[i + 1]?.startsWith("--") ? true : argv[++i] ?? true);
  }
  return out;
}
export function commitSummary(c) {
  return `${c.slice(0, 10)} ${git(["show", "-s", "--format=%s", c])}`;
}
