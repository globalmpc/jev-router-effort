# Analyzer

Local, repeatable evidence collection for JEV routing decisions. It reads Claude Code JSONL
(`~/.claude/projects`), Codex JSONL (`~/.codex/sessions` and Orca account homes under
`~/Library/Application Support/orca/codex-*`), Antigravity conversation SQLite files
(`~/.gemini/antigravity-cli/conversations`, opened read-only/immutable, protobuf decoded without a
schema) and JEV decision status files. It calls no model or network service.

Everything with prompt text, paths or raw ids is written under `Analyzer/private/` (Git-ignored).
`docs/routing-evidence.md` holds only aggregates and redacted `ev-…` ids. It describes your own sessions, so it is Git-ignored too.

## Loop

Run the steps explicitly; nothing expands automatically.

```sh
node Analyzer/cli.mjs analyze --window 24h --now 2026-09-29T21:16:04Z   # collect, dedupe, sample ≥20% per stratum, write packets
# read Analyzer/private/runs/<run>/packets/*.md, then for each sampled session:
node Analyzer/cli.mjs review label --run <run> --evidence ev-… --outcome success|failure|unknown \
  --basis user|qa|test --citations L12,step31 --task-type … --reviewer …   # model/effort come from the citations
node Analyzer/cli.mjs review status --run <run>
node Analyzer/cli.mjs expand-check --run <run>          # 48h only when reviewed 24h evidence is insufficient
node Analyzer/cli.mjs analyze --window 48h --now <same> # then review label the new 24-48h picks
node Analyzer/cli.mjs feedback add --ref ev-… --outcome failure --source user --authorized-by user|transcript …
node Analyzer/cli.mjs feedback import-runtime           # router-captured reports, unverified
node Analyzer/cli.mjs feedback verify --id fb-… --citations … [--session ev-…]
node Analyzer/cli.mjs compile --now …                   # Analyzer/private/proposed-policy.json (policy v1)
node Analyzer/cli.mjs report                            # docs/routing-evidence.md
```

`bin/jev-maintain.mjs` forwards the same commands.

## Rules the tool enforces

- Eligible: activity in the window, events after `--now` ignored, at least one human-written
  message. Subagent transcripts, router probes, image-helper calls and jev-router bench traffic are
  counted as exclusions, not dropped silently. Same-session files are merged before counting.
- Sampling: per stratum (band × CLI × routing × kind), `ceil(rate × N)` lowest `sha256(seed:key)`;
  the 0–24h picks are identical in the 24h and 48h runs. Known cases are added as `purposive` and
  never count toward coverage.
- Labels: every citation must be a ref in the session packet (no free-form strings). `user`/`qa`
  outcomes must cite a human follow-up message; assistant text or commands never qualify. `test`
  cites a runner command with a verdict (a pass must come after the last edit). Everything else is
  `unknown`.
- Attribution is derived from the cited evidence: the model/effort of the turns a follow-up reacts
  to, or of the turn that ran the cited test. Two or more sources, or none, is rejected; sessions
  are never attributed by majority. Aliases and unseen efforts stay as observed
  (`gemini-pro-agent`, `null` = unknown).
- A `test`-basis success is a check-level pass: reported separately and counted as `unknown` in
  policy rules (`checkOnlyPasses`), never as task success.
- `feedback verify` resolves citations against the analyzed inventory and derives attribution the
  same way; `compile` re-checks every verified record, so an edited `feedback.jsonl` cannot mint
  an outcome.
- Compilation re-checks every rule with `src/evidence-policy.mjs` `supportedRule`. Rules carry
  `evidenceAt` = the oldest counted outcome's time (never the compile time); outcomes older than 30
  days are dropped. Aliases and unknown efforts (except AGY names that encode effort) never
  validate. `docs/routing-policy.json` is never written by the analyzer.
- Known cases (sessions re-verified every run, e.g. a destructive-recovery incident) are listed only in
  `Analyzer/private/known-cases.json`: `[{ "id", "key": "cli:sessionId", "expected", "taskType",
  "reportedBy" }]`. The public code holds the generic verifier only.
