import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { parseDescriptions, shouldDescribeImages, withImageDescriptions } from "../src/image-describe.mjs";
import { describeClaudeImages, startProxy, turnImages } from "../src/proxy.mjs";
import { codexTurnImages, describeCodexImages, startCodexProxy } from "../src/codex-proxy.mjs";
// Korean keywords are written as \u escapes so the source stays English-only.

const PNG = { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" };
const DATA_URL = "data:image/png;base64,iVBORw0KGgo=";

async function fakeUpstream(t, handler) {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    seen.push({ url: req.url, headers: req.headers, body: raw ? JSON.parse(raw) : null });
    handler(req, res, seen.at(-1));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  return { url: `http://127.0.0.1:${server.address().port}`, seen };
}

test("descriptions are appended to Jev's prompt, with a marker when one is missing", () => {
  assert.equal(withImageDescriptions("fix this", 0, null), "fix this");
  assert.equal(
    withImageDescriptions("fix this", 2, ["login form, 500 error", null]),
    "fix this\n\n[image 1: login form, 500 error]\n[image 2 attached, not described]",
  );
  assert.equal(withImageDescriptions("", 1, ["a chart"]), "[image 1: a chart]");
});

test("image placeholders the CLIs add do not count toward the 200 characters", () => {
  const path = `/private/tmp/${"x".repeat(200)}/1.png`;
  assert.equal(shouldDescribeImages(`\uC774\uAC70 \uBD10\uC918\n\n[Image: source: ${path}]`), true);
  assert.equal(shouldDescribeImages(`[Image #1] \uC774\uAC70 \uBD10\uC918`), true);
  assert.equal(shouldDescribeImages(`<image name=[Image #1] path="${path}">\n</image>\n\uC774\uAC70 \uBD10\uC918`), true);
  assert.equal(shouldDescribeImages("x".repeat(200)), false);
});

test("model replies are split per image and capped", () => {
  assert.deepEqual(parseDescriptions("Image 1: a form\nImage 2: a stack trace", 2), ["a form", "a stack trace"]);
  assert.deepEqual(parseDescriptions("just one thing", 1), ["just one thing"]);
  assert.equal(parseDescriptions("", 1), null);
  assert.equal(parseDescriptions("x".repeat(900), 1)[0].length, 400);
});

test("only the newest user message's images are described", () => {
  const body = {
    messages: [
      { role: "user", content: [{ type: "image", source: PNG }, { type: "text", text: "old" }] },
      { role: "assistant", content: "ok" },
      { role: "user", content: [{ type: "text", text: "new" }] },
    ],
  };
  assert.equal(turnImages(body).length, 0);
  body.messages[2].content.push({ type: "image", source: PNG });
  assert.equal(turnImages(body).length, 1);
  assert.equal(codexTurnImages({ input: [{ role: "user", content: [{ type: "input_image", image_url: DATA_URL }] }] }).length, 1);
});

test("Claude describes images with the turn's credentials and Jev routes on the description", async (t) => {
  const upstream = await fakeUpstream(t, (req, res, { body }) => {
    res.setHeader("content-type", "application/json");
    if (body.model === "claude-haiku-4-5-20251001") {
      return res.end(JSON.stringify({ content: [{ type: "text", text: "Image 1: terminal with a stack trace" }] }));
    }
    res.end('{"id":"msg_1","type":"message"}');
  });
  let jevPrompt;
  const { port, close } = await startProxy({
    upstreamURL: upstream.url,
    route: async ({ prompt }) => {
      jevPrompt = prompt;
      return { choice: "claude-sonnet-5-5", confidence: 0.8 };
    },
  });
  t.after(close);
  const turn = { role: "user", content: [{ type: "image", source: PNG }, { type: "text", text: "why does this fail" }] };
  await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": "sk-test" },
    body: JSON.stringify({ model: "jev-router", tools: [{ name: "Bash" }], messages: [turn] }),
  });

  const [describeCall, work] = upstream.seen;
  assert.equal(describeCall.headers["x-api-key"], "sk-test");
  assert.equal(describeCall.body.messages[0].content[0].source.data, PNG.data);
  assert.equal(jevPrompt, "why does this fail\n\n[image 1: terminal with a stack trace]");
  assert.deepEqual(work.body.messages, [turn], "the working model gets the original turn");
});

test("a failed Claude description still routes, marking the image undescribed", async (t) => {
  const upstream = await fakeUpstream(t, (req, res) => res.writeHead(500).end());
  const result = await describeClaudeImages({
    images: [{ type: "image", source: PNG }], headers: {}, upstreamURL: upstream.url, model: "claude-haiku-4-5-20251001",
  });
  assert.equal(result, null);
});

test("Codex describes images with the fastest model at its lowest effort", async (t) => {
  const upstream = await fakeUpstream(t, (req, res) => {
    res.setHeader("content-type", "text/event-stream");
    res.end(
      'data: {"type":"response.output_text.delta","delta":"Image 1: settings "}\n\n' +
        'data: {"type":"response.output_text.delta","delta":"page"}\n\n' +
        "data: [DONE]\n\n",
    );
  });
  const result = await describeCodexImages({
    images: [{ type: "input_image", image_url: DATA_URL }],
    headers: { authorization: "Bearer sub", "chatgpt-account-id": "acct", "x-openai-internal-codex-responses-lite": "1" },
    baseURL: upstream.url,
    model: { id: "gpt-5.6-luna", efforts: ["low", "medium"] },
  });
  assert.deepEqual(result, ["settings page"]);
  const [call] = upstream.seen;
  assert.equal(call.url, "/responses");
  assert.equal(call.headers.authorization, "Bearer sub");
  assert.equal(call.headers["x-openai-internal-codex-responses-lite"], undefined);
  assert.equal(call.body.model, "gpt-5.6-luna");
  assert.deepEqual(call.body.reasoning, { effort: "low" });
  assert.equal(call.body.input[0].content[0].image_url, DATA_URL);
});

test("Codex proxy feeds the description to Jev and leaves the turn intact", async (t) => {
  const upstream = await fakeUpstream(t, (req, res) => {
    if (req.url.includes("/models")) {
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ models: [
        { slug: "gpt-5.6-luna", visibility: "list", supported_in_api: true },
        { slug: "gpt-5.6-sol", visibility: "list", supported_in_api: true },
      ] }));
    }
    res.setHeader("content-type", "text/event-stream");
    res.end('data: {"type":"response.completed","response":{"id":"r1"}}\n\n');
  });
  let described;
  let jevPrompt;
  const { port, close } = await startCodexProxy({
    chatgptBaseURL: upstream.url,
    apiBaseURL: upstream.url,
    describe: async ({ images, model }) => {
      described = { count: images.length, model: model.id };
      return ["a failing CI run"];
    },
    route: async ({ prompt }) => {
      jevPrompt = prompt;
      return { choice: "gpt-5.6-sol", confidence: 0.9 };
    },
  });
  t.after(close);
  const user = { role: "user", content: [{ type: "input_text", text: "fix it" }, { type: "input_image", image_url: DATA_URL }] };
  await fetch(`http://127.0.0.1:${port}/responses`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer sub", "chatgpt-account-id": "acct" },
    body: JSON.stringify({ model: "jev-router", input: [{ type: "additional_tools", role: "developer", tools: [{}] }, user] }),
  }).then((r) => r.text());

  assert.deepEqual(described, { count: 1, model: "gpt-5.6-luna" });
  assert.equal(jevPrompt, "fix it\n\n[image 1: a failing CI run]");
  const work = upstream.seen.find((call) => call.url === "/responses");
  assert.deepEqual(work.body.input[1], user);
});

test("descriptions run only when the prompt text is under 200 characters", async (t) => {
  const long = "the settings page crashes after saving a profile with an emoji name ".repeat(4).trim();
  assert.ok(long.length >= 200);
  const tagged = `<image name=[Image #1] path="/private/tmp/${"x".repeat(200)}/shot.png">\n</image>\nlook at this`;
  for (const [text, expected, codexOnly] of [["look at this", 1], [long, 0], [tagged, 1, true]]) {
    const upstream = await fakeUpstream(t, (req, res) => {
      if (req.url.includes("/models")) {
        res.setHeader("content-type", "application/json");
        return res.end(JSON.stringify({ models: [{ slug: "gpt-5.6-luna", visibility: "list", supported_in_api: true }] }));
      }
      res.setHeader("content-type", req.url.startsWith("/v1/messages") ? "application/json" : "text/event-stream");
      res.end(req.url.startsWith("/v1/messages") ? '{"id":"m"}' : 'data: {"type":"response.completed","response":{}}\n\n');
    });
    const calls = { claude: 0, codex: 0 };
    const prompts = {};
    const claude = await startProxy({
      upstreamURL: upstream.url,
      describe: async () => (calls.claude++, ["a chart"]),
      route: async ({ prompt }) => ((prompts.claude = prompt), null),
    });
    const codex = await startCodexProxy({
      chatgptBaseURL: upstream.url,
      apiBaseURL: upstream.url,
      describe: async () => (calls.codex++, ["a chart"]),
      route: async ({ prompt }) => ((prompts.codex = prompt), null),
    });
    t.after(claude.close);
    t.after(codex.close);
    await fetch(`http://127.0.0.1:${claude.port}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "jev-router", tools: [{ name: "Bash" }],
        messages: [{ role: "user", content: [{ type: "image", source: PNG }, { type: "text", text }] }],
      }),
    });
    await fetch(`http://127.0.0.1:${codex.port}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", "chatgpt-account-id": "acct" },
      body: JSON.stringify({
        model: "jev-router",
        input: [
          { type: "additional_tools", role: "developer", tools: [{}] },
          { role: "user", content: [{ type: "input_text", text }, { type: "input_image", image_url: DATA_URL }] },
        ],
      }),
    }).then((r) => r.text());
    const marker = expected ? "[image 1: a chart]" : "[image 1 attached, not described]";
    assert.equal(calls.codex, expected, `${text.length} chars`);
    if (!codexOnly) {
      assert.equal(calls.claude, expected, `${text.length} chars`);
      assert.equal(prompts.claude, `${text}\n\n${marker}`);
    }
    assert.equal(prompts.codex, `${text}\n\n${marker}`);
  }
});
