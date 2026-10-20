import { createHash } from "node:crypto";
import http from "node:http";
import https from "node:https";
import { availableTiers, shouldUseExactModel } from "./config.mjs";
import { log } from "./log.mjs";
import { decide } from "./policy.mjs";
import { createTaskRuntime, sendRoutingHold } from "./task-runtime.mjs";
import { askJev, warmJev } from "./router.mjs";
import { writeDecision } from "./status.mjs";
import { rejectForeign } from "./local-guard.mjs";

/** The z.ai coding-plan endpoint the ZAI CLI uses by default; `ZAI_BASE_URL` overrides it. */
export const GLM_DEFAULT_UPSTREAM = "https://api.z.ai/api/coding/paas/v4";

/**
 * Models Jev chooses between, all served by the coding endpoint (checked against its
 * `/models` list). The CLI's own picker only offers glm-4.6/4.5/4.5-air, so the proxy
 * rewrites `model` rather than relying on it.
 */
export const GLM_MODELS = [
  { id: "glm-5.3-flash", tier: "haiku", description: "GLM-5.3 Flash; fast, cheap" },
  { id: "glm-5.2", tier: "sonnet", description: "GLM-5.2; balanced" },
  { id: "glm-5.3", tier: "opus", description: "GLM-5.3; strongest z.ai model" },
];

/**
 * `reasoning_effort` levels, lowest first. GLM-5.3 and 5.3-flash accept only these three;
 * GLM-5.2 accepts them too (docs.z.ai chat-completion reference).
 */
export const GLM_EFFORTS = ["low", "high", "max"];

/**
 * The ZAI CLI renders nothing until a model stream has fully ended, but it renders a tool
 * call the moment that happens, and `echo` runs without confirmation. So a routed turn is
 * answered by the proxy itself with a synthetic `bash` call that echoes the decision; the
 * CLI shows it as soon as Jev decides and sends the tool result back, at which point the
 * real request goes to z.ai. The synthetic pair is removed from history before every
 * request so the model never reads Jev's notes.
 */
export const NOTE_TOOL_PREFIX = "jev-note-";
let noteSeq = 0;

const debug = (line) => process.env.JEV_DEBUG && log(line);
const isChat = (url) => /\/chat\/completions(?:\?|$)/.test(url ?? "");
export const glmTierOf = (id) => GLM_MODELS.find((model) => model.id === id)?.tier ?? null;

const textOf = (content) =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.filter((part) => part?.type === "text").map((part) => part.text).join("\n")
      : "";

/** The user's text when this request starts a new turn; null for tool continuations. */
export function glmNewTurnPrompt(body) {
  const last = body?.messages?.at(-1);
  if (last?.role !== "user") return null;
  return textOf(last.content).trim() || null;
}

/** Stable per-conversation key: the first user message never changes within a session. */
export function glmConversationKey(body) {
  const first = body?.messages?.find((message) => message.role === "user");
  return createHash("sha256").update(textOf(first?.content)).digest("hex").slice(0, 16);
}

const isNoteCall = (call) => typeof call?.id === "string" && call.id.startsWith(NOTE_TOOL_PREFIX);

/** True when this request answers the proxy's own decision call rather than a model call. */
export const isNoteReply = (body) => {
  const last = body?.messages?.at(-1);
  return last?.role === "tool" && typeof last.tool_call_id === "string" && last.tool_call_id.startsWith(NOTE_TOOL_PREFIX);
};

export function stripGlmNotes(body) {
  if (!Array.isArray(body?.messages)) return body;
  body.messages = body.messages.filter((message) => {
    if (message.role === "assistant") return !(message.tool_calls?.length && message.tool_calls.every(isNoteCall));
    if (message.role === "tool") return !(typeof message.tool_call_id === "string" && message.tool_call_id.startsWith(NOTE_TOOL_PREFIX));
    return true;
  });
  return body;
}

export function glmDecisionText({ model, effort, reason, confidence, effortConfidence }) {
  if (reason.startsWith("jev-unavailable")) return `[Jev] unavailable; using ${model}.`;
  const detail = confidence == null ? reason : `${reason}, confidence ${confidence.toFixed(2)}`;
  const effortDetail = effort
    ? `, effort ${effort}${effortConfidence == null ? "" : ` (${effortConfidence.toFixed(2)})`}`
    : "";
  return `[Jev] routed this turn to ${model} (${detail}${effortDetail}).`;
}

/** The synthetic decision call, in the shape the CLI's stream reducer and `chat()` both read. */
export function noteToolCall(routing) {
  const command = `echo '${glmDecisionText(routing).replace(/'/g, "")}'`;
  return {
    id: `${NOTE_TOOL_PREFIX}${++noteSeq}`,
    type: "function",
    function: { name: "bash", arguments: JSON.stringify({ command }) },
  };
}

function sendNote(res, routing, stream) {
  const call = noteToolCall(routing);
  const created = Math.floor(Date.now() / 1000);
  if (!stream) {
    res.writeHead(200, { "content-type": "application/json" });
    return void res.end(JSON.stringify({
      id: call.id,
      object: "chat.completion",
      created,
      model: routing.model,
      choices: [{ index: 0, message: { role: "assistant", content: "", tool_calls: [call] }, finish_reason: "tool_calls" }],
    }));
  }
  const chunk = (delta, finish) =>
    `data: ${JSON.stringify({ id: call.id, object: "chat.completion.chunk", created, model: routing.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  res.write(chunk({ role: "assistant", content: "", tool_calls: [{ index: 0, ...call }] }, null));
  res.write(chunk({}, "tool_calls"));
  res.end("data: [DONE]\n\n");
}

export async function startGlmProxy({
  upstream = GLM_DEFAULT_UPSTREAM,
  route = askJev,
  statusId = "",
  onDecision = () => {},
  runtimeConfig,
  cwd = process.cwd(),
  workspaceError,
} = {}) {
  if (route === askJev) warmJev();
  const tasks = createTaskRuntime({ cli: "glm", route, cwd, workspaceError, config: runtimeConfig ?? (route !== askJev ? { enabled: false } : undefined) });
  const states = new Map();
  const base = new URL(upstream);
  const basePath = base.pathname.replace(/\/$/, "");
  const transport = base.protocol === "http:" ? http : https;

  const choose = async (body, key, prompt) => {
    const candidates = GLM_MODELS.filter((model) => availableTiers().includes(model.tier));
    const previous = states.get(key);
    const currentModel = previous?.model ?? candidates.find((model) => model.tier === "opus")?.id ?? candidates[0].id;
    const current = glmTierOf(currentModel);
    const contextTokens = Math.round(JSON.stringify(body.messages ?? []).length / 4);
    const jev = await tasks.route({
      taskKey: key,
      taskHistory: body.messages.filter(m => m.role === "user").map(m => typeof m.content === "string" ? m.content : "").filter(Boolean),
      prompt,
      current: currentModel,
      currentEffort: previous?.effort ?? null,
      contextTokens,
      models: candidates,
      efforts: GLM_EFFORTS,
    });
    const chosen = candidates.find((model) => model.id === jev?.choice);
    const decision = decide({
      prompt,
      jev: jev && { ...jev, choice: chosen?.tier },
      current,
      available: [...new Set(candidates.map((model) => model.tier))],
      contextTokens,
    });
    const model = shouldUseExactModel(decision.reason, chosen?.tier, decision.tier)
      ? chosen.id
      : decision.tier === current
        ? currentModel
        : candidates.find((candidate) => candidate.tier === decision.tier)?.id ?? currentModel;
    const effort = GLM_EFFORTS.includes(jev?.effort) ? jev.effort : previous?.effort ?? null;
    states.set(key, { model, effort });
    const routing = {
      prompt,
      tier: glmTierOf(model),
      model,
      effort,
      effortMode: "auto",
      confidence: jev?.confidence ?? null,
      effortConfidence: jev?.effortConfidence ?? null,
      metrics: jev?.metrics ?? null,
      reason: decision.reason,
      evidence: jev?.evidence ?? null,
      checkpoint: jev?.checkpoint ?? null,
      jev: jev ? { request: jev.request, response: jev.response } : null,
      at: Date.now(),
    };
    writeDecision(statusId, routing);
    onDecision(routing);
    debug(`glm ${key.slice(0, 8)} ${currentModel} -> ${model}/${effort} (${decision.reason}) | ${prompt.slice(0, 60)}`);
    return routing;
  };

  const server = http.createServer((req, res) => {
    if (rejectForeign(req, res, server.address().port)) return;
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", async () => {
      let out = Buffer.concat(chunks);
      if (req.method === "POST" && isChat(req.url)) {
        try {
          const raw = JSON.parse(out.toString());
          const replying = isNoteReply(raw);
          const body = stripGlmNotes(raw);
          const key = glmConversationKey(body);
          tasks.assertLocal(key);
          const prompt = replying ? null : glmNewTurnPrompt(body);
          if (prompt) {
            let routing = null;
            try {
              routing = await choose(body, key, prompt);
            } catch (err) {
              if (err.routingHold) throw err;
              log(`glm routing failed: ${err.message}`);
            }
            // Answer this request ourselves; the CLI comes back with the echo's result and
            // that follow-up is the one z.ai sees.
            if (routing) return void sendNote(res, routing, body.stream === true);
          }
          // Tool continuations and sub-agents keep the turn's model; a conversation the proxy
          // has never routed keeps whatever the CLI asked for.
          const state = states.get(key);
          if (state?.model) body.model = state.model;
          if (state?.effort && body.thinking?.type !== "disabled") body.reasoning_effort = state.effort;
          tasks.assertModel({ taskKey: key, model: body.model, effort: body.reasoning_effort });
          out = Buffer.from(JSON.stringify(body));
        } catch (err) {
          if (sendRoutingHold(res, err)) return;
          debug(`glm request not rewritten: ${err.message}`);
        }
      }

      const headers = { ...req.headers, host: base.host };
      for (const name of ["content-length", "transfer-encoding", "connection", "accept-encoding"]) delete headers[name];
      headers["content-length"] = String(out.length);
      const upstreamReq = transport.request(
        { hostname: base.hostname, port: base.port || undefined, path: `${basePath}${req.url ?? "/"}`, method: req.method, headers },
        (response) => {
          res.writeHead(response.statusCode, response.headers);
          response.pipe(res);
        },
      );
      upstreamReq.on("error", (err) => {
        debug(`glm upstream error: ${err.message}`);
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: err.message } }));
      });
      res.on("close", () => {
        if (!res.writableFinished) upstreamReq.destroy();
      });
      upstreamReq.end(out);
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: server.address().port,
    close: () => {
      server.close();
      server.closeAllConnections();
    },
  };
}
