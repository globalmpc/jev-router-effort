# JEV improvement harness

The global `jev-router-improver` owns a reported routing problem through investigation, an issue, a verified patch and a scoped commit. `jev-claude-executor` and `jev-codex-executor` accept bounded execution handoffs. The global definitions live in your own agent-definitions repository; this repository owns the executable routing and analysis code.

## Evidence → policy → implementation

1. Accept the original objective, session reference and user/QA failure report. A report is unverified evidence, not an automatic negative model score.
2. Run `jev-maintain analyze --window 24h`. Freeze the observation time for a reproducible run. Review at least 20% of eligible sessions. Use `jev-maintain expand-check --run RUN_ID` after review; expand to 48h only if the 24h evidence is insufficient. Never extend this bootstrap analysis beyond 48h.
3. Inspect private packets, cite concrete outcomes and preserve unknowns. Source availability, denominator, actual reviews, routed/unrouted status and sampling bias must be reported. CLI alias, exact model and reasoning effort are separate fields. The assistant saying “done” is not acceptance evidence.
4. Compile a candidate policy. Minimum support is a conservative bootstrap gate, not a statistically established performance guarantee: at least five independently identified known outcomes per task/model/effort cell; preferences require ≥90% observed success and Wilson 95% lower bound ≥0.55; exclusions require ≥3 failures and ≥50% failures. Unknown outcomes do not count as successes. Rules expire after 30 days.
5. Write `issue/YYYY-MM-DD-name/{intend,directive,result}.md` before changing policy/code. Document evidence, expected behavior, regressions and rollback. Validate against held-out cases when available, run tests, then make one scoped commit for the completed issue. Do not push or publish without a separate request.

`Analyzer/private/` contains local session packets, feedback and compiled personal proposals and is Git-ignored. `docs/routing-policy.json` is the distributable, empty default. `docs/routing-evidence.md` describes measured coverage without transcript disclosure. No private source material is published by `npm pack`.

```sh
node bin/jev-maintain.mjs status
node bin/jev-maintain.mjs analyze --window 24h
node Analyzer/cli.mjs --help
npm test
```

See `Analyzer/README.md` for feedback/review/compile arguments. Runtime-detected feedback is stored separately at `~/.local/state/jev-router/feedback.jsonl` and is also ingested by the Analyzer.

Analyzer commands require Node.js 22.15+ for the built-in SQLite reader (Analyzer tests fail on 22.14 and pass on 22.15-22.23). Core routing retains its existing Node.js 20.12+ requirement. Antigravity evidence parsing also needs the local conversation database files; absent sources are reported, not fabricated.

## Runtime activation

No config means original routing, with no new task-state writes or checkpointing. For an opted-in installation, `~/.config/jev-router/runtime.json` (or `JEV_RUNTIME_CONFIG`) has:

```json
{
  "schemaVersion": 1,
  "enabled": true,
  "checkpoint": true,
  "handoff": true,
  "policyPath": "/absolute/path/to/reviewed-personal-policy.json",
  "stateDir": "/absolute/private/path/to/jev-router-state",
  "externalModels": [],
  "externalCatalog": {}
}
```

Optional `capabilityRouting` (`off` by default; `log`, `recommend`, `apply`) adds skill/agent selection, a private event log and label-based reports; see `capability-routing.md`. An empty policy retains existing cheap/mid/high model selection. Task context can improve the JEV judgement, but is not measured model performance. `JEV_RUNTIME_DISABLED=1` disables this opt-in layer. New proxy processes read the config; already-running terminals are not restarted or silently reconfigured.

`externalModels` lists exact `{cli,id,efforts}` candidates for evidence selection; `externalCatalog` separately verifies exact launch availability with dated evidence (see `execution-safeguards.md`). Both must agree. Model suitability comes from supported policy rules, not presence in a CLI catalog. Do not invent catalog entries to force a handoff. Empty catalogs mean no automatic cross-CLI delegation.

An explicitly requested evaluation preference may also select an external executor without inventing outcome evidence. Add the following optional field to the user's private runtime config, after checking the exact target against a fresh native catalog and the executor sender gate:

```json
{
  "routingPreferences": [{
    "id": "codex-evaluation-claude",
    "sourceCli": "codex",
    "taskType": "evaluation",
    "target": { "cli": "claude", "model": "claude-sonnet-5-5", "effort": null },
    "provenance": { "kind": "user-preference", "source": "maintainer request 2026-09-30" },
    "reason": "The maintainer prefers native Claude for evaluation and review"
  }]
}
```

This example is a configuration shape, not availability or quality evidence. `null` is the native CLI default and must be listed explicitly by the actual checked catalog. The target must also appear in `externalModels`. Only conservative evaluation requests (English evaluate/review/QA/grade or their Korean equivalents) match; implementation and review in the same request remain local. A later evaluation request overrides the implementation profile for that turn while preserving the original objective. Manual model or effort choices prevent new automatic external selection. Validated avoidance evidence vetoes the preference. A persisted handoff's `selection.kind` distinguishes `user-preference` from `outcome-evidence`; preference records have no fabricated samples or success confidence. The distributable policy remains separate and unchanged.

Availability evidence expires after 24 hours and must be refreshed from the native CLI before use; stale entries are skipped, never renewed just by copying today's date. `checkpointOptions` may explicitly set `sensitive`, `acknowledgeUncovered` or `maxFileBytes` as documented by the checkpoint API. Any exclusions leave those paths unprotected.

## Execution contract

- Persistent per-conversation state keeps the whole original objective, four recent requests and eight failure reports (recent/feedback texts bounded to 6,000 characters). The classifier still gets the compact excerpts described below. Use `new task:` or `/new-task` (or the Korean equivalent) to establish a new objective before a handoff occurs. An objective too large for a required handoff packet refuses before launch instead of being silently truncated.
- Identity uses each adapter's existing conversation key. Where the CLI provides no stable ID, the first message is part of that key; compaction/replacement of that message or identical openings can affect continuity. Do not claim uninterrupted identity across every upstream CLI version.
- The TypeSafe classification request receives related task context (objective ≤3,000 characters, two recent requests ≤1,000 each, two failure excerpts ≤500 each), not only the current prompt. Full local routing records are not sent wholesale. This adds context to the existing external classification service; latency impact has not been benchmarked.
- Coupled mutation signals or JEV task/tool complexity ≥0.65 trigger a checkpoint before the task model request. Cross-CLI delegation always requires one. Classifier calls can occur first; they cannot execute workspace tools. Prompt length alone does not trigger a checkpoint.
- Checkpoints create real local Git commits under `refs/jev/checkpoints/`, including staged and non-ignored unstaged/untracked work while leaving HEAD, the actual index and files unchanged. This avoids changing the branch's task history. Sensitive filenames, unrepresented states and concurrent changes can cause a refusal. Ignored files are not protected; see the detailed receipt and `execution-safeguards.md`.
- Codex `-C`/`--cd` selects the checkpoint root. CLI options that open an unverified project, a new worktree, a remote workspace or additional writable directories outside that root block complex execution. Launch from the actual checkout instead. Arbitrary shell operations outside the declared root are not protected.
- Validated local evidence selects only exact available models and compatible efforts. An exclusion is rechecked on the actual final model, not only on JEV's proposal. Explicit user model overrides remain respected.
- Supported outcome evidence or an explicit configured user evaluation preference fences local auto-routing before launch. An HTTP 409 hold prevents upstream task generation. Delivery acceptance, observed start and completion are distinct. The hold detail includes the Orca terminal receipt/handle when available. Retry/uncertainty never silently re-enables the old writer. Concurrent processes cannot route the same persisted task simultaneously.
- Codex hands off the available instructions, user/assistant text (including artifact and check references), function calls and tool results in local `packet.context`. Bootstrap AGENTS instructions stay in that context and do not replace the first task objective. These receiver-only fields are removed from classifier arguments and never enter the TypeSafe task context. Non-text content is explicitly marked unavailable rather than copied as binary data. The complete required textual context must fit the bounded private packet; it refuses oversized context instead of silently cutting instructions or artifacts. Earlier session content unavailable in the current Codex request cannot be reconstructed.
- Evaluation packets and the Orca submission line grant read-only authority. The evaluator may inspect evidence and report findings, but has no authority to edit files, commit, activate configuration or send external messages. Generic executor instructions and conversation context cannot expand that scope. This is an instruction contract, not an OS sandbox; the coordinator must inspect the actual result and workspace state.
- Manual model selection cannot bypass an existing task's handoff fence (Claude tool-free auxiliary calls remain allowed). A typed prelaunch rejection with no possible executor clears the fence but still holds that request; ambiguous creation/delivery remains fenced. A live task lock fails fast with a hold rather than queueing a second execution.
- A fenced task has no automatic reset command. Inspect its task state and Orca receipt, verify the external writer has finished/stopped, and start a fresh CLI conversation. Do not delete the fence to retry blindly. This is a full handoff, not an unattended supervisor.

These checks cover requests through the JEV proxies, not arbitrary shell commands or separately launched native CLI sessions. Fresh manual-model tasks bypass automatic model selection/checkpointing; they do not bypass an existing handoff fence. A checkpoint provides recovery material; it is not a sandbox, continuous backup or interception of every destructive command. Checkpoints can accumulate after successive complex turns; unchanged trees reuse their task's snapshot, and refs are not automatically deleted. The default 8 task categories are deliberately coarse until reviewed cases justify finer categories through a dated issue. No universal ranking of Claude, Codex and Gemini is asserted.

## Change control

Review quality, latency and cost separately. Classification confidence is not task-success probability. Keep a cold-start path for people without history. Preserve unrelated dirty files, never auto-restore a shared workspace, and retain checkpoint refs until the owner explicitly approves removal.
