import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jevDecisionEvents, startCodexProxy, stripCodexNotes } from "../src/codex-proxy.mjs";

/** The note text exactly as the proxy streams it, so a format change keeps this test honest. */
function noteText(decision) {
  const done = jevDecisionEvents(decision)
    .split("\n\n")
    .map((frame) => frame.match(/^data: (.*)$/m)?.[1])
    .filter(Boolean)
    .map((data) => JSON.parse(data))
    .find((event) => event.type === "response.output_item.done");
  return done.item.content[0].text;
}

/** How Codex sends a stored note back on the next request: same message, no `jev-` id. */
const storedNote = (text) => ({
  type: "message",
  role: "assistant",
  content: [{ type: "output_text", text }],
  phase: "commentary",
});

const routed = noteText({ tier: "opus", model: "gpt-5.6-sol", effort: "low", effortMode: "auto", confidence: 0.9, reason: "jev" });

test("removes the proxy's routing notes from Codex history and keeps everything else", () => {
  const withExtras = noteText({
    tier: "sonnet", model: "gpt-5.6-terra", effort: "high", effortMode: "manual", confidence: 0.42, reason: "jev",
    capabilities: "skill unclear: first\nsecond\u001b[2J\u202eyrev; name one to apply", checkpoint: { ok: false, error: "disk\nfull" },
  });
  assert.match(withExtras, /skill unclear: first second \[2J yrev; name one to apply\./);
  assert.equal(/[\p{Cc}\p{Cf}]/u.test(withExtras), false, "a note is always one line, with no control or format characters");
  const rlo = String.fromCharCode(0x202e);
  const tag = String.fromCodePoint(0xe0041);
  const invisible = String.fromCharCode(0x2061);
  const checkpointed = noteText({
    tier: "opus", model: "gpt-5.6-sol", confidence: 0.9, reason: "jev",
    capabilities: `skill example-skill${invisible}\n`, checkpoint: { ok: false, error: `src/a${rlo}b${tag}.mjs` },
  });
  assert.match(checkpointed, /skill example-skill\. Checkpoint FAILED, no recovery point for this turn: src\/a b \.mjs$/);
  assert.equal(/[\p{Cc}\p{Cf}]/u.test(checkpointed), false, "checkpoint paths are made inert too");
  const blank = noteText({ tier: "opus", model: "gpt-5.6-sol", confidence: 0.9, reason: "jev", capabilities: `${invisible}\n` });
  assert.match(blank, /\(jev, confidence 0\.90\)\.$/, "a notice that is only invisible text adds nothing");
  const cut = noteText({ tier: "opus", model: "gpt-5.6-sol", confidence: 0.9, reason: "jev", checkpoint: { ok: false, error: `${"a".repeat(199)}${tag}` } });
  assert.equal(/\p{Cs}/u.test(cut), false, "a surrogate pair cut by the length limit leaves nothing behind");
  const unavailable = noteText({ tier: "opus", model: "gpt-5.6-sol", confidence: null, reason: "jev-unavailable" });
  const { phase, ...withoutPhase } = storedNote(routed);
  assert.equal(phase, "commentary");
  const { phase: _, ...extrasWithoutPhase } = storedNote(withExtras);
  const kept = [
    { type: "additional_tools", role: "developer", tools: [{}] },
    { type: "message", role: "user", content: [{ type: "input_text", text: routed }] },
    { type: "message", role: "user", phase: "commentary", content: [{ type: "output_text", text: routed }] },
    { type: "message", role: "assistant", phase: "commentary", content: [{ type: "output_text", text: "I'll list the files first." }] },
    { type: "message", id: "msg_1", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: routed, annotations: [] }] },
    { type: "message", role: "assistant", phase: "commentary", content: [{ type: "output_text", text: `Earlier: ${routed}` }] },
    { type: "message", role: "assistant", phase: "commentary", content: [{ type: "output_text", text: routed }, { type: "output_text", text: "More." }] },
    { type: "message", role: "assistant", phase: "commentary", content: [{ type: "output_text", text: "[Jev] routed this turn to the fast model." }] },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: `${routed}\nThe tests pass.` }] },
    { type: "message", role: "assistant", phase: "commentary", content: [{ type: "output_text", text: `${routed}\nI will run the migration next.` }] },
    { type: "reasoning", summary: [], encrypted_content: "opaque" },
    { type: "function_call", call_id: "call_1", name: "exec_command", arguments: "{\"cmd\":\"ls src\"}" },
    { type: "function_call_output", call_id: "call_1", output: routed },
    { type: "message", role: "assistant", phase: "commentary", content: [{ type: "output_text", text: { value: routed } }] },
  ];
  const body = {
    input: [
      kept[0], kept[1], kept[2], storedNote(routed), kept[3],
      { ...storedNote(withExtras), id: "jev-example" }, kept[4], storedNote(unavailable),
      kept[5], kept[6], kept[7], kept[8], withoutPhase, kept[9], extrasWithoutPhase, kept[10], kept[11], kept[12],
      { ...storedNote(checkpointed), phase: null }, kept[13],
    ],
  };
  assert.equal(stripCodexNotes(body), body);
  assert.deepEqual(body.input, kept);
  const none = { model: "gpt-5.6-sol" };
  assert.deepEqual(stripCodexNotes(none), { model: "gpt-5.6-sol" });
});

test("Codex proxy forwards history without earlier notes and still streams one note per new turn", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "jev-codex-notes-"));
  const statusId = `codex-notes-test-${process.pid}`;
  t.after(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(join(tmpdir(), "jev-claude", `${statusId}.json`), { force: true });
  });
  const received = [];
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      if (req.url.startsWith("/backend-api/codex/models")) {
        res.setHeader("content-type", "application/json");
        return res.end(JSON.stringify({ models: [
          { slug: "gpt-5.6-terra", display_name: "GPT-5.6-Terra", visibility: "list", supported_in_api: true, priority: 2 },
          { slug: "gpt-5.6-sol", display_name: "GPT-5.6-Sol", visibility: "list", supported_in_api: true, priority: 3 },
        ] }));
      }
      received.push(JSON.parse(Buffer.concat(chunks).toString()));
      res.setHeader("content-type", "text/event-stream");
      res.end(
        'event: response.created\ndata: {"type":"response.created","response":{"id":"r1"}}\n\n' +
          'event: response.completed\ndata: {"type":"response.completed","response":{"id":"r1"}}\n\n',
      );
    });
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => upstream.close());
  const upstreamURL = `http://127.0.0.1:${upstream.address().port}`;
  const { port, close } = await startCodexProxy({
    chatgptBaseURL: `${upstreamURL}/backend-api/codex`,
    apiBaseURL: `${upstreamURL}/v1`,
    route: async () => ({ choice: "gpt-5.6-sol", confidence: 0.9 }),
    statusId,
    codexAuthFile: join(home, "auth.json"),
  });
  t.after(close);
  const send = (model, input) =>
    fetch(`http://127.0.0.1:${port}/responses`, {
      method: "POST",
      headers: { authorization: "Bearer subscription-token", "chatgpt-account-id": "acct", "content-type": "application/json" },
      body: JSON.stringify({ model, prompt_cache_key: "notes", input }),
    }).then((response) => response.text());
  const notesIn = (stream) => (stream.match(/event: response\.output_item\.added\ndata: [^\n]*"phase":"commentary"/g) ?? []).length;

  const tools = { type: "additional_tools", role: "developer", tools: [{}] };
  const first = { type: "message", role: "user", content: [{ type: "input_text", text: "list the files in src" }] };
  const answer = { type: "message", id: "msg_1", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "12 files.", annotations: [] }] };
  const second = { type: "message", role: "user", content: [{ type: "input_text", text: "now count the tests" }] };

  assert.equal(notesIn(await send("jev-router", [tools, first])), 1);
  assert.equal(notesIn(await send("jev-router", [tools, first, storedNote(routed), answer, second])), 1);
  assert.equal(notesIn(await send("gpt-5.6-terra", [tools, first, storedNote(routed), answer, second])), 0);

  assert.equal(received.length, 3);
  assert.deepEqual(received[1].input, [tools, first, answer, second]);
  assert.deepEqual(received[2].input, [tools, first, answer, second], "a manually chosen model gets clean history too");
  assert.equal(received.some((body) => JSON.stringify(body).includes("[Jev]")), false);
});
