# 9router upstream toolkit

Node ESM, intentionally dependency-free. Run from the repository root:

```sh
node .docs/scripts/upstream/cli.js <operation> [target] [options]
```

All operations are read-only by default. `--apply` is required for fetch,
rebase, cherry-pick, ledger, or patch writes. `--push` is accepted by `land`
and `sync`, uses `--force-with-lease`, and never permits pushes to `upstream`.
`refresh` updates the current branch from its `origin/<branch>` counterpart
using fast-forward when possible, otherwise rebase. Apply operations require a
clean tree; `land` and `sync` create `backup/master-TIMESTAMP`.
Refs are resolved as immutable commits and ancestry is checked before rebasing.
The ledger is schema-versioned and written atomically. Keep `.docs/scripts/samples`
ignored: it is reference material, not executable toolkit code.

## Examples

### Inspect and classify changes

<example>
<command>node .docs/scripts/upstream/cli.js analyze upstream/master --json</command>
<command>node .docs/scripts/upstream/cli.js classify --branch feature/my-work</command>
<command>node .docs/scripts/upstream/cli.js landed upstream/master</command>
<command>node .docs/scripts/upstream/cli.js reset-candidates upstream/master</command>
</example>

### Refresh a worktree from fork origin

<example>
<command>node .docs/scripts/upstream/cli.js refresh</command>
<command>node .docs/scripts/upstream/cli.js refresh --remoteRef origin/master --apply</command>
</example>

### Land a feature branch into fork origin

<example>
<command>node .docs/scripts/upstream/cli.js classify --branch feature/my-work</command>
<command>node .docs/scripts/upstream/cli.js land --branch feature/my-work --apply</command>
<command>node .docs/scripts/upstream/cli.js land --branch feature/my-work --apply --push</command>
</example>

### Sync fork origin from an upstream tag or commit

<example>
<command>node .docs/scripts/upstream/cli.js sync --target upstream/master --json</command>
<command>node .docs/scripts/upstream/cli.js sync --target v0.5.56 --apply</command>
<command>node .docs/scripts/upstream/cli.js sync --target v0.5.56 --apply --push</command>
</example>

### Adopt an upstream PR temporarily

<example>
<command>node .docs/scripts/upstream/cli.js adopt 3352</command>
<command>node .docs/scripts/upstream/cli.js adopt 3352 --apply</command>
</example>

### Generate and review a cleanup plan

<example>
<command>node .docs/scripts/upstream/cli.js cleanup --base origin/master --generate .docs/fork-sync-state/my-branch-cleanup.json</command>
<command>node .docs/scripts/upstream/cli.js cleanup --plan .docs/fork-sync-state/my-branch-cleanup.json --json</command>
<command>node .docs/scripts/upstream/cli.js cleanup --plan .docs/fork-sync-state/my-branch-cleanup.json --apply</command>
</example>

`--generate` preserves every commit initially and marks each one `review
required`. Edit the local plan before applying it: move a wrongly suggested
drop entry into `replay`, add a reason, or group commits under `subject` to
squash them. The toolkit never treats a commit as disposable solely because
its subject contains `debug`, `test`, or `fix`.

To change a classification without editing JSON manually, preview the
modification first and add `--apply` to write it:

<example>
<command>node .docs/scripts/upstream/cli.js cleanup --plan .docs/fork-sync-state/my-branch-cleanup.json --modify 10c38bbf --action replay --reason "retain warmup behavior; debug logging is still useful during origin refresh"</command>
<command>node .docs/scripts/upstream/cli.js cleanup --plan .docs/fork-sync-state/my-branch-cleanup.json --modify 10c38bbf --action replay --reason "retain warmup behavior; debug logging is still useful during origin refresh" --apply</command>
</example>

Backups and patch snapshots are stored in ignored `.docs` state. Resolve
conflicts with Git and use `git rebase --abort` to abandon an operation.
Never use this toolkit to push fork changes to `upstream`; upstream
contributions should use separate branches based directly on upstream.
