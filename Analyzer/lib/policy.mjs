import { supportedRule, TASK_TYPES, wilsonLower } from '../../src/evidence-policy.mjs';
import { redactId } from './util.mjs';

export const MAX_EVIDENCE_AGE_MS = 30 * 86400_000;

/**
 * Outcome observations: one per independent session. Verified user/QA feedback (already
 * re-validated against the inventory by the caller) overrides a reviewer label for the same
 * session; the assistant's completion claim is never an input.
 */
export function mergeObservations(labels, feedback) {
  const bySession = new Map();
  for (const l of labels) {
    bySession.set(l.key, {
      key: l.key, evidenceId: l.evidenceId, outcome: l.outcome, basis: l.basis, taskType: l.taskType,
      cli: l.attribution?.cli, model: l.attribution?.model, effort: l.attribution?.effort ?? null,
      evidenceAt: toMs(l.evidenceAt), checkOnly: Boolean(l.checkOnly), origin: 'review',
    });
  }
  for (const f of feedback.filter(x => x.verified)) {
    const key = f.sessionKey ?? f.ref;
    const prev = bySession.get(key);
    bySession.set(key, {
      key, evidenceId: prev?.evidenceId ?? redactId(key), outcome: f.outcome, basis: f.source,
      taskType: f.taskType ?? prev?.taskType, cli: f.cli ?? prev?.cli, model: f.model ?? prev?.model,
      effort: f.effort ?? null, evidenceAt: toMs(f.evidenceAt), checkOnly: false, origin: `feedback:${f.id}`,
    });
  }
  return [...bySession.values()];
}

const toMs = v => (typeof v === 'number' ? v : v ? Date.parse(v) : NaN);
const attributable = o => o.cli && o.model && !['unknown', 'mixed'].includes(o.model) && !/^unknown/.test(o.model) && TASK_TYPES.includes(o.taskType);

/** A concrete, versioned model string (not a JEV/AGY alias such as `gemini-pro-agent`). */
export const exactModel = model => /\d/.test(model ?? '') && !/-(agent|default)$/.test(model) && !/^(unknown|mixed)/.test(model);
/** Effort is known when observed, or encoded in an Antigravity model name. */
const effortKnown = (cli, model, effort) => effort !== null || (cli === 'antigravity' && /-(minimal|low|medium|high)$/.test(model));

/**
 * Compile observations into policy v1 rules. Validation is re-derived from
 * src/evidence-policy.mjs; `evidenceAt` is the oldest counted outcome, so recompiling cannot
 * refresh old evidence, and outcomes older than 30 days are dropped instead of counted.
 */
export function compilePolicy(observations, { now = Date.now(), version } = {}) {
  const generatedAt = new Date(now).toISOString();
  const groups = new Map();
  const abstained = [];
  for (const o of observations) {
    if (!attributable(o)) { abstained.push({ evidenceId: o.evidenceId, reason: 'model/effort/taskType not attributable', outcome: o.outcome }); continue; }
    if (o.outcome !== 'unknown' && !(now - o.evidenceAt <= MAX_EVIDENCE_AGE_MS && o.evidenceAt <= now + 60_000)) {
      abstained.push({ evidenceId: o.evidenceId, reason: Number.isFinite(o.evidenceAt) ? 'evidence older than 30 days' : 'evidence time unknown', outcome: o.outcome });
      continue;
    }
    const k = `${o.taskType}|${o.cli}|${o.model}|${o.effort ?? ''}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(o);
  }
  const rules = [];
  for (const [k, obs] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    const [taskType, cli, model] = k.split('|');
    const effort = obs[0].effort ?? null;
    // A passing check (tests) is not a verified task success: it stays out of `successes`.
    const checkOnlyPasses = obs.filter(o => o.outcome === 'success' && o.checkOnly).length;
    const counted = obs.filter(o => o.outcome === 'failure' || (o.outcome === 'success' && !o.checkOnly));
    const successes = counted.filter(o => o.outcome === 'success').length;
    const failures = counted.length - successes;
    const unknown = obs.length - counted.length;
    if (!counted.length) { abstained.push({ group: k, reason: checkOnlyPasses ? 'only check-level passes' : 'no known outcomes', sessions: obs.length }); continue; }
    const outcome = failures > successes ? 'avoid' : 'prefer';
    const rule = {
      id: `${outcome}-${taskType}-${cli}-${model}-${effort ?? 'effort-unknown'}`.replace(/[^\w.-]+/g, '-'),
      taskType, cli, model, effort, outcome,
      sampleSize: obs.length, successes, failures, unknown,
      evidenceIds: obs.map(o => o.evidenceId),
      status: 'candidate',
      evidenceAt: new Date(Math.min(...counted.map(o => o.evidenceAt))).toISOString(),
      generatedAt,
      checkOnlyPasses,
    };
    const known = successes + failures;
    const bases = [...new Set(counted.map(o => o.basis))].join('+');
    // Aliases and unobserved efforts cannot back a version-specific rule.
    const specific = exactModel(model) && effortKnown(cli, model, effort);
    const validated = specific && supportedRule({ ...rule, status: 'validated' }, { generatedAt }, now);
    rule.status = validated ? 'validated' : 'candidate';
    rule.reason = `${known} known of ${obs.length} sessions (basis: ${bases}); Wilson95 lower=${wilsonLower(outcome === 'prefer' ? successes : failures, known).toFixed(2)}; `
      + (validated ? 'meets runtime support thresholds.' : 'below runtime support thresholds (>=5 known independent sessions; prefer >=0.9 & Wilson>=0.55; avoid >=3 failures & >=50%), kept as candidate.')
      + (!exactModel(model) ? ' Model is an alias, not a versioned model.' : '')
      + (effort === null ? ' Effort unobserved: null here means unknown.' : '')
      + (checkOnlyPasses ? ` ${checkOnlyPasses} check-level pass(es) counted as unknown.` : '')
      + (unknown ? ' Unknown-outcome sessions are grouped by the heuristic taskType candidate.' : '');
    rules.push(rule);
  }
  return {
    schemaVersion: 1,
    version: version ?? `1.0.0-proposed.${generatedAt.slice(0, 10)}`,
    generatedAt,
    rules,
    abstained,
  };
}
