# AGY, Claude Code and Codex: where Jev routing connects

Research date: 2026-09-28. Web sources were found with the Genspark CLI (`gsk`) and checked against the official documentation. **What a product supports**, **what this repository implements** and **what has been verified on a real account** are different things.

## Conclusion

AGY's `/model` screen is a real model and effort picker. From AGY 1.1.27, `/model <name> <prompt>` uses a different model for **one turn only** and then returns to the previous model.[A1] The claim that "AGY cannot change models mid-conversation" is therefore wrong. A model the user picks by hand is a separate question from a connection point where Jev **intercepts every ordinary prompt and selects automatically**.

Since the earlier diagnosis, the working tree gained an AGY proxy that uses `CLOUD_CODE_URL` and a `jev-router` model row.[R3] That is **implemented and passing mock tests**. It is not evidence of official support or of consecutive successful turns while signed in to a real AGY account. Native automatic routing stays marked **unverified** until two turns (model A, then model B) are sent on an AGY 1.2.12 account and the actual upstream requests and responses are checked.

## Comparison

| Aspect | Claude Code (`jev-claude`) | Codex CLI (`jev-codex`) | AGY (`jev-agy`) |
| --- | --- | --- | --- |
| How a person picks a model | `/model` picker and command.[C1] | Model picker, `--model` and config.[O1] | `/model` picker and `--model`; effort is selectable too.[A1][A2] |
| **A different model for one turn** | This repository rewrites the proxied request of a new turn.[R1] | This repository rewrites the proxied request of a new turn.[R2] | Official `/model <name> <prompt>`: **one manual turn, then back to the original model**.[A1] |
| Adding a router row to the picker | A custom `/model` row via `ANTHROPIC_CUSTOM_MODEL_OPTION` is documented.[C2] | The repository's proxy adds a `jev-router` row to the model catalog; custom providers are officially supported.[R2][O1] | The repository's proxy adds a `jev-router` row to AGY's catalog response. Not confirmed as an official AGY extension contract.[R3] |
| Sending requests to an external proxy | `ANTHROPIC_BASE_URL` gateway setting.[C3] | `model_providers.<id>.base_url` and `model_provider`; per-run `--config` is possible.[O1] | The repository uses `CLOUD_CODE_URL`. No equivalent proxy contract was found in the official AGY docs; a third-party measurement suggests the control API and the inference API may be separate.[R3][T1] |
| Official hook output that **changes** the current model | The router rewrites proxied requests instead of using hooks.[R1] | The router rewrites proxied requests instead of using hooks.[R2] | `PreInvocation` input includes `modelName`, but the documented output is `injectSteps`, with no model-change field.[A3] |
| Can headless input replace the native UI? | Not applicable: the original CLI runs behind the proxy.[R1] | Not applicable: the original CLI runs behind the proxy.[R2] | No. AGY's `stream-json` is headless and that stream does not support the `/model` slash command.[A4] |
| Existing sign-in and authentication | Billing and auth through a Claude gateway depend on the sign-in and gateway credentials. Check header-forwarding conditions when proxying subscription auth.[C3] | `requires_openai_auth=true` is the provider setting that uses OpenAI auth.[O2][R2] | Whether the proxy forwards real OAuth requests unchanged on both paths **needs real-account verification**.[R3][T1] |
| Level confirmed in this repository | Proxy implementation and tests; earlier runs recorded routing cases.[R1] | Proxy implementation and tests; earlier runs recorded routing cases.[R2] | Proxy code and mock tests. During this research the full suite passed **94 tests**; consecutive successful native AGY turns are **not yet confirmed separately**.[R3] |

### Connection diagram

```mermaid
flowchart LR
  U[User prompt] --> C[Claude Code: Jev Router row]
  U --> O[Codex: Jev Router row]
  U --> A[AGY: Jev Router row attempt]
  C --> CP[ANTHROPIC_BASE_URL proxy]
  O --> OP[model_providers.base_url proxy]
  A --> AP[CLOUD_CODE_URL proxy]
  CP --> CJ[Jev choice → request model rewritten]
  OP --> OJ[Jev choice → request model rewritten]
  AP -. needs consecutive-turn check on a real AGY 1.2.12 account .-> AJ[Jev choice → request model rewritten]
```

The dotted AGY line marks an **unverified connection**, not an impossible one. AGY's manual `/model <name> <prompt>` works on its own and is not evidence of automatic interception.[A1]

## Why AGY needs stricter measurement

Claude's custom model row and gateway, and Codex's user-defined providers, are each in the official configuration docs.[C2][C3][O1] For AGY, no official proxy contract describing `CLOUD_CODE_URL` was found. A community investigation claims the variable applies to the control API while inference calls may use a separate client.[T1] That report is a **third-party observation on a different version** and must not be promoted to an established fact about AGY 1.2.12. It is still a reason to check the risk that only the catalog row appears while real generation requests bypass the proxy.

Confirmation procedure: in the native `jev-agy` UI, run a light first prompt and then a complex second prompt. For both turns, compare in one session the **request received by the AGY proxy**, the **Jev decision**, the **actual model ID sent upstream** and **response success**. Do not declare success from the picker row or mock tests alone. If the measurement fails, record the version and the failure point. This research did not change network traffic or account settings.

## Sources

- [A1] [AGY CLI changelog](https://github.com/google-antigravity/antigravity-cli/blob/main/CHANGELOG.md): `/model <name> <prompt>` in 1.1.27 and the model and effort picker in 1.1.5.
- [A2] [Using the AGY CLI](https://antigravity.google/docs/cli/using/): `/model` and the settings screen.
- [A3] [AGY Hooks](https://antigravity.google/docs/hooks/): the `PreInvocation` input and output contract.
- [A4] [AGY Headless mode](https://antigravity.google/docs/cli/headless/): the `/model` limitation in `stream-json`.
- [C1] [Claude Code model configuration](https://code.claude.com/docs/en/model-config): the picker and `/model`.
- [C2] [Claude Code environment variables](https://code.claude.com/docs/en/env-vars): `ANTHROPIC_CUSTOM_MODEL_OPTION`.
- [C3] [Claude Code LLM gateway](https://code.claude.com/docs/en/llm-gateway): `ANTHROPIC_BASE_URL` and notes on subscription and gateway auth.
- [O1] [OpenAI Docs: Codex advanced configuration](https://developers.openai.com/codex/config-file/config-advanced): providers and per-run overrides.
- [O2] [OpenAI Docs: Codex configuration reference](https://developers.openai.com/codex/config-reference): `base_url`, `wire_api`, `requires_openai_auth`.
- [T1] [9Router AGY investigation issue](https://github.com/decolua/9router/issues/1358): a third-party report of separate control and inference paths; not generalizable to the current AGY version.
- [R3] Repository implementation: [AGY launcher](../src/anti-cli.mjs), [AGY proxy](../src/agy-proxy.mjs), [AGY mock tests](../test/agy-proxy.test.mjs). Not official documentation or real-account evidence.
- [R1] Repository implementation: [Claude launcher](../bin/jev-claude.mjs), [Claude proxy](../src/proxy.mjs).
- [R2] Repository implementation: [Codex launcher](../src/codex-cli.mjs), [Codex proxy](../src/codex-proxy.mjs).
