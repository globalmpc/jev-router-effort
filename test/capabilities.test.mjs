import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildInstruction,
  capabilityQuestions,
  decideCapabilities,
  discoverCatalog,
  explicitMentions,
  injectClaude,
  MARKER,
  optedOut,
  parseFrontMatter,
  promptHash,
  shortlist,
} from "../src/capabilities.mjs";
import { createCapabilityRuntime } from "../src/capability-runtime.mjs";
import { readEvents, routingReport } from "../src/routing-log.mjs";
import { startProxy } from "../src/proxy.mjs";
import { startCodexProxy } from "../src/codex-proxy.mjs";
// Korean keywords are written as \u escapes so the source stays English-only.

const SKILLS = {
  "hr-write-jd": "HR\uC758 Make JD \uBA54\uBAA8\uB85C JD \uCD08\uC548\uC744 \uC791\uC131\uD55C\uB2E4. \uC5ED\uD560·\uC131\uACFC·\uC5C5\uBB34·\uC694\uAC74\uC744 \uC6D0\uBB38\uC5D0\uC11C \uB3C4\uCD9C\uD55C\uB2E4. \uD2B8\uB9AC\uAC70\uB294 Make JD, JD \uCD08\uC548, \uCC44\uC6A9 \uC9C1\uBB34\uAE30\uC220\uC11C.",
  "hr-perf-plan": "PIP(\uC131\uACFC \uAC1C\uC120 \uD504\uB85C\uADF8\uB7A8) \uBB38\uC11C\uB97C \uB9CC\uB4E0\uB2E4. \uD2B8\uB9AC\uAC70 - PIP \uBB38\uC11C, \uC131\uACFC \uAC1C\uC120 \uD504\uB85C\uADF8\uB7A8.",
  "ops-report-daily": "OPS \uBAA8\uB2C8\uD130 \uC77C\uC77C \uBCF4\uACE0\uC11C\uB97C \uC0DD\uC131\uD55C\uB2E4. \uD2B8\uB9AC\uAC70 - OPS \uC77C\uC77C \uBCF4\uACE0, \uBAA8\uB2C8\uD130 \uD14C\uC774\uBE14.",
  "fin-asset-ledger": "FIN \uC790\uC0B0 \uC6D0\uC7A5 \uB300\uC0AC \uB9AC\uD3EC\uD2B8\uB97C \uB9CC\uB4E0\uB2E4. \uD2B8\uB9AC\uAC70 - FIN \uC6D0\uC7A5, FIN \uB300\uC0AC.",
  "biz-ir-deck": "BIZ \uD22C\uC790\uC790 IR \uB371 \uCD08\uC548\uC744 \uB9CC\uB4E0\uB2E4. \uD2B8\uB9AC\uAC70 - IR \uB371, \uD22C\uC790 \uC124\uBA85 \uC790\uB8CC.",
  "ops-report-daily-v1-archived": "\uC608\uC804 OPS \uC77C\uC77C \uBCF4\uACE0 \uC0DD\uC131\uAE30. \uD2B8\uB9AC\uAC70 - OPS \uC77C\uC77C \uBCF4\uACE0.",
};
const AGENTS = {
  "hr-jd-drafter": "HR JD \uCD08\uC548\uC744 hr-write-jd \uC2A4\uD0AC\uB85C \uC791\uC131\uD558\uB294 \uC791\uC5C5\uC790. JD \uCD08\uC548 \uC791\uC131 \uC694\uCCAD\uC744 \uC704\uC784\uBC1B\uB294\uB2E4.",
  "security-pr-reviewer": "PR \uBCF4\uC548 \uB9AC\uBDF0 \uC804\uB2F4 \uC5D0\uC774\uC804\uD2B8. \uBCF4\uC548 \uCDE8\uC57D\uC810 \uB9AC\uBDF0\uB97C \uC704\uC784\uBC1B\uB294\uB2E4.",
};

function makeTree(t, { duplicate = null, link = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "jev-cap-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const cwd = join(root, "work", "not-hr-folder");
  const skill = (dir, name, description, extra = "") => {
    mkdirSync(join(dir, name), { recursive: true });
    writeFileSync(join(dir, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nBody of ${name}.${extra}\n`);
  };
  for (const [name, d] of Object.entries(SKILLS)) skill(join(home, ".claude/skills"), name, d);
  mkdirSync(join(home, ".claude/agents"), { recursive: true });
  for (const [name, d] of Object.entries(AGENTS)) writeFileSync(join(home, ".claude/agents", `${name}.md`), `---\nname: ${name}\ndescription: ${d}\nmodel: inherit\n---\nAgent ${name}.\n`);
  if (duplicate) skill(join(cwd, ".claude/skills"), duplicate, SKILLS[duplicate], " Project variant.");
  if (link) { mkdirSync(join(cwd, ".claude/skills"), { recursive: true }); symlinkSync(join(home, ".claude/skills/hr-write-jd"), join(cwd, ".claude/skills/hr-write-jd")); }
  mkdirSync(cwd, { recursive: true });
  return { root, home, cwd, catalog: discoverCatalog({ cli: "claude", cwd, home }) };
}

const answer = (choice, confidence, probabilities) => ({ choice, confidence, probabilities: probabilities ?? { [choice]: confidence, none: 1 - confidence } });
const decideFor = (catalog, prompt, answers = null, extra = {}) => {
  const shortlisted = { skills: shortlist(prompt, catalog.skills, { limit: 6 }), agents: shortlist(prompt, catalog.agents, { limit: 4 }) };
  return { shortlisted, decision: decideCapabilities({ prompt, catalog, shortlisted, answers, ...extra }) };
};

test("front matter parser reads folded descriptions", () => {
  assert.deepEqual(parseFrontMatter("---\nname: x\ndescription: >-\n  first line\n  second line\nsummary: \"s\"\n---\nbody"),
    { name: "x", description: "first line second line", summary: "s" });
});

test("discovery keeps metadata, path and hash only; archived names are not auto-eligible", (t) => {
  const { catalog } = makeTree(t);
  const jd = catalog.skills.find((s) => s.name === "hr-write-jd");
  assert.equal(jd.department, "hr");
  assert.match(jd.id, /^skill:claude:user:hr-write-jd#[0-9a-f]{12}$/);
  assert.equal(jd.hash.length, 64);
  assert.ok(!("body" in jd));
  assert.equal(catalog.skills.find((s) => s.name.endsWith("archived")).autoEligible, false);
  assert.equal(catalog.agents.length, 2);
});

test("HR request from a non-HR folder selects hr-write-jd and the classifier sees metadata only", (t) => {
  const { catalog, cwd } = makeTree(t);
  assert.ok(!cwd.includes("/hr"));
  const prompt = "\uBC31\uC5D4\uB4DC \uAC1C\uBC1C\uC790 \uCC44\uC6A9\uC6A9 JD \uCD08\uC548 \uC880 \uC368\uC918";
  const { shortlisted, decision } = decideFor(catalog, prompt, { skill: answer("hr-write-jd", 0.86), agent: answer("none", 0.8) });
  assert.equal(shortlisted.skills[0].candidate.name, "hr-write-jd");
  const questions = JSON.stringify(capabilityQuestions(shortlisted));
  assert.ok(questions.includes("hr-write-jd") && !questions.includes("Body of hr-write-jd"));
  assert.deepEqual(decision.skills.selected.map((s) => s.name), ["hr-write-jd"]);
  assert.equal(decision.skills.reason, "jev");
  assert.equal(decision.agent.selected, null);
  assert.equal(decision.agent.reason, "jev-none");
});

test("department prefixes separate OPS, FIN and BIZ candidates", (t) => {
  const { catalog } = makeTree(t);
  const top = (p) => shortlist(p, catalog.skills, { limit: 3 })[0]?.candidate.name;
  assert.equal(top("OPS \uC77C\uC77C \uBCF4\uACE0 \uB9CC\uB4E4\uC5B4\uC918"), "ops-report-daily");
  assert.equal(top("FIN \uC6D0\uC7A5 \uB300\uC0AC \uB9AC\uD3EC\uD2B8 \uBD80\uD0C1\uD574"), "fin-asset-ledger");
  assert.equal(top("BIZ IR \uB371 \uCD08\uC548 \uB9CC\uB4E4\uC5B4\uC918"), "biz-ir-deck");
  assert.ok(!shortlist("OPS \uC77C\uC77C \uBCF4\uACE0 \uB9CC\uB4E4\uC5B4\uC918", catalog.skills, { limit: 6 }).some((s) => s.candidate.name.endsWith("archived")));
});

test("a general question needs no skill and no agent; the classifier is not asked", (t) => {
  const { catalog } = makeTree(t);
  const { shortlisted, decision } = decideFor(catalog, "\uD30C\uC774\uC36C \uB9AC\uC2A4\uD2B8 \uCEF4\uD504\uB9AC\uD5E8\uC158\uC774 \uBB50\uC57C?");
  assert.equal(Object.keys(capabilityQuestions(shortlisted)).length, 0);
  assert.equal(decision.skills.reason, "no-candidate");
  assert.equal(decision.skills.needed, false);
  assert.equal(decision.agent.reason, "no-candidate");
});

test("skill only, agent only and both are independent dimensions", (t) => {
  const { catalog } = makeTree(t);
  const prompt = "JD \uCD08\uC548 \uC791\uC131\uD558\uACE0 \uC774 PR \uBCF4\uC548 \uB9AC\uBDF0\uB3C4 \uD574\uC918";
  const skillOnly = decideFor(catalog, prompt, { skill: answer("hr-write-jd", 0.8), agent: answer("none", 0.9) }).decision;
  assert.equal(skillOnly.skills.selected.length, 1); assert.equal(skillOnly.agent.selected, null);
  const agentOnly = decideFor(catalog, prompt, { skill: answer("none", 0.7), agent: answer("security-pr-reviewer", 0.8) }).decision;
  assert.equal(agentOnly.skills.selected.length, 0); assert.equal(agentOnly.agent.selected.name, "security-pr-reviewer");
  const both = decideFor(catalog, prompt, { skill: answer("hr-write-jd", 0.8), agent: answer("hr-jd-drafter", 0.7) }).decision;
  assert.equal(both.skills.selected[0].name, "hr-write-jd"); assert.equal(both.agent.selected.name, "hr-jd-drafter");
});

test("explicit skill/agent requests are respected; topical mentions and opt-outs are distinguished", (t) => {
  const { catalog } = makeTree(t);
  assert.deepEqual(explicitMentions("/hr-perf-plan \uB85C \uBB38\uC11C \uB9CC\uB4E4\uC5B4", catalog.skills, "skill"), ["hr-perf-plan"]);
  assert.deepEqual(explicitMentions("hr-perf-plan \uC2A4\uD0AC\uB85C \uD574\uC918", catalog.skills, "skill"), ["hr-perf-plan"]);
  assert.deepEqual(explicitMentions("hr-perf-plan \uD30C\uC77C\uC774 \uC5B4\uB514 \uC788\uC9C0?", catalog.skills, "skill"), []);
  assert.deepEqual(explicitMentions("@agent-hr-jd-drafter \uC5D0\uAC8C \uB9E1\uACA8", catalog.agents, "agent"), ["hr-jd-drafter"]);
  const forced = decideFor(catalog, "hr-perf-plan \uC2A4\uD0AC\uB85C JD \uCD08\uC548 \uC368\uC918", { skill: answer("hr-write-jd", 0.9) }).decision;
  assert.deepEqual(forced.skills.selected.map((s) => [s.name, s.source]), [["hr-perf-plan", "explicit"]]);
  assert.equal(optedOut("\uC2A4\uD0AC \uC5C6\uC774 JD \uCD08\uC548\uB9CC \uAC04\uB2E8\uD788", "skill"), true);
  assert.equal(optedOut("\uC5D0\uC774\uC804\uD2B8 \uC5C6\uC774 \uC9C1\uC811 \uCC98\uB9AC\uD574", "agent"), true);
  const none = decideFor(catalog, "\uC2A4\uD0AC \uC5C6\uC774 JD \uCD08\uC548\uB9CC \uAC04\uB2E8\uD788", { skill: answer("hr-write-jd", 0.9) }).decision;
  assert.equal(none.skills.reason, "explicit-none"); assert.equal(none.skills.selected.length, 0);
});

test("same-name candidates are distinguished by path and hash; one linked file is one candidate", (t) => {
  const dup = makeTree(t, { duplicate: "hr-write-jd" });
  const twins = dup.catalog.skills.filter((s) => s.name === "hr-write-jd");
  assert.equal(twins.length, 2);
  assert.notEqual(twins[0].id, twins[1].id);
  const d = decideFor(dup.catalog, "hr-write-jd \uC2A4\uD0AC\uB85C JD \uC368\uC918").decision;
  assert.equal(d.skills.reason, "duplicate-name");
  assert.equal(d.skills.needsConfirmation, true);
  assert.equal(d.conflicts[0].candidates.length, 2);
  const linked = makeTree(t, { link: true });
  assert.equal(linked.catalog.skills.filter((s) => s.name === "hr-write-jd").length, 1);
});

test("ambiguous and low-confidence answers fall back to no selection with a reason", (t) => {
  const { catalog } = makeTree(t);
  const prompt = "OPS \uC77C\uC77C \uBCF4\uACE0 \uB9CC\uB4E4\uC5B4\uC918";
  const ambiguous = decideFor(catalog, prompt, { skill: answer("ops-report-daily", 0.45, { "ops-report-daily": 0.45, "fin-asset-ledger": 0.4, none: 0.15 }) }).decision;
  assert.equal(ambiguous.skills.reason, "ambiguous");
  assert.equal(ambiguous.needsConfirmation, true);
  assert.equal(ambiguous.skills.selected.length, 0);
  const low = decideFor(catalog, prompt, { skill: answer("ops-report-daily", 0.4, { "ops-report-daily": 0.4, none: 0.35, "fin-asset-ledger": 0.05 }) }).decision;
  assert.equal(low.skills.reason, "low-confidence");
  const unavailable = decideFor(catalog, prompt, null).decision;
  assert.equal(unavailable.skills.reason, "jev-unavailable");
  assert.ok(unavailable.uncertainty.some((u) => u.includes("kept existing handling")));
});

test("a short continuation keeps the earlier skill; a new task drops it", (t) => {
  const { catalog } = makeTree(t);
  const first = decideFor(catalog, "JD \uCD08\uC548 \uC368\uC918", { skill: answer("hr-write-jd", 0.9) }).decision;
  const next = decideFor(catalog, "\uC88B\uC544, \uACC4\uC18D\uD574\uC918", null, { previous: first }).decision;
  assert.equal(next.skills.reason, "previous-context");
  assert.equal(next.skills.selected[0].source, "context");
  assert.equal(decideFor(catalog, "\uC0C8 \uC791\uC5C5: \uACC4\uC18D\uD574\uC918", null, { previous: first, newTask: true }).decision.skills.selected.length, 0);
});

test("a required skill rule is added, and an explicit opt-out conflict is reported", (t) => {
  const { catalog } = makeTree(t);
  const config = { requiredSkills: [{ id: "jd-rule", skill: "hr-write-jd", pattern: "JD" }] };
  const added = decideFor(catalog, "JD \uCD08\uC548 \uC368\uC918", { skill: answer("none", 0.9) }, { config }).decision;
  assert.deepEqual(added.skills.selected.map((s) => s.source), ["required"]);
  const conflict = decideFor(catalog, "\uC2A4\uD0AC \uC5C6\uC774 JD \uCD08\uC548 \uC368\uC918", null, { config }).decision;
  assert.equal(conflict.skills.selected.length, 0);
  assert.equal(conflict.conflicts[0].type, "required-vs-explicit-none");
});

test("application re-reads the skill, records hash drift and never injects in recommend mode", (t) => {
  const { catalog } = makeTree(t);
  const decision = decideFor(catalog, "JD \uCD08\uC548 \uC368\uC918", { skill: answer("hr-write-jd", 0.9), agent: answer("hr-jd-drafter", 0.8) }).decision;
  const applied = buildInstruction(decision, { mode: "apply", cli: "claude", agentSupport: "delegate" });
  assert.ok(applied.text.startsWith(MARKER));
  assert.ok(applied.text.includes("Body of hr-write-jd"));
  assert.ok(applied.text.includes('subagent_type "hr-jd-drafter"'));
  assert.equal(applied.applied.skills[0].hashChanged, false);
  const drift = buildInstruction(decision, { mode: "apply", cli: "claude", agentSupport: "delegate", readFile: () => "changed" });
  assert.equal(drift.applied.skills[0].hashChanged, true);
  const missing = buildInstruction(decision, { mode: "apply", readFile: () => { throw Object.assign(new Error("gone"), { code: "ENOENT" }); } });
  assert.equal(missing.applied.skills[0].applied, false);
  assert.equal(buildInstruction(decision, { mode: "recommend" }).text, null);
  const codex = buildInstruction(decision, { mode: "apply", cli: "codex", agentSupport: "recommend-only" });
  assert.equal(codex.applied.agent.applied, false);
  assert.ok(!codex.text.includes("subagent_type"));
});

test("injection is idempotent and re-applied to the same message for cache stability", () => {
  const injections = new Map([[promptHash("JD \uC368\uC918"), `${MARKER}>x</jev-routing-capabilities>`]]);
  const body = { messages: [{ role: "user", content: "JD \uC368\uC918" }, { role: "assistant", content: [{ type: "text", text: "ok" }] }, { role: "user", content: "next" }] };
  assert.equal(injectClaude(body, injections), 1);
  assert.equal(injectClaude(body, injections), 0);
  assert.equal(body.messages[0].content.length, 2);
  assert.equal(typeof body.messages[2].content, "string");
});

function upstream(t, handler) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => { seen.push({ url: req.url, body: data ? JSON.parse(data) : null }); handler(req, res); });
  });
  t.after(() => server.close());
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ base: `http://127.0.0.1:${server.address().port}`, seen })));
}
const sse = (res, model) => {
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.end(`event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { model } })}\n\nevent: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "hi" } })}\n\n`);
};

function runtimeFor(t, tree, mode = "apply", extra = {}) {
  const stateDir = join(tree.root, "state");
  const config = { schemaVersion: 1, enabled: true, stateDir, capabilityRouting: { mode, dataset: "regression",
    roots: { claude: { skills: [{ dir: join(tree.home, ".claude/skills"), scope: "user" }], agents: [{ dir: join(tree.home, ".claude/agents"), scope: "user", format: "md" }] },
      codex: { skills: [{ dir: join(tree.home, ".claude/skills"), scope: "user" }], agents: [] } }, ...extra } };
  return { stateDir, config };
}

test("Claude proxy: one turn links input, candidates, decision, application, served model and masked input", async (t) => {
  const tree = makeTree(t);
  const { stateDir, config } = runtimeFor(t, tree);
  const { base, seen } = await upstream(t, (req, res) => sse(res, "claude-sonnet-5-5"));
  let asked;
  const route = async (input) => { asked = input.capabilityQuestions; return { choice: "claude-sonnet-5-5", confidence: 0.8, effort: "medium", ms: 12,
    routerModel: "test-router", usage: { inputTokens: 100, outputTokens: 5 },
    capabilityAnswers: { skill: answer("hr-write-jd", 0.85), agent: answer("hr-jd-drafter", 0.7) } }; };
  const proxy = await startProxy({ upstreamURL: base, route, runtimeConfig: config, cwd: tree.cwd });
  t.after(proxy.close);
  const prompt = "JD \uCD08\uC548 \uC791\uC131\uD574\uC918. \uCC38\uACE0 token=sentinel-value-x \uC740 \uBB34\uC2DC";
  const body = { model: "jev-router", tools: [{ name: "Read", input_schema: { type: "object" } }], messages: [{ role: "user", content: prompt }] };
  const res = await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, { method: "POST", body: JSON.stringify(body) });
  const text = await res.text();
  assert.match(text, /skill hr-write-jd; agent hr-jd-drafter \(recommended\)/);
  assert.ok(asked.skill && asked.agent, "skill and agent questions ride on the routing call");
  const sent = seen.at(-1).body.messages[0].content;
  assert.ok(sent.some((b) => b.text?.includes("Body of hr-write-jd")), "skill content reaches the model");
  const events = readEvents(stateDir);
  const ids = new Set(events.map((e) => e.requestId));
  assert.equal(ids.size, 1);
  assert.deepEqual(events.map((e) => e.type), ["request", "candidates", "decision", "application", "served"]);
  const [request, , decision, application, served] = events;
  assert.ok(request.taskId && request.conversationId && request.routerVersion && request.catalog.hash);
  assert.ok(!request.input.text.includes("sentinel-value-x"), "secret masked");
  assert.equal(request.input.sha256.length, 64);
  assert.equal(decision.routerModel, "test-router");
  assert.deepEqual(decision.usage, { inputTokens: 100, outputTokens: 5 });
  assert.equal(decision.cost, "unknown");
  assert.equal(application.skills[0].applied, true);
  assert.equal(application.agent.applied, "recommendation-injected");
  assert.equal(served.model, "claude-sonnet-5-5");
  assert.equal(decision.taskId, request.taskId);
});

test("Claude proxy: identical retry reuses the decision; tool loop keeps injection and logs delegation once", async (t) => {
  const tree = makeTree(t);
  const { stateDir, config } = runtimeFor(t, tree);
  const { base, seen } = await upstream(t, (req, res) => sse(res, "claude-sonnet-5-5"));
  let calls = 0;
  const route = async () => { calls++; return { choice: "claude-sonnet-5-5", confidence: 0.8, effort: "medium", capabilityAnswers: { skill: answer("hr-write-jd", 0.85), agent: answer("hr-jd-drafter", 0.7) } }; };
  const proxy = await startProxy({ upstreamURL: base, route, runtimeConfig: config, cwd: tree.cwd });
  t.after(proxy.close);
  const post = (body) => fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, { method: "POST", body: JSON.stringify(body) }).then((r) => r.text());
  const turn = { model: "jev-router", tools: [{ name: "Agent", input_schema: { type: "object" } }], messages: [{ role: "user", content: "JD \uCD08\uC548 \uC791\uC131\uD574\uC918" }] };
  await post(turn);
  await post(turn); // network retry of the same request
  const loop = { ...turn, messages: [...turn.messages,
    { role: "assistant", content: [{ type: "tool_use", id: "tu1", name: "Agent", input: { subagent_type: "hr-jd-drafter", prompt: "x" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: "draft" }] }] };
  await post(loop);
  await post(loop);
  const events = readEvents(stateDir);
  assert.equal(events.filter((e) => e.type === "decision").length, 1, "no duplicate decision for a retry");
  const requests = events.filter((e) => e.type === "request");
  assert.equal(requests[1].attempt, 2);
  assert.equal(requests[1].retryOf, requests[0].requestId);
  assert.equal(events.filter((e) => e.type === "tool_observed").length, 1);
  assert.equal(events.filter((e) => e.type === "tool_result").length, 1);
  const loopBody = seen.at(-1).body.messages[0].content;
  assert.equal(loopBody.filter((b) => b.text?.startsWith(MARKER)).length, 1, "same injection in the tool loop");
  const report = routingReport({ stateDir, dataset: "regression" });
  assert.equal(report.sample.retries, 1);
  assert.equal(report.application.agent.delegationStarted, 1);
  assert.equal(report.application.agent.delegationCompleted, 1);
  assert.ok(calls >= 1);
});

test("selection/execution mismatch is recorded in recommend mode and for a different served model", async (t) => {
  const tree = makeTree(t);
  const { stateDir, config } = runtimeFor(t, tree, "recommend");
  const { base, seen } = await upstream(t, (req, res) => sse(res, "claude-opus-5-5"));
  const route = async () => ({ choice: "claude-sonnet-5-5", confidence: 0.8, capabilityAnswers: { skill: answer("hr-write-jd", 0.85), agent: answer("none", 0.9) } });
  const proxy = await startProxy({ upstreamURL: base, route, runtimeConfig: config, cwd: tree.cwd });
  t.after(proxy.close);
  await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, { method: "POST", body: JSON.stringify({ model: "jev-router", tools: [{ name: "Read", input_schema: {} }], messages: [{ role: "user", content: "JD \uCD08\uC548 \uC791\uC131\uD574\uC918" }] }) }).then((r) => r.text());
  assert.equal(typeof seen.at(-1).body.messages[0].content, "string", "recommend mode does not change the request");
  const application = readEvents(stateDir).find((e) => e.type === "application");
  assert.ok(application.mismatch.some((m) => m.reason.includes("recommend mode")));
  const report = routingReport({ stateDir, dataset: "regression" });
  assert.equal(report.application.model.servedDiffersFromSelected, 1);
  assert.equal(report.application.skills.injected, 0);
});

test("Codex proxy injects the selected skill and reports agent delegation as unsupported", async (t) => {
  const tree = makeTree(t);
  const { stateDir, config } = runtimeFor(t, tree, "apply", { clis: ["claude", "codex"] });
  config.capabilityRouting.roots.codex.agents = [{ dir: join(tree.home, ".claude/agents"), scope: "user", format: "md" }];
  const { base, seen } = await upstream(t, (req, res) => {
    if (req.url.startsWith("/models")) { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ models: [{ slug: "gpt-5.6-terra", supported_reasoning_levels: [{ effort: "medium" }] }] })); }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ type: "response.created", response: { model: "gpt-5.6-terra" } })}\n\n`);
  });
  const route = async () => ({ choice: "gpt-5.6-terra", confidence: 0.8, effort: "medium", capabilityAnswers: { skill: answer("hr-write-jd", 0.85), agent: answer("hr-jd-drafter", 0.8) } });
  const proxy = await startCodexProxy({ chatgptBaseURL: base, apiBaseURL: base, route, runtimeConfig: config, cwd: tree.cwd });
  t.after(proxy.close);
  const res = await fetch(`http://127.0.0.1:${proxy.port}/responses`, { method: "POST", headers: { "chatgpt-account-id": "x" },
    body: JSON.stringify({ model: "jev-router", input: [{ type: "additional_tools", tools: [{}] }, { role: "user", content: [{ type: "input_text", text: "JD \uCD08\uC548 \uC791\uC131\uD574\uC918" }] }] }) });
  assert.match(await res.text(), /agent hr-jd-drafter \(recommended\)/);
  const sent = seen.find((s) => s.url.startsWith("/responses")).body.input[1].content;
  assert.ok(sent.some((p) => p.text?.includes("Body of hr-write-jd")));
  const application = readEvents(stateDir).find((e) => e.type === "application");
  assert.equal(application.agent.applied, false);
  assert.equal(routingReport({ stateDir, dataset: "regression" }).application.agent.recommendationOnlyHost, 1);
});

test("mode off is the cold path: no events and an unchanged body", async (t) => {
  const tree = makeTree(t);
  const { stateDir, config } = runtimeFor(t, tree, "off");
  assert.equal(createCapabilityRuntime({ cli: "claude", config }), null);
  const { base, seen } = await upstream(t, (req, res) => sse(res, "claude-sonnet-5-5"));
  let asked = "unset";
  const proxy = await startProxy({ upstreamURL: base, route: async (input) => { asked = input.capabilityQuestions; return { choice: "claude-sonnet-5-5", confidence: 0.8 }; }, runtimeConfig: config, cwd: tree.cwd });
  t.after(proxy.close);
  await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, { method: "POST", body: JSON.stringify({ model: "jev-router", tools: [{ name: "Read", input_schema: {} }], messages: [{ role: "user", content: "JD \uCD08\uC548 \uC791\uC131\uD574\uC918" }] }) }).then((r) => r.text());
  assert.equal(asked, undefined);
  assert.equal(seen.at(-1).body.messages[0].content, "JD \uCD08\uC548 \uC791\uC131\uD574\uC918");
  assert.deepEqual(readEvents(stateDir), []);
  assert.ok(!JSON.stringify(readFileSync(join(stateDir, "decisions.jsonl"), "utf8")).includes("capabil"));
});

test("Korean particles attached to Latin words still shortlist (JD + particle)", (t) => {
  const { catalog } = makeTree(t);
  assert.equal(shortlist("JD\uAC00 \uBB54\uC9C0 \uC54C\uB824\uC918", catalog.skills, { limit: 3 })[0]?.candidate.name, "hr-write-jd");
});

test("the classifier is not asked a question the user already answered", (t) => {
  const tree = makeTree(t);
  const { config } = runtimeFor(t, tree);
  const caps = createCapabilityRuntime({ cli: "claude", config, cwd: tree.cwd });
  const named = caps.prepare({ prompt: "/hr-perf-plan \uB85C PIP \uBB38\uC11C\uC640 JD \uCD08\uC548 \uC368\uC918", conversationId: "a", messageCount: 1 });
  assert.ok(!named.questions?.skill, "explicit skill: no skill question");
  const optOut = caps.prepare({ prompt: "\uC2A4\uD0AC \uC5C6\uC774 JD \uCD08\uC548 \uC791\uC131\uD574\uC918", conversationId: "b", messageCount: 1 });
  assert.ok(!optOut.questions?.skill, "opt-out: no skill question");
  const open = caps.prepare({ prompt: "JD \uCD08\uC548 \uC791\uC131\uD574\uC918", conversationId: "c", messageCount: 1 });
  assert.ok(open.questions.skill);
});

test("Claude proxy: a resend under a new conversation key after HTTP 400 is linked as a retry", async (t) => {
  const tree = makeTree(t);
  const { stateDir, config } = runtimeFor(t, tree);
  let first = true;
  const { base, seen } = await upstream(t, (req, res) => {
    if (first) { first = false; res.writeHead(400, { "content-type": "application/json" }); return res.end("{}"); }
    sse(res, "claude-haiku-4-5-20251001");
  });
  let calls = 0;
  const route = async () => { calls++; return { choice: "claude-haiku-4-5-20251001", confidence: 0.8,
    capabilityAnswers: { skill: answer("hr-write-jd", 0.85), agent: calls === 1 ? answer("hr-jd-drafter", 0.7) : answer("none", 0.9) } }; };
  const proxy = await startProxy({ upstreamURL: base, route, runtimeConfig: config, cwd: tree.cwd });
  t.after(proxy.close);
  const post = (body) => fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, { method: "POST", body: JSON.stringify(body) }).then((r) => r.text());
  const turn = { model: "jev-router", tools: [{ name: "Read", input_schema: {} }], messages: [{ role: "user", content: "JD \uCD08\uC548 \uC791\uC131\uD574\uC918" }] };
  await post({ ...turn, messages: [...turn.messages, { role: "system", content: "hook output" }] });
  await post({ ...turn, metadata: { user_id: JSON.stringify({ session_id: "s-after-400" }) } }); // new conversation key
  const events = readEvents(stateDir);
  assert.equal(events.filter((e) => e.type === "decision").length, 1, "decided once");
  const requests = events.filter((e) => e.type === "request");
  assert.equal(requests[1].attempt, 2);
  assert.notEqual(requests[0].conversationId, requests[1].conversationId);
  assert.ok(seen.at(-1).body.messages[0].content.some((b) => b.text?.includes('subagent_type "hr-jd-drafter"')), "same delegation recommendation, not a new one");
  const report = routingReport({ stateDir, dataset: "regression" });
  assert.equal(report.sample.decisions, 1);
  assert.equal(report.application.model.servedObserved, 1);
});
