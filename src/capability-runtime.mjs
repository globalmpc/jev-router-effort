// Per-process skill/agent routing state shared by the Claude and Codex proxies: retry
// detection, decision logging, request injection and tool-call observation.
import { readFileSync } from "node:fs";
import {
  buildInstruction,
  CAPABILITY_POLICY_VERSION,
  CAPABILITY_THRESHOLDS,
  capabilityConfig,
  capabilityNotice,
  capabilityQuestions,
  decideCapabilities,
  discoverCatalog,
  explicitMentions,
  injectClaude,
  injectCodex,
  observeClaudeTools,
  optedOut,
  promptHash,
  shortlist,
} from "./capabilities.mjs";
import { createRoutingLog, hostRecord, inputRecord } from "./routing-log.mjs";
import { isNewTaskPrompt } from "./task-runtime.mjs";

const PACKAGE_VERSION = (() => {
  try { return JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version; } catch { return "unknown"; }
})();
export const ROUTER_VERSION = `jev-router@${PACKAGE_VERSION}`;

/** What each CLI path can actually do with a selection. */
export const CLI_SUPPORT = {
  claude: { skills: "inject", agent: "delegate", level: "full" },
  codex: { skills: "inject", agent: "recommend-only", level: "skills-only" },
};

const DISABLED = (reason) => ({ selected: [], needed: null, reason, confidence: null });

export function createCapabilityRuntime({ cli, config, cwd = process.cwd(), discover = discoverCatalog, now = Date.now, catalogTtlMs = 30_000, policyVersion = null } = {}) {
  const cap = capabilityConfig(config);
  if (cap.mode === "off" || !config?.stateDir) return null;
  const support = CLI_SUPPORT[cli] ?? { skills: "none", agent: "none", level: "unsupported" };
  const capable = cap.clis.includes(cli) && support.level !== "unsupported" && ["recommend", "apply"].includes(cap.mode);
  const log = createRoutingLog({ stateDir: config.stateDir, dataset: cap.dataset, now });
  let catalog = null;
  let catalogAt = 0;
  const loadCatalog = () => {
    if (!catalog || now() - catalogAt > catalogTtlMs) {
      try { catalog = discover({ cli, cwd, config: cap }); }
      catch (error) { catalog = { cli, hash: "unavailable", skills: [], agents: [], error: error.message }; }
      catalogAt = now();
    }
    return catalog;
  };
  const conversations = new Map();
  // Claude Code can resend a failed first request under a new conversation key (observed
  // with 2.1.289 print mode after HTTP 400). Same prompt + history length shortly after an
  // upstream failure is linked as a retry, so it is not decided or delegated twice.
  const failedRecent = new Map();
  const requestPrompt = new Map();
  const RETRY_WINDOW_MS = 120_000;
  const convo = (id) => {
    let c = conversations.get(id);
    if (!c) {
      if (conversations.size > 50) conversations.delete(conversations.keys().next().value);
      conversations.set(id, (c = { injections: new Map(), last: null, previous: null, seenTools: new Set(), turnRequest: null }));
    }
    return c;
  };

  return {
    mode: cap.mode,
    support,
    log,
    /** Call once per new user turn before classification. */
    prepare({ prompt, conversationId, sessionId = null, messageCount = 0 }) {
      const c = convo(conversationId);
      const digest = promptHash(prompt);
      let retry = c.last && c.last.promptHash === digest && c.last.messageCount === messageCount;
      const failed = failedRecent.get(`${digest}:${messageCount}`);
      if (!retry && failed && now() - failed.at < RETRY_WINDOW_MS) {
        const origin = conversations.get(failed.conversationId);
        if (origin?.last?.promptHash === digest) {
          c.last = origin.last;
          const injection = origin.injections.get(digest);
          if (injection) c.injections.set(digest, injection);
          c.previous = origin.previous;
          retry = true;
        }
      }
      const ctx = { requestId: log.newRequestId(), conversationId, sessionId, prompt, promptHash: digest, messageCount,
        attempt: retry ? c.last.attempt + 1 : 1, retryOf: retry ? c.last.requestId : null, started: now() };
      if (retry && c.last.decision) {
        ctx.reused = c.last.decision;
        return ctx;
      }
      if (!capable) return ctx;
      const current = loadCatalog();
      ctx.catalog = current;
      ctx.shortlisted = {
        skills: shortlist(prompt, current.skills, { limit: CAPABILITY_THRESHOLDS.shortlistSkills, departments: cap.departments }),
        agents: shortlist(prompt, current.agents, { limit: CAPABILITY_THRESHOLDS.shortlistAgents, departments: cap.departments }),
      };
      // Skip a question the user already answered by naming a target or opting out.
      const answered = (kind, list) => optedOut(prompt, kind) || explicitMentions(prompt, list, kind).length > 0;
      const questions = capabilityQuestions({
        skills: answered("skill", current.skills) ? [] : ctx.shortlisted.skills,
        agents: answered("agent", current.agents) ? [] : ctx.shortlisted.agents,
      });
      ctx.questions = Object.keys(questions).length ? questions : null;
      return ctx;
    },

    /** Records the full decision and returns the notice fragment. Never throws. */
    finalize(ctx, { jev, taskId = null, taskType = null, model, effort, effortMode = "auto", modelReason, manualModel = false, policyVersion: pv = policyVersion }) {
      if (!ctx) return { notice: "" };
      const c = convo(ctx.conversationId);
      const requestBase = { requestId: ctx.requestId, taskId, conversationId: ctx.conversationId, sessionId: ctx.sessionId,
        attempt: ctx.attempt, retryOf: ctx.retryOf, cli, host: hostRecord(), cwd, mode: cap.mode, capabilitySupport: capable ? support.level : "none",
        routerVersion: ROUTER_VERSION, capabilityPolicyVersion: CAPABILITY_POLICY_VERSION, evidencePolicyVersion: pv ?? null,
        catalog: ctx.catalog ? { hash: ctx.catalog.hash, skills: ctx.catalog.skills.length, agents: ctx.catalog.agents.length } : null,
        taskType, input: inputRecord(ctx.prompt) };
      try {
        if (ctx.reused !== undefined) {
          // A retried request reuses the earlier selection: no new delegation, no duplicate decision.
          log.event("request", requestBase);
          c.last = { ...c.last, attempt: ctx.attempt };
          c.turnRequest = ctx.requestId;
          requestPrompt.set(ctx.requestId, { key: `${ctx.promptHash}:${ctx.messageCount}`, conversationId: ctx.conversationId });
          return { notice: c.last.notice ?? "", decision: ctx.reused, retry: true };
        }
        let decision;
        if (capable) {
          decision = decideCapabilities({ prompt: ctx.prompt, catalog: ctx.catalog, shortlisted: ctx.shortlisted,
            answers: jev?.capabilityAnswers ?? null, config: cap, previous: c.previous, newTask: isNewTaskPrompt(ctx.prompt) });
        } else {
          const reason = cap.mode === "log" ? "mode-log" : "unsupported-cli";
          decision = { version: CAPABILITY_POLICY_VERSION, skills: DISABLED(reason), agent: { ...DISABLED(reason), selected: null }, conflicts: [], uncertainty: [], needsConfirmation: false };
        }
        const record = {
          requestId: ctx.requestId, taskId, conversationId: ctx.conversationId,
          model: { selected: model ?? null, proposed: jev?.choice ?? null, reason: modelReason ?? null, confidence: jev?.confidence ?? null, manual: manualModel || String(modelReason ?? "").startsWith("override") },
          effort: { selected: effort ?? null, proposed: jev?.effort ?? null, mode: effortMode, confidence: jev?.effortConfidence ?? null },
          skills: decision.skills, agent: decision.agent, conflicts: decision.conflicts, uncertainty: decision.uncertainty,
          needsConfirmation: decision.needsConfirmation, evidence: jev?.evidence ?? null,
          routerModel: jev?.routerModel ?? (jev ? "unknown" : null), routerMs: jev?.ms ?? null,
          usage: jev?.usage ?? "unknown", cost: "unknown", wallMs: now() - ctx.started,
        };
        log.event("request", requestBase);
        if (ctx.shortlisted) {
          log.event("candidates", { requestId: ctx.requestId, catalogHash: ctx.catalog.hash,
            skills: ctx.shortlisted.skills.map((s) => ({ id: s.candidate.id, score: s.score, hits: s.hits })),
            agents: ctx.shortlisted.agents.map((s) => ({ id: s.candidate.id, score: s.score, hits: s.hits })),
            askedClassifier: !!ctx.questions });
        }
        log.event("decision", record);
        let applied = { skills: [], agent: null };
        if (capable) {
          const built = buildInstruction(decision, { mode: cap.mode, cli, agentSupport: support.agent });
          applied = built.applied;
          if (built.text) {
            c.injections.set(ctx.promptHash, built.text);
            if (c.injections.size > 20) c.injections.delete(c.injections.keys().next().value);
          }
          const mismatch = [];
          for (const s of applied.skills) if (s.applied !== true) mismatch.push({ id: s.id, reason: s.reason });
          for (const s of applied.skills) if (s.hashChanged) mismatch.push({ id: s.id, reason: "skill file changed after discovery" });
          if (applied.agent?.applied === false) mismatch.push({ id: applied.agent.id, reason: applied.agent.reason });
          if (cap.mode === "recommend" && (decision.skills.selected.length || decision.agent.selected)) mismatch.push({ reason: "recommend mode: selection not applied" });
          log.event("application", { requestId: ctx.requestId, mode: cap.mode, support, skills: applied.skills, agent: applied.agent, mismatch });
        }
        const notice = capabilityNotice(decision, cap.mode);
        c.previous = decision;
        c.last = { promptHash: ctx.promptHash, messageCount: ctx.messageCount, requestId: ctx.retryOf ?? ctx.requestId, attempt: ctx.attempt, decision, notice };
        c.turnRequest = ctx.requestId;
        requestPrompt.set(ctx.requestId, { key: `${ctx.promptHash}:${ctx.messageCount}`, conversationId: ctx.conversationId });
        if (requestPrompt.size > 200) requestPrompt.delete(requestPrompt.keys().next().value);
        return { notice, decision, applied };
      } catch (error) {
        log.event("error", { requestId: ctx.requestId, stage: "capability-finalize", message: String(error.message).slice(0, 500) });
        return { notice: "" };
      }
    },

    /** Records a request that failed before a decision (hold, routing error). */
    fail(ctx, stage, error) {
      if (!ctx) return;
      log.event("request", { requestId: ctx.requestId, conversationId: ctx.conversationId, sessionId: ctx.sessionId, attempt: ctx.attempt,
        retryOf: ctx.retryOf, cli, host: hostRecord(), cwd, mode: cap.mode, routerVersion: ROUTER_VERSION, input: inputRecord(ctx.prompt) });
      log.event("error", { requestId: ctx.requestId, stage, hold: !!error?.routingHold, message: String(error?.message ?? error).slice(0, 500) });
      const c = convo(ctx.conversationId);
      // A later identical request is linked as a retry of this one, but decided afresh.
      c.last = { promptHash: ctx.promptHash, messageCount: ctx.messageCount, requestId: ctx.retryOf ?? ctx.requestId, attempt: ctx.attempt, decision: null, notice: "" };
    },

    /** Re-applies recorded injections to every routed request of the conversation. */
    inject(body, conversationId) {
      if (cap.mode !== "apply") return 0;
      const c = conversations.get(conversationId);
      if (!c) return 0;
      return cli === "codex" ? injectCodex(body, c.injections) : injectClaude(body, c.injections);
    },

    /** Logs Agent/Skill tool calls and their results once each (Claude request history). */
    observe(body, conversationId) {
      if (cli !== "claude") return;
      const c = conversations.get(conversationId);
      if (!c?.turnRequest) return;
      const { calls, results } = observeClaudeTools(body);
      for (const call of calls) {
        if (c.seenTools.has(`call:${call.toolUseId}`)) continue;
        c.seenTools.add(`call:${call.toolUseId}`);
        log.event("tool_observed", { requestId: c.turnRequest, conversationId, ...call });
      }
      for (const result of results) {
        if (!c.seenTools.has(`call:${result.toolUseId}`) || c.seenTools.has(`result:${result.toolUseId}`)) continue;
        c.seenTools.add(`result:${result.toolUseId}`);
        log.event("tool_result", { requestId: c.turnRequest, conversationId, ...result });
      }
      if (c.seenTools.size > 2000) c.seenTools = new Set([...c.seenTools].slice(-1000));
    },

    served(requestId, { status, model }) {
      const origin = requestPrompt.get(requestId);
      if (origin && !(status >= 200 && status < 300)) {
        failedRecent.set(origin.key, { at: now(), conversationId: origin.conversationId });
        if (failedRecent.size > 100) failedRecent.delete(failedRecent.keys().next().value);
      }
      log.event(status >= 200 && status < 300 ? "served" : "error", status >= 200 && status < 300
        ? { requestId, status, model: model ?? null }
        : { requestId, stage: "upstream", status, message: `upstream HTTP ${status}` });
    },
  };
}
