import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {
  sanitizeSchema,
  newTurnPrompt,
  applyTier,
  claudeModels,
  conversationKey,
  sessionOf,
  startProxy,
  claudeEffort,
  routingNotice,
  prependRoutingNotice,
} from "../src/proxy.mjs";

test("only the sentinel model is routed", () => {
  assert.equal(isAuto("jev-router"), true);
  assert.equal(isAuto("claude-opus-4-6"), false, "a model the user picked is theirs");
  assert.equal(isAuto("claude-haiku-4-5-20251001"), false, "internal Haiku calls pass through");
  assert.equal(isAuto(undefined), false);
});

test("the sentinel is not mistaken for a real tier", () => {
  assert.equal(tierOf("jev-router"), null);
});
import { tierOf, isAuto } from "../src/config.mjs";
import { writeDecision, writeStatus, readStatus, pruneStale, writeStatusFile, STATUS_DIR } from "../src/status.mjs";
import { chmodSync, mkdirSync, readFileSync, statSync, unlinkSync, utimesSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

test("reads the session id out of Claude Code's metadata", () => {
  const sid = "11111111-2222-4333-8444-555555555555";
  assert.equal(sessionOf({ metadata: { user_id: JSON.stringify({ session_id: sid }) } }), sid);
  assert.equal(sessionOf({ metadata: { user_id: "not-json" } }), "");
  assert.equal(sessionOf({}), "");
});

test("status round-trips per session and misses cleanly", () => {
  const sid = `test-${process.pid}`;
  writeStatus(sid, { tier: "opus", confidence: 0.87, reason: "jev" });
  assert.deepEqual(readStatus(sid), { tier: "opus", confidence: 0.87, reason: "jev" });
  assert.equal(readStatus("no-such-session"), null);
  assert.doesNotThrow(() => writeStatus("", { tier: "opus" }));
});

test("status files are private to their owner", { skip: process.platform === "win32" }, () => {
  const sid = `perm-${process.pid}`;
  writeStatus(sid, { tier: "opus" });
  assert.equal(statSync(STATUS_DIR).mode & 0o777, 0o700);
  assert.equal(statSync(join(STATUS_DIR, `${sid}.json`)).mode & 0o777, 0o600);
});

test("stale status files are pruned and fresh ones kept", () => {
  mkdirSync(STATUS_DIR, { recursive: true });
  const stale = join(STATUS_DIR, `stale-${process.pid}.json`);
  const fresh = join(STATUS_DIR, `fresh-${process.pid}.json`);
  writeFileSync(stale, "{}");
  writeFileSync(fresh, "{}");
  const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  utimesSync(stale, old, old);
  assert.ok(pruneStale() >= 1);
  assert.equal(existsSync(stale), false);
  assert.equal(existsSync(fresh), true);
});

test("routing status retains the exact recent Jev exchanges", () => {
  const sid = `history-${process.pid}`;
  writeDecision(sid, { prompt: "first", jev: { request: { id: 1 }, response: { confidence: 0.6 } } });
  writeDecision(sid, { prompt: "second", jev: { request: { id: 2 }, response: { confidence: 0.8 } } });
  const status = readStatus(sid);
  assert.equal(status.prompt, "second");
  assert.deepEqual(status.history.map(({ prompt }) => prompt), ["first", "second"]);
  assert.equal(status.history[0].jev.response.confidence, 0.6);
});

test("recognises older model versions within a tier", () => {
  assert.equal(tierOf("claude-sonnet-4-6"), "sonnet");
  assert.equal(tierOf("claude-sonnet-5-5"), "sonnet");
  assert.equal(tierOf("claude-haiku-4-5-20251001"), "haiku");
  assert.equal(tierOf("claude-opus-4-1"), "opus");
  assert.equal(tierOf("claude-fable-5-1[1m]"), "fable");
  assert.equal(tierOf("gpt-9"), null);
  assert.equal(tierOf(undefined), null);
});

test("keeps available Claude model versions as separate Jev choices", () => {
  assert.deepEqual(
    claudeModels([
      { id: "claude-opus-5-5", display_name: "Claude Opus 5" },
      { id: "claude-opus-4-8", display_name: "Claude Opus 4.8" },
    ]).map(({ id, tier }) => ({ id, tier })),
    [
      { id: "claude-opus-5-5", tier: "opus" },
      { id: "claude-opus-4-8", tier: "opus" },
    ],
  );
});

test("Claude proxy sends exact account models to Jev and routes the chosen version", async (t) => {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      if (req.url.startsWith("/v1/models")) {
        res.setHeader("content-type", "application/json");
        return res.end(JSON.stringify({
          data: [
            { id: "claude-opus-5-5", display_name: "Claude Opus 5" },
            { id: "claude-opus-4-8", display_name: "Claude Opus 4.8" },
            { id: "claude-sonnet-5-5", display_name: "Claude Sonnet 5" },
          ],
        }));
      }
      seen.push(JSON.parse(Buffer.concat(chunks)));
      res.setHeader("content-type", "application/json");
      res.end('{"id":"msg_1","type":"message","model":"claude-opus-4-8"}');
    });
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => upstream.close());

  const { port, close } = await startProxy({
    upstreamURL: `http://127.0.0.1:${upstream.address().port}`,
    route: async ({ models }) => {
      assert.deepEqual(models.map((model) => model.id), [
        "claude-opus-5-5",
        "claude-opus-4-8",
        "claude-sonnet-5-5",
      ]);
      return { choice: "claude-opus-4-8", confidence: 0.91, ms: 1 };
    },
  });
  t.after(close);

  await fetch(`http://127.0.0.1:${port}/v1/models`).then((response) => response.json());
  await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "jev-router",
      tools: [{ name: "Bash" }],
      messages: [{ role: "user", content: "debug this race" }],
    }),
  });

  assert.equal(seen[0].model, "claude-opus-4-8");
});

test("Claude routes effort with the model and pins it across tool continuations", async (t) => {
  const sent = [];
  const upstream = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    sent.push(JSON.parse(raw));
    res.setHeader("content-type", "application/json");
    res.end('{"id":"msg_1","type":"message","model":"claude-sonnet-5-5"}');
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => upstream.close());
  let calls = 0;
  const { port, close } = await startProxy({
    upstreamURL: `http://127.0.0.1:${upstream.address().port}`,
    route: async ({ efforts, currentEffort }) => {
      calls++;
      assert.deepEqual(efforts, ["low", "medium", "high"]);
      assert.equal(currentEffort, "high");
      return { choice: "claude-sonnet-5-5", confidence: 0.8, effort: "low", effortConfidence: 0.9 };
    },
  });
  t.after(close);
  const post = (messages, model = "jev-router") => fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, tools: [{ name: "Bash" }], output_config: { effort: "high" }, messages }),
  });
  const first = [{ role: "user", content: "fix this" }];
  await (await post(first)).text();
  await (await post([...first, { role: "assistant", content: [{ type: "tool_use", id: "t", name: "Bash" }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "done" }] }])).text();
  await (await post(first, "claude-opus-5-5")).text();
  assert.equal(calls, 1);
  assert.deepEqual(sent.map((body) => body.output_config.effort), ["low", "low", "high"]);
  assert.deepEqual(sent.map((body) => body.model), ["claude-sonnet-5-5", "claude-sonnet-5-5", "claude-opus-5-5"]);
});

test("Claude effort falls back to the client setting and omits effort for Haiku", () => {
  assert.equal(claudeEffort("sonnet", "unknown", "medium"), "medium");
  assert.equal(claudeEffort("opus", null, "max"), "max");
  assert.equal(claudeEffort("opus", null, "unsupported"), null);
  assert.equal(claudeEffort("haiku", "low", "high"), null);
  assert.match(routingNotice({ model: "claude-haiku-4-5-20251001", effort: null, confidence: 0.65, reason: "jev" }), /effort n\/a/);
  assert.match(routingNotice({ model: "claude-sonnet-5-5", effort: null, confidence: 0.65, reason: "jev" }), /effort unset/);
});

test("routing notice prefixes the first real text without corrupting tool blocks", async () => {
  const frame = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  const input = [
    frame("message_start", { message: { id: "msg_1" } }),
    frame("content_block_start", { index: 0, content_block: { type: "tool_use", id: "tool_1" } }),
    frame("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: "{}" } }),
    frame("content_block_stop", { index: 0 }),
    frame("content_block_start", { index: 1, content_block: { type: "text", text: "" } }),
    frame("content_block_delta", { index: 1, delta: { type: "text_delta", text: "Done." } }),
    frame("content_block_stop", { index: 1 }),
    frame("message_stop", {}),
  ].join("");
  const stream = prependRoutingNotice("[Jev] routed this turn to claude-sonnet-5-5 (effort auto → low).");
  const chunks = [];
  stream.on("data", (chunk) => chunks.push(chunk));
  stream.write(Buffer.from(input.slice(0, 23)));
  stream.end(Buffer.from(input.slice(23)));
  await new Promise((resolve) => stream.on("end", resolve));
  const events = Buffer.concat(chunks).toString().trim().split(/\n\n/)
    .map((part) => JSON.parse(part.split("\n").find((line) => line.startsWith("data: ")).slice(6)));
  assert.deepEqual(events.map((event) => event.type), [
    "message_start", "content_block_start", "content_block_delta", "content_block_stop",
    "content_block_start", "content_block_delta", "content_block_stop", "message_stop",
  ]);
  assert.equal(events[2].delta.partial_json, "{}");
  assert.equal(events[5].delta.text, "[Jev] routed this turn to claude-sonnet-5-5 (effort auto → low).\nDone.");
  assert.deepEqual(events.slice(1, 4).map((event) => event.index), [0, 0, 0]);
  assert.deepEqual(events.slice(4, 7).map((event) => event.index), [1, 1, 1]);
});

test("Claude proxy shows the routing decision before the model's first streamed block", async (t) => {
  const frame = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  const upstream = http.createServer(async (req, res) => {
    assert.equal(req.headers["accept-encoding"], undefined, "routed SSE must remain uncompressed");
    for await (const _chunk of req) { /* Drain request. */ }
    res.setHeader("content-type", "text/event-stream");
    res.write(frame("message_start", { message: { id: "msg_1", model: "claude-sonnet-5-5" } }));
    res.write(frame("content_block_start", { index: 0, content_block: { type: "text", text: "" } }));
    res.write(frame("content_block_delta", { index: 0, delta: { type: "text_delta", text: "Done." } }));
    res.write(frame("content_block_stop", { index: 0 }));
    res.end(frame("message_stop", {}));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => upstream.close());
  const { port, close } = await startProxy({
    upstreamURL: `http://127.0.0.1:${upstream.address().port}`,
    route: async () => ({ choice: "claude-sonnet-5-5", effort: "low", confidence: 0.91 }),
  });
  t.after(close);
  const response = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: "POST", headers: { "content-type": "application/json", "accept-encoding": "gzip, br" },
    body: JSON.stringify({ model: "jev-router", stream: true, tools: [{ name: "Bash" }],
      messages: [{ role: "user", content: "hello" }] }),
  });
  const data = await response.text();
  const deltas = [...data.matchAll(/^data: (\{.*\})$/gm)]
    .map(([, json]) => JSON.parse(json)).filter((event) => event.type === "content_block_delta");
  assert.equal(response.status, 200);
  assert.match(deltas[0].delta.text, /^\[Jev\] routed this turn to claude-sonnet-5/);
  assert.match(deltas[0].delta.text, /\nDone\.$/);
  assert.equal(deltas[0].index, 0);
});

test("a routed request without metadata is recorded under the conversation key", async (t) => {
  const upstream = http.createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      res.end('{"id":"msg_1","type":"message","model":"claude-sonnet-5-5"}');
    });
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => upstream.close());

  const { port, close } = await startProxy({
    upstreamURL: `http://127.0.0.1:${upstream.address().port}`,
    route: async () => ({ choice: "claude-sonnet-5-5", confidence: 0.77, ms: 1 }),
  });
  t.after(close);

  // Exactly what `claude -p` sends first: no metadata, so no session id.
  const body = {
    model: "jev-router",
    tools: [{ name: "Bash" }],
    messages: [{ role: "user", content: `rename this variable ${process.pid}` }],
  };
  await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  assert.equal(sessionOf(body), "", "the request carries no session id");
  const status = readStatus(conversationKey(body));
  assert.ok(status, "the decision is filed under the conversation key instead of being dropped");
  assert.equal(status.tier, "sonnet");
  assert.equal(status.confidence, 0.77);
});

const withTools = (messages) => ({ tools: [{ name: "Bash" }], messages });

test("converts a draft-04 boolean exclusiveMinimum into a draft 2020-12 number", () => {
  const schema = { type: "object", properties: { topN: { minimum: 0, exclusiveMinimum: true } } };
  sanitizeSchema(schema);
  assert.deepEqual(schema.properties.topN, { exclusiveMinimum: 0 });
});

test("drops a false exclusiveMaximum and keeps the bound", () => {
  const schema = { properties: { n: { maximum: 10, exclusiveMaximum: false } } };
  sanitizeSchema(schema);
  assert.deepEqual(schema.properties.n, { maximum: 10 });
});

test("leaves an already-valid numeric bound alone", () => {
  const schema = { properties: { n: { exclusiveMinimum: 5 } } };
  sanitizeSchema(schema);
  assert.equal(schema.properties.n.exclusiveMinimum, 5);
});

test("reaches schemas nested in arrays and sub-objects", () => {
  const schema = { anyOf: [{ items: { minimum: 1, exclusiveMinimum: true } }] };
  sanitizeSchema(schema);
  assert.deepEqual(schema.anyOf[0].items, { exclusiveMinimum: 1 });
});

test("survives null and primitive nodes", () => {
  assert.doesNotThrow(() => sanitizeSchema(null));
  assert.doesNotThrow(() => sanitizeSchema({ a: null, b: 3, c: "x" }));
});

test("reads a plain string prompt as a new turn", () => {
  assert.equal(newTurnPrompt(withTools([{ role: "user", content: "fix the bug" }])), "fix the bug");
});

test("detects a new Claude turn followed by a system message", () => {
  const body = withTools([
    { role: "user", content: [{ type: "text", text: "route this" }] },
    { role: "system", content: [{ type: "text", text: "additional instructions" }] },
  ]);
  assert.equal(newTurnPrompt(body), "route this");
});

test("does not reroute tool results followed by a system message", () => {
  const body = withTools([
    { role: "user", content: "route this" },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "done" }] },
    { role: "system", content: "additional instructions" },
  ]);
  assert.equal(newTurnPrompt(body), null);
});

test("reads a text block prompt as a new turn", () => {
  const body = withTools([{ role: "user", content: [{ type: "text", text: "fix the bug" }] }]);
  assert.equal(newTurnPrompt(body), "fix the bug");
});

test("ignores a tool_result continuation mid-turn", () => {
  const body = withTools([
    { role: "user", content: "fix the bug" },
    { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "done" }] },
  ]);
  assert.equal(newTurnPrompt(body), null);
});

test("ignores auxiliary calls that carry no tools", () => {
  const body = { messages: [{ role: "user", content: "summarise this" }] };
  assert.equal(newTurnPrompt(body), null);
});

test("ignores a request whose last message is from the assistant", () => {
  const body = withTools([{ role: "assistant", content: "thinking" }]);
  assert.equal(newTurnPrompt(body), null);
});

test("ignores an empty prompt", () => {
  assert.equal(newTurnPrompt(withTools([{ role: "user", content: "   " }])), null);
});

test("survives a malformed body", () => {
  assert.equal(newTurnPrompt(undefined), null);
  assert.equal(newTurnPrompt({}), null);
  assert.equal(newTurnPrompt({ tools: [], messages: [] }), null);
});

test("strips system reminders Claude Code injects into the prompt", () => {
  const body = withTools([
    {
      role: "user",
      content: "fix the bug\n<system-reminder>be careful\nabout things</system-reminder>",
    },
  ]);
  assert.equal(newTurnPrompt(body), "fix the bug");
});

test("a prompt that is only a system reminder is not a turn", () => {
  const body = withTools([{ role: "user", content: "<system-reminder>noise</system-reminder>" }]);
  assert.equal(newTurnPrompt(body), null);
});

test("routing to haiku strips fields haiku cannot accept", () => {
  const body = {
    model: "claude-sonnet-4-6",
    thinking: { type: "adaptive" },
    output_config: { effort: "medium" },
    context_management: { edits: [{ type: "clear_thinking_20251015", keep: "all" }] },
  };
  applyTier(body, "haiku");
  assert.equal(body.model, "claude-haiku-4-5-20251001");
  assert.equal(body.thinking, undefined);
  assert.equal(body.output_config, undefined);
  assert.equal(body.context_management, undefined);
});

test("routing to haiku keeps context-management strategies unrelated to thinking", () => {
  const body = {
    model: "claude-sonnet-4-6",
    context_management: { edits: [{ type: "clear_tool_uses_20250919" }, { type: "clear_thinking_20251015" }] },
  };
  applyTier(body, "haiku");
  assert.deepEqual(body.context_management, { edits: [{ type: "clear_tool_uses_20250919" }] });
});

test("routing to opus leaves thinking and effort intact", () => {
  const body = {
    model: "claude-sonnet-4-6",
    thinking: { type: "adaptive" },
    output_config: { effort: "medium" },
  };
  applyTier(body, "opus");
  assert.equal(body.model, "claude-opus-5-5");
  assert.deepEqual(body.thinking, { type: "adaptive" });
  assert.deepEqual(body.output_config, { effort: "medium" });
});

test("an unknown tier leaves the request untouched", () => {
  const body = { model: "claude-sonnet-4-6", thinking: { type: "adaptive" } };
  applyTier(body, "nonsense");
  assert.equal(body.model, "claude-sonnet-4-6");
});

test("a conversation keeps one key as it grows, and differs from a sub-agent", () => {
  const main = { messages: [{ role: "user", content: "main task" }] };
  const grown = {
    messages: [{ role: "user", content: "main task" }, { role: "assistant", content: "ok" }],
  };
  const sub = { messages: [{ role: "user", content: "sub-agent task" }] };
  assert.equal(conversationKey(main), conversationKey(grown));
  assert.notEqual(conversationKey(main), conversationKey(sub));
});

test("the key ignores the cache_control breakpoint Claude Code moves between requests", () => {
  const first = {
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "<system-reminder>x</system-reminder>" },
          { type: "text", text: "do the thing", cache_control: { type: "ephemeral", ttl: "1h" } },
        ],
      },
    ],
  };
  const later = {
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "<system-reminder>x</system-reminder>" },
          { type: "text", text: "do the thing" },
        ],
      },
      { role: "assistant", content: "working" },
    ],
  };
  assert.equal(conversationKey(first), conversationKey(later));
});

test("the same opening text in two sessions gets two keys", () => {
  const mk = (id) => ({
    metadata: { user_id: JSON.stringify({ session_id: id }) },
    messages: [{ role: "user", content: "same opening" }],
  });
  assert.notEqual(conversationKey(mk("a")), conversationKey(mk("b")));
});

test("the key survives metadata that is not JSON", () => {
  const body = { metadata: { user_id: "not-json" }, messages: [{ role: "user", content: "hi" }] };
  assert.doesNotThrow(() => conversationKey(body));
});

test("writeStatusFile keeps the Claude settings file owner-only inside the status directory", { skip: process.platform === "win32" }, (t) => {
  mkdirSync(STATUS_DIR, { recursive: true });
  chmodSync(STATUS_DIR, 0o777); // as left by an older version; must be tightened before writing
  const name = `settings-${process.pid}.json`;
  const file = writeStatusFile(name, JSON.stringify({ statusLine: { type: "command", command: "x" } }));
  t.after(() => unlinkSync(file));
  assert.equal(file, join(STATUS_DIR, name));
  assert.equal(statSync(STATUS_DIR).mode & 0o777, 0o700);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).statusLine.command, "x");
});
