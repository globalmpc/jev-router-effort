import http from "node:http";
import https from "node:https";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { Transform } from "node:stream";
import {
  TIERS,
  tierOf,
  idOf,
  availableTiers,
  tierSpec,
  isAuto,
  shouldUseExactModel,
} from "./config.mjs";
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

const ANTHROPIC_BASE_URL = "https://api.anthropic.com";
const CLAUDE_EFFORTS = ["low", "medium", "high"];
const CLAUDE_MANUAL_EFFORTS = [...CLAUDE_EFFORTS, "xhigh", "max"];
const debug = (line) => process.env.JEV_DEBUG && log(line);

export function claudeEffort(tier, recommended, previous) {
  if (!tierSpec(tier)?.effort) return null;
  return CLAUDE_EFFORTS.includes(recommended)
    ? recommended
    : CLAUDE_MANUAL_EFFORTS.includes(previous) ? previous : null;
}

export function routingNotice({ model, effort, confidence, reason, capabilities = "" }) {
  const detail = confidence == null ? reason : `${reason}, confidence ${confidence.toFixed(2)}`;
  const effortDetail = effort ? `effort auto → ${effort}`
    : tierSpec(tierOf(model))?.effort === false ? "effort n/a" : "effort unset";
  return `[Jev] routed this turn to ${model} (${detail}, ${effortDetail}).${capabilities ? ` ${capabilities}.` : ""}`;
}

/** Prefix the first real text delta so Claude Code's UI renders the decision. */
export function prependRoutingNotice(notice, onInserted = () => {}) {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  let inserted = false;
  const event = (type, data) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  return new Transform({
    transform(chunk, _encoding, callback) {
      pending += decoder.write(chunk);
      let boundary;
      while ((boundary = /\r?\n\r?\n/.exec(pending))) {
        const frame = pending.slice(0, boundary.index);
        pending = pending.slice(boundary.index + boundary[0].length);
        const type = /^event:\s*(.+)$/m.exec(frame)?.[1];
        const data = frame.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
        let parsed;
        try { parsed = JSON.parse(data); } catch { /* Ping and unrecognized frames pass through. */ }
        if (type === "content_block_delta" && parsed?.delta?.type === "text_delta" && !inserted) {
          inserted = true;
          parsed.delta.text = `${notice}\n${parsed.delta.text ?? ""}`;
          this.push(event(type, parsed));
          onInserted();
          continue;
        }
        this.push(`${frame}\n\n`);
      }
      callback();
    },
    flush(callback) {
      const remaining = pending + decoder.end();
      if (remaining) this.push(remaining);
      callback();
    },
  });
}

/**
 * Claude Code converts draft-04 relics in MCP tool schemas before sending them first-party,
 * but skips that when ANTHROPIC_BASE_URL is set, so the API rejects the request. In draft
 * 2020-12 `exclusiveMinimum`/`exclusiveMaximum` are numbers, not booleans.
 */
export function sanitizeSchema(node) {
  if (Array.isArray(node)) return node.forEach(sanitizeSchema);
  if (!node || typeof node !== "object") return;
  for (const [key, bound] of [
    ["exclusiveMinimum", "minimum"],
    ["exclusiveMaximum", "maximum"],
  ]) {
    if (typeof node[key] === "boolean") {
      if (node[key] && typeof node[bound] === "number") {
        node[key] = node[bound];
        delete node[bound];
      } else {
        delete node[key];
      }
    }
  }
  for (const v of Object.values(node)) sanitizeSchema(v);
}

/**
 * The text of a genuinely new user turn, or null.
 *
 * A turn can continue for many requests while Claude works through tool calls, and those
 * continuations end in a `tool_result` rather than typed text. Routing them would re-ask
 * Jev on every tool call and let the model flip mid-task, so only the opening request of a
 * turn counts. Claude Code also injects `<system-reminder>` blocks into the user message,
 * which are noise to a router and measurably blunt Jev's confidence, so they are removed.
 */
export function newTurnPrompt(body) {
  if (!Array.isArray(body?.tools) || body.tools.length === 0) return null; // auxiliary call
  // Claude Code can append a system message after the user's latest turn.
  // Skip only trailing system entries; an assistant or tool_result still means continuation.
  const last = body?.messages?.findLast((message) => message?.role !== "system");
  if (!last || last.role !== "user") return null;
  let text;
  if (typeof last.content === "string") {
    text = last.content;
  } else if (Array.isArray(last.content)) {
    if (last.content.some((b) => b.type === "tool_result")) return null;
    text = last.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n");
  } else {
    return null;
  }
  return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim() || null;
}

/** Image blocks the user attached to a new turn, capped so a description stays fast. */
export function turnImages(body) {
  const last = body?.messages?.findLast((message) => message?.role !== "system");
  if (last?.role !== "user" || !Array.isArray(last.content)) return [];
  return last.content.filter((b) => b?.type === "image" && b.source).slice(0, DESCRIBE_MAX_IMAGES);
}

/**
 * Asks a fast Claude model for one short description per image, as routing input for Jev.
 * Uses the turn's own credentials (forwarded, never read). Returns one string (or null) per
 * image, or null on any failure or when `deadlineMs` passes. Never throws.
 */
export async function describeClaudeImages({ images, headers, upstreamURL, model, deadlineMs = DESCRIBE_DEADLINE_MS }) {
  try {
    if (!images?.length || !model) return null;
    const response = await fetch(`${upstreamURL.replace(/\/$/, "")}/v1/messages`, {
      method: "POST",
      headers: { ...describeHeaders(headers), "content-type": "application/json" },
      body: JSON.stringify({
        model,
        max_tokens: 400,
        messages: [{ role: "user", content: [...images, { type: "text", text: describeInstruction(images.length) }] }],
      }),
      signal: AbortSignal.timeout(deadlineMs),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    const text = (data.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("");
    const found = parseDescriptions(text, images.length);
    debug(found ? `described ${found.filter(Boolean).length} image(s) with ${model}` : "image description empty");
    return found;
  } catch (err) {
    debug(`image description failed: ${err.name === "TimeoutError" ? "timeout" : err.message}`);
    return null;
  }
}

/**
 * Points a request at a tier, removing request fields that tier cannot accept. Claude Code
 * composes the body for whatever model it thinks it is talking to, so downgrading to Haiku
 * while leaving `thinking: {type:"adaptive"}` in place is a hard 400.
 */
export function applyTier(body, tierName, model = idOf(tierName)) {
  const tier = tierSpec(tierName);
  if (!tier) return body;
  body.model = model;
  if (!tier.thinking) {
    delete body.thinking;
    // A context-management strategy that prunes thinking blocks is itself rejected once
    // thinking is gone, so it has to go with it.
    const edits = body.context_management?.edits;
    if (Array.isArray(edits)) {
      body.context_management.edits = edits.filter((e) => !/thinking/i.test(e?.type ?? ""));
      if (body.context_management.edits.length === 0) delete body.context_management;
    }
  }
  if (!tier.effort && body.output_config) {
    delete body.output_config.effort;
    if (Object.keys(body.output_config).length === 0) delete body.output_config;
  }
  return body;
}

/** Exact Claude models reported by the account, newest first; static ids are the cold-start fallback. */
export function claudeModels(catalog = []) {
  const models = catalog
    .filter((model) => tierOf(model?.id))
    .map((model) => ({
      id: model.id,
      tier: tierOf(model.id),
      description: [
        model.display_name,
        model.created_at && `released ${model.created_at.slice(0, 10)}`,
        model.max_input_tokens && `${model.max_input_tokens} input tokens`,
      ].filter(Boolean).join("; "),
    }));
  return models.length
    ? models
    : TIERS.map((tier) => ({ id: tier.id, tier: tier.name, description: tier.id }));
}

const modelForTier = (models, tier) => models.find((model) => model.tier === tier)?.id ?? idOf(tier);

/**
 * Identifies the conversation a request belongs to. Claude Code runs sub-agents through the
 * same endpoint, so a single pinned model would let a sub-agent's choice leak into the main
 * conversation.
 *
 * Only stable fields may be used. Claude Code moves its `cache_control` breakpoint between
 * requests and rewrites message metadata, so the key is built from the session id plus the
 * text of the first message, which is fixed once a conversation starts and differs between
 * the main agent and each sub-agent.
 */
/**
 * Session id Claude Code embeds in request metadata, or "" when it isn't present.
 * `metadata.user_id` is a JSON string, not a plain id.
 */
export function sessionOf(body) {
  try {
    return JSON.parse(body?.metadata?.user_id ?? "{}").session_id ?? "";
  } catch {
    return "";
  }
}

export function conversationKey(body) {
  const session = sessionOf(body);
  const content = body?.messages?.[0]?.content;
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .filter((b) => b.type === "text")
            .map((b) => b.text)
            .join("")
        : "";
  return createHash("sha1").update(`${session}|${text}`).digest("hex").slice(0, 12);
}

/**
 * Records the tier Claude Code is asking for and reports whether the user has taken manual
 * control. The first tier seen in a conversation is the baseline; any later change means the
 * user picked a model with /model, and an explicit choice must beat the router. Compared by
 * tier rather than exact model id, because Claude Code varies the id within a tier.
 */
export function observeModel(state, current) {
  state.baseline ??= current;
  if (current !== state.baseline) state.manual = true;
  return state.manual;
}


export async function startProxy({
  upstreamURL = ANTHROPIC_BASE_URL,
  route = askJev,
  describe = describeClaudeImages,
  describeDeadlineMs = DESCRIBE_DEADLINE_MS,
  runtimeConfig,
  cwd = process.cwd(),
  workspaceError,
} = {}) {
  if (route === askJev) warmJev();
  const tasks = createTaskRuntime({ cli: "claude", route, cwd, workspaceError, config: runtimeConfig ?? (route !== askJev ? { enabled: false } : undefined) });
  // Opt-in skill/agent routing and private event log; null unless runtime config enables it.
  const capabilities = createCapabilityRuntime({ cli: "claude", config: tasks.config, cwd });
  // Tier routed for each conversation's turn in flight, reused by its follow-up requests and
  // by the cache-rebuild guard, which needs to know what the prompt cache was built on.
  const convos = new Map();
  const catalog = new Map();
  const stateFor = (key) => {
    let s = convos.get(key);
    if (!s) {
      if (convos.size > 50) convos.delete(convos.keys().next().value);
      convos.set(key, (s = { tier: null }));
    }
    return s;
  };

  const server = http.createServer((req, res) => {
    if (rejectForeign(req, res, server.address().port)) return;
    // Claude Code probes the base URL before its first request.
    if (req.method === "HEAD") return res.writeHead(200).end();

    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      let out = Buffer.concat(chunks);
      let notice = null;
      let routingState = null;
      let capability = null;

      if (/^\/v1\/messages/.test(req.url ?? "")) {
        try {
          const body = JSON.parse(out.toString());
          // Claude Code's request shape is undocumented and moves; JEV_DUMP captures it.
          if (process.env.JEV_DUMP) {
            writeDump(JSON.stringify(body, null, 2));
          }
          body.tools?.forEach((t) => sanitizeSchema(t.input_schema));
          if (Array.isArray(body.tools)) tasks.assertLocal(conversationKey(body));

          // Anything that is not the sentinel is a model the user chose, and an explicit
          // choice beats the router. That also covers Claude Code's own cheap Haiku calls
          // for titles and summaries, which must never be pinned up to the session's tier.
          if (!isAuto(body.model)) {
            debug(`passthrough, user selected ${body.model}`);
            // Only a real agent turn reflects the user's choice. Claude Code's own auxiliary
            // calls carry no tools and must not flip the status line to manual mid-session.
            if (Array.isArray(body.tools)) {
              writeStatus(sessionOf(body), { manual: true, at: Date.now() });
            }
          } else {
            const key = conversationKey(body);
            tasks.assertLocal(key);
            const state = stateFor(key);
            routingState = state;
            // What the prompt cache was built on, which is what a downgrade would discard.
            const current = state.tier ?? "opus";
            const prompt = newTurnPrompt(body);
            const explaining = prompt?.includes("<jev-explain>");
            let fresh = null;
            if (prompt && !explaining) {
              const models = claudeModels([...catalog.values()]).filter((model) =>
                availableTiers().includes(model.tier),
              );
              const available = [...new Set(models.map((model) => model.tier))];
              const currentModel = state.model ?? modelForTier(models, current);
              const contextTokens = Math.round(JSON.stringify(body.messages).length / 4);
              const images = turnImages(body);
              const descriptions = images.length && shouldDescribeImages(prompt)
                ? await describe({
                    images, headers: req.headers, upstreamURL, deadlineMs: describeDeadlineMs,
                    model: modelForTier(claudeModels([...catalog.values()]), "haiku"),
                  })
                : null;
              // Trailing system entries are dropped from the count: Claude Code resends a 400'd first
              // request with them folded into the user turn, and that must still count as a retry.
              capability = capabilities?.prepare({ prompt, conversationId: key, sessionId: sessionOf(body) || null,
                messageCount: body.messages.filter((m) => m?.role !== "system").length }) ?? null;
              const jev = await tasks.route({
                taskKey: key,
                taskHistory: body.messages.filter(m => m.role === "user").map(m => newTurnPrompt({ ...body, messages: [m] })).filter(Boolean),
                prompt: withImageDescriptions(prompt, images.length, descriptions), current: currentModel, currentEffort: state.effort ?? body.output_config?.effort,
                contextTokens, models, efforts: CLAUDE_EFFORTS,
                ...(capability?.questions ? { capabilityQuestions: capability.questions } : {}),
              });
              const chosen = models.find((model) => model.id === jev?.choice);
              const tierAnswer = jev && { ...jev, choice: chosen?.tier };
              const { tier, reason } = decide({
                prompt,
                jev: tierAnswer,
                current,
                available,
                contextTokens,
              });
              const model =
                shouldUseExactModel(reason, chosen?.tier, tier)
                  ? chosen.id
                  : tier === current
                    ? currentModel
                    : modelForTier(models, tier);
              state.tier = tier;
              state.model = model;
              state.effort = claudeEffort(tier, jev?.effort, state.effort ?? body.output_config?.effort);
              const capabilityResult = capabilities?.finalize(capability, { jev, taskId: tasks.taskIdFor(key), taskType: jev?.taskContext?.taskType ?? null,
                model, effort: state.effort, modelReason: reason }) ?? { notice: "" };
              state.capabilityNotice = capabilityResult.notice;
              fresh = {
                prompt,
                model,
                effort: state.effort,
                effortMode: "auto",
                effortConfidence: jev?.effortConfidence ?? null,
                confidence: jev?.confidence ?? null,
                metrics: jev?.metrics ?? null,
                reason,
                evidence: jev?.evidence ?? null,
                checkpoint: jev?.checkpoint ?? null,
                capabilities: capabilityResult.decision ?? null,
                requestId: capability?.requestId ?? null,
                jev: jev ? { request: jev.request, response: jev.response } : null,
              };
              debug(
                `${key} ${jev ? `${jev.ms ?? "?"}ms p=${jev.confidence?.toFixed(2) ?? "unknown"}` : "no-jev"} ` +
                  `${current} -> ${tier} (${reason}) ctx~${contextTokens} | ${prompt.slice(0, 60)}`,
              );
            }
            // The sentinel is not a real model, so every routed request must be rewritten,
            // including follow-ups that reuse the tier chosen for the turn.
            const tier = state.tier ?? current;
            const model = state.model ?? idOf(tier);
            debug(`${key} rewrite ${body.model} -> ${model}`);
            if (capabilities) {
              capabilities.observe(body, key);
              const injected = capabilities.inject(body, key);
              if (injected) debug(`${key} capability injection on ${injected} message(s)`);
            }
            applyTier(body, tier, model);
            if (state.effort) {
              body.output_config ??= {};
              body.output_config.effort = state.effort;
            }
            tasks.assertModel({ taskKey: key, model, effort: state.effort });
            if (fresh) state.notice = routingNotice({ model, effort: state.effort, confidence: fresh.confidence, reason: fresh.reason, capabilities: state.capabilityNotice });
            notice = state.notice;
            // Publish what went out. Claude Code's UI shows the row you picked, not the tier
            // it resolved to, so the status line is the only place this is visible.
            // `claude -p` omits metadata on the first request of a session, so there is no
            // session id to file the decision under and it would be dropped. The conversation
            // key is stable for the same conversation and is already what `debug` prints, so
            // it is the identifier a user can pass to `jev-explain` for a print-mode run.
            if (fresh && !explaining) {
              writeDecision(sessionOf(body) || key, { tier, ...fresh, at: Date.now() });
            }
          }
          out = Buffer.from(JSON.stringify(body));
        } catch (err) {
          capabilities?.fail(capability, err?.routingHold ? "routing-hold" : "routing", err);
          capability = null;
          if (sendRoutingHold(res, err)) return;
          debug(`passthrough, could not process body: ${err.message}`);
        }
      }

      const target = new URL(upstreamURL);
      const transport = target.protocol === "http:" ? http : https;
      const headers = { ...req.headers, host: target.host };
      delete headers["content-length"];
      if (req.method === "GET" && /^\/v1\/models(?:\?|$)/.test(req.url ?? "")) {
        delete headers["accept-encoding"];
      }
      // A routed turn needs an uncompressed SSE stream to show the decision in its first
      // text delta. Follow-up requests return to the CLI's normal compression setting.
      if (process.env.JEV_DEBUG || notice) delete headers["accept-encoding"];
      const upstream = transport.request(
        {
          hostname: target.hostname,
          port: target.port || undefined,
          path: `${target.pathname.replace(/\/$/, "")}${req.url}`,
          method: req.method,
          headers,
        },
        (up) => {
          const isModels = req.method === "GET" && /^\/v1\/models(?:\?|$)/.test(req.url ?? "");
          if (isModels) {
            const chunks = [];
            up.on("data", (chunk) => chunks.push(chunk));
            up.on("end", () => {
              const data = Buffer.concat(chunks);
              try {
                for (const model of JSON.parse(data.toString()).data ?? []) {
                  if (tierOf(model?.id)) catalog.set(model.id, model);
                }
              } catch (err) {
                debug(`could not read Claude model catalog: ${err.message}`);
              }
              const headers = { ...up.headers };
              delete headers["content-length"];
              res.writeHead(up.statusCode, headers);
              res.end(data);
            });
            return;
          }
          const isStream = /text\/event-stream/i.test(up.headers["content-type"] ?? "");
          const showNotice = notice && up.statusCode >= 200 && up.statusCode < 300 && isStream &&
            !up.headers["content-encoding"];
          debug(`notice: ${showNotice ? "prepend" : "skip"} status=${up.statusCode} stream=${isStream} ` +
            `fresh=${Boolean(notice)} encoding=${up.headers["content-encoding"] ?? "none"}`);
          const responseHeaders = showNotice ? { ...up.headers } : up.headers;
          if (showNotice) delete responseHeaders["content-length"];
          res.writeHead(up.statusCode, responseHeaders);
          if (capability) {
            // Record the model the API reports, so selection and actual service can differ visibly.
            const requestId = capability.requestId;
            if (up.statusCode < 200 || up.statusCode >= 300) capabilities.served(requestId, { status: up.statusCode });
            else {
              let text = "";
              const onData = (chunk) => {
                text += chunk.toString("utf8");
                const m = /"model"\s*:\s*"([^"]+)"/.exec(text);
                if (!m && text.length < 8192) return;
                up.off("data", onData);
                capabilities.served(requestId, { status: up.statusCode, model: m?.[1] ?? null });
              };
              if (up.headers["content-encoding"]) capabilities.served(requestId, { status: up.statusCode, model: null });
              else up.on("data", onData);
            }
          }
          // Report the model the API itself says it used, so the routing can be confirmed
          // from the wire rather than trusted from our own decision log. Claude Code's UI
          // always shows the model it asked for, never the one we rewrote to.
          if (process.env.JEV_DEBUG) {
            let seen = false;
            up.on("data", (c) => {
              if (seen) return;
              const m = /"model"\s*:\s*"([^"]+)"/.exec(c.toString("utf8"));
              if (!m) return;
              seen = true;
              debug(`${up.statusCode} served by ${m[1]}`);
            });
          }
          if (showNotice) {
            up.pipe(prependRoutingNotice(notice, () => { routingState.notice = null; })).pipe(res);
          } else up.pipe(res);
        },
      );
      upstream.on("error", (e) => {
        debug(`upstream error: ${e.message}`);
        if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { message: e.message } }));
      });
      if (out.length) upstream.write(out);
      upstream.end();
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: server.address().port, close: () => server.close() };
}
