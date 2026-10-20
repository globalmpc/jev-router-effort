// Korean keywords are written as \u escapes so the source stays English-only.
// Private routing event log, outcome labels and the label-based performance report.
// Files live in the runtime stateDir with mode 0600 and never inside the repository.
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { join } from "node:path";

export const EVENTS_FILE = "routing-events.jsonl";
export const LABELS_FILE = "routing-labels.jsonl";
export const LOG_SCHEMA = 1;
export const LABEL_SOURCES = ["user", "qa", "executable"];
export const LABEL_DIMENSIONS = ["model", "effort", "skills", "agent", "task"];
export const TASK_OUTCOMES = ["success", "failure", "unknown"];

const SECRET_PATTERNS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED:private-key]"],
  [/\b(?:sk|rk|pk)-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{16,}/g, "[REDACTED:api-key]"],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, "[REDACTED:slack-token]"],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}/g, "[REDACTED:github-token]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED:aws-key]"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[REDACTED:jwt]"],
  [/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{12,}/gi, "$1 [REDACTED]"],
  [/\b(password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|\uBE44\uBC00\uBC88\uD638|\uD1A0\uD070)(\s*[:=]\s*|\s+)(["']?)[^\s"']{6,}\3/gi, "$1$2[REDACTED]"],
];

/** Masks common credential shapes. Not a guarantee; the log stays private regardless. */
export function maskSecrets(text) {
  let out = String(text ?? "");
  for (const [re, replacement] of SECRET_PATTERNS) out = out.replace(re, replacement);
  return out;
}

const sha = (text) => createHash("sha256").update(String(text)).digest("hex");

function appendPrivate(file, value) {
  mkdirSync(join(file, ".."), { recursive: true, mode: 0o700 });
  appendFileSync(file, JSON.stringify(value) + "\n", { mode: 0o600 });
  chmodSync(file, 0o600);
}

function readLines(file) {
  if (!existsSync(file)) return [];
  const out = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* a torn last line is skipped, not fatal */ }
  }
  return out;
}

/** Input reference kept privately: masked bounded text plus a hash of the original. */
export function inputRecord(prompt, maxChars = 4000) {
  const masked = maskSecrets(prompt);
  return { sha256: sha(prompt), chars: String(prompt ?? "").length, text: masked.slice(0, maxChars), truncated: masked.length > maxChars };
}

export function hostRecord() {
  return { platform: process.platform, hostHash: sha(hostname()).slice(0, 12), node: process.versions.node };
}

/**
 * Event writer for one CLI process. Logging failures never block a request.
 * `dataset` separates regression fixtures from live use in reports.
 */
export function createRoutingLog({ stateDir, dataset = "live", now = Date.now, onError = () => {} } = {}) {
  if (!stateDir) return null;
  const file = join(stateDir, EVENTS_FILE);
  return {
    file,
    dataset,
    newRequestId: () => randomUUID(),
    event(type, fields) {
      try {
        appendPrivate(file, { v: LOG_SCHEMA, type, at: new Date(now()).toISOString(), dataset, ...fields });
        return true;
      } catch (error) {
        onError(error);
        return false;
      }
    },
  };
}

/** Records a ground-truth label. Classifier confidence and agent completion claims are refused. */
export function addLabel({ stateDir, requestId, dimension, expected, outcome, source, evidence, labeler = null, dataset, now = Date.now }) {
  if (!stateDir) throw new Error("stateDir is required");
  if (!requestId) throw new Error("--request is required");
  if (!LABEL_DIMENSIONS.includes(dimension)) throw new Error(`dimension must be one of ${LABEL_DIMENSIONS.join(", ")}`);
  if (!LABEL_SOURCES.includes(source)) throw new Error(`source must be one of ${LABEL_SOURCES.join(", ")}; model confidence or an agent's own completion claim is not a label`);
  if (!evidence || !String(evidence).trim()) throw new Error("--evidence is required (test output, QA note or user report reference)");
  const events = readLines(join(stateDir, EVENTS_FILE));
  const request = events.find((e) => e.type === "request" && e.requestId === requestId);
  if (!request) throw new Error(`Unknown request ${requestId}`);
  let value;
  if (dimension === "task") {
    if (!TASK_OUTCOMES.includes(outcome)) throw new Error(`task labels need --outcome ${TASK_OUTCOMES.join("|")}`);
    value = { outcome };
  } else if (dimension === "skills") {
    const list = expected === undefined || expected === null || expected === "none" || expected === "" ? []
      : (Array.isArray(expected) ? expected : String(expected).split(",")).map((s) => s.trim()).filter(Boolean);
    value = { expected: [...new Set(list)].sort() };
  } else {
    if (expected === undefined) throw new Error("--expected is required (use none for no agent)");
    value = { expected: expected === "none" || expected === "" ? null : String(expected) };
  }
  const label = { v: LOG_SCHEMA, labelId: randomUUID(), at: new Date(now()).toISOString(), requestId, taskId: request.taskId ?? null,
    conversationId: request.conversationId ?? null, dataset: dataset ?? request.dataset ?? "live", dimension, ...value, source,
    evidence: maskSecrets(evidence).slice(0, 2000), labeler };
  appendPrivate(join(stateDir, LABELS_FILE), label);
  return label;
}

/** Drops events and labels older than `days`. Returns counts. */
export function pruneLog({ stateDir, days = 30, now = Date.now }) {
  const cutoff = now() - days * 86400_000;
  const result = {};
  for (const name of [EVENTS_FILE, LABELS_FILE]) {
    const file = join(stateDir, name);
    if (!existsSync(file)) { result[name] = { kept: 0, removed: 0 }; continue; }
    const rows = readLines(file);
    const kept = rows.filter((r) => Date.parse(r.at) >= cutoff);
    const tmp = `${file}.${randomUUID()}.tmp`;
    writeFileSync(tmp, kept.map((r) => JSON.stringify(r)).join("\n") + (kept.length ? "\n" : ""), { mode: 0o600 });
    renameSync(tmp, file);
    result[name] = { kept: kept.length, removed: rows.length - kept.length };
  }
  return result;
}

const ratio = (num, den) => (den ? Number((num / den).toFixed(4)) : null);
const percentile = (values, p) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
};

function selectedFor(decision, dimension) {
  if (!decision) return undefined;
  if (dimension === "model") return decision.model?.selected ?? null;
  if (dimension === "effort") return decision.effort?.selected ?? null;
  if (dimension === "skills") return (decision.skills?.selected ?? []).map((s) => s.name).sort();
  if (dimension === "agent") return decision.agent?.selected?.name ?? null;
  return undefined;
}

/**
 * Label-based report. Recommendation accuracy and task success are reported separately;
 * every metric carries its denominator. Without labels a metric is "unmeasured".
 */
export function routingReport({ stateDir, since = null, dataset = "live", now = Date.now }) {
  const after = since ? now() - since : -Infinity;
  const inScope = (row) => Date.parse(row.at) >= after && (dataset === "all" || row.dataset === dataset);
  const events = readLines(join(stateDir, EVENTS_FILE)).filter(inScope);
  const labels = readLines(join(stateDir, LABELS_FILE)).filter(inScope);
  const requests = events.filter((e) => e.type === "request");
  const primary = requests.filter((e) => !(e.attempt > 1));
  const byId = new Map(primary.map((r) => [r.requestId, { request: r }]));
  // Events of a retry belong to its first attempt; a retry's decision fills a failed first attempt.
  const rootOf = new Map(requests.filter((r) => r.attempt > 1 && r.retryOf).map((r) => [r.requestId, r.retryOf]));
  for (const e of events) {
    if (e.type === "request") continue;
    const slot = byId.get(rootOf.get(e.requestId) ?? e.requestId);
    if (slot && rootOf.has(e.requestId) && ["decision", "application", "served"].includes(e.type) && slot[e.type]) continue;
    if (!slot) continue;
    if (e.type === "decision") slot.decision = e;
    else if (e.type === "application") slot.application = e;
    else if (e.type === "served") slot.served = e;
    else if (e.type === "tool_observed") (slot.tools ??= []).push(e);
    else if (e.type === "tool_result") (slot.results ??= []).push(e);
    else if (e.type === "error") (slot.errors ??= []).push(e);
  }
  // The last label per request and dimension wins; earlier ones stay in the file for audit.
  const latest = new Map();
  for (const label of labels) latest.set(`${label.requestId}:${label.dimension}`, label);
  const decided = [...byId.values()].filter((s) => s.decision);
  const total = decided.length;

  const dimensions = {};
  for (const dimension of ["model", "effort", "skills", "agent"]) {
    let n = 0, correct = 0, missed = 0, unnecessary = 0, noneExpected = 0, noneCorrect = 0, neededExpected = 0, neededCorrect = 0;
    for (const slot of decided) {
      const label = latest.get(`${slot.request.requestId}:${dimension}`);
      if (!label) continue;
      n++;
      const selected = selectedFor(slot.decision, dimension);
      if (dimension === "skills") {
        const exp = new Set(label.expected), sel = new Set(selected);
        if (exp.size === sel.size && [...exp].every((x) => sel.has(x))) correct++;
        missed += [...exp].filter((x) => !sel.has(x)).length;
        unnecessary += [...sel].filter((x) => !exp.has(x)).length;
        if (!exp.size) { noneExpected++; if (!sel.size) noneCorrect++; } else { neededExpected++; if (sel.size) neededCorrect++; }
      } else {
        if (selected === label.expected) correct++;
        if (dimension === "agent") {
          if (label.expected && selected !== label.expected) missed++;
          if (selected && selected !== label.expected) unnecessary++;
          if (label.expected === null) { noneExpected++; if (selected === null) noneCorrect++; } else { neededExpected++; if (selected) neededCorrect++; }
        }
      }
    }
    dimensions[dimension] = {
      labeled: n, decisions: total, labelCoverage: ratio(n, total),
      accuracy: n ? ratio(correct, n) : "unmeasured", correct,
      ...(dimension === "skills" || dimension === "agent" ? {
        missedTargets: n ? missed : "unmeasured", unnecessaryTargets: n ? unnecessary : "unmeasured",
        noSelectionAccuracy: noneExpected ? ratio(noneCorrect, noneExpected) : "unmeasured", noSelectionDenominator: noneExpected,
        needDetection: neededExpected ? ratio(neededCorrect, neededExpected) : "unmeasured", needDenominator: neededExpected,
      } : {}),
    };
  }

  let success = 0, failure = 0, unknown = 0;
  for (const slot of decided) {
    const label = latest.get(`${slot.request.requestId}:task`);
    if (!label) continue;
    if (label.outcome === "success") success++; else if (label.outcome === "failure") failure++; else unknown++;
  }
  const outcomeLabeled = success + failure + unknown;

  const reasons = {};
  let fallback = 0, confirmations = 0, conflicts = 0;
  for (const { decision } of decided) {
    for (const key of ["skills", "agent"]) {
      const reason = decision[key]?.reason ?? "missing";
      reasons[`${key}:${reason}`] = (reasons[`${key}:${reason}`] ?? 0) + 1;
    }
    if (["jev-unavailable", "low-confidence", "jev-unknown-choice"].some((r) => [decision.skills?.reason, decision.agent?.reason, decision.model?.reason].some((x) => String(x ?? "").startsWith(r)))) fallback++;
    if (decision.needsConfirmation) confirmations++;
    if (decision.conflicts?.length) conflicts++;
  }

  const latency = decided.map((s) => s.decision.routerMs).filter(Number.isFinite);
  const tokens = decided.map((s) => s.decision.usage).filter((u) => u && Number.isFinite(u.inputTokens));
  const errors = events.filter((e) => e.type === "error");

  // Selection versus what actually happened on the wire and in tool calls.
  let agentSelected = 0, agentStarted = 0, agentCompleted = 0, agentNotObserved = 0, agentOpen = 0, otherAgents = 0;
  let skillsSelected = 0, skillsInjected = 0, skillNotApplied = 0, modelMismatch = 0, served = 0, unsupportedHost = 0;
  const convoRequests = new Map();
  for (const r of primary) (convoRequests.get(r.conversationId) ?? convoRequests.set(r.conversationId, []).get(r.conversationId)).push(r);
  const laterTurn = (r) => (convoRequests.get(r.conversationId) ?? []).some((x) => Date.parse(x.at) > Date.parse(r.at));
  for (const slot of decided) {
    const { decision, application } = slot;
    const agent = decision.agent?.selected?.name;
    const agentCalls = (slot.tools ?? []).filter((t) => t.tool === "Agent");
    if (agent) {
      agentSelected++;
      const call = agentCalls.find((t) => t.target === agent);
      if (call) {
        agentStarted++;
        if ((slot.results ?? []).some((r) => r.toolUseId === call.toolUseId)) agentCompleted++;
      } else if (laterTurn(slot.request)) agentNotObserved++;
      else agentOpen++;
    }
    otherAgents += agentCalls.filter((t) => t.target !== agent).length;
    skillsSelected += decision.skills?.selected?.length ?? 0;
    for (const s of application?.skills ?? []) { if (s.applied === true) skillsInjected++; else skillNotApplied++; }
    if (application?.agent && application.agent.applied === false) unsupportedHost++;
    if (slot.served?.model) { served++; if (decision.model?.selected && slot.served.model !== decision.model.selected) modelMismatch++; }
  }

  const unsupported = primary.filter((r) => r.capabilitySupport && r.capabilitySupport !== "full").length;
  return {
    generatedAt: new Date(now()).toISOString(),
    dataset,
    window: since ? `${Math.round(since / 3600_000)}h` : "all",
    sample: { requests: requests.length, primaryRequests: primary.length, retries: requests.length - primary.length, decisions: total,
      byCli: Object.fromEntries([...new Set(primary.map((r) => r.cli))].map((cli) => [cli, primary.filter((r) => r.cli === cli).length])) },
    note: "Recommendation accuracy uses selection labels only. Task success uses outcome labels only. Confidence and completion claims are never labels.",
    recommendation: dimensions,
    taskOutcome: { labeled: outcomeLabeled, decisions: total, labelCoverage: ratio(outcomeLabeled, total), success, failure, unknown,
      successRate: success + failure ? ratio(success, success + failure) : "unmeasured", successRateDenominator: success + failure },
    handling: { fallbackRate: ratio(fallback, total), fallback, confirmationRate: ratio(confirmations, total), confirmations,
      conflictRate: ratio(conflicts, total), conflicts, errorRate: ratio(errors.length, primary.length), errors: errors.length, reasons },
    application: {
      skills: { selected: skillsSelected, injected: skillsInjected, notApplied: skillNotApplied },
      agent: { selected: agentSelected, delegationStarted: agentStarted, delegationCompleted: agentCompleted,
        notObservedAfterTurn: agentNotObserved, turnStillOpenOrUnknown: agentOpen, delegatedToOtherAgent: otherAgents,
        recommendationOnlyHost: unsupportedHost },
      model: { servedObserved: served, servedDiffersFromSelected: modelMismatch },
      unsupportedHostRequests: unsupported,
    },
    latency: { routerMs: { n: latency.length, p50: percentile(latency, 50), p95: percentile(latency, 95), max: latency.length ? Math.max(...latency) : null } },
    resources: { routerTokens: { n: tokens.length, unknown: total - tokens.length,
      input: tokens.reduce((a, u) => a + u.inputTokens, 0), output: tokens.reduce((a, u) => a + (u.outputTokens ?? 0), 0) },
      cost: "unknown", injectedSkillBytes: decided.reduce((a, s) => a + (s.application?.skills ?? []).reduce((b, x) => b + (x.bytes ?? 0), 0), 0) },
  };
}

export function readEvents(stateDir) {
  return readLines(join(stateDir, EVENTS_FILE));
}
