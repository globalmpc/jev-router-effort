import { TASK_TYPES } from '../../src/evidence-policy.mjs';
import { clip, formatLocal } from './util.mjs';

export const OUTCOMES = ['success', 'failure', 'unknown'];
// Who established the outcome. The assistant's own completion claim is deliberately absent.
export const BASES = ['user', 'qa', 'test', 'none'];

/** Every reference a label may cite, so citations can be checked mechanically. */
export function citableRefs(s) {
  const refs = new Set();
  for (const f of s.followUps) refs.add(f.ref);
  for (const c of s.commands) { refs.add(c.ref); if (c.resultRef) refs.add(c.resultRef); }
  if (s.lastAssistant) refs.add(s.lastAssistant.ref);
  return refs;
}

export function dominantModel(s) {
  const models = s.models.filter(m => m.model !== 'unknown');
  const top = models[0];
  if (!top) {
    // AGY without a JEV notice: fall back to generation-metadata strings when they name one
    // model (a base name plus its effort-suffixed variant counts as one).
    const names = (s.observedModels ?? []).map(m => m.model).sort((a, b) => b.length - a.length);
    if (names.length && names.every(n => names[0].startsWith(n))) return { cli: s.cli, model: names[0], effort: null };
    return { cli: s.cli, model: names.length ? 'mixed' : 'unknown', effort: null };
  }
  const second = models[1];
  const mixed = second && second.model !== top.model && second.turns >= top.turns * 0.5;
  return { cli: s.cli, model: mixed ? 'mixed' : top.model, effort: mixed ? null : top.effort ?? null };
}

/** Human-readable review packet. Private: contains prompt text. */
export function packetMarkdown(s, timeZone) {
  const lines = [];
  lines.push(`# ${s.evidenceId} — ${s.cli} / ${s.kind} / ${s.routing}`);
  lines.push(`key: ${s.key}`);
  lines.push(`window band: ${s.band}; first ${formatLocal(s.firstAt, timeZone)}; last ${formatLocal(s.lastAt, timeZone)}`);
  lines.push(`cwd: ${s.cwd ?? 'unknown'}; version: ${s.cliVersion ?? 'unknown'}; entrypoint: ${s.entrypoint ?? 'unknown'}; orca dispatch: ${s.orcaDispatched}`);
  lines.push(`candidate taskType: ${s.profile.taskType} (signals: ${s.profile.signals.join(', ') || 'none'}; mutating: ${s.profile.mutating})`);
  lines.push('');
  lines.push('## Models observed');
  for (const m of s.models) lines.push(`- ${m.model} effort=${m.effort ?? 'unknown'} turns=${m.turns} source=${m.source}`);
  for (const m of s.observedModels) lines.push(`- (metadata) ${m.model} ×${m.count} source=${m.source}`);
  for (const e of s.modelEnums) lines.push(`- (enum) ${e.value} ×${e.count}`);
  for (const d of s.jevDecisions.slice(0, 10)) lines.push(`- jev ${d.link}: ${d.model} effort=${d.effort ?? 'n/a'} tier=${d.tier} conf=${d.confidence} reason=${d.reason}`);
  lines.push('');
  lines.push('## Objective (first user message)');
  lines.push(clip(s.objective, 1500));
  lines.push('');
  lines.push(`## Follow-ups (${s.followUps.length})`);
  for (const f of s.followUps.slice(0, 40)) {
    const prior = (f.priorModels ?? []).map(m => `${m.model}/${m.effort ?? 'unknown'}×${m.turns}`).join(', ') || 'none';
    lines.push(`- [${f.ref}] (${f.reaction}; after ${prior}) ${clip(f.text, 500)}`);
  }
  lines.push('');
  lines.push(`## Execution: ${s.commands.length} commands, ${s.edits} edits in ${s.editDirs.length} dirs, ${s.delegations} delegations, aborted=${s.aborted}`);
  for (const t of s.testRuns.slice(-12)) lines.push(`- test [${t.ref}] ${clip(t.cmd, 140)} → exit=${t.exitCode ?? 'unknown'} verdict=${t.verdict} pass=${t.passed ?? '?'} fail=${t.failed ?? '?'} afterLastEdit=${t.afterLastEdit}`);
  for (const d of s.destructive) lines.push(`- DESTRUCTIVE [${d.ref}${d.resultRef ? `→${d.resultRef}` : ''}] ${d.kinds.join(', ')}: ${clip(d.cmd, 200)} exit=${d.exitCode ?? 'unknown'}`);
  for (const x of s.external.slice(0, 10)) lines.push(`- external [${x.ref}] ${x.kinds.join(', ')}: ${clip(x.cmd, 160)}`);
  lines.push('');
  lines.push('## Last assistant message');
  if (s.lastAssistant) lines.push(`[${s.lastAssistant.ref}] claimsComplete=${s.lastAssistant.claimsComplete} (not evidence of success)\n${clip(s.lastAssistant.text, 800)}`);
  return lines.join('\n') + '\n';
}

export function labelTemplate(s) {
  return {
    evidenceId: s.evidenceId,
    key: s.key,
    outcome: 'unknown',
    basis: 'none',
    citations: [],
    taskType: s.profile.taskType,
    // Majority attribution is only a placeholder for unknown labels; a known outcome is
    // re-attributed from its cited evidence by deriveEvidence().
    attribution: dominantModel(s),
    notes: '',
    reviewed: false,
  };
}

const modelKey = m => `${m.model}|${m.effort ?? ''}`;

/**
 * Tie a success/failure to the evidence it cites. User/QA outcomes must cite a human follow-up;
 * the model/effort is the one that produced the turns that follow-up reacts to. Test outcomes
 * cite a runner command and take the model/effort that issued it. More than one candidate
 * model/effort, or none, is an error: mixed sessions are never attributed by majority.
 */
export function deriveEvidence(basis, citations, summary) {
  const errors = [];
  const refs = citableRefs(summary);
  const unknownRefs = citations.filter(c => !refs.has(c));
  if (unknownRefs.length) errors.push(`citations not present in the session packet: ${unknownRefs.join(', ')}`);
  let sources = [];
  let times = [];
  if (basis === 'user' || basis === 'qa') {
    const cited = summary.followUps.filter(f => citations.includes(f.ref));
    if (!cited.length) errors.push(`${basis} basis must cite a human follow-up message (assistant text and commands are not ${basis} evidence)`);
    sources = cited.flatMap(f => f.priorModels ?? []);
    times = cited.map(f => f.at);
  } else if (basis === 'test') {
    const cited = summary.testRuns.filter(t => citations.includes(t.ref));
    if (!cited.length) errors.push('test basis must cite a test-runner command');
    sources = cited.map(t => ({ model: t.model, effort: t.effort }));
    times = cited.map(t => t.at);
  } else errors.push('success/failure needs a user, qa or test basis');
  const distinct = [...new Map(sources.filter(m => m.model && m.model !== 'unknown').map(m => [modelKey(m), m])).values()];
  if (!errors.length && distinct.length !== 1) {
    errors.push(distinct.length ? `cited evidence follows more than one model/effort (${distinct.map(modelKey).join(', ')}); outcome is not attributable` : 'cited evidence has no observed model; outcome is not attributable');
  }
  const at = times.filter(Number.isFinite);
  return {
    errors,
    attribution: distinct.length === 1 ? { cli: summary.cli, model: distinct[0].model, effort: distinct[0].effort ?? null } : null,
    evidenceAt: at.length ? Math.max(...at) : null,
  };
}

/** Return a list of problems; an empty list means the label may be counted. */
export function validateLabel(label, summary) {
  const errors = [];
  if (!summary) return ['label references a session that is not in the run inventory'];
  if (!OUTCOMES.includes(label.outcome)) errors.push(`invalid outcome ${label.outcome}`);
  if (!BASES.includes(label.basis)) errors.push(`invalid basis ${label.basis}`);
  if (!TASK_TYPES.includes(label.taskType)) errors.push(`invalid taskType ${label.taskType}`);
  if (label.outcome !== 'unknown' && BASES.includes(label.basis)) {
    const citations = label.citations ?? [];
    const derived = deriveEvidence(label.basis, citations, summary);
    errors.push(...derived.errors);
    if (derived.attribution && modelKey(derived.attribution) !== modelKey(label.attribution ?? {})) {
      errors.push(`attribution ${modelKey(label.attribution ?? {})} does not match the cited evidence (${modelKey(derived.attribution)})`);
    }
    if (label.basis === 'test') {
      const tests = summary.testRuns.filter(t => citations.includes(t.ref));
      const ok = label.outcome === 'success' ? tests.some(t => t.verdict === 'pass' && t.afterLastEdit) : tests.some(t => t.verdict === 'fail' || (t.exitCode ?? 0) !== 0);
      if (!ok) errors.push('test basis must cite a test run whose runner verdict supports the outcome (pass after the last edit for success)');
    }
  }
  if (label.outcome !== 'unknown' && !label.reviewed) errors.push('label not marked reviewed');
  return errors;
}

/** A passing check is not proof the whole request was met: it never counts as policy success. */
export const isCheckOnly = label => label.outcome === 'success' && label.basis === 'test';
