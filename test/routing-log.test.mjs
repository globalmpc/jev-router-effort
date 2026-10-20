import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addLabel, createRoutingLog, maskSecrets, pruneLog, readEvents, routingReport, EVENTS_FILE } from "../src/routing-log.mjs";
// Korean keywords are written as \u escapes so the source stays English-only.

const dir = (t) => {
  const d = mkdtempSync(join(tmpdir(), "jev-log-"));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  return d;
};

function seed(stateDir, { dataset = "live", now = Date.now } = {}) {
  const log = createRoutingLog({ stateDir, dataset, now });
  const ids = [];
  const turns = [
    { skills: ["hr-write-jd"], agent: "hr-jd-drafter", model: "claude-sonnet-5-5", ms: 300 },
    { skills: [], agent: null, model: "claude-haiku-4-5-20251001", ms: 200 },
    { skills: ["ops-report-daily"], agent: null, model: "claude-sonnet-5-5", ms: 500, reason: "jev-unavailable" },
  ];
  for (const [i, turn] of turns.entries()) {
    const requestId = log.newRequestId();
    ids.push(requestId);
    log.event("request", { requestId, taskId: `task-${i}`, conversationId: `c-${i}`, attempt: 1, cli: "claude", capabilitySupport: "full" });
    log.event("decision", { requestId, model: { selected: turn.model, reason: "jev" }, effort: { selected: "low" },
      skills: { selected: turn.skills.map((name) => ({ name })), reason: turn.reason ?? (turn.skills.length ? "jev" : "jev-none") },
      agent: { selected: turn.agent ? { name: turn.agent } : null, reason: turn.agent ? "jev" : "jev-none" },
      conflicts: [], needsConfirmation: false, routerMs: turn.ms, usage: i === 2 ? "unknown" : { inputTokens: 100, outputTokens: 4 } });
  }
  return { log, ids };
}

test("secrets are masked in logged input", () => {
  const masked = maskSecrets("key sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUV and xoxb-1234567890-abcdef and password: hunter22 Bearer abcdefghijklmnop");
  for (const secret of ["ABCDEFGHIJKLMNOPQRSTUV", "xoxb-1234567890", "hunter22", "abcdefghijklmnop"]) assert.ok(!masked.includes(secret), secret);
  assert.equal(maskSecrets("JD \uCD08\uC548 \uC368\uC918"), "JD \uCD08\uC548 \uC368\uC918");
});

test("event log is private (0600)", { skip: process.platform === "win32" }, (t) => {
  const stateDir = dir(t);
  seed(stateDir);
  assert.equal(statSync(join(stateDir, EVENTS_FILE)).mode & 0o777, 0o600);
});

test("without labels every accuracy is unmeasured and coverage is explicit", (t) => {
  const stateDir = dir(t);
  seed(stateDir);
  const report = routingReport({ stateDir });
  assert.equal(report.sample.decisions, 3);
  for (const dimension of ["model", "effort", "skills", "agent"]) {
    assert.equal(report.recommendation[dimension].accuracy, "unmeasured");
    assert.equal(report.recommendation[dimension].labelCoverage, 0);
  }
  assert.equal(report.taskOutcome.successRate, "unmeasured");
  assert.equal(report.handling.fallback, 1);
  assert.equal(report.latency.routerMs.p50, 300);
  assert.equal(report.resources.routerTokens.unknown, 1);
  assert.equal(report.resources.cost, "unknown");
});

test("labels compute per-dimension accuracy, misses, unnecessary picks and no-selection accuracy separately from task success", (t) => {
  const stateDir = dir(t);
  const { ids } = seed(stateDir);
  const label = (requestId, dimension, extra) => addLabel({ stateDir, requestId, dimension, source: "user", evidence: "user confirmed in chat", ...extra });
  label(ids[0], "skills", { expected: "hr-write-jd" });
  label(ids[0], "agent", { expected: "none" });            // agent was unnecessary
  label(ids[1], "skills", { expected: "none" });           // correct no-selection
  label(ids[2], "skills", { expected: "fin-asset-ledger" }); // wrong target: one miss, one unnecessary
  label(ids[0], "task", { outcome: "success" });
  label(ids[1], "task", { outcome: "unknown" });
  addLabel({ stateDir, requestId: ids[2], dimension: "task", outcome: "failure", source: "executable", evidence: "npm test exit 1" });
  const r = routingReport({ stateDir });
  assert.equal(r.recommendation.skills.labeled, 3);
  assert.equal(r.recommendation.skills.accuracy, 0.6667);
  assert.equal(r.recommendation.skills.missedTargets, 1);
  assert.equal(r.recommendation.skills.unnecessaryTargets, 1);
  assert.equal(r.recommendation.skills.noSelectionAccuracy, 1);
  assert.equal(r.recommendation.skills.noSelectionDenominator, 1);
  assert.equal(r.recommendation.agent.accuracy, 0);
  assert.equal(r.recommendation.agent.unnecessaryTargets, 1);
  assert.equal(r.recommendation.model.accuracy, "unmeasured");
  assert.equal(r.taskOutcome.successRate, 0.5);
  assert.equal(r.taskOutcome.successRateDenominator, 2);
  assert.equal(r.taskOutcome.unknown, 1);
});

test("confidence or self-reported completion cannot be a label; unknown requests are refused", (t) => {
  const stateDir = dir(t);
  const { ids } = seed(stateDir);
  assert.throws(() => addLabel({ stateDir, requestId: ids[0], dimension: "task", outcome: "success", source: "model", evidence: "assistant said done" }), /source must be/);
  assert.throws(() => addLabel({ stateDir, requestId: ids[0], dimension: "task", outcome: "success", source: "user", evidence: "" }), /evidence/);
  assert.throws(() => addLabel({ stateDir, requestId: "nope", dimension: "task", outcome: "success", source: "user", evidence: "x" }), /Unknown request/);
});

test("regression fixtures and live use are reported separately", (t) => {
  const stateDir = dir(t);
  seed(stateDir, { dataset: "regression" });
  seed(stateDir, { dataset: "live" });
  assert.equal(routingReport({ stateDir, dataset: "live" }).sample.decisions, 3);
  assert.equal(routingReport({ stateDir, dataset: "regression" }).sample.decisions, 3);
  assert.equal(routingReport({ stateDir, dataset: "all" }).sample.decisions, 6);
});

test("prune removes events older than the retention window", (t) => {
  const stateDir = dir(t);
  const old = Date.now() - 40 * 86400_000;
  seed(stateDir, { now: () => old });
  seed(stateDir);
  const result = pruneLog({ stateDir, days: 30 });
  assert.equal(result[EVENTS_FILE].removed, 6);
  assert.equal(readEvents(stateDir).length, 6);
});
