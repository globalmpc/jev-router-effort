// Korean keywords are written as \u escapes so the source stays English-only.
// Skill and agent routing: catalog discovery, candidate shortlisting, selection and
// request-body application. Discovery reads metadata and hashes only; skill bodies are read
// at application time for the selected skill, never sent to the classifier.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { choice } from "@typesafe-ai/sdk";

export const CAPABILITY_POLICY_VERSION = "capability-v1";
export const CAPABILITY_MODES = ["off", "log", "recommend", "apply"];
export const MARKER = "<jev-routing-capabilities";

/** Selection thresholds. Classifier confidence is not a task-success probability. */
export const CAPABILITY_THRESHOLDS = {
  selectMin: 0.5,
  ambiguousSecond: 0.3,
  ambiguousGap: 0.15,
  shortlistSkills: 6,
  shortlistAgents: 4,
  minScore: 3,
  maxSkillBytes: 24000,
  continuationChars: 80,
};

/**
 * Department prefixes identify ownership in a name (`hr-write-jd`). The prompt's folder is
 * context only; a JD request from any folder can still reach an accessible `hr-` skill.
 * Aliases are deliberately few; extend them in runtime config, not by guessing here.
 */
export const DEFAULT_DEPARTMENTS = {
  hr: ["hr", "\uC778\uC0AC", "\uCC44\uC6A9", "jd", "\uC9C1\uBB34\uAE30\uC220\uC11C", "pip"],
};

const sha256 = (text) => createHash("sha256").update(text).digest("hex");

export function capabilityConfig(config = {}) {
  const raw = config?.capabilityRouting ?? {};
  const mode = config?.enabled && CAPABILITY_MODES.includes(raw.mode) ? raw.mode : "off";
  return {
    mode,
    clis: Array.isArray(raw.clis) ? raw.clis : ["claude", "codex"],
    departments: { ...DEFAULT_DEPARTMENTS, ...(raw.departments ?? {}) },
    requiredSkills: Array.isArray(raw.requiredSkills) ? raw.requiredSkills : [],
    excludeSkills: Array.isArray(raw.excludeSkills) ? raw.excludeSkills : [],
    excludeAgents: Array.isArray(raw.excludeAgents) ? raw.excludeAgents : [],
    roots: raw.roots ?? null,
    retentionDays: Number.isInteger(raw.retentionDays) && raw.retentionDays > 0 ? raw.retentionDays : 30,
    dataset: raw.dataset === "regression" ? "regression" : "live",
  };
}

/** Minimal YAML front matter reader: scalar keys plus folded/literal blocks. */
export function parseFrontMatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match) return {};
  const out = {};
  const lines = match[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    let value = kv[2].trim();
    if (/^[>|][-+]?$/.test(value)) {
      const block = [];
      while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]) || lines[i + 1].trim() === "")) block.push(lines[++i].trim());
      value = block.join(value.startsWith(">") ? " " : "\n").trim();
    } else if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1);
    if (!(kv[1] in out)) out[kv[1]] = value;
  }
  return out;
}

function parseToml(text) {
  const field = (name) => {
    const triple = new RegExp(`^${name}\\s*=\\s*"""([\\s\\S]*?)"""`, "m").exec(text);
    if (triple) return triple[1].trim();
    return new RegExp(`^${name}\\s*=\\s*"((?:[^"\\\\]|\\\\.)*)"`, "m").exec(text)?.[1] ?? null;
  };
  return { name: field("name"), description: field("description"), model: field("model"), model_reasoning_effort: field("model_reasoning_effort") };
}

/** Where each CLI natively loads skills and agents. Tests and config may replace these. */
export function defaultRoots(cli, cwd = process.cwd(), home = homedir()) {
  if (cli === "claude") {
    return {
      skills: [{ dir: join(home, ".claude/skills"), scope: "user" }, { dir: join(cwd, ".claude/skills"), scope: "project" }],
      agents: [{ dir: join(home, ".claude/agents"), scope: "user", format: "md" }, { dir: join(cwd, ".claude/agents"), scope: "project", format: "md" }],
    };
  }
  if (cli === "codex") {
    return {
      skills: [
        { dir: join(home, ".codex/skills"), scope: "user" },
        { dir: join(home, ".agents/skills"), scope: "user-agents" },
        { dir: join(cwd, ".agents/skills"), scope: "project" },
      ],
      agents: [{ dir: join(home, ".codex/agents"), scope: "user", format: "toml" }],
    };
  }
  return { skills: [], agents: [] };
}

const departmentOf = (name, departments) => {
  const prefix = /^([a-z]+)-/.exec(name)?.[1];
  return prefix && prefix in departments ? prefix : null;
};

function readCandidate({ kind, cli, file, scope, format, departments, exclude }) {
  let realPath;
  let text;
  try {
    realPath = realpathSync(file);
    text = readFileSync(realPath, "utf8");
  } catch {
    return null;
  }
  const meta = format === "toml" ? parseToml(text) : parseFrontMatter(text);
  const fallbackName = kind === "skill" ? basename(file.replace(/\/SKILL\.md$/, "")) : basename(file).replace(/\.(md|toml)$/, "");
  const name = String(meta.name || fallbackName).trim();
  const description = String(meta.description ?? meta.summary ?? "").replace(/\s+/g, " ").trim();
  const hash = sha256(text);
  const ineligible = [];
  if (/^true$/i.test(String(meta["disable-model-invocation"] ?? ""))) ineligible.push("model invocation disabled by definition");
  if (/(?:^|-)(?:archived|deprecated)(?:-|$)/.test(name)) ineligible.push("archived or deprecated name");
  if (exclude.includes(name)) ineligible.push("excluded by runtime config");
  if (!description) ineligible.push("no description");
  return {
    kind, cli, name, scope, description: description.slice(0, 600),
    summary: meta.summary ? String(meta.summary).slice(0, 200) : null,
    exclusions: meta.not_for ?? meta.exclude ?? null,
    department: departmentOf(name, departments),
    version: meta.version ?? null,
    model: meta.model ?? null,
    effort: meta.effort ?? meta.model_reasoning_effort ?? null,
    path: realPath, sourcePath: file, hash,
    id: `${kind}:${cli}:${scope}:${name}#${hash.slice(0, 12)}`,
    autoEligible: ineligible.length === 0,
    ineligible,
  };
}

/** Lists actually installed skills/agents for one CLI. Missing directories are skipped. */
export function discoverCatalog({ cli, cwd = process.cwd(), home = homedir(), config = {} } = {}) {
  const cap = capabilityConfig({ enabled: true, capabilityRouting: config.capabilityRouting ?? config });
  const roots = cap.roots?.[cli] ?? defaultRoots(cli, cwd, home);
  const seen = new Set();
  const items = [];
  const push = (candidate) => {
    if (!candidate) return;
    const key = `${candidate.kind}:${candidate.path}`;
    if (seen.has(key)) return; // one file linked from several roots is one candidate
    seen.add(key);
    items.push(candidate);
  };
  for (const { dir, scope } of roots.skills ?? []) {
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir).sort()) {
      if (entry.startsWith(".")) continue;
      const file = join(dir, entry, "SKILL.md");
      if (existsSync(file)) push(readCandidate({ kind: "skill", cli, file, scope, departments: cap.departments, exclude: cap.excludeSkills }));
    }
  }
  for (const { dir, scope, format = "md" } of roots.agents ?? []) {
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir).sort()) {
      if (entry.startsWith(".") || !entry.endsWith(`.${format}`)) continue;
      const file = join(dir, entry);
      try { if (!statSync(file).isFile()) continue; } catch { continue; }
      push(readCandidate({ kind: "agent", cli, file, scope, format, departments: cap.departments, exclude: cap.excludeAgents }));
    }
  }
  const skills = items.filter((c) => c.kind === "skill");
  const agents = items.filter((c) => c.kind === "agent");
  const hash = sha256(items.map((c) => c.id).sort().join("\n")).slice(0, 16);
  return { cli, hash, skills, agents, discoveredAt: new Date().toISOString() };
}

const STOP = new Set(["the", "and", "for", "with", "this", "that", "from", "into", "use", "when", "user", "skill", "skills", "agent", "agents",
  "\uD55C\uB2E4", "\uC788\uB2E4", "\uD558\uB294", "\uC704\uD55C", "\uC0AC\uC6A9", "\uC2A4\uD0AC", "\uC5D0\uC774\uC804\uD2B8", "\uD2B8\uB9AC\uAC70", "\uACBD\uC6B0", "\uC788\uB294", "\uC5C6\uB294", "\uADF8\uB9AC\uACE0", "\uB610\uB294", "\uC5D0\uC11C", "\uC73C\uB85C",
  "\uB9CC\uB4E4", "\uB9CC\uB4E4\uC5B4", "\uB9CC\uB4E4\uC5B4\uC918", "\uD574\uC918", "\uC791\uC131", "\uC791\uC131\uD574", "\uC791\uC131\uD55C\uB2E4", "\uC694\uCCAD", "\uC2E4\uD589", "\uD655\uC778", "\uD544\uC694", "\uC815\uB9AC", "\uB2E4\uC74C"]);
const PARTICLE = /(?:\uC73C\uB85C|\uC5D0\uC11C|\uC5D0\uAC8C|\uD558\uACE0|\uD55C\uB2E4|\uD558\uB2E4|\uD588\uB2E4|\uD569\uB2C8\uB2E4|\uC744|\uB97C|\uC774|\uAC00|\uC740|\uB294|\uC758|\uB85C|\uC5D0|\uC640|\uACFC|\uB3C4)$/;
// Split "JD" + Korean subject particle into "jd" and the particle: Korean particles attach directly to Latin words.
const words = (text) => (String(text).toLowerCase()
  .replace(/([a-z0-9])([\uac00-\ud7a3])/g, "$1 $2").replace(/([\uac00-\ud7a3])([a-z0-9])/g, "$1 $2")
  .match(/[\p{L}\p{N}]+/gu) ?? []);
const stem = (word) => (/[\uAC00-\uD7A3]/.test(word) && word.length > 2 ? word.replace(PARTICLE, "") : word);
const meaningful = (word) => !STOP.has(word) && (/[\uAC00-\uD7A3]/.test(word) ? word.length >= 2 : word.length >= 3 || /^[a-z]{2}$/.test(word));

/** Lexical evidence that a candidate is relevant. It only shortlists; it never selects. */
export function candidateScore(prompt, candidate, departments = DEFAULT_DEPARTMENTS) {
  const text = String(prompt).toLowerCase();
  const promptWords = new Set(words(text));
  const has = (w) => (/[\uAC00-\uD7A3]/.test(w) ? text.includes(w) : promptWords.has(w));
  let score = 0;
  const hits = [];
  for (const part of candidate.name.split("-")) {
    if (meaningful(part) && part !== candidate.department && has(part)) { score += 3; hits.push(part); }
  }
  const dept = candidate.department;
  if (dept && (departments[dept] ?? [dept]).some((alias) => has(alias.toLowerCase()))) { score += 3; hits.push(`dept:${dept}`); }
  const [body, trigger = ""] = candidate.description.split(/\uD2B8\uB9AC\uAC70|trigger(?:s)?\s*[:=-]|use when/i);
  const counted = new Set();
  for (const [source, weight] of [[trigger, 2], [body, 1]]) {
    for (const raw of words(source)) {
      const w = stem(raw);
      if (!meaningful(w) || counted.has(w) || !has(w)) continue;
      counted.add(w);
      score += weight;
      hits.push(w);
    }
  }
  return { score, hits: hits.slice(0, 8) };
}

export function shortlist(prompt, list, { limit, minScore = CAPABILITY_THRESHOLDS.minScore, departments } = {}) {
  return list.filter((c) => c.autoEligible)
    .map((c) => ({ candidate: c, ...candidateScore(prompt, c, departments) }))
    .filter((x) => x.score >= minScore)
    .sort((a, b) => b.score - a.score || a.candidate.name.localeCompare(b.candidate.name))
    .slice(0, limit);
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Names the user requested explicitly; plain topical mentions are not requests. */
export function explicitMentions(prompt, list, kind) {
  const text = String(prompt);
  const noun = kind === "skill" ? "(?:\uC2A4\uD0AC|skill)" : "(?:\uC11C\uBE0C\\s*\uC5D0\uC774\uC804\uD2B8|\uC5D0\uC774\uC804\uD2B8|sub-?agent|agent)";
  const sigil = kind === "skill" ? "[/$]" : "@(?:agent-)?";
  const names = [...new Set(list.map((c) => c.name))];
  return names.filter((name) => {
    const n = escape(name);
    return new RegExp(`(?:^|[\\s(\\[\`'"])${sigil}${n}(?![\\w-])`, "i").test(text)
      || new RegExp(`(?<![\\w-])\`?${n}\`?\\s*(?:\uC744|\uB97C|\uC73C\uB85C|\uB85C)?\\s*${noun}`, "i").test(text)
      || new RegExp(`${noun}\\s*[:=]?\\s*\`?${n}\`?(?![\\w-])`, "i").test(text);
  });
}

export function optedOut(prompt, kind) {
  const text = String(prompt);
  return kind === "skill"
    ? /\uC2A4\uD0AC\s*(?:\uC5C6\uC774|\uC740\s*\uBE7C\uACE0|\uC4F0\uC9C0\s*\uB9D0|\uC0AC\uC6A9\uD558\uC9C0\s*\uB9D0)|without\s+(?:any\s+|a\s+)?skills?\b|\bno\s+skills?\b|don'?t\s+use\s+(?:any\s+|a\s+)?skills?\b/i.test(text)
    : /(?:\uC5D0\uC774\uC804\uD2B8|\uC704\uC784)\s*(?:\uC5C6\uC774|\uC4F0\uC9C0\s*\uB9D0|\uBD80\uB974\uC9C0\s*\uB9D0|\uD558\uC9C0\s*\uB9D0)|\uC704\uC784\uD558\uC9C0\s*\uB9D0|without\s+(?:any\s+|a\s+)?(?:sub-?)?agents?\b|\bno\s+(?:sub-?)?agents?\b|don'?t\s+(?:delegate|use\s+(?:any\s+|a\s+)?(?:sub-?)?agents?)\b/i.test(text);
}

const NONE_SKILL = "Use no skill. The request is a general question, explanation or task that none of the listed skills is designed for.";
const NONE_AGENT = "Use no agent. The main assistant handles it directly; simple explanations, quick edits and single-step work need no delegation.";

/** Choice questions over the shortlist plus an explicit "none". Metadata only. */
export function capabilityQuestions({ skills = [], agents = [] }) {
  const criteria = (list, none) => ({
    none,
    ...Object.fromEntries(list.map(({ candidate: c }) => [c.name, { name: c.name, description: c.description.slice(0, 400), ...(c.department ? { department: c.department } : {}) }])),
  });
  const questions = {};
  if (skills.length) {
    questions.skill = choice([
      "Pick the one skill whose documented purpose matches this request, or none.",
      "A skill name prefix is its department. The working folder is context, not a restriction.",
      "Choose none when the request only resembles a skill's topic but does not ask for its output.",
    ], criteria(skills, NONE_SKILL));
  }
  if (agents.length) {
    questions.agent = choice([
      "Decide whether this request should be delegated to one specialised agent, or handled directly (none).",
      "Delegate only when the agent's documented job is the requested work. Prefer none for explanations and small tasks.",
    ], criteria(agents, NONE_AGENT));
  }
  return questions;
}

const pick = (c) => ({ id: c.id, name: c.name, path: c.path, hash: c.hash, scope: c.scope, model: c.model ?? null, effort: c.effort ?? null });

function judge(answer, shortlisted, kind) {
  if (!shortlisted.length) return { selected: [], needed: false, reason: "no-candidate", confidence: null };
  if (!answer?.choice) return { selected: [], needed: null, reason: "jev-unavailable", confidence: null };
  const probs = Object.entries(answer.probabilities ?? {}).filter(([k]) => k !== "none").sort((a, b) => b[1] - a[1]);
  const top = { choice: answer.choice, confidence: answer.confidence ?? null, probabilities: Object.fromEntries(Object.entries(answer.probabilities ?? {}).map(([k, v]) => [k, Number(v.toFixed?.(4) ?? v)])) };
  if (answer.choice === "none") return { selected: [], needed: false, reason: "jev-none", ...top };
  const [first, second] = probs;
  if (second && second[1] >= CAPABILITY_THRESHOLDS.ambiguousSecond && first[1] - second[1] < CAPABILITY_THRESHOLDS.ambiguousGap) {
    return { selected: [], needed: true, reason: "ambiguous", needsConfirmation: true, alternatives: [first[0], second[0]], ...top };
  }
  if ((answer.confidence ?? 0) < CAPABILITY_THRESHOLDS.selectMin) return { selected: [], needed: null, reason: "low-confidence", ...top };
  const found = shortlisted.find((s) => s.candidate.name === answer.choice)?.candidate;
  if (!found) return { selected: [], needed: null, reason: "jev-unknown-choice", ...top };
  return { selected: [{ ...pick(found), source: "jev" }], needed: true, reason: "jev", ...top };
}

function resolveNames(names, list, kind, conflicts) {
  const out = [];
  for (const name of names) {
    const matches = list.filter((c) => c.name === name);
    const hashes = new Set(matches.map((c) => c.hash));
    if (hashes.size > 1) {
      conflicts.push({ kind, name, type: "duplicate-name", candidates: matches.map(pick) });
      continue;
    }
    if (matches.length) out.push(matches[0]);
  }
  return out;
}

/**
 * Turns explicit requests, required rules, classifier answers and prior context into one
 * independent decision per dimension. Pure: no I/O.
 */
export function decideCapabilities({ prompt, catalog, shortlisted = { skills: [], agents: [] }, answers = null, config = {}, previous = null, newTask = false }) {
  const cap = capabilityConfig({ enabled: true, capabilityRouting: config.capabilityRouting ?? config });
  const conflicts = [];
  const uncertainty = [];
  const result = {};
  for (const kind of ["skill", "agent"]) {
    const list = kind === "skill" ? catalog.skills : catalog.agents;
    const short = kind === "skill" ? shortlisted.skills : shortlisted.agents;
    const optOut = optedOut(prompt, kind);
    const explicitNames = explicitMentions(prompt, list, kind);
    const explicit = resolveNames(explicitNames, list, kind, conflicts);
    let decision;
    if (explicit.length) {
      decision = { selected: explicit.map((c) => ({ ...pick(c), source: "explicit" })), needed: true, reason: "explicit", confidence: null, manual: true };
      if (kind === "agent" && explicit.length > 1) {
        decision = { selected: [], needed: true, reason: "ambiguous", needsConfirmation: true, alternatives: explicit.map((c) => c.name), manual: true };
      }
    } else if (conflicts.some((c) => c.kind === kind && c.type === "duplicate-name")) {
      decision = { selected: [], needed: true, reason: "duplicate-name", needsConfirmation: true, manual: true };
    } else if (optOut) {
      decision = { selected: [], needed: false, reason: "explicit-none", confidence: null, manual: true };
    } else {
      decision = judge(answers?.[kind], short, kind);
      const carry = kind === "skill" && !newTask && !short.length && previous?.skills?.selected?.length
        && String(prompt).trim().length <= CAPABILITY_THRESHOLDS.continuationChars;
      if (carry) {
        decision = { selected: previous.skills.selected.map((s) => ({ ...s, source: "context" })), needed: true, reason: "previous-context", confidence: null };
      }
    }
    if (kind === "skill") {
      for (const rule of cap.requiredSkills) {
        let matches = false;
        try { matches = new RegExp(rule.pattern, "i").test(prompt); } catch { conflicts.push({ kind, type: "invalid-required-rule", rule: rule.id ?? null }); }
        if (!matches) continue;
        const target = list.find((c) => c.name === rule.skill);
        if (!target) { conflicts.push({ kind, type: "required-unavailable", rule: rule.id ?? null, skill: rule.skill }); continue; }
        if (optOut) { conflicts.push({ kind, type: "required-vs-explicit-none", rule: rule.id ?? null, skill: rule.skill, resolution: "explicit choice respected" }); continue; }
        if (!decision.selected.some((s) => s.name === rule.skill)) {
          decision = { ...decision, selected: [...decision.selected, { ...pick(target), source: "required", rule: rule.id ?? null }], needed: true,
            reason: decision.selected.length ? `${decision.reason}+required` : "required" };
        }
      }
    }
    if (decision.needsConfirmation) uncertainty.push(`${kind}: ${decision.reason}`);
    if (["low-confidence", "jev-unavailable", "jev-unknown-choice"].includes(decision.reason)) uncertainty.push(`${kind}: ${decision.reason}; kept existing handling`);
    result[kind === "skill" ? "skills" : "agent"] = decision;
  }
  const agent = result.agent;
  return {
    version: CAPABILITY_POLICY_VERSION,
    skills: result.skills,
    agent: { ...agent, selected: agent.selected[0] ?? null },
    conflicts,
    uncertainty,
    needsConfirmation: !!(result.skills.needsConfirmation || agent.needsConfirmation),
  };
}

/** Short notice fragment for the routed turn, or "" when nothing to say. */
export function capabilityNotice(decision, mode) {
  if (!decision) return "";
  const parts = [];
  const s = decision.skills;
  if (s.selected.length) parts.push(`skill ${s.selected.map((x) => x.name).join("+")}${mode === "apply" ? "" : " (recommended)"}`);
  else if (s.needsConfirmation) parts.push(`skill unclear: ${(s.alternatives ?? []).join(" | ") || s.reason}; name one to apply`);
  const a = decision.agent;
  if (a.selected) parts.push(`agent ${a.selected.name} (recommended)`);
  else if (a.needsConfirmation) parts.push(`agent unclear: ${(a.alternatives ?? []).join(" | ") || a.reason}`);
  if (decision.conflicts.length) parts.push(`conflict: ${decision.conflicts.map((c) => c.type).join(", ")}`);
  return parts.join("; ");
}

/**
 * Builds the text placed in the user's turn. Re-reads each selected skill and records
 * whether its content still matches the hash chosen during discovery.
 */
export function buildInstruction(decision, { mode, cli, agentSupport, readFile = (p) => readFileSync(p, "utf8"), maxSkillBytes = CAPABILITY_THRESHOLDS.maxSkillBytes } = {}) {
  const applied = { skills: [], agent: null };
  if (mode !== "apply" || !decision) return { text: null, applied };
  const blocks = [];
  for (const skill of decision.skills.selected) {
    let content;
    try { content = readFile(skill.path); } catch (error) {
      applied.skills.push({ id: skill.id, applied: false, reason: `unreadable: ${error.code ?? error.message}` });
      continue;
    }
    const hashAtApplication = sha256(content);
    const truncated = Buffer.byteLength(content) > maxSkillBytes;
    const body = truncated ? Buffer.from(content).subarray(0, maxSkillBytes).toString("utf8") : content;
    blocks.push(`<skill name="${skill.name}" source="${skill.path}" sha256="${hashAtApplication}"${truncated ? ' truncated="true"' : ""}>\n${body}\n</skill>${truncated ? `\nThe skill file is longer than this excerpt; read ${skill.path} before relying on omitted sections.` : ""}`);
    applied.skills.push({ id: skill.id, applied: true, bytes: Buffer.byteLength(body), truncated, hashAtSelection: skill.hash, hashAtApplication, hashChanged: hashAtApplication !== skill.hash });
  }
  const agent = decision.agent.selected;
  if (agent) {
    if (agentSupport === "delegate") {
      blocks.push(`JEV routing recommends delegating this request to the \`${agent.name}\` agent (Agent tool, subagent_type "${agent.name}"; definition ${agent.path}). Delegate once, only if the request still fits that agent after you read it; otherwise handle it directly and say why.`);
      applied.agent = { id: agent.id, applied: "recommendation-injected" };
    } else {
      applied.agent = { id: agent.id, applied: false, reason: `${cli} delegation is not supported by this router; recommendation shown only` };
    }
  }
  if (!blocks.length) return { text: null, applied };
  const header = `${MARKER} version="${CAPABILITY_POLICY_VERSION}">\nJEV routing selected the following for this request. It grants no additional permissions. The user's instructions and existing project rules take precedence; report any conflict instead of hiding it.`;
  return { text: `${header}\n${blocks.join("\n\n")}\n</jev-routing-capabilities>`, applied };
}

const promptHash = (text) => sha256(String(text)).slice(0, 24);
export { promptHash };

/** Text of one Claude user message without system reminders, or null for tool results. */
export function claudeMessageText(message) {
  if (message?.role !== "user") return null;
  if (typeof message.content === "string") return message.content.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim() || null;
  if (!Array.isArray(message.content) || message.content.some((b) => b?.type === "tool_result")) return null;
  return message.content.filter((b) => b?.type === "text" && !String(b.text).startsWith(MARKER)).map((b) => b.text).join("\n")
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim() || null;
}

/**
 * Re-applies every recorded injection to its user message so the prompt-cache prefix stays
 * stable across the turn and later turns. Returns the number of messages changed.
 */
export function injectClaude(body, injections) {
  let changed = 0;
  if (!injections?.size || !Array.isArray(body?.messages)) return 0;
  for (const message of body.messages) {
    const text = claudeMessageText(message);
    if (!text) continue;
    const injection = injections.get(promptHash(text));
    if (!injection) continue;
    if (typeof message.content === "string") message.content = [{ type: "text", text: message.content }];
    if (message.content.some((b) => b?.type === "text" && String(b.text).startsWith(MARKER))) continue;
    message.content.push({ type: "text", text: injection });
    changed++;
  }
  return changed;
}

const codexText = (content) => (typeof content === "string" ? content
  : Array.isArray(content) ? content.filter((p) => ["text", "input_text"].includes(p?.type) && !String(p.text).startsWith(MARKER)).map((p) => p.text).join("\n") : "");
const cleanCodex = (text) => text.replace(/<system[-_]reminder>[\s\S]*?<\/system[-_]reminder>/gi, "")
  .replace(/<current_datetime>[\s\S]*?<\/current_datetime>/gi, "").replace(/<environment_context>[\s\S]*?<\/environment_context>/gi, "").trim();

export function injectCodex(body, injections) {
  let changed = 0;
  if (!injections?.size || !Array.isArray(body?.input)) return 0;
  for (const item of body.input) {
    if (item?.role !== "user") continue;
    const text = cleanCodex(codexText(item.content));
    const injection = text && injections.get(promptHash(text));
    if (!injection) continue;
    if (typeof item.content === "string") item.content = [{ type: "input_text", text: item.content }];
    if (!Array.isArray(item.content) || item.content.some((p) => String(p?.text ?? "").startsWith(MARKER))) continue;
    item.content.push({ type: "input_text", text: injection });
    changed++;
  }
  return changed;
}

/** Agent and Skill tool calls and results visible in a Claude request history. */
export function observeClaudeTools(body) {
  const calls = [];
  const results = [];
  for (const message of body?.messages ?? []) {
    if (!Array.isArray(message?.content)) continue;
    for (const block of message.content) {
      if (message.role === "assistant" && block?.type === "tool_use" && ["Agent", "Task", "Skill"].includes(block.name)) {
        calls.push({ toolUseId: block.id, tool: block.name === "Skill" ? "Skill" : "Agent",
          target: block.name === "Skill" ? block.input?.skill ?? block.input?.command ?? null : block.input?.subagent_type ?? null });
      }
      if (message.role === "user" && block?.type === "tool_result") results.push({ toolUseId: block.tool_use_id, isError: block.is_error === true });
    }
  }
  return { calls, results };
}

export function catalogSummary(catalog) {
  const row = (c) => ({ id: c.id, name: c.name, scope: c.scope, department: c.department, autoEligible: c.autoEligible, ineligible: c.ineligible, path: c.path, version: c.version });
  return { cli: catalog.cli, hash: catalog.hash, skills: catalog.skills.map(row), agents: catalog.agents.map(row) };
}
