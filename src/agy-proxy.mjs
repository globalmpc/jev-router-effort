import http from "node:http";
import https from "node:https";
import { randomUUID } from "node:crypto";
import { closeSync, openSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { availableTiers, shouldUseExactModel } from "./config.mjs";
import { askJev, warmJev } from "./router.mjs";
import { shouldDescribeImages } from "./image-describe.mjs";
import { decide } from "./policy.mjs";
import { createTaskRuntime, sendRoutingHold } from "./task-runtime.mjs";
import { log, writeDump } from "./log.mjs";
import { writeDecision, writeStatus } from "./status.mjs";
import { rejectForeign } from "./local-guard.mjs";

/** AGY's own default Cloud Code server; `CLOUD_CODE_URL` overrides it in the CLI. */
export const AGY_DEFAULT_UPSTREAM = "https://daily-cloudcode-pa.googleapis.com";
export const AGY_AUTO_MODEL = "jev-router";

// Written as the first streamed part of a routed turn, and removed from history before the
// next request so the model never reads Jev's notes as its own output.
const NOTE = /\[Jev\] (?:routed this turn to|unavailable;)[^\n]*\n\n/g;

// Only Gemini is routed: Claude through AGY rejects replayed thinking parts without a signature.
export function agyTierOf(id) {
  if (typeof id !== "string") return null;
  if (/^gemini-[\w.-]*flash-(?:extra-low|low|medium|high)$/.test(id)) return "haiku";
  if (/^gemini-[\w.-]*pro-(?:low|medium|high|agent)$/.test(id) || id === "gemini-pro-agent") return "opus";
  return null;
}

/** Models the native agent picker offers, excluding deprecated IDs and the router itself. */
export function agyModels(catalog) {
  const ids = [];
  for (const sort of catalog?.agentModelSorts ?? []) {
    for (const group of sort.groups ?? []) {
      for (const id of group.modelIds ?? []) if (!ids.includes(id)) ids.push(id);
    }
  }
  if (!ids.length) ids.push(...Object.keys(catalog?.models ?? {}));
  const deprecated = catalog?.deprecatedModelIds ?? {};
  return ids
    .filter((id) => id !== AGY_AUTO_MODEL && !deprecated[id] && catalog?.models?.[id] && agyTierOf(id))
    .map((id) => {
      const info = catalog.models[id];
      return {
        id,
        tier: agyTierOf(id),
        description: [
          info.displayName,
          info.tagTitle,
          info.thinkingBudget && `thinking budget ${info.thinkingBudget} tokens`,
        ].filter(Boolean).join("; "),
      };
    });
}

/** Adds the "Jev Router" row to AGY's catalog response, first in the native picker. */
export function addAgyJevModel(catalog) {
  if (!catalog?.models || catalog.models[AGY_AUTO_MODEL]) return catalog;
  const template = catalog.models[catalog.defaultAgentModelId] ??
    catalog.models[agyModels(catalog)[0]?.id];
  if (!template) return catalog;
  catalog.models[AGY_AUTO_MODEL] = {
    ...template,
    displayName: "Jev Router (auto)",
    tagTitle: "Auto",
    tagDescription: "Jev picks the model for each turn",
    recommended: true,
  };
  for (const sort of catalog.agentModelSorts ?? []) {
    for (const group of sort.groups ?? []) {
      if (Array.isArray(group.modelIds) && !group.modelIds.includes(AGY_AUTO_MODEL)) {
        group.modelIds.unshift(AGY_AUTO_MODEL);
      }
    }
  }
  return catalog;
}

/** The user's text when this request starts a new turn; null for tool continuations. */
export function agyNewTurnPrompt(body) {
  const last = body?.request?.contents?.at(-1);
  return last?.role === "user" && Array.isArray(last.parts) ? userRequestOf(last) : null;
}

function userRequestOf(content) {
  for (const part of content.parts) {
    const match = typeof part?.text === "string" && /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/.exec(part.text);
    if (match?.[1]) return match[1];
  }
  return null;
}

export const AGY_IMAGE_MAX_BYTES = 7 * 1024 * 1024;
export const AGY_IMAGES_MAX_TOTAL_BYTES = 14 * 1024 * 1024;
// A quoted path may contain spaces. An unquoted one may escape them with a backslash, as a
// Finder drag of "Screenshot … at ….png" does; U+202F is the space macOS puts before AM/PM.
const IMAGE_PATH = /(["'])(\/[^"'\n]*?\.(?:png|jpe?g|gif|webp))\1|(?<![^\s"'`(<[])(\/(?:\\.| |[^\s"'`<>()[\]\\])*?\.(?:png|jpe?g|gif|webp))(?=$|[\s"'`)>\],;:!?]|\.(?:\s|$))/gi;

/** Absolute image paths as written in the prompt (`raw`) and on disk (`path`). */
function imageMentions(prompt) {
  const found = [];
  for (const [match, , quoted, bare] of String(prompt ?? "").matchAll(IMAGE_PATH)) {
    const raw = quoted ?? bare;
    const path = quoted ?? bare.replace(/\\(.)/g, "$1");
    if (!found.some((m) => m.path === path)) found.push({ raw: quoted ? match.slice(1, -1) : raw, path });
  }
  return found;
}

/** The image type the file's first bytes declare, whatever its name says. */
export function agyImageType(head) {
  const text = (from, to) => head.toString("latin1", from, to);
  if (head.length >= 4 && head.readUInt32BE(0) === 0x89504e47) return "image/png";
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "image/jpeg";
  if (text(0, 4) === "GIF8") return "image/gif";
  if (text(0, 4) === "RIFF" && text(8, 12) === "WEBP") return "image/webp";
  return null;
}

function readHead(path) {
  const head = Buffer.alloc(12);
  const fd = openSync(path, "r");
  try {
    return head.subarray(0, readSync(fd, head, 0, head.length, 0));
  } finally {
    closeSync(fd);
  }
}

/**
 * Local image files the prompt names by absolute path (as Orca pastes screenshots): real
 * images by their magic bytes, each ≤ 7 MB, together ≤ `maxTotal`. Others stay as text.
 */
export function agyImagePaths(prompt, maxTotal = AGY_IMAGES_MAX_TOTAL_BYTES) {
  const paths = [];
  let total = 0;
  for (const { path } of imageMentions(prompt)) {
    try {
      const stat = statSync(path);
      if (!stat.isFile() || stat.size === 0 || stat.size > AGY_IMAGE_MAX_BYTES || total + stat.size > maxTotal) continue;
      if (!agyImageType(readHead(path))) continue;
      total += stat.size;
      paths.push(path);
    } catch { /* Missing or unreadable: leave it as text. */ }
  }
  return paths;
}

/**
 * Cached bytes while the file is unchanged. `fill` allows reading a file not cached yet;
 * `room` is checked against the file's size before anything is read.
 */
function loadImage(cache, path, fill, room = Infinity) {
  try {
    const stat = statSync(path);
    const hit = cache.get(path);
    if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit;
    if (hit) cache.delete(path);
    if (!fill && !hit) return null;
    if (!stat.isFile() || stat.size === 0 || stat.size > AGY_IMAGE_MAX_BYTES || stat.size > room) return null;
    const bytes = readFileSync(path);
    const mimeType = agyImageType(bytes);
    if (!mimeType) return null;
    const entry = { mtimeMs: stat.mtimeMs, size: bytes.length, mimeType, data: bytes.toString("base64") };
    cache.set(path, entry);
    return entry;
  } catch {
    cache.delete(path);
    return null;
  }
}

const hasMedia = (content) => content.parts.some((part) => part?.inlineData || part?.fileData);

/**
 * Gives the model the pixels of every image named in a user request, newest turn first so
 * the total cap drops the oldest. A new turn fills `cache`; continuations and later turns
 * re-attach the cached bytes, because AGY's history never keeps what the proxy added.
 * Messages AGY already gave media to are left alone, and so are AGY's title (`checkpoint`)
 * calls. `maxTurns` limits how many user turns get images. Returns the attached paths and
 * the number of turns they came from; cache entries the request no longer uses are evicted.
 */
export function attachAgyImages(body, cache = new Map(), { maxTotal = AGY_IMAGES_MAX_TOTAL_BYTES, maxTurns = Infinity } = {}) {
  const contents = body?.request?.contents;
  const attached = { paths: [], turns: 0 };
  if (!Array.isArray(contents) || body.requestType === "checkpoint") return attached;
  const newTurn = agyNewTurnPrompt(body) == null ? null : contents.at(-1);
  const keep = new Set();
  let total = 0;
  for (const content of [...contents].reverse()) {
    const prompt = content?.role === "user" && Array.isArray(content.parts) ? userRequestOf(content) : null;
    const mentions = prompt ? imageMentions(prompt) : [];
    if (hasMedia(content)) for (const { path } of mentions) keep.add(path);
    if (!mentions.length || hasMedia(content)) continue;
    const parts = [];
    for (const { path } of mentions) {
      if (attached.paths.includes(path)) continue;
      if (attached.turns >= maxTurns) {
        keep.add(path);
        continue;
      }
      const entry = loadImage(cache, path, content === newTurn, maxTotal - total);
      if (!entry || total + entry.size > maxTotal) continue;
      total += entry.size;
      keep.add(path);
      attached.paths.push(path);
      parts.push({ inlineData: { mimeType: entry.mimeType, data: entry.data } });
    }
    if (parts.length) attached.turns++;
    content.parts.push(...parts);
  }
  for (const path of cache.keys()) if (!keep.has(path)) cache.delete(path);
  return attached;
}

/**
 * The cheapest image-capable Gemini flash model in the signed-in catalog. AGY's own title
 * model (seen on `checkpoint` requests) wins, then the catalog's flash-lite tier.
 */
export function agyDescribeModel(catalog, preferred) {
  const models = catalog?.models ?? {};
  const deprecated = catalog?.deprecatedModelIds ?? {};
  const usable = (id) => typeof id === "string" && /^gemini-[\w.-]*flash/.test(id) &&
    models[id]?.supportsImages === true && !deprecated[id];
  if (usable(preferred)) return preferred;
  const lite = (catalog?.tieredModelIds?.flashLite ?? []).find(usable);
  if (lite) return lite;
  const levels = ["lite", "extra-low", "low", "medium"];
  const rank = (id) => {
    const level = levels.findIndex((name) => id.endsWith(`-${name}`));
    return level < 0 ? levels.length : level;
  };
  return Object.keys(models).filter(usable).sort((a, b) => rank(a) - rank(b))[0] ?? null;
}

const DESCRIPTION_MAX_CHARS = 400;
const DESCRIBE_INSTRUCTION =
  "Describe each image factually in ≤ 60 words: what UI/code/error is shown, visible text, and anything broken.";

// Headers that belong to one connection or one body, never forwarded to another request.
const HOP_HEADERS = ["content-length", "transfer-encoding", "connection", "accept-encoding", "keep-alive", "upgrade"];
const forwardHeaders = (incoming, host) => {
  const headers = { ...incoming, host };
  for (const name of HOP_HEADERS) delete headers[name];
  return headers;
};

/**
 * Asks a fast vision model for one short description per image, as routing input for Jev.
 * Uses the turn's own upstream and headers (auth is forwarded, never read). Returns one
 * string (or null) per image, or null on any failure or when `deadlineMs` passes. Never throws.
 */
export async function describeAgyImages({
  paths, headers, catalog, upstream, turn, preferred, cache = new Map(), deadlineMs = 4000,
}) {
  try {
    const model = agyDescribeModel(catalog, preferred);
    if (!model || !paths?.length) return null;
    const images = paths.map((path) => loadImage(cache, path, true));
    if (images.some((image) => !image)) return null;
    const base = new URL(upstream);
    const payload = Buffer.from(JSON.stringify({
      project: turn?.project,
      requestId: `checkpoint/${randomUUID()}`,
      model,
      userAgent: turn?.userAgent,
      requestType: "checkpoint",
      request: {
        contents: [{
          role: "user",
          parts: [
            ...images.map(({ mimeType, data }) => ({ inlineData: { mimeType, data } })),
            { text: `${DESCRIBE_INSTRUCTION}\nReply with exactly ${paths.length} line(s), "Image N: <description>", in order.` },
          ],
        }],
        generationConfig: { temperature: 0, thinkingConfig: { includeThoughts: false, thinkingLevel: "LOW" } },
        ...(turn?.request?.sessionId ? { sessionId: turn.request.sessionId } : {}),
      },
    }));
    const text = await new Promise((resolve, reject) => {
      const req = (base.protocol === "http:" ? http : https).request({
        hostname: base.hostname,
        port: base.port || undefined,
        path: `${base.pathname.replace(/\/$/, "")}/v1internal:generateContent`,
        method: "POST",
        headers: { ...forwardHeaders(headers, base.host), "content-type": "application/json", "content-length": String(payload.length) },
        signal: AbortSignal.timeout(deadlineMs),
      }, (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          if (res.statusCode !== 200) return void reject(new Error(`HTTP ${res.statusCode}`));
          try {
            const data = JSON.parse(Buffer.concat(chunks).toString());
            const parts = (data.response ?? data).candidates?.[0]?.content?.parts ?? [];
            resolve(parts.filter((part) => !part.thought && typeof part.text === "string").map((part) => part.text).join(""));
          } catch (err) {
            reject(err);
          }
        });
        res.on("error", reject);
      });
      req.on("error", reject);
      req.end(payload);
    });
    const lines = new Map();
    for (const [, n, line] of text.matchAll(/^\s*\**Image\s*(\d+)\**\s*[:.-]\s*(.+?)\s*$/gim)) lines.set(Number(n), line);
    const found = paths.map((_, i) => {
      const line = lines.get(i + 1) ?? (paths.length === 1 ? text.trim().replace(/\s+/g, " ") : "");
      return line ? (line.length > DESCRIPTION_MAX_CHARS ? `${line.slice(0, DESCRIPTION_MAX_CHARS - 1)}…` : line) : null;
    });
    if (!found.some(Boolean)) {
      debug("agy image description empty");
      return null;
    }
    debug(`agy described ${found.filter(Boolean).length} image(s) with ${model}`);
    return found;
  } catch (err) {
    const timeout = err.name === "TimeoutError" || err.cause?.name === "TimeoutError";
    debug(`agy image description failed: ${timeout ? "timeout" : err.message}`);
    return null;
  }
}

/** Jev's view of the prompt: each image path replaced by what the image shows. */
export function agyPromptWithImages(prompt, paths, descriptions) {
  const raw = new Map(imageMentions(prompt).map((mention) => [mention.path, mention.raw]));
  return paths.reduce((text, path, i) => text.split(raw.get(path) ?? path).join(descriptions?.[i]
    ? `[image: ${descriptions[i]}]`
    : `[image attached: ${basename(path)}, not described]`), prompt);
}

export const agyConversationKey = (body) =>
  body?.request?.labels?.trajectory_id ?? body?.request?.sessionId ?? "default";

/** Removes Jev's own notes from the model's history. Returns the same body. */
export function stripAgyNotes(body) {
  const contents = body?.request?.contents;
  if (!Array.isArray(contents)) return body;
  body.request.contents = contents.flatMap((content) => {
    if (content?.role !== "model" || !Array.isArray(content.parts)) return [content];
    const parts = content.parts.flatMap((part) => {
      if (typeof part?.text !== "string" || part.thought || !part.text.includes("[Jev] ")) return [part];
      const text = part.text.replace(NOTE, "");
      return text ? [{ ...part, text }] : [];
    });
    return parts.length ? [{ ...content, parts }] : [];
  });
  return body;
}

/** Points a request at the chosen model, copying the fields AGY derives from the catalog. */
export function applyAgyModel(body, id, info) {
  body.model = id;
  const request = body.request ?? {};
  if (request.labels) {
    if (info?.model) request.labels.model_enum = info.model;
    if ("used_claude" in request.labels) request.labels.used_claude = "false";
    if ("used_claude_conservative" in request.labels) request.labels.used_claude_conservative = "false";
    if ("used_non_gemini_model" in request.labels) request.labels.used_non_gemini_model = "false";
  }
  const config = request.generationConfig;
  if (config && info) {
    if (config.maxOutputTokens != null && info.maxOutputTokens) config.maxOutputTokens = info.maxOutputTokens;
    if (config.thinkingConfig?.thinkingBudget != null && info.thinkingBudget) {
      config.thinkingConfig.thinkingBudget = info.thinkingBudget;
    }
  }
  return body;
}

export function agyDecisionText({ model, reason, confidence }) {
  if (reason.startsWith("jev-unavailable")) return `[Jev] unavailable; using ${model}.\n\n`;
  const detail = confidence == null ? reason : `${reason}, confidence ${confidence.toFixed(2)}`;
  return `[Jev] routed this turn to ${model} (${detail}).\n\n`;
}

const agyDecisionEvent = (text, delimiter = "\r\n\r\n") =>
  `data: ${JSON.stringify({ response: { candidates: [{ content: { role: "model", parts: [{ text }] } }] } })}${delimiter}`;

// Transient upstream failures that AGY itself would retry; backoff before each extra attempt.
const RETRYABLE = new Set([429, 500, 502, 503, 504]);
// Statuses that can mean "this image was refused"; only these drop proxy-attached images.
const IMAGE_REJECTED = new Set([400, 413, 422]);
export const AGY_IMAGE_CACHE_BUDGET_BYTES = 64 * 1024 * 1024;
const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000];

const debug = (line) => process.env.JEV_DEBUG && log(line);
const isGenerate = (url) => /:(?:stream)?[gG]enerateContent(?:\?|$)/.test(url ?? "");
const isCatalog = (url) => /:fetchAvailableModels(?:\?|$)/.test(url ?? "");

export async function startAgyProxy({
  upstream = AGY_DEFAULT_UPSTREAM,
  route = askJev,
  statusId = "",
  retryDelays = RETRY_DELAYS_MS,
  describe = describeAgyImages,
  describeDeadlineMs = 4000,
  imageBudgetBytes = AGY_IMAGE_CACHE_BUDGET_BYTES,
  runtimeConfig,
  cwd = process.cwd(),
  workspaceError,
} = {}) {
  if (route === askJev) warmJev();
  const tasks = createTaskRuntime({ cli: "antigravity", route, cwd, workspaceError, config: runtimeConfig ?? (route !== askJev ? { enabled: false } : undefined) });
  const states = new Map();
  // Per conversation: path -> {mtimeMs, size, mimeType, data}, so every later request in it
  // re-attaches the same bytes without describing them again. Kept in least-recently-used
  // order; whole conversations are evicted once the cached base64 exceeds `imageBudgetBytes`.
  const imageCaches = new Map();
  const imageCacheOf = (key) => {
    const cache = imageCaches.get(key) ?? new Map();
    imageCaches.delete(key);
    imageCaches.set(key, cache);
    return cache;
  };
  const cachedBytes = (cache) => [...cache.values()].reduce((sum, entry) => sum + entry.data.length, 0);
  const settleImageCaches = (key) => {
    if (imageCaches.get(key)?.size === 0) imageCaches.delete(key);
    let total = [...imageCaches.values()].reduce((sum, cache) => sum + cachedBytes(cache), 0);
    for (const [other, cache] of imageCaches) {
      if (total <= imageBudgetBytes) break;
      if (other === key) continue;
      total -= cachedBytes(cache);
      imageCaches.delete(other);
      debug(`agy image cache over budget; evicted conversation ${other.slice(0, 8)}`);
    }
  };
  let catalog = null;
  let titleModel = null;
  const base = new URL(upstream);
  const basePath = base.pathname.replace(/\/$/, "");
  const transport = base.protocol === "http:" ? http : https;

  const choose = async (body, key, headers, images) => {
    const candidates = agyModels(catalog).filter((model) => availableTiers().includes(model.tier));
    const fallback = candidates.some((model) => model.id === catalog?.defaultAgentModelId)
      ? catalog.defaultAgentModelId
      : candidates[0]?.id;
    const previous = states.get(key)?.model;
    const currentModel = candidates.some((model) => model.id === previous) ? previous : fallback;
    const prompt = agyNewTurnPrompt(body);
    if (!prompt || !candidates.length) return { model: currentModel, routing: null };

    const current = agyTierOf(currentModel) ?? "haiku";
    const contextTokens = Math.round(JSON.stringify(body.request?.contents ?? []).length / 4);
    let jevPrompt = prompt;
    let imageMs = null;
    // Pasted paths say nothing about the task, so they do not count toward the text length.
    const ownText = imageMentions(prompt).reduce((text, { raw }) => text.split(raw).join(""), prompt);
    if (images.length && !shouldDescribeImages(ownText)) {
      jevPrompt = agyPromptWithImages(prompt, images, null);
    } else if (images.length) {
      const started = Date.now();
      const descriptions = await describe({
        paths: images, headers, catalog, upstream, turn: body, preferred: titleModel,
        cache: imageCacheOf(key), deadlineMs: describeDeadlineMs,
      });
      imageMs = Date.now() - started;
      jevPrompt = agyPromptWithImages(prompt, images, descriptions);
    }
    const jev = await tasks.route({ prompt: jevPrompt, current: currentModel, contextTokens, models: candidates,
      taskKey: key, taskHistory: (body.request?.contents ?? []).filter(c => c.role === "user").map(userRequestOf).filter(Boolean) });
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
    states.set(key, { model });
    const routing = {
      prompt,
      tier: agyTierOf(model),
      model,
      confidence: jev?.confidence ?? null,
      metrics: jev?.metrics ?? null,
      reason: decision.reason,
      evidence: jev?.evidence ?? null,
      checkpoint: jev?.checkpoint ?? null,
      images: images.length,
      imageMs,
      jev: jev ? { request: jev.request, response: jev.response } : null,
      at: Date.now(),
    };
    writeDecision(statusId, routing);
    debug(`agy ${key.slice(0, 8)} ${currentModel} -> ${model} (${decision.reason}) | ${prompt.slice(0, 60)}`);
    return { model, routing };
  };

  const server = http.createServer((req, res) => {
    if (rejectForeign(req, res, server.address().port)) return;
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", async () => {
      let out = Buffer.concat(chunks);
      let routing = null;
      let key = null;
      let bare = null; // the body without proxy-attached images, for a resend on image rejection
      let attached = { paths: [], turns: 0 };
      let imageKey = null;
      const t0 = Date.now();
      const timing = { jev: null };
      if (req.method === "POST" && isGenerate(req.url)) {
        try {
          const body = stripAgyNotes(JSON.parse(out.toString()));
          if (body.requestType !== "checkpoint") tasks.assertLocal(agyConversationKey(body));
          if (body.requestType === "checkpoint" && typeof body.model === "string") titleModel = body.model;
          const prompt = agyNewTurnPrompt(body);
          const images = prompt ? agyImagePaths(prompt) : [];
          if (body.model === AGY_AUTO_MODEL) {
            key = agyConversationKey(body);
            tasks.assertLocal(key);
            let model;
            const state = states.get(key);
            try {
              if (state?.failedPrompt && state.failedPrompt === prompt) {
                // AGY's retry after an upstream error: keep the turn's model, skip Jev, and let
                // the real upstream status through so AGY can show its own error.
                model = state.model;
                state.failedPrompt = null;
              } else {
                ({ model, routing } = await choose(body, key, req.headers, images));
              }
              timing.jev = Date.now() - t0;
              timing.imageMs = routing?.imageMs ?? null;
            } catch (err) {
              if (err.routingHold) throw err;
              // Routing is fail-open: keep this conversation's model, or AGY's default.
              log(`agy routing failed: ${err.message}`);
              model = states.get(key)?.model ?? catalog?.defaultAgentModelId;
            }
            if (!model) throw new Error("AGY model catalog is not loaded yet; select a model with /model");
            applyAgyModel(body, model, catalog?.models?.[model]);
            tasks.assertModel({ taskKey: key, model });
          } else if (prompt) {
            writeStatus(statusId, { manual: true, model: body.model, at: Date.now() });
          }
          // After routing, so Jev's context size never counts the base64.
          bare = Buffer.from(JSON.stringify(body));
          if (body.requestType !== "checkpoint") {
            imageKey = agyConversationKey(body);
            attached = attachAgyImages(body, imageCacheOf(imageKey));
            settleImageCaches(imageKey);
          }
          timing.images = attached.paths.length;
          timing.model = body.model;
          out = attached.paths.length ? Buffer.from(JSON.stringify(body)) : bare;
          if (process.env.JEV_DUMP) {
            // The forwarded body, with image bytes replaced by their length.
            const dump = JSON.stringify(body, (name, value) =>
              name === "data" && typeof value === "string" ? `<${value.length} base64 chars>` : value, 2);
            writeDump(dump);
          }
        } catch (err) {
          if (sendRoutingHold(res, err)) return;
          res.writeHead(503, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { code: 503, message: `Jev routing failed: ${err.message}`, status: "UNAVAILABLE" } }));
          return;
        }
      }

      // Google withholds its response headers until the model's first token, which can take
      // tens of seconds. The decision is known now, so answer AGY and show it immediately.
      if (routing) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(agyDecisionEvent(agyDecisionText(routing)));
        timing.note = Date.now() - t0;
      }
      // Once a 200 is sent, an upstream failure can no longer reach AGY as a status code, so
      // retry transient failures here, as AGY would. If they persist, drop the connection;
      // AGY then retries on its own and that request is passed through unrouted.
      const failAfterNote = (why) => {
        debug(`agy upstream failed after decision was shown (${why}); dropping for AGY retry`);
        const state = states.get(key);
        if (state) state.failedPrompt = routing.prompt;
        res.destroy();
      };
      let upstreamReq;
      let retryTimer;
      const retryOrFail = (attempt, why) => {
        if (res.destroyed) return;
        if (attempt >= retryDelays.length) return void failAfterNote(why);
        debug(`agy upstream ${why}; retry ${attempt + 1}/${retryDelays.length} in ${retryDelays[attempt]}ms`);
        retryTimer = setTimeout(() => send(attempt + 1), retryDelays[attempt]);
      };

      // Uncompressed replies (no accept-encoding) let the proxy read the catalog and add the decision line.
      const headers = forwardHeaders(req.headers, base.host);
      // Image rejection (400/413/422) steps down: all images -> newest turn's only (on 413, or
      // 400 with several turns) -> none. Paths are evicted only once a smaller request succeeds.
      let imageStage = attached.paths.length ? "all" : "none";
      let dropped = [];
      const dropImages = (status) => {
        if (imageStage === "all" && attached.turns > 1 && (status === 413 || status === 400)) {
          const newest = JSON.parse(bare.toString());
          const kept = attachAgyImages(newest, imageCaches.get(imageKey) ?? new Map(), { maxTurns: 1 });
          if (kept.paths.length) {
            imageStage = "newest";
            dropped = attached.paths.filter((path) => !kept.paths.includes(path));
            out = Buffer.from(JSON.stringify(newest));
            return;
          }
        }
        imageStage = "none";
        dropped = attached.paths;
        out = bare;
      };
      const send = (attempt = 0) => {
        headers["content-length"] = String(out.length);
        upstreamReq = transport.request(
          { hostname: base.hostname, port: base.port || undefined, path: `${basePath}${req.url ?? "/"}`, method: req.method, headers },
          (response) => {
            const responseHeaders = { ...response.headers };
            const ok = response.statusCode >= 200 && response.statusCode < 300;
            if (imageStage !== "none" && IMAGE_REJECTED.has(response.statusCode)) {
              // A refused image must never break the turn: resend with fewer images.
              response.resume();
              if (res.destroyed) return;
              dropImages(response.statusCode);
              debug(`agy upstream HTTP ${response.statusCode} with attached images; resending with ${imageStage === "newest" ? "the newest turn's only" : "none"}`);
              return void send(attempt);
            }
            if (ok && dropped.length) {
              const cache = imageCaches.get(imageKey);
              for (const path of dropped) cache?.delete(path);
              settleImageCaches(imageKey);
            }
            if (isGenerate(req.url)) {
              timing.headers = Date.now() - t0;
              response.once("data", () => { timing.firstByte = Date.now() - t0; });
              response.once("end", () => debug(
                `agy timing ${req.url.split("?")[0].split(":").pop()} model=${timing.model} status=${response.statusCode} ` +
                  `images=${timing.images ?? 0} imageMs=${timing.imageMs ?? "-"} jev=${timing.jev ?? "-"}ms note=${timing.note ?? "-"}ms headers=${timing.headers}ms firstByte=${timing.firstByte}ms end=${Date.now() - t0}ms`,
              ));
            }
            if (ok && req.method === "POST" && isCatalog(req.url)) {
              const body = [];
              response.on("data", (chunk) => body.push(chunk));
              response.on("end", () => {
                let data = Buffer.concat(body);
                try {
                  const parsed = JSON.parse(data.toString());
                  catalog = structuredClone(parsed);
                  data = Buffer.from(JSON.stringify(addAgyJevModel(parsed)));
                  delete responseHeaders["content-length"];
                  delete responseHeaders["transfer-encoding"];
                } catch (err) {
                  debug(`could not extend AGY model catalog: ${err.message}`);
                }
                res.writeHead(response.statusCode, responseHeaders);
                res.end(data);
              });
              return;
            }

            if (!routing) {
              res.writeHead(response.statusCode, responseHeaders);
              response.pipe(res);
              return;
            }
            if (!ok) {
              response.resume();
              if (RETRYABLE.has(response.statusCode)) return void retryOrFail(attempt, `HTTP ${response.statusCode}`);
              return void failAfterNote(`HTTP ${response.statusCode}`);
            }
            response.pipe(res);
          },
        );
        upstreamReq.on("error", (err) => {
          debug(`agy upstream error on ${(req.url ?? "").split("?")[0]}: ${err.message}`);
          if (routing) return void retryOrFail(attempt, err.message);
          if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { code: 502, message: err.message, status: "UNAVAILABLE" } }));
        });
        upstreamReq.end(out);
      };
      // AGY cancels background calls (analytics, quota) when it exits; stop waiting on them.
      res.on("close", () => {
        clearTimeout(retryTimer);
        if (!res.writableFinished) upstreamReq?.destroy();
      });
      send();
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
