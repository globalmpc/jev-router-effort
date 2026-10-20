import { homedir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { taskProfile } from '../../src/evidence-policy.mjs';
import { claimsComplete, destructiveKinds, externalKinds, isOrcaDispatch, isSyntheticUserText, isTestCommand, parseTestOutput, reactionCandidate } from './signals.mjs';
import { claudeRoots, discoverClaude, parseClaudeFile } from './sources/claude.mjs';
import { codexRoots, discoverCodex, parseCodexFile } from './sources/codex.mjs';
import { antigravityRoot, discoverAntigravity, parseAntigravityFile } from './sources/antigravity.mjs';
import { jevPaths, promptKey, readAudit, readRuntimeEvents, readStatusDecisions } from './sources/jev.mjs';
import { HOUR, redactId, sha } from './util.mjs';

// Router self-traffic: image-description helper calls and connectivity/latency probes.
const JEV_HELPER = /^Describe (this|each) image factually in/i;
const PROBE = /^(reply with (exactly )?the (single )?word\b.*|say (ok|hi)( in two words)?|routing test|line one\. line two: reply with the single word \w+|hi|ping|what is \d+\s*[-+*\/]\s*\d+\? reply with the number only\.?|use your directory listing tool on the current directory, then reply with the number of files only)\.?$/i;
// Benchmark prompts that point into a jev-router session scratchpad (router development traffic).
const BENCH = /\/private\/tmp\/claude-\d+\/-[^/\s]*jev-router[^/\s]*\/[^/\s]+\/scratchpad(\/|$|\s)/;

export const BANDS =[[0, 24, '0-24h'], [24, 48, '24-48h']];

export function bandOf(lastAt, now) {
  const age = (now - lastAt) / HOUR;
  return BANDS.find(([lo, hi]) => age >= lo && age < hi)?.[2] ?? null;
}

/** Merge files that describe the same (cli, sessionId); drop duplicated events. */
export function dedupeSessions(sessions) {
  const byKey = new Map();
  let merged = 0;
  for (const s of sessions) {
    const key = `${s.cli}:${s.sessionId}`;
    const prev = byKey.get(key);
    if (!prev) { byKey.set(key, { ...s, key, events: [...s.events] }); continue; }
    merged++;
    prev.files.push(...s.files);
    prev.events.push(...s.events);
    prev.parseErrors += s.parseErrors;
    prev.cwd ??= s.cwd;
  }
  let droppedEvents = 0;
  for (const s of byKey.values()) {
    const seen = new Set();
    const kept = [];
    for (const e of s.events.sort((a, b) => (a.at || 0) - (b.at || 0))) {
      const id = sha(`${e.type}|${e.at}|${e.text ?? ''}|${e.cmd ?? ''}|${e.path ?? ''}`);
      if (seen.has(id)) { droppedEvents++; continue; }
      seen.add(id);
      kept.push(e);
    }
    s.events = kept;
  }
  return { sessions: [...byKey.values()], mergedFiles: merged, droppedEvents };
}

function topDir(path, cwd) {
  if (!path) return null;
  const rel = cwd && path.startsWith(cwd) ? relative(cwd, path) : path;
  const parts = rel.split(sep).filter(Boolean);
  return parts.length > 1 ? parts.slice(0, Math.min(2, parts.length - 1)).join('/') : '.';
}

/** Derive reviewable facts from a session's events up to `now`. */
export function summarize(session, { now, windowStart, jev }) {
  const events = session.events.filter(e => !Number.isFinite(e.at) || e.at <= now);
  const timed = events.filter(e => Number.isFinite(e.at));
  const firstAt = timed.length ? Math.min(...timed.map(e => e.at)) : NaN;
  const lastAt = timed.length ? Math.max(...timed.map(e => e.at)) : NaN;
  const users = events.filter(e => e.type === 'user' && !isSyntheticUserText(e.text) && !e.sidechain);
  const assistants = events.filter(e => e.type === 'assistant');
  const commands = events.filter(e => e.type === 'command');
  const edits = events.filter(e => e.type === 'edit');

  const exclusion = !timed.length ? (session.events.some(e => e.at > now) ? 'started-after-now' : 'no-timestamps')
    : lastAt < windowStart ? 'no-activity-in-window'
      : session.kind === 'subagent' ? 'subagent-without-human-message'
        : !users.length ? 'no-user-message'
        : !assistants.length && !commands.length ? 'no-assistant-turn'
          : users.length === 1 && !commands.length && JEV_HELPER.test(users[0].text) ? 'jev-internal-helper'
            : users.every(u => PROBE.test(u.text.trim())) ? 'probe-prompt'
              : BENCH.test(users[0].text) || BENCH.test(session.cwd ?? '') ? 'router-bench-traffic'
              : null;

  const models = new Map();
  for (const a of assistants) {
    if (!a.model || a.model === '<synthetic>') continue;
    const k = `${a.model}|${a.effort ?? 'unknown'}`;
    const m = models.get(k) ?? { model: a.model, effort: a.effort ?? null, turns: 0, source: a.modelSource ?? `${session.cli}.transcript` };
    m.turns++;
    models.set(k, m);
  }

  let routing = 'not-observed';
  const linked = [];
  if (session.cli === 'claude') {
    const own = jev.decisions.filter(d => d.cli === 'claude' && d.key === session.sessionId);
    linked.push(...own.map(d => ({ ...d, link: 'status-file-session-id' })));
    if (own.length || events.some(e => e.type === 'notice')) routing = 'jev-routed';
    else if (jev.manual.some(m => m.key === session.sessionId)) routing = 'jev-manual';
  } else {
    const prompts = new Set(users.map(u => promptKey(u.text)));
    const own = jev.decisions.filter(d => d.cli === session.cli && d.promptKey && prompts.has(d.promptKey)
      && Number.isFinite(d.at) && d.at >= firstAt - HOUR && d.at <= lastAt + HOUR);
    linked.push(...own.map(d => ({ ...d, link: 'status-history-prompt-match' })));
    const notices = events.filter(e => e.type === 'notice');
    const jevTurns = events.filter(e => e.type === 'turn' && e.requestedModel === 'jev-router');
    if (notices.length || jevTurns.length || own.length) routing = 'jev-routed';
    else if (session.provider === 'jev') routing = 'jev-manual';
    else if (session.cli === 'codex') routing = 'not-routed';
  }

  const cmdFacts = commands.map(c => {
    const test = isTestCommand(c.cmd) ? parseTestOutput(c.output) : null;
    // A runner summary that contradicts a non-zero exit (e.g. "Build complete!" then exit 1) proves nothing.
    if (test && test.verdict === 'pass' && Number.isInteger(c.exitCode) && c.exitCode !== 0) test.verdict = 'unknown';
    return {
      ref: c.ref, resultRef: c.resultRef ?? null, at: c.at, cmd: c.cmd, exitCode: c.exitCode, exitSource: c.exitSource,
      model: c.model ?? 'unknown', effort: c.effort ?? null,
      isError: Boolean(c.isError), test: test ? { ...test, runnerVerdict: test.verdict } : null,
      destructive: destructiveKinds(c.cmd), external: externalKinds(c.cmd), output: c.output ?? null,
    };
  });
  const testRuns = cmdFacts.filter(c => c.test);
  const lastEditAt = edits.length ? Math.max(...edits.map(e => e.at || 0)) : null;
  const objective = users[0]?.text ?? '';
  const profile = taskProfile(objective);
  // The model/effort that produced the work a follow-up reacts to: assistant turns since the
  // previous human message. Attribution for a label comes from here, not the session majority.
  const followUps = users.slice(1).map((u, i) => {
    const prev = users[i];
    const seen = new Map();
    for (const a of assistants) {
      if (a.at < prev.at || a.at > u.at || !a.model || a.model === '<synthetic>') continue;
      const k = `${a.model}|${a.effort ?? 'unknown'}`;
      seen.set(k, (seen.get(k) ?? 0) + 1);
    }
    const priorModels = [...seen].sort((a, b) => b[1] - a[1]).map(([k, turns]) => ({ model: k.split('|')[0], effort: k.split('|')[1] === 'unknown' ? null : k.split('|')[1], turns }));
    return { ref: u.ref, at: u.at, text: u.text, reaction: reactionCandidate(u.text), priorModels };
  });
  const lastAssistant = assistants.at(-1);
  const dirs = new Set(edits.map(e => topDir(e.path, session.cwd)).filter(Boolean));

  return {
    key: session.key,
    evidenceId: redactId(session.key),
    cli: session.cli,
    sessionId: session.sessionId,
    kind: session.kind,
    parentId: session.parentId ?? null,
    account: session.account === 'default' ? 'default' : redactId(session.account, 'acct'),
    files: session.files,
    cwd: session.cwd,
    cliVersion: session.cliVersion,
    entrypoint: session.entrypoint,
    openedVia: session.openedVia ?? null,
    parseErrors: session.parseErrors,
    firstAt, lastAt,
    band: Number.isFinite(lastAt) ? bandOf(lastAt, now) : null,
    exclusion,
    routing,
    orcaDispatched: isOrcaDispatch(objective),
    objective,
    profile,
    userMessages: users.length,
    assistantTurns: assistants.length,
    models: [...models.values()].sort((a, b) => b.turns - a.turns),
    observedModels: session.observedModels ?? [],
    modelEnums: session.modelEnums ?? [],
    jevDecisions: linked.map(({ prompt, ...d }) => d),
    commands: cmdFacts,
    testRuns: testRuns.map(t => ({ ref: t.ref, at: t.at, model: t.model, effort: t.effort, cmd: t.cmd, exitCode: t.exitCode, verdict: t.test.verdict, passed: t.test.passed, failed: t.test.failed, afterLastEdit: lastEditAt === null || t.at >= lastEditAt })),
    destructive: cmdFacts.filter(c => c.destructive.length).map(c => ({ ref: c.ref, resultRef: c.resultRef, kinds: c.destructive, exitCode: c.exitCode, cmd: c.cmd })),
    external: cmdFacts.filter(c => c.external.length).map(c => ({ ref: c.ref, kinds: c.external, cmd: c.cmd })),
    edits: edits.length,
    editDirs: [...dirs],
    delegations: events.filter(e => e.type === 'delegate').length,
    children: session.children ?? [],
    aborted: events.filter(e => e.type === 'aborted').length,
    followUps,
    lastAssistant: lastAssistant ? { ref: lastAssistant.ref, text: lastAssistant.text, claimsComplete: claimsComplete(lastAssistant.text) } : null,
  };
}

export function defaultSources(home = homedir()) {
  return {
    claudeRoots: claudeRoots(home),
    codexRoots: codexRoots(home),
    antigravityRoot: antigravityRoot(home),
    jev: jevPaths(home),
  };
}

/** Discover, parse, dedupe and summarize every session with activity since `sinceMs`. */
export function collect({ now, windowMs, sources = defaultSources(), cacheDir, fileMtimeSlackMs = 0, keepRawFor = [] }) {
  const windowStart = now - windowMs;
  const since = windowStart - fileMtimeSlackMs;
  const inventory = { sources: [], missing: [] };
  const parsed = [];

  const claudeFiles = discoverClaude(sources.claudeRoots, since);
  inventory.sources.push({ cli: 'claude', roots: sources.claudeRoots.length, files: claudeFiles.length });
  for (const { file } of claudeFiles) parsed.push(parseClaudeFile(file));

  const codexFiles = discoverCodex(sources.codexRoots, since);
  inventory.sources.push({ cli: 'codex', roots: sources.codexRoots.length, files: codexFiles.length, accounts: new Set(codexFiles.map(f => f.account)).size });
  for (const { file, account } of codexFiles) parsed.push(parseCodexFile(file, account));

  const agyFiles = discoverAntigravity(sources.antigravityRoot, since);
  inventory.sources.push({ cli: 'antigravity', roots: 1, files: agyFiles.length });
  for (const { file } of agyFiles) parsed.push(parseAntigravityFile(file, { cacheDir }));
  if (!claudeFiles.length) inventory.missing.push('claude: no transcripts in window');
  if (!codexFiles.length) inventory.missing.push('codex: no transcripts in window');
  if (!agyFiles.length) inventory.missing.push('antigravity: no conversations in window');

  const status = readStatusDecisions(sources.jev.statusDir);
  const audit = readAudit(sources.jev.audit);
  const runtimeDecisions = readRuntimeEvents(sources.jev.runtimeDecisions);
  const runtimeFeedback = readRuntimeEvents(sources.jev.runtimeFeedback);
  inventory.jev = {
    statusFiles: status.files,
    statusDecisions: status.decisions.length,
    statusDecisionsInWindow: status.decisions.filter(d => d.at >= windowStart && d.at <= now).length,
    manualStatus: status.manual.length,
    auditRows: audit.length,
    auditRowsInWindow: audit.filter(a => a.at >= windowStart && a.at <= now).length,
    runtimeDecisions: runtimeDecisions.length,
    runtimeFeedback: runtimeFeedback.length,
    note: 'Status files are pruned after 7 days and keep at most 20 decisions per key; Codex/AGY keys are process ids, linked to sessions only by exact prompt match.',
  };
  if (!runtimeDecisions.length) inventory.missing.push('jev runtime decisions.jsonl: absent or empty');

  const { sessions, mergedFiles, droppedEvents } = dedupeSessions(parsed);
  inventory.dedupe = { parsedFiles: parsed.length, distinctSessions: sessions.length, mergedFiles, droppedDuplicateEvents: droppedEvents };

  const jev = { decisions: status.decisions, manual: status.manual };
  const summaries = sessions.map(s => summarize(s, { now, windowStart, jev }));
  // Antigravity subagent conversations are only discoverable from the parent's tool output.
  const childToParent = new Map();
  for (const s of summaries) for (const c of s.children) childToParent.set(`antigravity:${c}`, s.key);
  for (const s of summaries) {
    if (childToParent.has(s.key)) {
      s.kind = 'subagent';
      s.parentKey = childToParent.get(s.key);
      // Its "user" input is the parent agent's prompt, not a person.
      if (!s.exclusion) s.exclusion = 'subagent-without-human-message';
    } else if (s.cli === 'antigravity' && s.kind === 'interactive' && s.userMessages === 1) s.kind = 'single-shot';
    if (s.cli === 'codex' && s.parentId) s.parentKey = `codex:${s.parentId}`;
    if (s.cli === 'claude' && s.parentId) s.parentKey = `claude:${s.parentId}`;
  }
  // Callers may name sessions by key or by redacted evidence id.
  const keep = new Set(keepRawFor);
  const raw = Object.fromEntries(sessions.filter(s => keep.has(s.key) || keep.has(redactId(s.key))).map(s => [s.key, s.events.filter(e => !Number.isFinite(e.at) || e.at <= now)]));
  return { inventory, sessions: summaries, windowStart, now, audit, runtimeFeedback, raw };
}
