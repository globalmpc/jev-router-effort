import http from "node:http";
import https from "node:https";
import { createHash, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { availableTiers, shouldUseExactModel } from "./config.mjs";
import { askJev, warmJev } from "./router.mjs";
import { decide } from "./policy.mjs";
import { createTaskRuntime, sendRoutingHold } from "./task-runtime.mjs";
import { createCapabilityRuntime } from "./capability-runtime.mjs";
import { log, writeDump } from "./log.mjs";
import { writeDecision, writeStatus } from "./status.mjs";
import {
  DESCRIBE_DEADLINE_MS,
  DESCRIBE_MAX_IMAGES,
  describeHeaders,
  describeInstruction,
  parseDescriptions,
  shouldDescribeImages,
  withImageDescriptions,
} from "./image-describe.mjs";
import { rejectForeign } from "./local-guard.mjs";

const CHATGPT_BASE_URL = "https://chatgpt.com/backend-api/codex";
const API_BASE_URL = "https://api.openai.com/v1";
export const CODEX_AUTO_MODEL = "jev-router";
export const CODEX_AUTO_EFFORT = "auto";
// The native picker also lists client modes such as Ultra (automatic delegation).
// Those modes are not valid Responses API reasoning.effort values.
const API_EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
const apiEffortsOf = (model) =>
  model?.supported_reasoning_levels?.map((level) => level.effort)
    .filter((effort) => API_EFFORTS.has(effort)) ?? [];
const DEFAULT_MODELS = {
  haiku: "gpt-5.6-luna",
  sonnet: "gpt-5.6-terra",
  opus: "gpt-5.6-sol",
  fable: "gpt-6-astra",
};
const MODEL_ENV = {
  haiku: "JEV_CODEX_FAST_MODEL",
  sonnet: "JEV_CODEX_BALANCED_MODEL",
  opus: "JEV_CODEX_STRONG_MODEL",
  fable: "JEV_CODEX_LONG_MODEL",
};

export const codexModelOf = (tier) => process.env[MODEL_ENV[tier]] ?? DEFAULT_MODELS[tier];

export function codexTierOf(model) {
  const configured = Object.keys(DEFAULT_MODELS).find((tier) => codexModelOf(tier) === model);
  if (configured) return configured;
  if (/(?:astra|fable|long)/i.test(model ?? "")) return "fable";
  if (/(?:sol|opus|strong|max|pro)/i.test(model ?? "")) return "opus";
  if (/(?:luna|haiku|fast|mini|nano)/i.test(model ?? "")) return "haiku";
  return /^gpt-/i.test(model ?? "") ? "sonnet" : null;
}

/** Only models reported by the account are eligible, including on cold start. */
export function codexModels(models = new Map()) {
  const available = [...models.values()]
    .filter((model) => model.slug !== CODEX_AUTO_MODEL && model.supported_in_api !== false)
    .map((model) => {
      const efforts = apiEffortsOf(model);
      return {
        id: model.slug,
        tier: codexTierOf(model.slug),
        description: [
          model.display_name,
          model.description,
          model.context_window && `${model.context_window} context tokens`,
          efforts.length && `supported reasoning efforts: ${efforts.join(", ")}`,
        ].filter(Boolean).join("; "),
        efforts,
        defaultEffort: API_EFFORTS.has(model.default_reasoning_level) ? model.default_reasoning_level : null,
      };
    })
    .filter((model) => model.tier);
  return available;
}

const modelForTier = (models, tier) =>
  models.find((model) => model.tier === tier)?.id ?? models[0]?.id;

const textOf = (content) => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((item) => item?.type === "text" || item?.type === "input_text" || item?.type === "output_text")
    .map((item) => item.text)
    .join("\n");
};

const cleanPrompt = (text) =>
  text
    .replace(/<system[-_]reminder>[\s\S]*?<\/system[-_]reminder>/gi, "")
    .replace(/<current_datetime>[\s\S]*?<\/current_datetime>/gi, "")
    .replace(/<environment_context>[\s\S]*?<\/environment_context>/gi, "")
    .trim();

export const isCodexAuxiliaryPrompt = (prompt) =>
  /^Generate a concise, single-line task title\b/i.test(prompt);

/** User text that starts a new Codex turn, or null for tool continuations. */
export function codexNewTurnPrompt(body) {
  if (!Array.isArray(body?.input)) return null;
  if (!body.input.some((item) => item?.type === "additional_tools")) return null;
  for (const item of [...body.input].reverse()) {
    if (item?.type === "function_call_output" || item?.type === "custom_tool_call_output") return null;
    if (item?.role !== "user") continue;
    const prompt = cleanPrompt(textOf(item.content));
    if (prompt && !isCodexAuxiliaryPrompt(prompt)) return prompt;
  }
  return null;
}

/** Images the user attached to the newest user message, capped so a description stays fast. */
export function codexTurnImages(body) {
  const last = [...(body?.input ?? [])].reverse().find((item) => item?.role === "user");
  if (!Array.isArray(last?.content)) return [];
  return last.content.filter((item) => item?.type === "input_image" && item.image_url).slice(0, DESCRIBE_MAX_IMAGES);
}

/**
 * Asks the account's fastest model, at its lowest effort, for one short description per
 * image, as routing input for Jev. Uses the turn's own credentials (forwarded, never read).
 * The ChatGPT backend only streams, so the reply is read from SSE text deltas. Returns one
 * string (or null) per image, or null on any failure or when `deadlineMs` passes. Never throws.
 */
export async function describeCodexImages({ images, headers, baseURL, model, deadlineMs = DESCRIBE_DEADLINE_MS }) {
  try {
    if (!images?.length || !model?.id) return null;
    const forwarded = describeHeaders(headers);
    delete forwarded["x-openai-internal-codex-responses-lite"];
    const effort = ["none", "minimal", "low"].find((level) => model.efforts?.includes(level));
    const response = await fetch(`${baseURL.replace(/\/$/, "")}/responses`, {
      method: "POST",
      headers: { ...forwarded, "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify({
        model: model.id,
        instructions: "You describe images for a task router. Be brief and factual.",
        input: [{ type: "message", role: "user", content: [...images, { type: "input_text", text: describeInstruction(images.length) }] }],
        ...(effort ? { reasoning: { effort } } : {}),
        stream: true,
        store: false,
      }),
      signal: AbortSignal.timeout(deadlineMs),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    let text = "";
    for (const line of (await response.text()).split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      try {
        const event = JSON.parse(line.slice(5));
        if (event.type === "response.output_text.delta") text += event.delta ?? "";
      } catch { /* [DONE] and keep-alives */ }
    }
    const found = parseDescriptions(text, images.length);
    debug(found ? `described ${found.filter(Boolean).length} image(s) with ${model.id}` : "image description empty");
    return found;
  } catch (err) {
    debug(`image description failed: ${err.name === "TimeoutError" ? "timeout" : err.message}`);
    return null;
  }
}

export function codexConversationKey(body) {
  const stable =
    body?.prompt_cache_key ??
    body?.client_metadata?.["x-codex-turn-metadata"] ??
    `${body?.instructions ?? ""}|${textOf(body?.input?.find((item) => item?.role === "user")?.content)}`;
  return createHash("sha1").update(String(stable)).digest("hex").slice(0, 12);
}

/** Receiver-only textual context. Never send instructions/artifacts/tool output to Jev. */
export function codexHandoffContext(body) {
  const items = [];
  for (const item of body?.input ?? []) {
    if (item?.type === 'additional_tools') continue;
    const entry = { type: item.type ?? 'message', ...(item.role ? { role: item.role } : {}) };
    if (item.call_id) entry.callId = item.call_id;
    if (item.name) entry.name = item.name;
    if (item.arguments !== undefined) entry.arguments = item.arguments;
    const text = textOf(item.content);
    if (text) entry.text = text;
    if (item.output !== undefined) entry.output = item.output;
    if (Array.isArray(item.content)) {
      const nonText = item.content.filter(part => !['text', 'input_text', 'output_text'].includes(part?.type));
      if (nonText.length) entry.unavailableContent = nonText.map(part => ({ type: part?.type ?? 'unknown',
        reason: 'Non-text content not transferred; inspect the original conversation if needed.' }));
    }
    if (!entry.text && entry.output === undefined && entry.arguments === undefined && !entry.unavailableContent) {
      entry.unavailableContent = [{ type: item.type ?? 'unknown', reason: 'No transferable text in this input item.' }];
    }
    items.push(entry);
  }
  return { instructions: body?.instructions ?? '', items };
}

/** Instruction-only user messages belong to receiver context, not the task objective. */
export function codexTaskHistory(body) {
  return (body?.input ?? []).filter(item => item?.role === 'user')
    .map(item => cleanPrompt(textOf(item.content)))
    .filter(prompt => prompt && !isCodexAuxiliaryPrompt(prompt)
      && !/^#\s*AGENTS\.md instructions for\b/i.test(prompt)
      && !/^<INSTRUCTIONS>[\s\S]*<\/INSTRUCTIONS>\s*$/i.test(prompt));
}

export function addJevModel(catalog) {
  if (!Array.isArray(catalog?.models) || catalog.models.some((model) => model.slug === CODEX_AUTO_MODEL)) {
    return catalog;
  }
  const template =
    catalog.models.find((model) => model.slug === codexModelOf("sonnet")) ??
    catalog.models.find((model) => model.visibility === "list") ??
    catalog.models[0];
  if (!template) return catalog;
  const effortLevels = [];
  const seenEfforts = new Set();
  for (const model of catalog.models) {
    for (const level of model.supported_reasoning_levels ?? []) {
      if (!level?.effort || seenEfforts.has(level.effort)) continue;
      seenEfforts.add(level.effort);
      effortLevels.push(level);
    }
  }
  catalog.models.unshift({
    ...template,
    slug: CODEX_AUTO_MODEL,
    display_name: "Jev Router",
    description: "Jev picks the cheapest model that can complete each turn.",
    visibility: "list",
    supported_in_api: true,
    priority: 0,
    upgrade: null,
    default_reasoning_level: CODEX_AUTO_EFFORT,
    supported_reasoning_levels: [
      { effort: CODEX_AUTO_EFFORT, description: "Jev chooses the reasoning effort for each turn." },
      ...effortLevels,
    ],
  });
  return catalog;
}

export function applyCodexTier(body, tier, models = new Map(), model = codexModelOf(tier)) {
  body.model = model;
  const info = models.get(model);
  if (body.reasoning?.effort) {
    const efforts = apiEffortsOf(info);
    const requested = body.reasoning.effort;
    const effort = efforts.length
      ? effortForModel({ efforts, defaultEffort: info.default_reasoning_level }, requested)
      : API_EFFORTS.has(requested) ? requested : null;
    if (effort) body.reasoning.effort = effort;
    else delete body.reasoning.effort;
  }
  return body;
}

/** Keep only API efforts supported by the selected model, never client modes. */
export function effortForModel(model, requested, fallback) {
  const efforts = (model?.efforts ?? []).filter((effort) => API_EFFORTS.has(effort));
  if (requested && efforts.includes(requested)) return requested;
  if (fallback && efforts.includes(fallback)) return fallback;
  if (model?.defaultEffort && efforts.includes(model.defaultEffort)) return model.defaultEffort;
  return efforts[0] ?? null;
}

export const upstreamFor = (
  headers,
  path = "",
  chatgptBaseURL = CHATGPT_BASE_URL,
  apiBaseURL = API_BASE_URL,
) => /\/models(?:\?|$)/.test(path) || headers["chatgpt-account-id"] ? chatgptBaseURL : apiBaseURL;

export function jevDecisionEvents({ tier, model = codexModelOf(tier), effort, effortMode, confidence, effortConfidence, reason, capabilities = "" }) {
  const detail = confidence == null ? reason : `${reason}, confidence ${confidence.toFixed(2)}`;
  const effortDetail = effort
    ? effortMode === CODEX_AUTO_EFFORT
      ? `, effort auto → ${effort}${effortConfidence == null ? "" : ` (${effortConfidence.toFixed(2)})`}`
      : `, effort ${effort} (manual)`
    : "";
  const id = `jev-${randomUUID()}`;
  const text = reason.startsWith("jev-unavailable")
    ? `[Jev] unavailable; using ${model}. Add JEV_API_KEY=... to ~/.jev-router.env and restart jev-codex.`
    : `[Jev] routed this turn to ${model} (${detail}${effortDetail}).${capabilities ? ` ${capabilities}.` : ""}`;
  const item = {
    type: "message",
    role: "assistant",
    id,
    phase: "commentary",
    content: [{ type: "output_text", text }],
  };
  const events = [
    { type: "response.output_item.added", item: { ...item, content: [] } },
    { type: "response.output_text.delta", item_id: id, delta: text },
    { type: "response.output_item.done", item },
  ];
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}

const debug = (line) => process.env.JEV_DEBUG && log(line);
const upstreamPath = (base, path) => `${new URL(base).pathname.replace(/\/$/, "")}${path}`;

export async function startCodexProxy({
  chatgptBaseURL = CHATGPT_BASE_URL,
  apiBaseURL = API_BASE_URL,
  route = askJev,
  describe = describeCodexImages,
  describeDeadlineMs = DESCRIBE_DEADLINE_MS,
  statusId = "",
  runtimeConfig,
  checkpoint,
  handoff,
  cwd = process.cwd(),
  workspaceError,
} = {}) {
  if (route === askJev) warmJev();
  const tasks = createTaskRuntime({ cli: "codex", route, cwd, workspaceError, checkpoint, handoff, config: runtimeConfig ?? (route !== askJev ? { enabled: false } : undefined) });
  const states = new Map();
  const models = new Map();
  const capabilities = createCapabilityRuntime({ cli: "codex", config: tasks.config, cwd });

  const server = http.createServer((req, res) => {
    if (rejectForeign(req, res, server.address().port)) return;
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", async () => {
      let out = Buffer.concat(chunks);
      let routing;
      let capability = null;
      if (req.method === "POST" && /\/responses(?:\?|$)/.test(req.url ?? "")) {
        try {
          const body = JSON.parse(out.toString());
          tasks.assertLocal(codexConversationKey(body));
          if (process.env.JEV_DUMP) {
            writeDump(JSON.stringify(body, null, 2));
          }
          if (body.model === CODEX_AUTO_MODEL) {
            // Codex may reuse its own catalog cache and never GET /models through us.
            // Fetch with this request's account credentials instead of inventing ids.
            if (!models.size) {
              const headers = { ...req.headers };
              for (const name of ["host", "content-length", "connection", "content-type", "accept-encoding"]) delete headers[name];
              const clientVersion = req.headers["version"] ?? /codex[^/]*\/([\d.]+)/i.exec(req.headers["user-agent"] ?? "")?.[1] ?? "0.157.1";
              const response = await fetch(`${chatgptBaseURL}/models?client_version=${encodeURIComponent(clientVersion)}`, {
                headers, signal: AbortSignal.timeout(15000),
              });
              if (!response.ok) throw new Error(`Model catalog HTTP ${response.status}`);
              const catalog = await response.json();
              if (!Array.isArray(catalog.models)) throw new Error("Invalid model catalog");
              for (const info of catalog.models) models.set(info.slug, info);
            }
            const key = codexConversationKey(body);
            tasks.assertLocal(key);
            const candidates = codexModels(models).filter((model) =>
              availableTiers().includes(model.tier) &&
              // Keep the CLI's wire format: Lite bodies cannot safely be sent
              // to legacy models merely by removing the protocol header.
              (req.headers["x-openai-internal-codex-responses-lite"] === undefined ||
                models.get(model.id)?.use_responses_lite === true),
            );
            const available = [...new Set(candidates.map((model) => model.tier))];
            if (!candidates.length) throw new Error("No account models available for routing");
            const previousModel = states.get(key)?.model;
            const currentModel = candidates.some((model) => model.id === previousModel)
              ? previousModel : modelForTier(candidates, "opus");
            const current = codexTierOf(currentModel) ?? "opus";
            const prompt = codexNewTurnPrompt(body);
            const explaining = prompt?.includes("<jev-explain>") || /^\$jev-explain\b/i.test(prompt ?? "");
            let tier = current;
            let model = currentModel;
            const requestedEffort = body.reasoning?.effort ?? CODEX_AUTO_EFFORT;
            const effortMode = requestedEffort === CODEX_AUTO_EFFORT ? CODEX_AUTO_EFFORT : "manual";
            let effort = effortMode === "manual" ? requestedEffort : states.get(key)?.effort ?? null;
            if (prompt && !explaining) {
              const contextTokens = Math.round(JSON.stringify(body.input).length / 4);
              const efforts = [...new Set(candidates.flatMap((candidate) => candidate.efforts))];
              const images = codexTurnImages(body);
              const descriptions = images.length && shouldDescribeImages(prompt)
                ? await describe({
                    images, headers: req.headers, deadlineMs: describeDeadlineMs,
                    baseURL: upstreamFor(req.headers, req.url, chatgptBaseURL, apiBaseURL),
                    model: candidates.find((candidate) => candidate.tier === "haiku") ?? candidates[0],
                  })
                : null;
              capability = capabilities?.prepare({ prompt, conversationId: key, messageCount: body.input.length }) ?? null;
              const jev = await tasks.route({
                ...(capability?.questions ? { capabilityQuestions: capability.questions } : {}),
                taskKey: key,
                taskHistory: codexTaskHistory(body),
                localContext: codexHandoffContext(body),
                manualEffort: effortMode === "manual" ? requestedEffort : null,
                prompt: withImageDescriptions(prompt, images.length, descriptions),
                current: currentModel,
                currentEffort: effort,
                contextTokens,
                models: candidates,
                efforts: effortMode === CODEX_AUTO_EFFORT ? efforts : [],
              });
              const chosen = candidates.find((candidate) => candidate.id === jev?.choice);
              const decision = decide({
                prompt,
                jev: jev && { ...jev, choice: chosen?.tier },
                current,
                available,
                contextTokens,
              });
              tier = decision.tier;
              model =
                shouldUseExactModel(decision.reason, chosen?.tier, tier)
                  ? chosen.id
                  : tier === current
                    ? currentModel
                    : modelForTier(candidates, tier);
              const selected = candidates.find((candidate) => candidate.id === model);
              effort = effortForModel(
                selected,
                effortMode === CODEX_AUTO_EFFORT ? jev?.effort : requestedEffort,
                effort,
              );
              states.set(key, { tier, model, effort, effortMode });
              const capabilityResult = capabilities?.finalize(capability, { jev, taskId: tasks.taskIdFor(key), taskType: jev?.taskContext?.taskType ?? null,
                model, effort, effortMode, modelReason: decision.reason, manualModel: false }) ?? { notice: "" };
              routing = {
                prompt,
                tier,
                model,
                effort,
                effortMode,
                confidence: jev?.confidence ?? null,
                effortConfidence: effortMode === CODEX_AUTO_EFFORT ? jev?.effortConfidence ?? null : null,
                metrics: jev?.metrics ?? null,
                reason: decision.reason,
                evidence: jev?.evidence ?? null,
                checkpoint: jev?.checkpoint ?? null,
                capabilities: capabilityResult.decision ?? null,
                capabilityNotice: capabilityResult.notice,
                requestId: capability?.requestId ?? null,
                jev: jev ? { request: jev.request, response: jev.response } : null,
                at: Date.now(),
              };
              writeDecision(statusId, routing);
              debug(`${key} ${current} -> ${tier} (${decision.reason}) | ${prompt.slice(0, 60)}`);
            }
            if (effort) {
              body.reasoning ??= {};
              body.reasoning.effort = effort;
            }
            capabilities?.inject(body, key);
            applyCodexTier(body, tier, models, model);
            tasks.assertModel({ taskKey: key, model, effort });
          } else {
            const prompt = codexNewTurnPrompt(body);
            const explaining = prompt?.includes("<jev-explain>") || /^\$jev-explain\b/i.test(prompt ?? "");
            if (prompt && !explaining) writeStatus(statusId, { manual: true, at: Date.now() });
          }
          out = Buffer.from(JSON.stringify(body));
        } catch (err) {
          capabilities?.fail(capability, err?.routingHold ? "routing-hold" : "routing", err);
          if (sendRoutingHold(res, err)) return;
          res.writeHead(503, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { message: `Jev routing failed: ${err.message}`, type: "routing_error" } }));
          return;
        }
      }

      const base = upstreamFor(req.headers, req.url, chatgptBaseURL, apiBaseURL);
      const target = new URL(base);
      const transport = target.protocol === "http:" ? http : https;
      const headers = { ...req.headers, host: target.host };
      delete headers["content-length"];
      const upstream = transport.request(
        {
          hostname: target.hostname,
          port: target.port || undefined,
          path: upstreamPath(base, req.url ?? "/"),
          method: req.method,
          headers,
        },
        (response) => {
          const responseHeaders = { ...response.headers };
          const isModels = req.method === "GET" && /\/models(?:\?|$)/.test(req.url ?? "");
          if (isModels) {
            const body = [];
            response.on("data", (chunk) => body.push(chunk));
            response.on("end", () => {
              let data = Buffer.concat(body);
              try {
                const catalog = addJevModel(JSON.parse(data.toString()));
                models.clear();
                for (const model of catalog.models) models.set(model.slug, model);
                data = Buffer.from(JSON.stringify(catalog));
                delete responseHeaders["content-length"];
              } catch (err) {
                debug(`could not extend Codex model catalog: ${err.message}`);
              }
              res.writeHead(response.statusCode, responseHeaders);
              res.end(data);
            });
            return;
          }

          if (capability) {
            const requestId = capability.requestId;
            if (response.statusCode < 200 || response.statusCode >= 300) capabilities.served(requestId, { status: response.statusCode });
            else {
              let seen = "";
              const onData = (chunk) => {
                seen += chunk.toString("utf8");
                const m = /"model"\s*:\s*"([^"]+)"/.exec(seen);
                if (!m && seen.length < 8192) return;
                response.off("data", onData);
                capabilities.served(requestId, { status: response.statusCode, model: m?.[1] ?? null });
              };
              response.on("data", onData);
            }
          }
          const inspectForDecision = routing && response.statusCode >= 200 && response.statusCode < 300;
          if (inspectForDecision) delete responseHeaders["content-length"];
          res.writeHead(response.statusCode, responseHeaders);
          if (!inspectForDecision) {
            response.pipe(res);
            return;
          }
          let pending = "";
          let inspected = false;
          response.on("data", (chunk) => {
            if (inspected) return void res.write(chunk);
            pending += chunk.toString();
            const end = pending.indexOf("\n\n");
            if (end < 0) return;
            const first = pending.slice(0, end + 2);
            res.write(first);
            const isSSE = /^(?:event|data):/m.test(first);
            if (isSSE) res.write(jevDecisionEvents({ ...routing, capabilities: routing.capabilityNotice }));
            debug(`codex decision display ${isSSE ? "inject" : "skip"}`);
            res.write(pending.slice(end + 2));
            pending = "";
            inspected = true;
          });
          response.on("end", () => {
            if (pending) {
              debug("codex decision display skip");
              res.write(pending);
            }
            res.end();
          });
        },
      );
      upstream.on("error", (err) => {
        debug(`codex upstream error: ${err.message}`);
        if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: err.message, type: "proxy_error" } }));
      });
      if (out.length) upstream.write(out);
      upstream.end();
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: server.address().port, close: () => server.close() };
}
