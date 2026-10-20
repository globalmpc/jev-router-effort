import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  addAgyJevModel, agyDescribeModel, agyImagePaths, agyImageType, agyModels, agyNewTurnPrompt, agyPromptWithImages, agyTierOf,
  applyAgyModel, attachAgyImages, describeAgyImages, startAgyProxy, stripAgyNotes,
} from "../src/agy-proxy.mjs";
import { readStatus, STATUS_DIR } from "../src/status.mjs";

// Trimmed from a real `v1internal:fetchAvailableModels` reply (AGY 1.2.12).
const CATALOG = {
  models: {
    "gemini-3.8-flash-high": { displayName: "Gemini 3.8 Flash (High)", model: "M318", thinkingBudget: 8000, maxOutputTokens: 65536, supportsImages: true },
    "gemini-3.8-flash-low": { displayName: "Gemini 3.8 Flash (Low)", model: "M320", thinkingBudget: 1000, maxOutputTokens: 65536, supportsImages: true },
    "gemini-3.1-pro-high": { displayName: "Gemini 3.1 Pro (High)", model: "M37" },
    "gemini-3.1-pro-low": { displayName: "Gemini 3.1 Pro (Low)", model: "M36", thinkingBudget: 1001, maxOutputTokens: 65535 },
    "claude-sonnet-4-6": { displayName: "Claude Sonnet 4.6 (Thinking)", model: "M36", thinkingBudget: 1024, maxOutputTokens: 64000 },
    "claude-opus-4-6-thinking": { displayName: "Claude Opus 4.6 (Thinking)", model: "M26", thinkingBudget: 1024, maxOutputTokens: 64000 },
    "gemini-3.5-flash-lite": { displayName: "Lite", model: "M50", supportsImages: true },
    "gemini-3.1-flash-lite": { displayName: "Text-only lite", model: "M51" },
  },
  tieredModelIds: { flashLite: ["gemini-3.5-flash-lite"] },
  defaultAgentModelId: "gemini-3.8-flash-high",
  agentModelSorts: [{ displayName: "Recommended", groups: [{ modelIds: [
    "gemini-3.8-flash-high", "gemini-3.8-flash-low", "gemini-3.1-pro-low", "claude-sonnet-4-6", "claude-opus-4-6-thinking",
  ] }] }],
  deprecatedModelIds: { "gemini-3.1-pro-high": { newModelId: "gemini-pro-agent" } },
};

const turn = (text, extra = []) => ({
  project: "p",
  model: "jev-router",
  requestType: "agent",
  request: {
    contents: [...extra, { role: "user", parts: [{ text: `<USER_REQUEST>\n${text}\n</USER_REQUEST>\n<ADDITIONAL_METADATA>t</ADDITIONAL_METADATA>` }] }],
    labels: { model_enum: "M318", trajectory_id: "traj-1", used_claude: "false", used_claude_conservative: "false", used_non_gemini_model: "false" },
    generationConfig: { maxOutputTokens: 65536, thinkingConfig: { includeThoughts: true, thinkingBudget: 8000 } },
  },
});

const continuation = () => ({
  ...turn("ignored"),
  request: {
    ...turn("ignored").request,
    contents: [
      { role: "user", parts: [{ text: "<USER_REQUEST>\nlist files\n</USER_REQUEST>" }] },
      { role: "model", parts: [{ text: "[Jev] routed this turn to gemini-3.1-pro-low (jev, confidence 0.90).\n\n" }, { functionCall: { name: "list_dir" } }] },
      { role: "user", parts: [{ functionResponse: { name: "list_dir", response: {} } }] },
    ],
  },
});

test("maps picker models to tiers, skipping deprecated and non-agent entries", () => {
  assert.deepEqual(agyModels(CATALOG).map((m) => [m.id, m.tier]), [
    ["gemini-3.8-flash-high", "haiku"],
    ["gemini-3.8-flash-low", "haiku"],
    ["gemini-3.1-pro-low", "opus"],
  ]);
  assert.equal(agyTierOf("claude-sonnet-4-6"), null, "Claude is never routed");
  assert.equal(agyTierOf("gpt-oss-120b-medium"), null);
  assert.equal(agyTierOf("gemini-pro-agent"), "opus");
  assert.equal(agyTierOf("../../oops"), null);
});

test("adds a Jev Router row to the native picker without touching real entries", () => {
  const catalog = addAgyJevModel(structuredClone(CATALOG));
  assert.equal(catalog.models["jev-router"].displayName, "Jev Router (auto)");
  assert.equal(catalog.models["jev-router"].model, "M318");
  assert.equal(catalog.agentModelSorts[0].groups[0].modelIds[0], "jev-router");
  assert.deepEqual(catalog.models["claude-sonnet-4-6"], CATALOG.models["claude-sonnet-4-6"]);
  assert.equal(addAgyJevModel(catalog).agentModelSorts[0].groups[0].modelIds.filter((id) => id === "jev-router").length, 1);
});

test("detects new turns and ignores tool continuations", () => {
  assert.equal(agyNewTurnPrompt(turn("fix the race")), "fix the race");
  assert.equal(agyNewTurnPrompt(continuation()), null);
});

test("copies catalog-derived fields when switching model", () => {
  const body = applyAgyModel(turn("x"), "gemini-3.1-pro-low", CATALOG.models["gemini-3.1-pro-low"]);
  assert.equal(body.model, "gemini-3.1-pro-low");
  assert.equal(body.request.labels.model_enum, "M36");
  assert.equal(body.request.labels.used_claude, "false");
  assert.equal(body.request.labels.used_non_gemini_model, "false");
  assert.equal(body.request.generationConfig.maxOutputTokens, 65535);
  assert.equal(body.request.generationConfig.thinkingConfig.thinkingBudget, 1001);
});

test("removes Jev's notes from history, keeping the model's own parts", () => {
  const body = stripAgyNotes(continuation());
  assert.deepEqual(body.request.contents[1].parts, [{ functionCall: { name: "list_dir" } }]);
  const merged = stripAgyNotes({ request: { contents: [{ role: "model", parts: [{ text: "[Jev] unavailable; using x.\n\nHello" }] }] } });
  assert.equal(merged.request.contents[0].parts[0].text, "Hello");
});

async function fakeUpstream(t, { describeDelayMs = 0, describeText = "Image 1: Red dialog reading BUILD FAILED: missing semicolon" } = {}) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
      seen.push({ url: req.url, body, headers: req.headers });
      if (/fetchAvailableModels/.test(req.url)) {
        res.writeHead(200, { "content-type": "application/json" });
        return void res.end(JSON.stringify(CATALOG));
      }
      if (/:generateContent$/.test(req.url)) {
        const reply = { response: { candidates: [{ content: { role: "model", parts: [{ text: "hidden", thought: true }, { text: describeText }] } }] } };
        return void setTimeout(() => {
          if (res.destroyed) return;
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(reply));
        }, describeDelayMs);
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end('data: {"response": {"candidates": [{"content": {"role": "model","parts": [{"text": "ok"}]}}]}}\r\n\r\n');
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  return { url: `http://127.0.0.1:${server.address().port}`, seen };
}

async function post(port, path, body) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer secret" },
    body: JSON.stringify(body),
  });
  return { status: res.status, text: await res.text() };
}

test("routes each new turn, pins continuations and passes manual models through", async (t) => {
  const upstream = await fakeUpstream(t);
  const asked = [];
  const answers = ["gemini-3.1-pro-low", "gemini-3.8-flash-low"];
  const proxy = await startAgyProxy({
    upstream: upstream.url,
    route: async ({ prompt, models }) => {
      asked.push({ prompt, models: models.map((m) => m.id) });
      return { choice: answers[asked.length - 1], confidence: 0.9 };
    },
  });
  t.after(proxy.close);

  const catalog = JSON.parse((await post(proxy.port, "/v1internal:fetchAvailableModels", {})).text);
  assert.equal(catalog.agentModelSorts[0].groups[0].modelIds[0], "jev-router");

  const first = await post(proxy.port, "/v1internal:streamGenerateContent?alt=sse", turn("refactor the auth module"));
  assert.match(first.text, /^data: .*\[Jev\] routed this turn to gemini-3.1-pro-low \(jev, confidence 0\.90\)/);
  assert.match(first.text, /"text": "ok"/);
  let sent = upstream.seen.at(-1);
  assert.equal(sent.body.model, "gemini-3.1-pro-low");
  assert.equal(sent.body.request.labels.model_enum, "M36");
  assert.equal(sent.headers.authorization, "Bearer secret", "auth is forwarded untouched");
  assert.equal(sent.headers["accept-encoding"], undefined);

  const tool = await post(proxy.port, "/v1internal:streamGenerateContent?alt=sse", continuation());
  assert.doesNotMatch(tool.text, /\[Jev\]/);
  sent = upstream.seen.at(-1);
  assert.equal(sent.body.model, "gemini-3.1-pro-low", "continuation keeps the turn's model");
  assert.equal(JSON.stringify(sent.body).includes("[Jev]"), false, "notes never reach the model");
  assert.equal(asked.length, 1, "continuations do not ask Jev");

  await post(proxy.port, "/v1internal:streamGenerateContent?alt=sse", turn("rename a variable"));
  assert.equal(upstream.seen.at(-1).body.model, "gemini-3.8-flash-low");
  assert.equal(asked[1].models.includes("gemini-3.1-pro-high"), false, "deprecated ids are never offered");

  const manual = await post(proxy.port, "/v1internal:streamGenerateContent?alt=sse", { ...turn("hi"), model: "gemini-3.1-pro-low" });
  assert.doesNotMatch(manual.text, /\[Jev\]/);
  assert.equal(upstream.seen.at(-1).body.model, "gemini-3.1-pro-low");
  assert.equal(asked.length, 2);
});

test("fails open to AGY's default model when Jev is unavailable", async (t) => {
  const upstream = await fakeUpstream(t);
  const proxy = await startAgyProxy({ upstream: upstream.url, route: async () => null });
  t.after(proxy.close);
  await post(proxy.port, "/v1internal:fetchAvailableModels", {});
  const res = await post(proxy.port, "/v1internal:streamGenerateContent?alt=sse", turn("hello"));
  assert.equal(res.status, 200);
  assert.match(res.text, /\[Jev\] unavailable; using gemini-3\.8-flash-high\./);
  assert.equal(upstream.seen.at(-1).body.model, "gemini-3.8-flash-high");
});

test("shows the decision before a slow upstream sends its first byte", async (t) => {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      if (/fetchAvailableModels/.test(req.url)) {
        res.writeHead(200, { "content-type": "application/json" });
        return void res.end(JSON.stringify(CATALOG));
      }
      // Google holds headers until the first token; simulate a slow model.
      setTimeout(() => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end('data: {"response": {"candidates": [{"content": {"role": "model","parts": [{"text": "late"}]}}]}}\r\n\r\n');
      }, 1500);
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const proxy = await startAgyProxy({
    upstream: `http://127.0.0.1:${server.address().port}`,
    route: async () => ({ choice: "gemini-3.1-pro-low", confidence: 0.9 }),
  });
  t.after(proxy.close);
  await post(proxy.port, "/v1internal:fetchAvailableModels", {});

  const started = Date.now();
  const res = await fetch(`http://127.0.0.1:${proxy.port}/v1internal:streamGenerateContent?alt=sse`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(turn("hello")),
  });
  assert.equal(res.status, 200);
  const reader = res.body.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  assert.ok(Date.now() - started < 1000, "decision arrives before the upstream's first byte");
  assert.match(first, /\[Jev\] routed this turn to gemini-3.1-pro-low/);
  let rest = "";
  for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) rest += new TextDecoder().decode(chunk.value);
  assert.match(rest, /"text": "late"/);
});

test("a persistent upstream error after the decision drops the stream; AGY's retry gets the real status", async (t) => {
  let generate = 0;
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      if (/fetchAvailableModels/.test(req.url)) {
        res.writeHead(200, { "content-type": "application/json" });
        return void res.end(JSON.stringify(CATALOG));
      }
      seen.push(JSON.parse(Buffer.concat(chunks).toString()).model);
      generate++;
      res.writeHead(429, { "content-type": "application/json" });
      res.end('{"error":{"code":429,"message":"quota","status":"RESOURCE_EXHAUSTED"}}');
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  let asked = 0;
  const proxy = await startAgyProxy({
    upstream: `http://127.0.0.1:${server.address().port}`,
    route: async () => ({ choice: "gemini-3.1-pro-low", confidence: 0.9, asked: ++asked }),
    retryDelays: [],
  });
  t.after(proxy.close);
  await post(proxy.port, "/v1internal:fetchAvailableModels", {});

  await assert.rejects(post(proxy.port, "/v1internal:streamGenerateContent?alt=sse", turn("hello")));
  const retry = await post(proxy.port, "/v1internal:streamGenerateContent?alt=sse", turn("hello"));
  assert.equal(retry.status, 429);
  assert.match(retry.text, /RESOURCE_EXHAUSTED/);
  assert.doesNotMatch(retry.text, /\[Jev\]/);
  assert.deepEqual(seen, ["gemini-3.1-pro-low", "gemini-3.1-pro-low"]);
  assert.equal(asked, 1, "the retry does not ask Jev again");
  assert.equal(generate, 2);
});

test("retries a transient upstream failure without ending the stream AGY already has", async (t) => {
  let generate = 0;
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      if (/fetchAvailableModels/.test(req.url)) {
        res.writeHead(200, { "content-type": "application/json" });
        return void res.end(JSON.stringify(CATALOG));
      }
      if (++generate === 1) {
        res.writeHead(503, { "content-type": "application/json" });
        return void res.end('{"error":{"code":503,"status":"UNAVAILABLE"}}');
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end('data: {"response": {"candidates": [{"content": {"role": "model","parts": [{"text": "recovered"}]}}]}}\r\n\r\n');
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const proxy = await startAgyProxy({
    upstream: `http://127.0.0.1:${server.address().port}`,
    route: async () => ({ choice: "gemini-3.1-pro-low", confidence: 0.9 }),
    retryDelays: [10],
  });
  t.after(proxy.close);
  await post(proxy.port, "/v1internal:fetchAvailableModels", {});
  const res = await post(proxy.port, "/v1internal:streamGenerateContent?alt=sse", turn("hello"));
  assert.equal(res.status, 200);
  assert.match(res.text, /^data: .*\[Jev\] routed this turn/);
  assert.match(res.text, /"text": "recovered"/);
  assert.equal(generate, 2);
});

// A valid 1x1 PNG.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

function imageDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "jev-agy-img-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const shot = join(dir, "shot.png");
  writeFileSync(shot, PNG);
  return { dir, shot };
}

const describeCalls = (seen) => seen.filter((r) => /:generateContent$/.test(r.url));

test("finds readable local image paths, ignoring missing, oversized, fake and non-image files", (t) => {
  const { dir, shot } = imageDir(t);
  const photo = join(dir, "photo.JPEG");
  writeFileSync(photo, PNG);
  const big = join(dir, "big.png");
  writeFileSync(big, "");
  truncateSync(big, 7 * 1024 * 1024 + 1);
  const text = join(dir, "notes.txt");
  writeFileSync(text, "x");
  const fake = join(dir, "fake.png");
  writeFileSync(fake, "<html>not a png</html>");
  const prompt = `${shot} what is this? also ${shot}, "${photo}" ${big} ${text} ${fake} ${join(dir, "gone.png")} relative/x.png`;
  assert.deepEqual(agyImagePaths(prompt), [shot, photo]);
  assert.deepEqual(agyImagePaths("fix the race in src/app.mjs"), []);
  assert.deepEqual(agyImagePaths(`see ${shot}.`), [shot], "sentence punctuation is not part of the path");
});

test("finds quoted and backslash-escaped paths with spaces, as macOS names screenshots", (t) => {
  const { dir } = imageDir(t);
  const mac = join(dir, "Screenshot 2026-09-29 at 5.37.00 PM.png");
  writeFileSync(mac, PNG);
  const escaped = mac.replace(/ /g, "\\ ");
  assert.deepEqual(agyImagePaths(`${escaped} is broken`), [mac]);
  assert.deepEqual(agyImagePaths(`look at "${mac}" please`), [mac]);
  assert.deepEqual(agyImagePaths(`look at '${mac}'`), [mac]);
  assert.equal(agyPromptWithImages(`${escaped} is broken`, [mac], ["A red chart"]), "[image: A red chart] is broken");
});

test("reads the image type from magic bytes", () => {
  assert.equal(agyImageType(PNG), "image/png");
  assert.equal(agyImageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
  assert.equal(agyImageType(Buffer.from("GIF89a")), "image/gif");
  assert.equal(agyImageType(Buffer.from("RIFF\0\0\0\0WEBPVP8 ")), "image/webp");
  assert.equal(agyImageType(Buffer.from("RIFF\0\0\0\0WAVE")), null);
  assert.equal(agyImageType(Buffer.from("hello")), null);
});

test("caps the total image bytes per request, dropping the oldest turn's images first", (t) => {
  const { dir, shot } = imageDir(t);
  const other = join(dir, "other.png");
  writeFileSync(other, PNG);
  assert.deepEqual(agyImagePaths(`${shot} ${other}`, PNG.length), [shot], "the describe payload respects the cap");

  const cache = new Map();
  const first = turn(`${other} first`);
  attachAgyImages(first, cache);
  const later = turn(`${shot} second`, [first.request.contents[0], { role: "model", parts: [{ text: "ok" }] }]);
  later.request.contents[0] = { role: "user", parts: [{ text: `<USER_REQUEST>\n${other} first\n</USER_REQUEST>` }] };
  assert.deepEqual(attachAgyImages(later, cache, { maxTotal: PNG.length }), { paths: [shot], turns: 1 }, "newest turn wins under the cap");
  assert.equal(later.request.contents[0].parts.length, 1);
});

test("attaches images once, and leaves messages AGY already gave media to alone", (t) => {
  const { shot } = imageDir(t);
  const body = turn(`${shot} why is this broken?`);
  const cache = new Map();
  assert.deepEqual(attachAgyImages(body, cache), { paths: [shot], turns: 1 });
  const parts = body.request.contents.at(-1).parts;
  assert.equal(parts.length, 2);
  assert.match(parts[0].text, /why is this broken/, "the original text is kept");
  assert.deepEqual(parts[1], { inlineData: { mimeType: "image/png", data: PNG.toString("base64") } });
  assert.deepEqual(attachAgyImages(body, cache).paths, [], "a second pass adds nothing");
  assert.equal(body.request.contents.at(-1).parts.length, 2);
  assert.equal(cache.get(shot).mimeType, "image/png");

  const own = turn(`${shot} x`);
  own.request.contents.at(-1).parts.push({ fileData: { mimeType: "image/png", fileUri: "gs://x" } });
  assert.deepEqual(attachAgyImages(own, new Map()).paths, []);
  const title = { ...turn(`${shot} x`), requestType: "checkpoint" };
  assert.deepEqual(attachAgyImages(title, new Map()).paths, [], "AGY's title calls are left alone");
});

test("picks a catalog vision model for descriptions and never invents one", () => {
  assert.equal(agyDescribeModel(CATALOG), "gemini-3.5-flash-lite", "flash-lite tier");
  assert.equal(agyDescribeModel(CATALOG, "gemini-3.8-flash-low"), "gemini-3.8-flash-low", "AGY's own title model wins");
  assert.equal(agyDescribeModel(CATALOG, "gemini-9-flash-lite"), "gemini-3.5-flash-lite", "unknown ids are ignored");
  assert.equal(agyDescribeModel(CATALOG, "gemini-3.1-flash-lite"), "gemini-3.5-flash-lite", "text-only models are ignored");
  const { tieredModelIds, ...untiered } = CATALOG;
  assert.equal(agyDescribeModel(untiered), "gemini-3.5-flash-lite");
  assert.equal(agyDescribeModel({ models: { "claude-x": { supportsImages: true } } }), null);
  assert.equal(agyPromptWithImages("/a/b.png fix it", ["/a/b.png"], null), "[image attached: b.png, not described] fix it");
});

test("describeAgyImages returns null instead of throwing on failure", async (t) => {
  const { shot } = imageDir(t);
  const refused = http.createServer((req, res) => { req.resume(); res.writeHead(403); res.end("{}"); });
  await new Promise((r) => refused.listen(0, "127.0.0.1", r));
  t.after(() => refused.close());
  const args = { paths: [shot], headers: {}, catalog: CATALOG, turn: turn("x") };
  assert.equal(await describeAgyImages({ ...args, upstream: `http://127.0.0.1:${refused.address().port}` }), null);
  assert.equal(await describeAgyImages({ ...args, upstream: "http://127.0.0.1:1" }), null);
  assert.equal(await describeAgyImages({ ...args, catalog: null, upstream: "http://127.0.0.1:1" }), null);
});

test("an image turn is described for Jev and attached for the model", async (t) => {
  const { shot } = imageDir(t);
  const upstream = await fakeUpstream(t);
  const asked = [];
  const statusId = `agy-image-test-${process.pid}`;
  t.after(() => rmSync(join(STATUS_DIR, `${statusId}.json`), { force: true }));
  const proxy = await startAgyProxy({
    upstream: upstream.url,
    statusId,
    route: async ({ prompt }) => {
      asked.push(prompt);
      return { choice: "gemini-3.1-pro-low", confidence: 0.9, request: { state: { request: prompt } } };
    },
  });
  t.after(proxy.close);
  await post(proxy.port, "/v1internal:fetchAvailableModels", {});

  const res = await post(proxy.port, "/v1internal:streamGenerateContent?alt=sse", turn(`${shot} the layout is broken`));
  assert.match(res.text, /\[Jev\] routed this turn to gemini-3.1-pro-low/);

  const described = describeCalls(upstream.seen);
  assert.equal(described.length, 1, "one description call per new turn");
  assert.equal(described[0].body.model, "gemini-3.5-flash-lite");
  assert.equal(described[0].body.requestType, "checkpoint");
  assert.equal(described[0].body.project, "p");
  assert.equal(described[0].headers.authorization, "Bearer secret", "auth is forwarded untouched");
  assert.equal(described[0].body.request.contents[0].parts[0].inlineData.data, PNG.toString("base64"));

  assert.deepEqual(asked, ["[image: Red dialog reading BUILD FAILED: missing semicolon] the layout is broken"]);

  const sent = upstream.seen.at(-1);
  assert.equal(sent.body.model, "gemini-3.1-pro-low");
  const parts = sent.body.request.contents.at(-1).parts;
  assert.equal(parts.filter((p) => p.inlineData).length, 1);
  assert.equal(parts[1].inlineData.mimeType, "image/png");
  assert.ok(parts[0].text.includes(shot), "the model gets the original text");
  assert.equal(JSON.stringify(sent.body).includes("BUILD FAILED"), false, "the description never reaches the model");

  const record = readStatus(statusId);
  assert.equal(record.images, 1);
  assert.equal(typeof record.imageMs, "number");
  assert.match(record.jev.request.state.request, /^\[image: /);
});

test("an image turn with 200+ chars of text routes without describing; the path does not count", async (t) => {
  const { dir, shot } = imageDir(t);
  // tmpdir() is short on Linux (/tmp), so a nested folder keeps the path long enough below.
  const deepShot = join(dir, "a-folder-name-long-enough-on-every-platform", "shot.png");
  mkdirSync(dirname(deepShot));
  writeFileSync(deepShot, PNG);
  const upstream = await fakeUpstream(t);
  const asked = [];
  const proxy = await startAgyProxy({
    upstream: upstream.url,
    route: async ({ prompt }) => {
      asked.push(prompt);
      return { choice: "gemini-3.1-pro-low", confidence: 0.9 };
    },
  });
  t.after(proxy.close);
  await post(proxy.port, "/v1internal:fetchAvailableModels", {});

  const long = "the exporter menu overlaps the schedule calendar ".repeat(5).trim();
  assert.ok(long.length >= 200);
  await post(proxy.port, "/v1internal:streamGenerateContent?alt=sse", turn(`${shot} ${long}`));
  assert.equal(describeCalls(upstream.seen).length, 0, "enough text: no description call");
  assert.equal(asked[0], `[image attached: shot.png, not described] ${long}`);
  const parts = upstream.seen.at(-1).body.request.contents.at(-1).parts;
  assert.equal(parts.filter((p) => p.inlineData).length, 1, "the model still gets the image");

  const padded = `${deepShot} ${"x".repeat(150)}`;
  assert.ok(padded.length >= 200, "path plus text is over the line");
  await post(proxy.port, "/v1internal:streamGenerateContent?alt=sse", turn(padded));
  assert.equal(describeCalls(upstream.seen).length, 1, "150 chars of own text is still short");
});

test("describes with AGY's own title model when a checkpoint request has shown it", async (t) => {
  const { shot } = imageDir(t);
  const upstream = await fakeUpstream(t);
  const proxy = await startAgyProxy({ upstream: upstream.url, route: async () => ({ choice: "gemini-3.8-flash-low", confidence: 0.9 }) });
  t.after(proxy.close);
  await post(proxy.port, "/v1internal:fetchAvailableModels", {});
  await post(proxy.port, "/v1internal:streamGenerateContent?alt=sse", { model: "gemini-3.8-flash-low", requestType: "checkpoint", request: { contents: [{ role: "user", parts: [{ text: "title" }] }] } });
  await post(proxy.port, "/v1internal:streamGenerateContent?alt=sse", turn(`${shot} hi`));
  assert.equal(describeCalls(upstream.seen)[0].body.model, "gemini-3.8-flash-low");
});

test("a slow description falls back to the file name and the turn is still routed", async (t) => {
  const { shot } = imageDir(t);
  const upstream = await fakeUpstream(t, { describeDelayMs: 1000 });
  const asked = [];
  const proxy = await startAgyProxy({
    upstream: upstream.url,
    describeDeadlineMs: 100,
    route: async ({ prompt }) => {
      asked.push(prompt);
      return { choice: "gemini-3.1-pro-low", confidence: 0.9 };
    },
  });
  t.after(proxy.close);
  await post(proxy.port, "/v1internal:fetchAvailableModels", {});
  const started = Date.now();
  const res = await post(proxy.port, "/v1internal:streamGenerateContent?alt=sse", turn(`${shot} why?`));
  assert.ok(Date.now() - started < 900, "the deadline bounds the wait");
  assert.equal(res.status, 200);
  assert.match(res.text, /routed this turn to gemini-3.1-pro-low/);
  assert.deepEqual(asked, ["[image attached: shot.png, not described] why?"]);
  assert.equal(upstream.seen.at(-1).body.request.contents.at(-1).parts[1].inlineData.mimeType, "image/png");
});

test("text-only turns make no extra upstream calls", async (t) => {
  const upstream = await fakeUpstream(t);
  const proxy = await startAgyProxy({ upstream: upstream.url, route: async () => ({ choice: "gemini-3.1-pro-low", confidence: 0.9 }) });
  t.after(proxy.close);
  await post(proxy.port, "/v1internal:fetchAvailableModels", {});
  await post(proxy.port, "/v1internal:streamGenerateContent?alt=sse", turn("refactor the auth module"));
  assert.equal(upstream.seen.length, 2, "catalog plus the turn itself");
  assert.equal(JSON.stringify(upstream.seen.at(-1).body).includes("inlineData"), false);
});

// The image turn as AGY replays it in history: text only, the proxy's image not kept.
const imageHistory = (shot) => [
  { role: "user", parts: [{ text: `<USER_REQUEST>\n${shot} why is the layout broken?\n</USER_REQUEST>` }] },
  { role: "model", parts: [{ functionCall: { name: "list_dir" } }] },
  { role: "user", parts: [{ functionResponse: { name: "list_dir", response: {} } }] },
];

test("a continuation re-attaches the same bytes with zero describe calls", async (t) => {
  const { shot } = imageDir(t);
  const upstream = await fakeUpstream(t);
  const asked = [];
  const proxy = await startAgyProxy({ upstream: upstream.url, route: async ({ prompt }) => (asked.push(prompt), { choice: "gemini-3.1-pro-low", confidence: 0.9 }) });
  t.after(proxy.close);
  await post(proxy.port, "/v1internal:fetchAvailableModels", {});
  await post(proxy.port, "/v1internal:streamGenerateContent?alt=sse", turn(`${shot} why is the layout broken?`));
  const firstImage = upstream.seen.at(-1).body.request.contents.at(-1).parts[1].inlineData;

  await post(proxy.port, "/v1internal:streamGenerateContent?alt=sse", { ...turn("x"), request: { ...turn("x").request, contents: imageHistory(shot) } });
  const sent = upstream.seen.at(-1).body.request.contents;
  assert.equal(upstream.seen.at(-1).body.model, "gemini-3.1-pro-low", "continuation keeps the turn's model");
  assert.deepEqual(sent[0].parts[1].inlineData, firstImage, "same bytes as the first request");
  assert.equal(JSON.stringify(sent.slice(1)).includes("inlineData"), false, "only the message that named the image");
  assert.equal(describeCalls(upstream.seen).length, 1, "described once, on the new turn");
  assert.equal(asked.length, 1);
});

test("a follow-up turn keeps the earlier image and describes only the new prompt's images", async (t) => {
  const { shot } = imageDir(t);
  const upstream = await fakeUpstream(t);
  const asked = [];
  const proxy = await startAgyProxy({ upstream: upstream.url, route: async ({ prompt }) => (asked.push(prompt), { choice: "gemini-3.1-pro-low", confidence: 0.9 }) });
  t.after(proxy.close);
  await post(proxy.port, "/v1internal:fetchAvailableModels", {});
  await post(proxy.port, "/v1internal:streamGenerateContent?alt=sse", turn(`${shot} why is the layout broken?`));
  const followUp = turn("now fix it", [...imageHistory(shot), { role: "model", parts: [{ text: "The sidebar overflows." }] }]);
  await post(proxy.port, "/v1internal:streamGenerateContent?alt=sse", followUp);
  const sent = upstream.seen.at(-1).body.request.contents;
  assert.equal(sent[0].parts[1].inlineData.data, PNG.toString("base64"));
  assert.equal(sent.at(-1).parts.length, 1, "the text-only follow-up gets nothing new");
  assert.equal(describeCalls(upstream.seen).length, 1, "no re-describe on later turns");
  assert.equal(asked[1], "now fix it");
});

test("a 4xx on a request with attached images is resent once without them", async (t) => {
  const { shot } = imageDir(t);
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      if (/fetchAvailableModels/.test(req.url)) {
        res.writeHead(200, { "content-type": "application/json" });
        return void res.end(JSON.stringify(CATALOG));
      }
      if (/:generateContent$/.test(req.url)) {
        res.writeHead(400, { "content-type": "application/json" });
        return void res.end('{"error":{"code":400}}');
      }
      const body = Buffer.concat(chunks).toString();
      seen.push(body.includes("inlineData"));
      if (body.includes("inlineData")) {
        res.writeHead(400, { "content-type": "application/json" });
        return void res.end('{"error":{"code":400,"message":"bad image","status":"INVALID_ARGUMENT"}}');
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end('data: {"response": {"candidates": [{"content": {"role": "model","parts": [{"text": "ok without image"}]}}]}}\r\n\r\n');
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const asked = [];
  const proxy = await startAgyProxy({
    upstream: `http://127.0.0.1:${server.address().port}`,
    route: async ({ prompt }) => (asked.push(prompt), { choice: "gemini-3.1-pro-low", confidence: 0.9 }),
    retryDelays: [],
  });
  t.after(proxy.close);
  await post(proxy.port, "/v1internal:fetchAvailableModels", {});

  const routed = await post(proxy.port, "/v1internal:streamGenerateContent?alt=sse", turn(`${shot} hi`));
  assert.equal(routed.status, 200);
  assert.match(routed.text, /^data: .*\[Jev\] routed this turn/, "after the decision note was written");
  assert.match(routed.text, /ok without image/);
  assert.deepEqual(seen, [true, false]);
  assert.equal(asked[0], "[image attached: shot.png, not described] hi", "description failure is fail-open");

  const manual = await post(proxy.port, "/v1internal:streamGenerateContent?alt=sse", { ...turn(`${shot} again`), model: "gemini-3.1-pro-low" });
  assert.equal(manual.status, 200);
  assert.match(manual.text, /ok without image/);
  assert.deepEqual(seen, [true, false, true, false]);
});

test("a 4xx without proxy-attached images is passed through untouched", async (t) => {
  let generate = 0;
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      generate++;
      res.writeHead(400, { "content-type": "application/json" });
      res.end('{"error":{"code":400}}');
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const proxy = await startAgyProxy({ upstream: `http://127.0.0.1:${server.address().port}`, route: async () => null });
  t.after(proxy.close);
  const res = await post(proxy.port, "/v1internal:streamGenerateContent?alt=sse", { ...turn("hi"), model: "gemini-3.1-pro-low" });
  assert.equal(res.status, 400);
  assert.equal(generate, 1);
});

test("describe timeouts are recognised however the abort is wrapped", async (t) => {
  const { shot } = imageDir(t);
  const slow = http.createServer((req) => req.resume());
  await new Promise((r) => slow.listen(0, "127.0.0.1", r));
  t.after(() => { slow.closeAllConnections(); slow.close(); });
  const started = Date.now();
  const result = await describeAgyImages({
    paths: [shot], headers: {}, catalog: CATALOG, turn: turn("x"), upstream: `http://127.0.0.1:${slow.address().port}`, deadlineMs: 100,
  });
  assert.equal(result, null);
  assert.ok(Date.now() - started < 1000);
});

test("descriptions are trimmed before they reach Jev", async (t) => {
  const { shot } = imageDir(t);
  const upstream = await fakeUpstream(t, { describeText: `Image 1: ${"x".repeat(2000)}` });
  const [description] = await describeAgyImages({ paths: [shot], headers: {}, catalog: CATALOG, turn: turn("x"), upstream: upstream.url });
  assert.ok(description.length <= 400);
});

// Upstream whose generate replies are decided per request; records which contents carried images.
async function scriptedUpstream(t, reply) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      if (/fetchAvailableModels/.test(req.url)) {
        res.writeHead(200, { "content-type": "application/json" });
        return void res.end(JSON.stringify(CATALOG));
      }
      if (/:generateContent$/.test(req.url)) {
        res.writeHead(200, { "content-type": "application/json" });
        return void res.end(JSON.stringify({ response: { candidates: [{ content: { parts: [{ text: "Image 1: a chart" }] } }] } }));
      }
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const withImages = body.request.contents.flatMap((c, i) => (c.parts.some((p) => p.inlineData) ? [i] : []));
      seen.push(withImages);
      const status = reply(seen.length, withImages);
      if (status !== 200) {
        res.writeHead(status, { "content-type": "application/json" });
        return void res.end(`{"error":{"code":${status}}}`);
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end('data: {"response": {"candidates": [{"content": {"role": "model","parts": [{"text": "fine"}]}}]}}\r\n\r\n');
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  return { url: `http://127.0.0.1:${server.address().port}`, seen };
}

const routeTo = (choice) => async () => ({ choice, confidence: 0.9 });
const continuationOf = (shot, trajectory = "traj-1") => {
  const body = turn("x");
  body.request.contents = imageHistory(shot);
  body.request.labels.trajectory_id = trajectory;
  return body;
};

test("a 429 keeps the images through the normal retry, and the next continuation re-attaches", async (t) => {
  const { shot } = imageDir(t);
  const upstream = await scriptedUpstream(t, (n) => (n === 1 ? 429 : 200));
  const proxy = await startAgyProxy({ upstream: upstream.url, route: routeTo("gemini-3.1-pro-low"), retryDelays: [10] });
  t.after(proxy.close);
  await post(proxy.port, "/v1internal:fetchAvailableModels", {});
  const res = await post(proxy.port, "/v1internal:streamGenerateContent?alt=sse", turn(`${shot} why is the layout broken?`));
  assert.match(res.text, /fine/);
  assert.deepEqual(upstream.seen, [[0], [0]], "the retry still carries the image");
  await post(proxy.port, "/v1internal:streamGenerateContent?alt=sse", continuationOf(shot));
  assert.deepEqual(upstream.seen.at(-1), [0], "the cache survived the 429");
});

test("a 401 with attached images is sent exactly once and passed through", async (t) => {
  const { shot } = imageDir(t);
  const upstream = await scriptedUpstream(t, () => 401);
  const proxy = await startAgyProxy({ upstream: upstream.url, route: routeTo("gemini-3.1-pro-low") });
  t.after(proxy.close);
  await post(proxy.port, "/v1internal:fetchAvailableModels", {});
  const res = await post(proxy.port, "/v1internal:streamGenerateContent?alt=sse", { ...turn(`${shot} hi`), model: "gemini-3.1-pro-low" });
  assert.equal(res.status, 401);
  assert.deepEqual(upstream.seen, [[0]]);
});

test("a 413 with images from several turns retries with the newest turn's images first", async (t) => {
  const { dir, shot } = imageDir(t);
  const second = join(dir, "second.png");
  writeFileSync(second, PNG);
  const upstream = await scriptedUpstream(t, (n, withImages) => (withImages.length > 1 ? 413 : 200));
  const proxy = await startAgyProxy({ upstream: upstream.url, route: routeTo("gemini-3.1-pro-low") });
  t.after(proxy.close);
  await post(proxy.port, "/v1internal:fetchAvailableModels", {});
  await post(proxy.port, "/v1internal:streamGenerateContent?alt=sse", turn(`${shot} why is the layout broken?`));
  const followUp = turn(`${second} and this one?`, [...imageHistory(shot), { role: "model", parts: [{ text: "Overflow." }] }]);
  const res = await post(proxy.port, "/v1internal:streamGenerateContent?alt=sse", followUp);
  assert.match(res.text, /fine/);
  assert.deepEqual(upstream.seen.slice(1), [[0, 4], [4]], "413, then the newest turn's image only");

  const next = continuationOf(shot);
  next.request.contents = [...followUp.request.contents.map((c) => ({ ...c, parts: c.parts.filter((p) => !p.inlineData) })),
    { role: "model", parts: [{ functionCall: { name: "list_dir" } }] }, { role: "user", parts: [{ functionResponse: { name: "list_dir", response: {} } }] }];
  await post(proxy.port, "/v1internal:streamGenerateContent?alt=sse", next);
  assert.deepEqual(upstream.seen.at(-1), [4], "the dropped older image stays dropped after the resend succeeded");
});

test("the image cache has a proxy-wide budget and evicts the least recently used conversation", async (t) => {
  const { shot } = imageDir(t);
  const upstream = await scriptedUpstream(t, () => 200);
  const one = PNG.toString("base64").length;
  const proxy = await startAgyProxy({ upstream: upstream.url, route: routeTo("gemini-3.1-pro-low"), imageBudgetBytes: one + 1 });
  t.after(proxy.close);
  await post(proxy.port, "/v1internal:fetchAvailableModels", {});
  const inConversation = (body, trajectory) => ((body.request.labels.trajectory_id = trajectory), body);
  await post(proxy.port, "/v1internal:streamGenerateContent?alt=sse", inConversation(turn(`${shot} why is the layout broken?`), "old"));
  await post(proxy.port, "/v1internal:streamGenerateContent?alt=sse", inConversation(turn(`${shot} why is the layout broken?`), "new"));
  await post(proxy.port, "/v1internal:streamGenerateContent?alt=sse", continuationOf(shot, "new"));
  assert.deepEqual(upstream.seen.at(-1), [0], "the newer conversation keeps its image");
  await post(proxy.port, "/v1internal:streamGenerateContent?alt=sse", continuationOf(shot, "old"));
  assert.deepEqual(upstream.seen.at(-1), [], "the older conversation was evicted");
});
