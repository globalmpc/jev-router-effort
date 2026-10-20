# Skill and agent routing

JEV already picks a model and reasoning effort for each new user turn. With capability routing enabled it also decides, independently:

- whether a skill is needed, and which installed skill(s);
- whether an agent is needed, and which installed agent.

"No skill" and "no agent" are normal outcomes. A plain explanation or a small edit uses neither.

## Activation

Capability routing is off by default. It needs the opt-in runtime config (`~/.config/jev-router/runtime.json` or `JEV_RUNTIME_CONFIG`) with `enabled: true` and a `stateDir`:

```json
{
  "capabilityRouting": {
    "mode": "apply",
    "clis": ["claude", "codex"],
    "retentionDays": 30,
    "requiredSkills": [],
    "excludeSkills": [],
    "excludeAgents": [],
    "departments": { "hr": ["hr", "hiring", "jd", "job description"] }
  }
}
```

| mode | Effect |
| --- | --- |
| `off` (default) | Original behavior. No capability questions, no event log. |
| `log` | Logs model/effort decisions to the event log. No skill/agent selection. |
| `recommend` | Selects skills/agents and shows them in the routing notice. The request is not changed. |
| `apply` | Also places the selected skill text and agent recommendation in the user's turn. |

A new `jev-claude`/`jev-codex` process reads the config. Running sessions are not changed.

## How a selection is made

1. **Catalog.** The proxy lists the skills and agents the CLI itself loads. It reads metadata only: name, description, scope, department prefix, real path, version, `model`/`effort` fields and a SHA-256 of the file. The catalog is cached for 30 seconds.
   - Claude: `~/.claude/skills/*/SKILL.md`, `<cwd>/.claude/skills/*/SKILL.md`, `~/.claude/agents/*.md`, `<cwd>/.claude/agents/*.md`.
   - Codex: `~/.codex/skills`, `~/.agents/skills`, `<cwd>/.agents/skills`, and `~/.codex/agents/*.toml`.
   - Not eligible for automatic selection: `disable-model-invocation: true`, names containing `archived`/`deprecated`, an empty description, or a runtime exclusion. The user can still name them explicitly.
   - Plugin-provided skills and agents are not listed.
2. **Shortlist.** A lexical score over the name, department prefix and description (trigger text counts double) keeps up to 6 skills and 4 agents. The score only shortlists; it never selects. With an empty shortlist the classifier is not asked about that dimension.
3. **Classification.** The shortlist goes to TypeSafe JEV in the same call as the model/effort questions. Each dimension is a choice that includes `none`. Only names and descriptions (max 400 characters) are sent. Skill bodies are never sent.
4. **Decision.** These rules apply in order, separately for skills and agents:
   - An explicit request wins: `/name`, `$name`, `@agent-name`, `skill name`, `name skill`, `name agent` (Korean equivalents are also recognized). A topical mention of the name is not a request.
   - An explicit opt-out wins: `without skills`, `no skills`, `no agents`, `don't delegate` (Korean equivalents are also recognized).
   - If one name maps to files with different hashes, nothing is selected and confirmation is requested (`duplicate-name`). One file linked from several roots counts as one candidate.
   - JEV answer: `none` means no selection. Top two non-`none` labels within 0.15 of each other, with the second at 0.3 or more, means `ambiguous` and confirmation is requested. Confidence below 0.5 means `low-confidence` and nothing is selected. If JEV is unavailable, nothing is selected automatically.
   - A short follow-up (80 characters or less) with no candidates of its own keeps the previous turn's skill (`previous-context`). `new task:` / `/new-task` (or the Korean equivalent) clears it. Agents are never carried forward.
   - `requiredSkills` rules (`{id, skill, pattern}`) add their skill when the pattern matches. A conflict with an explicit opt-out is reported, and the user's opt-out is kept.

JEV's choice confidence is a classification score. It is not the probability that the task succeeds.

## Application by host

| Host | Skills | Agents |
| --- | --- | --- |
| `jev-claude` | The skill file is re-read and its text (max 24 KB, else truncated with the path) is added to the user's turn inside `<jev-routing-capabilities>`. | A recommendation to use the Agent tool with that `subagent_type` is added. Claude decides whether to delegate. The `Agent` tool call and its result are observed and logged. |
| `jev-codex` | Same text added as `input_text` to the user's message. | Recommendation shown in the notice only. Delegation is not supported. |
| `jev-agy`, `jev-glm` | Not supported. | Not supported. |

The same injection is re-applied to the same message in every later request of the conversation, so the prompt-cache prefix stays stable. After a proxy restart the earlier injections are gone and the cache rebuilds once.

Routing adds no permissions. The injected text says that the user's instructions and project rules take precedence. A delegated agent runs with its own definition and Claude Code's normal permission checks. JEV does not verify the subagent's exact model. That model comes from the agent definition, or from JEV routing when it inherits the router sentinel.

## Private event log

`<stateDir>/routing-events.jsonl` has mode 0600, with one JSON object per line. Every event has `requestId`. Request events also have `taskId`, `conversationId` and `sessionId`.

| Event | Contents |
| --- | --- |
| `request` | Time, attempt/`retryOf`, CLI, platform + hostname hash, cwd, mode, support level, router/capability/evidence policy versions, catalog hash and counts, task type, input (masked text up to 4,000 characters, length, SHA-256 of the original). |
| `candidates` | Shortlisted ids with scores and matched terms, and whether JEV was asked. |
| `decision` | Model and effort (selected, proposed, reason, confidence, manual), skills and agent (selected with path/hash/source, reason, confidence, probabilities), conflicts, uncertainty, confirmation flag, JEV model, JEV latency, JEV tokens, cost `unknown`. |
| `application` | Each skill: applied, bytes, truncated, hash at selection and at application. Agent recommendation status. A `mismatch` list for selections that were not applied. |
| `served` / `error` | Model reported by the API, or the upstream status. Routing holds and failures. |
| `tool_observed` / `tool_result` | Claude `Agent`/`Skill` tool calls and their results (start and completion of delegation). |

A retry reuses the first decision and does not add another delegation. This covers an identical resend, and a resend under a new conversation key within 120 seconds of an upstream failure. Claude Code 2.1.289 does this after a 400 on its first request.

Masking covers common key/token/password/private-key shapes. It does not catch every secret. Keep the state directory private.

Retention: run `jev-maintain routing-prune` (default `retentionDays`, 30). It removes older events and labels. To delete everything, remove `routing-events.jsonl` and `routing-labels.jsonl` from the state directory. These files are outside the repository and are not packaged.

## Labels and report

```sh
jev-maintain routing-label --request ID --dimension skills --expected hr-write-jd --source user --evidence "user: correct skill"
jev-maintain routing-label --request ID --dimension agent --expected none --source qa --evidence "QA note 2026-10-04"
jev-maintain routing-label --request ID --dimension task --outcome failure --source executable --evidence "npm test exit 1"
jev-maintain routing-report --since 7d --dataset live
```

Allowed label sources are `user`, `qa` and `executable`. Classifier confidence and an agent's own completion claim cannot be labels.

The report has these parts:

- **Recommendation accuracy** for model, effort, skills and agent, each from its own selection labels. Also: missed and unnecessary targets, no-selection accuracy, need detection, label coverage and denominators.
- **Task outcome**: success/failure/unknown from task labels. The success rate excludes unknown.
- **Handling**: fallback, confirmation, conflict and error rates, plus reason counts.
- **Application**: skills injected versus selected; agent delegation started, completed, not observed, or turn still open; recommendation-only hosts; served model different from selected.
- **Latency and resources**: JEV latency p50/p95, JEV tokens (with an unknown count), injected skill bytes. Cost is `unknown`.

A metric without labels is reported as `unmeasured`. Regression fixtures (`dataset: "regression"`) and live use (`live`) are reported separately.
