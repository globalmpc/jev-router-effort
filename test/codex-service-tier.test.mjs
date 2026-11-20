import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { addJevModel, applyCodexTier, codexModels, startCodexProxy } from "../src/codex-proxy.mjs";
import { codexArgs } from "../src/codex-cli.mjs";

const priority = { id: "priority", name: "Fast" };
const ultrafast = { id: "ultrafast", name: "Ultrafast" };

test("Ultrafast is a separate picker row, not a default tier or a routing candidate", () => {
  const catalog = addJevModel({ models: [{
    slug: "gpt-5.6-terra",
    service_tiers: [priority],
    additional_speed_tiers: ["fast"],
  }, {
    slug: "gpt-6.2-sol",
    service_tiers: [priority, ultrafast],
    additional_speed_tiers: ["fast", "ultrafast"],
  }] });

  assert.equal(catalog.models[0].slug, "jev-router");
  assert.deepEqual(catalog.models[0].service_tiers, [priority]);
  assert.deepEqual(catalog.models[0].additional_speed_tiers, ["fast"]);
  assert.equal(catalog.models[0].default_service_tier, null);
  assert.equal(catalog.models[1].slug, "jev-router-ultrafast");
  assert.equal(catalog.models[1].default_reasoning_level, "auto");
  assert.deepEqual(catalog.models[1].service_tiers, [priority, ultrafast]);
  assert.deepEqual(codexModels(new Map(catalog.models.map(m => [m.slug, m]))).map(m => m.id),
    ["gpt-5.6-terra", "gpt-6.2-sol"]);
  const unsupported = addJevModel({ models: [
    { slug: "gpt-5.6-terra", service_tiers: [priority] },
    { slug: "gpt-other", supported_in_api: false, service_tiers: [ultrafast] },
  ] });
  assert.equal(unsupported.models.some(m => m.slug === "jev-router-ultrafast"), false);
});

test("default launcher keeps Auto reasoning and standard speed", () => {
  const autoArgs = codexArgs("http://localhost", []);
  assert.deepEqual(autoArgs.slice(0, 2), ["--model", "jev-router"]);
  assert.ok(autoArgs.includes('service_tier="default"'));
  assert.ok(codexArgs("http://localhost", ["--model", "jev-router-ultrafast"]).includes('model_reasoning_effort="auto"'));
  assert.ok(!codexArgs("http://localhost", ["--model", "gpt-6.2-sol"]).includes('service_tier="default"'));
});

test("only the Ultrafast alias sends ultrafast, and only to a compatible concrete model", async (t) => {
  const sent = [];
  const catalog = { models: [
    { slug: "gpt-5.6-terra", service_tiers: [priority], use_responses_lite: true },
    { slug: "gpt-6.2-sol", service_tiers: [priority, ultrafast], use_responses_lite: false },
  ] };
  const upstream = http.createServer(async (req, res) => {
    if (req.url.startsWith("/models")) return res.end(JSON.stringify(catalog));
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    sent.push(JSON.parse(Buffer.concat(chunks)));
    res.end("{}");
  });
  await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => { upstream.closeAllConnections(); upstream.close(); });
  const base = `http://127.0.0.1:${upstream.address().port}`;
  const candidateLists = [];
  const proxy = await startCodexProxy({ chatgptBaseURL: base, apiBaseURL: base,
    route: async ({ models }) => {
      candidateLists.push(models.map(m => m.id));
      return { choice: "gpt-6.2-sol", confidence: 1 };
    } });
  t.after(proxy.close);
  const send = (model, { service_tier, lite } = {}) => fetch(`http://127.0.0.1:${proxy.port}/responses`, {
    method: "POST", headers: { ...(lite ? { "x-openai-internal-codex-responses-lite": "1" } : {}) },
    body: JSON.stringify({ model, service_tier, input: [
      { type: "additional_tools" }, { role: "user", content: "hello" },
    ] }),
  });
  for (const [model, opts] of [["jev-router", { service_tier: "ultrafast" }], ["jev-router-ultrafast", {}]]) {
    const response = await send(model, opts);
    assert.equal(response.status, 200);
    await response.text();
  }
  const incompatible = await send("jev-router-ultrafast", { lite: true });
  assert.equal(incompatible.status, 503);
  assert.match(await incompatible.text(), /No compatible account models support Ultrafast/);
  assert.deepEqual(candidateLists, [["gpt-5.6-terra", "gpt-6.2-sol"], ["gpt-6.2-sol"]]);
  assert.deepEqual(sent.map(({model, service_tier}) => [model, service_tier]), [
    ["gpt-6.2-sol", undefined], ["gpt-6.2-sol", "ultrafast"],
  ]);
});

test("the routed model keeps only service tiers it actually supports", () => {
  const models = new Map([
    ["gpt-6.2-sol", { service_tiers: [priority, ultrafast] }],
    ["gpt-5.6-terra", { service_tiers: [priority] }],
  ]);
  const supported = { model: "jev-router", service_tier: "ultrafast" };
  applyCodexTier(supported, "opus", models, "gpt-6.2-sol");
  assert.equal(supported.service_tier, "ultrafast");

  const unsupported = { model: "jev-router", service_tier: "ultrafast" };
  applyCodexTier(unsupported, "sonnet", models, "gpt-5.6-terra");
  assert.equal(Object.hasOwn(unsupported, "service_tier"), false);

  const defaultTier = { model: "jev-router", service_tier: "default" };
  applyCodexTier(defaultTier, "sonnet", models, "gpt-5.6-terra");
  assert.equal(defaultTier.service_tier, "default");
});
