# Jev Router Q&A

## Q1. What model-selection prompt does Jev receive?

`questionForModels()` in `src/config.mjs` produces these instructions:

> Pick the cheapest exact model that can fully complete this coding request in one pass, without retrying on a stronger model.
>
> Treat different model versions as separate choices. Judge required reasoning, not requested reply length.

The router sends the exact model IDs available to the signed-in account and CLI as choices. Each choice includes guidance on the model's tier, suitable work, and unsuitable work. Jev selects an **exact model ID from those choices**; the router does not convert a score into a model name.

`askJev()` in `src/router.mjs` also sends the original user request, the current model, an approximate conversation-context token count, and the available model IDs as state.

## Q2. What does Jev return?

The model-selection response contains:

- `choice`: Jev's recommended exact model ID.
- `confidence`: Jev's confidence in that recommendation.
- `probabilities`: probabilities for the choices.

The router asks for three separate ratings on a 0–9 scale and normalizes them to 0–1 in `metrics`:

- `taskComplexity`: ambiguity, scope, and impact of the request.
- `reasoningRequired`: reasoning needed to complete the request in one pass.
- `toolComplexity`: complexity of tool use, from none or simple tools to coordination across stateful tools.

The router calculates `contextSize`, the fraction of the context window in use, on the local machine. It does **not** sum these ratings to assign a model tier. `choice` holds Jev's model recommendation; the other ratings support observation and explanation.

The code does not guarantee that `confidence` represents a calibrated probability of the model successfully finishing the task. The policy uses it as a signal of uncertainty about Jev's recommendation.

## Q3. Does Jev make the final routing decision?

Jev recommends a candidate model. The code applies policy before sending a request:

- **Jev** recommends one available exact model ID and returns confidence and ratings.
- **`src/router.mjs`** assembles the Jev request, handles the call, and normalizes the response. It returns `null` on failure or timeout; it does not apply the final policy.
- **The proxies (`src/proxy.mjs`, `src/codex-proxy.mjs`)** map Jev's exact model to a shared tier, pass it to the policy, and apply the final model ID to the request.
- **`decide()` in `src/policy.mjs`** applies the user's preference, confidence limits, availability, and prompt-cache costs to select the execution tier.

Jev proposes the model; the policy can accept, limit, or reject that proposal.

## Q4. Which rules take precedence?

1. Selecting a concrete model instead of `jev-router` in `/model` bypasses Jev routing. The proxy forwards that model unchanged.
2. During automatic routing, a supported explicit instruction such as `use opus`, `use luna`, or `use strong` overrides Jev's recommendation.
3. If Jev fails, times out, returns no answer, or recommends a model outside the available candidates, the policy keeps the current model.
4. If `confidence < 0.3`, the policy refuses downgrades and caps upgrades at the higher of the current tier and the balanced tier. It does not downgrade a current strong model to balanced.
5. If the conversation exceeds 20,000 context tokens, the policy refuses downgrades that would require rebuilding the prompt cache.
6. If the selected tier is unavailable, the policy tries the next stronger available tier; it chooses a weaker tier only when no stronger tier is available. It does not step up to the more expensive `fable` tier unless the request already calls for `fable`.
7. Automatic routing includes `fable` only if `JEV_ALLOW_FABLE=1`.

If the policy accepts Jev's exact recommendation, the proxy runs that model version. If the policy changes the tier, the proxy selects an appropriate model ID for the resulting tier.

## Q5. Which file owns each decision?

| File | Responsibility |
| --- | --- |
| `src/config.mjs` | Tier order, default model IDs, Jev prompt, tier guidance, confidence/context/timeout thresholds, and explicit override patterns. |
| `src/router.mjs` | Jev request format, calls, timeout, retries, and normalization of responses and observation metrics. |
| `src/policy.mjs` | Pure policy that selects the final tier from Jev's recommendation and exception rules. |
| `src/proxy.mjs` | Claude Code manual model selection and mapping the live account catalog and policy result to a Claude model ID. |
| `src/codex-proxy.mjs` | Mapping the live Codex account catalog and policy result to a Codex model ID. |

`src/policy.mjs` owns the policy rules; `src/config.mjs` owns their thresholds and defaults. The proxy chooses the model ID to execute from the policy result and the account's model catalog:

```text
User selects a concrete model
  └─ Yes: forward that model
  └─ No: Jev recommends an exact model ID
       └─ Policy applies override, confidence, context, and availability rules
            └─ Proxy selects and runs a model ID for the final tier
```

These code rules keep an uncertain, invalid, or unavailable Jev recommendation from directly determining the execution model.

## Q6. Should we update Claude's static model ID in `src/config.mjs` to Opus 5.5?

An immediate static-ID change is not required for the normal routing path. Updating a verified fallback can improve cold-start resilience.

On the normal Claude path, the proxy retrieves the signed-in account's model catalog through `GET /v1/models`. Jev receives exact IDs from that catalog. If the catalog contains `claude-opus-5-5` while the static default in `src/config.mjs` says `claude-opus-5`, Jev can recommend `claude-opus-5-5` and the policy can accept it. The catalog, rather than the static `TIERS` ID, supplies the current candidates for that path.

If the catalog is empty or has not arrived during cold start, the static `TIERS` ID can serve as a fallback. An outdated ID that the account cannot use may then cause the first request to fail. Update the fallback after confirming that the official API and the account support the new ID.

Possible improvements:

1. Fetch and validate the model catalog before forwarding the first generation request.
2. If a tier has multiple versions, sort them by explicit metadata such as `created_at` from the Anthropic Models API, rather than by model-name text.
3. If the catalog is unavailable, retry, use a previously validated catalog, or return a clear error instead of executing an unverified static ID.
4. If static IDs remain as emergency fallbacks, check them against the official model list as new versions arrive.

These changes address future model releases without depending on a one-time substitution of `opus-5` with `opus-5-5`.

Official references:

- [Anthropic model overview](https://docs.anthropic.com/en/docs/about-claude/models/overview)
- [Anthropic Models API: list models](https://docs.anthropic.com/en/api/models-list)
