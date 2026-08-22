#!/usr/bin/env node
import { parseArgs, git, gitLines, ref, range, ancestor, mergeBase, patchIds, loadLedger, saveLedger, requireClean, assertPushRemote, commitSummary, config } from "./lib.js";
import { mkdir, writeFile } from "node:fs/promises";

const a = parseArgs(process.argv.slice(2)), command = a._[0] || "analyze";
const target = a._[1] || `${config.upstreamRemote}/${config.baseBranch}`;
const apply = a.apply === true || a.apply === "true";
const json = a.json === true;
const output = x => console.log(json ? JSON.stringify(x, null, 2) : x);

async function analyze() {
  const upstream = ref(target, "upstream target"), base = ref(`HEAD`, "HEAD");
  const commits = range(upstream, base).map(c => ({ sha: c, subject: commitSummary(c) }));
  const files = gitLines(["diff", "--name-only", `${upstream}...HEAD`]);
  const result = { target, upstream, commits, files, hotFiles: files.filter(f => config.hotFiles.includes(f)), clean: clean() };
  output(result);
}
function clean() { try { return git(["status", "--porcelain"]) === ""; } catch { return false; } }
async function classify() {
  const commits = range(a.base || `origin/${config.baseBranch}`, a.branch || "HEAD");
  output(commits.map(sha => ({ sha, subject: commitSummary(sha), value: "review", files: gitLines(["diff-tree", "--no-commit-id", "--name-only", "-r", sha]) })));
}
async function land() {
  await classify();
  if (!apply) return;
  requireClean(true);
  const base = ref(a.base || `origin/${config.baseBranch}`);
  const backup = `backup/${(a.branch || "feature").replace(/[^A-Za-z0-9._-]/g, "-")}-${Date.now()}`;
  git(["branch", backup, "HEAD"]);
  git(["rebase", base]);
  if (a.push) {
    git(["push", "--force-with-lease", assertPushRemote(a.remote || config.originRemote), `HEAD:${a.branch || git(["branch", "--show-current"])}`]);
  }
}
async function landed() {
  const base = a.base || (await loadLedger()).lastMergedUpstream || target;
  ref(base, "base");
  const local = range(base, "HEAD"), upstream = range(base, target);
  const upIds = new Set(patchIds(upstream).values());
  output(local.map(sha => ({ sha, subject: commitSummary(sha), landed: upIds.has(patchIds([sha]).get(sha)) })));
}
async function refresh() {
  const branch = git(["branch", "--show-current"]);
  const remoteRef = a.remoteRef || `${config.originRemote}/${branch || config.baseBranch}`;
  if (apply) { requireClean(true); git(["fetch", "--prune", "--", config.originRemote]); }
  const pinned = ref(remoteRef, "origin target");
  const current = ref("HEAD");
  const base = mergeBase(current, pinned);
  const localCommits = range(base, current);
  const originCommits = range(base, pinned);
  const originIds = new Set(patchIds(originCommits).values());
  const localIds = patchIds(localCommits);
  const dropped = localCommits.filter(commit => originIds.has(localIds.get(commit)));
  const kept = localCommits.filter(commit => !dropped.includes(commit));
  const action = ancestor(pinned, current)
    ? "up-to-date"
    : ancestor(current, pinned) && kept.length === 0
      ? "fast-forward"
      : "rebase";
  const plan = {
    dryRun: !apply,
    branch,
    remoteRef,
    current,
    mergeBase: base,
    target: pinned,
    action,
    kept: kept.map(commitSummary),
    dropped: dropped.map(commitSummary),
  };
  output(plan);
  if (!apply) return;
  if (action === "up-to-date") return;
  const backup = `backup/${(branch || config.baseBranch).replace(/[^A-Za-z0-9._-]/g, "-")}-${Date.now()}`;
  git(["branch", backup, "HEAD"]);
  const fetched = ref(remoteRef, "origin target");
  if (action === "fast-forward") {
    git(["merge", "--ff-only", fetched]);
    return;
  }
  git(["reset", "--keep", fetched]);
  for (const commit of kept) git(["cherry-pick", commit]);
}
async function sync() {
  if (apply) {
    requireClean(true);
    git(["fetch", "--prune", "--", config.upstreamRemote]);
    git(["fetch", "--prune", "--", config.originRemote]);
  }
  const upstream = ref(a.target || target, "pinned upstream target");
  const head = ref("HEAD"), base = ref(a.base || `origin/${config.baseBranch}`);
  if (!ancestor(base, head)) throw new Error("Current branch is not based on the configured base branch");
  const commits = range(base, head), ledger = await loadLedger();
  const landedIds = new Set(patchIds(range(ledger.lastMergedUpstream || upstream, upstream)).values());
  const ids = patchIds(commits);
  const drop = commits.filter(c => landedIds.has(ids.get(c)));
  const keep = commits.filter(c => !drop.includes(c));
  const report = { dryRun: !apply, upstream, keep: keep.map(commitSummary), drop: drop.map(commitSummary), conflicts: gitLines(["diff", "--name-only", `${upstream}...HEAD`]).filter(f => config.hotFiles.includes(f)) };
  output(report);
  if (!apply) return;
  requireClean(true);
  const backup = `backup/${config.baseBranch}-${new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14)}`;
  git(["branch", backup, "HEAD"]);
  git(["reset", "--keep", upstream]);
  for (const commit of keep) git(["cherry-pick", commit]);
  ledger.lastMergedUpstream = a.target || target; await saveLedger(ledger);
  if (a.push) {
    git(["push", "--force-with-lease", assertPushRemote(a.remote || config.originRemote), "HEAD"]);
  }
}
async function adopt() {
  const pr = a._[1]; if (!pr || !/^\d+$/.test(pr)) throw new Error("adopt requires a numeric PR");
  if (!apply) return output({ dryRun: true, command: `gh pr diff ${pr}` });
  requireClean(true);
  git(["fetch", config.upstreamRemote, `pull/${pr}/head`]);
  const sourceSha = ref("FETCH_HEAD", "PR source");
  const patchId = patchIds([sourceSha]).get(sourceSha);
  const patch = git(["format-patch", "-1", "--stdout", sourceSha]);
  await mkdir(config.patchDir, { recursive: true });
  await writeFile(new URL(`pr-${pr}.patch`, config.patchDir), patch);
  git(["cherry-pick", sourceSha]);
  const resolvedSha = git(["rev-parse", "HEAD"]);
  const ledger = await loadLedger();
  ledger.commits.push({ kind: "cherry-pick", upstreamPr: Number(pr), sourceSha, resolvedSha, patchId, keepIfLanded: false });
  await saveLedger(ledger);
}
async function resetCandidates() {
  const upstream = ref(a.target || target, "upstream target");
  const files = gitLines(["diff", "--name-only", `${upstream}...HEAD`]);
  output(files.map(file => {
    let insignificant = false;
    try { git(["diff", "--quiet", "--ignore-all-space", upstream, "HEAD", "--", file]); insignificant = true; } catch {}
    return { file, insignificant, recommendation: insignificant ? "reset-to-upstream" : "review" };
  }));
}
const commands = { analyze, classify, land, landed, refresh, sync, adopt, "reset-candidates": resetCandidates };
try { if (!commands[command]) throw new Error(`Unknown operation: ${command}`); await commands[command](); }
catch (e) { console.error(`upstream toolkit: ${e.message}`); process.exitCode = 1; }
