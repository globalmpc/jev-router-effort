import { TypeSafeClient } from "@typesafe-ai/sdk";
import {
  COMPLEXITY_MAX_SCORE,
  CONTEXT_WINDOW_TOKENS,
  QUESTIONS,
  questionForEfforts,
  questionForModels,
  THRESHOLDS,
} from "./config.mjs";
import { log } from "./log.mjs";

// The SDK's defaults (10s per attempt, 2 retries, no total budget) are far too slow for a
// per-prompt hot path, so the timeout, retry count and an outer deadline are all pinned.
// Built lazily because the constructor throws when no key is present, and a missing key
// should degrade to "no routing", not stop the session from starting.
let client;
function getClient() {
  client ??= new TypeSafeClient({
    apiKey: process.env.JEV_API_KEY ?? process.env.TYPESAFE_API_KEY,
    timeout: THRESHOLDS.jevTimeoutMs,
    retry: { maxRetries: THRESHOLDS.jevMaxRetries, backoffInitialMs: 150, backoffMaxMs: 400 },
    logLevel: "warn", // never "debug": request bodies contain the user's prompt
  });
  return client;
}

/**
 * Opens the TLS connection to Jev ahead of the first prompt, which otherwise pays the
 * handshake (~750ms vs ~350ms warm). Fire-and-forget; failure only means a cold first call.
 */
export function warmJev() {
  if (!(process.env.JEV_API_KEY ?? process.env.TYPESAFE_API_KEY)) return;
  try {
    getClient().fetch(getClient().baseURL, { method: "HEAD", signal: AbortSignal.timeout(THRESHOLDS.jevDeadlineMs) }).catch(() => {});
  } catch {}
}

/**
 * Asks Jev which tier fits this prompt. Returns null on any failure, which the policy
 * layer reads as "keep the current model" — routing must never block a prompt.
 *
 * @returns {Promise<?{choice: string, confidence: number, probabilities: object, metrics: object, ms: number}>}
 */
export function routingContext(context) {
  if (!context) return undefined;
  return {
    taskType: context.taskType, complex: context.complex, mutating: context.mutating, signals: context.signals,
    objective: String(context.objective ?? '').slice(0, 3000),
    recentRequests: (context.recentRequests ?? []).slice(-2).map(value => String(value).slice(0, 1000)),
    failures: (context.failures ?? []).slice(-2).map(f => ({ text: String(f.text ?? '').slice(0, 500), source: f.source })),
  };
}

export async function askJev({ prompt, current, currentEffort, contextTokens, models, efforts = [], taskContext, capabilityQuestions }) {
  if (!models?.length) return null;
  const started = Date.now();
  const abort = new AbortController();
  const deadline = setTimeout(() => abort.abort(), THRESHOLDS.jevDeadlineMs);
  const request = {
    state: {
      request: prompt,
      ...(taskContext ? { task_context: routingContext(taskContext) } : {}),
      session: { current_model: current, current_effort: currentEffort, context_tokens: contextTokens },
      environment: {
        available_models: models.map((model) => model.id),
        ...(efforts.length ? { available_reasoning_efforts: efforts } : {}),
      },
    },
    questions: {
      ...QUESTIONS,
      model: questionForModels(models),
      ...(efforts.length ? { effort: questionForEfforts(efforts) } : {}),
      // Skill/agent choices ride on the same call, so they add no extra round trip.
      ...(capabilityQuestions ?? {}),
    },
  };
  try {
    const result = await getClient().systemOne(request, { signal: abort.signal });
    const { model: answer, effort, task_complexity, reasoning_required, tool_complexity, skill, agent } = result.answers;
    return {
      ...answer,
      capabilityAnswers: capabilityQuestions ? { skill: skill ?? null, agent: agent ?? null } : null,
      routerModel: result.model ?? null,
      usage: result.usage ? { inputTokens: result.usage.input_tokens, outputTokens: result.usage.output_tokens } : null,
      effort: effort?.choice ?? null,
      effortConfidence: effort?.confidence ?? null,
      effortProbabilities: effort?.probabilities ?? null,
      request,
      response: result,
      metrics: {
        taskComplexity: task_complexity.score / COMPLEXITY_MAX_SCORE,
        reasoningRequired: reasoning_required.score / COMPLEXITY_MAX_SCORE,
        toolComplexity: tool_complexity.score / COMPLEXITY_MAX_SCORE,
        contextSize: Math.min(contextTokens / CONTEXT_WINDOW_TOKENS, 1),
      },
      ms: Date.now() - started,
    };
  } catch (err) {
    log(`routing failed, keeping ${current}: ${err.message}`);
    return null;
  } finally {
    clearTimeout(deadline);
  }
}
