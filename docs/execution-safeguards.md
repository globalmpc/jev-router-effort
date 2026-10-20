# Execution safeguards: checkpoint and Orca handoff

Contract for `src/checkpoint.mjs` and `src/handoff.mjs`: a Git checkpoint commit before complex
work, and cross-CLI execution through Orca with one writer per task.

## Checkpoint: `ensureCheckpoint`

```js
import { ensureCheckpoint } from "./src/checkpoint.mjs";
const receipt = await ensureCheckpoint({ cwd, taskId, reason });
```

Options: `sensitive` (`"fail"` default, `"exclude"`, `"include-local"`), `acknowledgeUncovered`
(paths the caller accepts leaving unprotected), `maxFileBytes` (100 MiB default), and an
injectable `git` runner for tests.

### What it records

- One local commit per snapshot, stash-shaped but not stash-compatible: the commit's tree is the working tree
  (tracked and non-ignored untracked files, deletions applied); parent 1 is `HEAD` (absent in an
  unborn repository); parent 2 is a commit of the staged index.
- A durable ref `refs/jev/checkpoints/<taskId>/<UTC stamp>-<short oid>`, created with
  `update-ref` in create-only mode and verified afterwards.
- It is built in temporary index files under the Git directory. `HEAD`, the branch, the user's
  index bytes and every working file are unchanged; the tests compare them byte for byte.
- No network, hooks, pushes, branch changes, worktrees, stashes or restores are involved.

### Receipt

`{ ok: true, taskId, reason, cwd, commit, indexCommit, ref, head, branch, indexTree,
worktreeTree, createdAt, reused, files: { count, changed, deleted, untracked, truncated },
excluded: [{ path, reason }], ignored: { count, covered: false, sample }, sensitive,
submodules, warnings, coverage }`

`reused: true` only when the task's newest checkpoint has the same `HEAD`, staged tree and
working tree. A matching task id alone is never enough.

### Refusals (thrown `CheckpointError` with `code`, `remedy`, `paths`)

| code | cause | caller action |
| --- | --- | --- |
| `not_git_repo` | not inside a non-bare checkout | run from a checkout |
| `locked` | another checkpoint holds `jev-checkpoint.lock`, or `index.lock` exists | wait; a lock left by a dead local process is cleared automatically |
| `unmerged_index` | unresolved merge or rebase conflicts | resolve or abort first |
| `assume_unchanged` | assume-unchanged entries would hide edits | clear the bit |
| `skip_worktree_modified` | a skip-worktree file on disk differs from its index entry, which `git add` cannot see | clear the bit, or acknowledge (the index version is recorded) |
| `nested_repo` | untracked nested Git repository | commit, ignore, or acknowledge as unprotected |
| `dirty_submodule` | submodule has uncommitted work | commit inside it, or acknowledge |
| `sensitive_paths` | credential-looking files that are staged or non-ignored in the working tree | ignore/unstage them or choose `exclude` / `include-local` |
| `oversized_paths` | working file or staged blob above `maxFileBytes` | ignore, raise the limit, or acknowledge |
| `concurrent_change` | files, index or `HEAD` changed during the snapshot (after one retry) | stop other writers |
| `coverage_verify_failed`, `ref_create_failed`, `ref_verify_failed`, `add_failed` | the result could not be proven | do not start complex execution |

Any refusal means complex execution must not start.

Screening covers the staged index as well as the working tree: a file staged and then deleted
from disk still reaches the index commit, so it is checked too. An excluded credential file and
an acknowledged oversized file are reset to their `HEAD` version (or removed when `HEAD` lacks
them) in both snapshot trees; the user's real index keeps its staged content. Skip-worktree
entries whose file is absent (sparse checkout) are recorded at their index version without a
refusal.

### Limits

- Ignored files are not protected. `git clean -x` or deleting ignored build outputs cannot be
  undone from the checkpoint. The receipt reports their count and a sample.
- Sensitive detection matches file names only; content is not scanned.
- `include-local` stores credentials in local Git objects. `refs/jev/*` is not pushed by
  `git push` or `git push --all`, but `git push --mirror` or an explicit refspec would push it.
- A submodule whose checked-out commit changed is recorded as that gitlink; the commit's
  content lives only in the submodule repository.
- A checkpoint is recovery protection. It does not intercept destructive shell commands.

### Recovering by hand

Nothing restores automatically. Inspect with `git show <commit>`, `git diff HEAD <commit>`, or
`git diff <commit>^2 <commit>` (unstaged part). Recover individual paths into the working tree
with `git restore --source=<commit> -- <path>` after confirming that it will not overwrite newer
work. Do not use `git stash apply` on it: untracked files are in the main tree rather than a
third parent, so stash semantics do not match and the apply can refuse or skip changes.

## Handoff: `handoffTask`

```js
import { handoffTask } from "./src/handoff.mjs";
const receipt = await handoffTask({
  cwd, taskId, target: { cli, model, effort }, catalog, packet, checkpoint, execute: true,
});
```

### Preconditions (thrown `HandoffError` before any Orca call or write)

- `target.cli` is `claude` or `codex`. Antigravity and GLM are not executors.
- `catalog[cli].models[model]` exists, lists `effort` (use `null` for the CLI default) in
  `efforts`, cites at least one entry in `evidence`, and has a `checkedAt` ISO time no older than
  24 hours (`CATALOG_MAX_AGE_MS`) and not more than 5 minutes in the future. The catalog comes
  from the caller's verified evidence or live model catalog; the module never maps tiers or
  aliases to models. A listing proves the launch is available, not that the model suits the
  task; selection comes from supported outcome policy or a separately labeled, explicitly configured user evaluation preference. Codes: `unsupported_target`, `catalog_stale`.
  The receipt records the entry's `evidence` and `checkedAt`.
- `checkpoint` is a successful `ensureCheckpoint` receipt for the same task whose ref still
  resolves to its commit (`checkpoint_required`, `checkpoint_mismatch`).
- `packet` is either `{ file }` or the runtime packet from `src/task-runtime.mjs`:
  `objective` (required), `currentRequest`, `recentRequests[]`, `failures[]` (strings or
  `{ text, source }`), `taskType`, `complex`, `mutating`, `signals[]`, `sourceCli`, `stateFile`,
  `evidenceRule`, `routingSelection`, plus optional `constraints[]`, `stage`, `affectedFiles[]`, `verification[]`,
  `context`, `authority`. `routingSelection.kind` is `outcome-evidence` (rule id/support) or
  `user-preference` (preference id/provenance/reason); the latter never implies measured quality.
  `authority: "read-only"` grants evaluation ownership with no workspace write permission.
  Both the packet header and Orca's submitted prompt say no edits or commits, overriding generic
  writer/executor instructions. Unknown fields are rendered under "Other fields" rather than dropped. The rendered
  packet must fit `maxPacketBytes` (64 KiB): older recent requests and failures are dropped with
  a visible count, the newest of each last; the objective and current request are never cut.
  A packet still too large is refused (`packet_too_large`, `invalid_packet`).
  The runtime transfers the whole objective and current request, with receiver-only Codex
  instructions, assistant artifacts and tool/check output in private `context`. Essential
  context is never silently truncated. Non-text unavailable content carries explicit omission
  metadata. Private packets stay in the Git common directory, not the working tree or classifier request.
- `executor_unavailable`: the named executor is not installed (see below).
- `writer_locked`: another call is handling the same task. `task_owned`: a terminal was
  already launched for the task with a different target. Before anything is sent, a newer
  packet for the same target replaces the old one on the same terminal.

`execute: false` (the default) validates and returns the plan (`state: "planned"`) without
writing or calling Orca.

### Executor

The executor is the global agent maintained in your own agent-definitions repository, loaded
without invented flags:

- Claude: `claude --agent jev-claude-executor --model M [--effort E]`. The definition must exist
  at `<workspace>/.claude/agents/` or `~/.claude/agents/jev-claude-executor.md`.
- Codex has no agent flag, so the launch is `codex --no-daemon --model M [-c model_reasoning_effort="E"]`
  and the prompt names `jev-codex-executor` and its procedure
  `~/.codex/skills/jev-router-improvement/references/execution.md`.
  `--no-daemon` avoids the daemon socket path limit in long Orca account-home paths.
- Both need that skill's `references/execution.md` and `scripts/check_target.py`. Before any Orca call, the sender executes the checker with `--sender` and requires exit 0 plus `accepted: true` JSON. A rejection is `executor_gate_rejected`; prompts cannot override this check. The packet
  includes the exact `check_target.py --cli --model [--effort] --router <JEV-package-root>` command
  and says to stop without edits when it exits nonzero. `check_target.py` is a second check in
  the executor. The catalog gate in `handoffTask` stays the authority for launching.
- The packet's Reporting section states there is no orchestration dispatch in a full handoff:
  the executor ends with a final report in its own terminal, which the coordinator reads with
  `orca terminal read`. No `worker_done` is expected.

### Orca sequence

Commands follow `orca skills get orca-cli` for Orca 1.4.210 (full handoff, not supervised
orchestration; no `orchestration task-create` or `dispatch`):

1. `orca worktree show --worktree path:<checkout> --json`. The returned path must equal the
   checkout. No worktree is ever created.
2. `orca terminal create --worktree id:<worktree id> --title "jev <task>" --command "<argv>" --json`.
   Argv is the native CLI with the executor above, never a `jev-*` wrapper, POSIX single-quoted
   because Orca types it into a login shell.
3. `orca terminal wait --terminal <h> --for tui-idle --timeout-ms <=60000 --json`, repeated once.
   Sending happens only when `wait.satisfied` is true.
4. `orca terminal send --terminal <h> --text <one line> --enter --wait-submit 30 --json`. The line
   points at the packet file; the process call uses argv, so no shell quoting is involved.

The executable is `$ORCA_CLI_COMMAND`, else `orca-ide` on Linux, else `orca`.

### Receipt and states

Stored at `<git-common-dir>/jev/handoffs/<taskId>/receipt.json` (written atomically) beside
`packet.md` and the per-task `lock`. None of these are in the working tree.

| state | meaning | on a repeated call |
| --- | --- | --- |
| `failed` | workspace missing, or Orca refused the create cleanly | starts again |
| `terminal_created` | executor launched, not yet idle | resumes on the same handle |
| `not_started` | executor never became idle; nothing sent | re-waits on the same handle if it still exists |
| `create_ambiguous` | create call gave no receipt; a terminal may exist | returned as `duplicate`, inspect `terminal list` |
| `sending` | send started; outcome unknown (crash) | returned as `duplicate`, never re-sent |
| `turn_started` | Orca observed the executor's turn start | returned as `duplicate` |
| `accepted_unverified` | input accepted, turn start not observed | returned as `duplicate`, never re-sent |
| `refused` | Orca refused the input | returned as `duplicate` |
| `send_ambiguous` | transport failure | replayed only with `--retry-request <id>` and identical text when Orca returned an id; otherwise final |

`ok` is true only for `turn_started`. `completion` is always `"unknown"`: the module never waits
for, generates, or infers the executor's result. The coordinator integrates the executor's
report and verifies it separately.

### Known gaps

- The executor TUI may stop at its own permission prompts; Orca then reports the observation
  (`permission`) and the receipt stays `accepted_unverified`.
- Readiness uses Orca's `tui-idle` detection. A CLI that Orca cannot classify will time out as
  `not_started`.
- Evaluation read-only authority is an explicit executor contract, not an OS sandbox. The
  coordinator verifies the result and actual workspace changes separately. Quota refusal,
  a catalog listing, or successful prompt delivery does not demonstrate task completion.
