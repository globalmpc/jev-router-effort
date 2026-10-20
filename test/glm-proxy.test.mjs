import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import {
  NOTE_TOOL_PREFIX,
  glmDecisionText,
  glmNewTurnPrompt,
  isNoteReply,
  startGlmProxy,
  stripGlmNotes,
} from "../src/glm-proxy.mjs";

async function fakeUpstream(status = 200) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      seen.push({ url: req.url, body: JSON.parse(Buffer.concat(chunks).toString()) });
      res.writeHead(status, { "content-type": status === 200 ? "text/event-stream" : "application/json" });
      res.end(status === 200 ? 'data: {"choices":[{"index":0,"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n' : '{"error":"busy"}');
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${server.address().port}/api/coding/paas/v4`, seen, close: () => server.close() };
}

const post = (port, body) =>
  fetch(`http://127.0.0.1:${port}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then((res) => res.text().then((text) => ({ status: res.status, text })));

const jev = (choice, effort) => async () => ({ choice, confidence: 0.9, effort, effortConfidence: 0.8, metrics: null });

/** Parses the streamed synthetic tool call the way the CLI's stream reducer does. */
function toolCallOf(sse) {
  const call = { id: "", name: "", arguments: "" };
  let finish = null;
  for (const line of sse.split("\n")) {
    if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
    const choice = JSON.parse(line.slice(6)).choices[0];
    for (const delta of choice.delta.tool_calls ?? []) {
      call.id += delta.id ?? "";
      call.name += delta.function?.name ?? "";
      call.arguments += delta.function?.arguments ?? "";
    }
    finish = choice.finish_reason ?? finish;
  }
  return { ...call, finish };
}

/** What the CLI sends after running the synthetic call. */
const noteReply = (messages, call, output) => [
  ...messages,
  { role: "assistant", content: "", tool_calls: [{ id: call.id, type: "function", function: { name: call.name, arguments: call.arguments } }] },
  { role: "tool", content: output, tool_call_id: call.id },
];

test("a new turn is answered at once with an echo tool call, without touching z.ai", async () => {
  const upstream = await fakeUpstream();
  const proxy = await startGlmProxy({ upstream: upstream.url, route: jev("glm-5.3-flash", "low") });
  try {
    const { status, text } = await post(proxy.port, {
      model: "glm-4.6",
      stream: true,
      messages: [{ role: "user", content: "rename a variable" }],
    });
    assert.equal(status, 200);
    const call = toolCallOf(text);
    assert.ok(call.id.startsWith(NOTE_TOOL_PREFIX));
    assert.equal(call.name, "bash");
    assert.equal(call.finish, "tool_calls");
    assert.equal(
      JSON.parse(call.arguments).command,
      "echo '[Jev] routed this turn to glm-5.3-flash (jev, confidence 0.90, effort low (0.80)).'",
    );
    assert.equal(upstream.seen.length, 0);
  } finally {
    proxy.close();
    upstream.close();
  }
});

test("the echo's result is stripped and the real request goes to the routed model and effort", async () => {
  const upstream = await fakeUpstream();
  let calls = 0;
  const route = async () => (calls++, { choice: "glm-5.3", confidence: 0.9, effort: "max" });
  const proxy = await startGlmProxy({ upstream: upstream.url, route });
  try {
    const messages = [{ role: "user", content: "design the schema" }];
    const first = await post(proxy.port, { model: "glm-4.6", stream: true, thinking: { type: "enabled" }, messages });
    const call = toolCallOf(first.text);
    const { text } = await post(proxy.port, {
      model: "glm-4.6",
      stream: true,
      thinking: { type: "enabled" },
      messages: noteReply(messages, call, "[Jev] routed this turn to glm-5.3 (jev, confidence 0.90, effort max).\n"),
    });
    assert.match(text, /"ok"/);
    assert.equal(calls, 1);
    assert.equal(upstream.seen.length, 1);
    const sent = upstream.seen[0].body;
    assert.equal(sent.model, "glm-5.3");
    assert.equal(sent.reasoning_effort, "max");
    assert.deepEqual(sent.messages, messages);
  } finally {
    proxy.close();
    upstream.close();
  }
});

test("tool continuations keep the turn's model and never re-route", async () => {
  const upstream = await fakeUpstream();
  let calls = 0;
  const route = async () => (calls++, { choice: "glm-5.2", confidence: 0.9, effort: "high" });
  const proxy = await startGlmProxy({ upstream: upstream.url, route });
  try {
    const messages = [{ role: "user", content: "list the files" }];
    const call = toolCallOf((await post(proxy.port, { model: "glm-4.6", stream: true, messages })).text);
    const history = noteReply(messages, call, "[Jev] ...\n");
    await post(proxy.port, { model: "glm-4.6", stream: true, messages: history });
    await post(proxy.port, {
      model: "glm-4.6",
      stream: true,
      messages: [...history, { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "bash", arguments: "{}" } }] }, { role: "tool", content: "a b", tool_call_id: "c1" }],
    });
    assert.equal(calls, 1);
    assert.equal(upstream.seen.length, 2);
    assert.equal(upstream.seen[1].body.model, "glm-5.2");
    assert.equal(upstream.seen[1].body.reasoning_effort, "high");
    assert.ok(upstream.seen[1].body.messages.every((message) => !JSON.stringify(message).includes(NOTE_TOOL_PREFIX)));
  } finally {
    proxy.close();
    upstream.close();
  }
});

test("non-stream requests get the tool call as a plain completion", async () => {
  const upstream = await fakeUpstream();
  const proxy = await startGlmProxy({ upstream: upstream.url, route: jev("glm-5.2", "high") });
  try {
    const { text } = await post(proxy.port, { model: "glm-4.6", messages: [{ role: "user", content: "hi" }] });
    const body = JSON.parse(text);
    assert.equal(body.choices[0].finish_reason, "tool_calls");
    assert.equal(body.choices[0].message.tool_calls[0].function.name, "bash");
    assert.equal(upstream.seen.length, 0);
  } finally {
    proxy.close();
    upstream.close();
  }
});

test("a failed Jev call still shows the decision and forwards the follow-up", async () => {
  const upstream = await fakeUpstream();
  const proxy = await startGlmProxy({ upstream: upstream.url, route: async () => null });
  try {
    const messages = [{ role: "user", content: "hi" }];
    const call = toolCallOf((await post(proxy.port, { model: "glm-4.6", stream: true, messages })).text);
    assert.match(JSON.parse(call.arguments).command, /^echo '\[Jev\] unavailable; using glm-5\.3\.'$/);
    await post(proxy.port, { model: "glm-4.6", stream: true, messages: noteReply(messages, call, "") });
    assert.equal(upstream.seen[0].body.model, "glm-5.3");
    assert.equal(upstream.seen[0].body.reasoning_effort, undefined);
  } finally {
    proxy.close();
    upstream.close();
  }
});

test("onDecision fires as soon as Jev decides, before anything reaches z.ai", async () => {
  const upstream = await fakeUpstream();
  let decided = null;
  const proxy = await startGlmProxy({
    upstream: upstream.url,
    route: jev("glm-5.3", "max"),
    onDecision: (routing) => { decided = { routing, upstreamCalls: upstream.seen.length }; },
  });
  try {
    await post(proxy.port, { model: "glm-4.6", stream: true, messages: [{ role: "user", content: "plan a migration" }] });
    assert.equal(decided.routing.model, "glm-5.3");
    assert.equal(decided.routing.effort, "max");
    assert.equal(decided.upstreamCalls, 0);
  } finally {
    proxy.close();
    upstream.close();
  }
});

test("helpers", () => {
  assert.equal(glmNewTurnPrompt({ messages: [{ role: "tool", content: "x" }] }), null);
  assert.equal(glmNewTurnPrompt({ messages: [{ role: "user", content: [{ type: "text", text: "hey" }] }] }), "hey");
  assert.equal(isNoteReply({ messages: [{ role: "tool", tool_call_id: `${NOTE_TOOL_PREFIX}1`, content: "" }] }), true);
  assert.equal(isNoteReply({ messages: [{ role: "tool", tool_call_id: "c1", content: "" }] }), false);
  const body = stripGlmNotes({
    messages: [
      { role: "user", content: "q" },
      { role: "assistant", content: "", tool_calls: [{ id: `${NOTE_TOOL_PREFIX}7`, type: "function", function: { name: "bash", arguments: "{}" } }] },
      { role: "tool", tool_call_id: `${NOTE_TOOL_PREFIX}7`, content: "[Jev] ..." },
      { role: "assistant", content: "answer" },
    ],
  });
  assert.deepEqual(body.messages.map((message) => message.role), ["user", "assistant"]);
  assert.equal(
    glmDecisionText({ model: "glm-5.3", effort: "max", reason: "jev", confidence: 0.5, effortConfidence: null }),
    "[Jev] routed this turn to glm-5.3 (jev, confidence 0.50, effort max).",
  );
});
