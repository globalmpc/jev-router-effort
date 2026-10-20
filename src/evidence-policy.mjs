import { readFileSync } from 'node:fs';
// Korean keywords are written as \u escapes so the source stays English-only.

export const TASK_TYPES = ['cross-module-change', 'local-code-change', 'evaluation', 'analysis', 'writing', 'research', 'operations', 'general'];

const KOREAN_ACTIONS = '\uAD6C\uD604|\uAC1C\uBC1C|\uC218\uC815|\uCD94\uAC00|\uBCF5\uAD6C|\uC801\uC6A9|\uC791\uC131|\uBCC0\uACBD|\uC0AD\uC81C|\uD3B8\uC9D1|\uBC30\uD3EC|\uCEE4\uBC0B|\uB9AC\uD329\uD130\uB9C1|\uB9AC\uD329\uD1A0\uB9C1|\uD478\uC2DC|\uC5C5\uB85C\uB4DC|\uAC8C\uC2DC|\uBC1C\uD589|\uBCD1\uD569|\uBA38\uC9C0|\uBC18\uC601';
const KOREAN_PARTICLE = '(?:\uC744|\uB97C|\uB3C4|\uC740|\uB294)?';
const KOREAN_NEGATION = new RegExp(`(?:${KOREAN_ACTIONS}|\uACE0\uCE58|\uC9C0\uC6B0|\uB9CC\uB4E4)${KOREAN_PARTICLE}(?:\uD558)?\\s*(?:\uD558\uC9C0\\s*\uB9D0(?:\uACE0|\uC544)|\uD558\uC9C0\\s*\uB9C8|\uC9C0\\s*\uB9D0(?:\uACE0|\uC544)|\uC9C0\\s*\uB9C8|\uC9C0\\s*\uC54A(?:\uACE0|\uC544))`, 'g');
const KOREAN_MUTATION = new RegExp(`(?:${KOREAN_ACTIONS})${KOREAN_PARTICLE}\\s*(?:\uD574|\uD558|\uD560|\uBC0F|\uD6C4|\uBC14\uB78D\uB2C8\uB2E4|\uC694\uCCAD|\uBD80\uD0C1|\uC9C4\uD589|\uC218\uD589|\uC644\uB8CC)|(?:${KOREAN_ACTIONS})\\s*[.!?。]?\\s*$|\uACE0\uCCD0|\uACE0\uCE58(?:\uACE0|\uBA74|\uC790|\uB77C|\uC138\uC694)|\uC9C0\uC6CC|\uC9C0\uC6B0(?:\uACE0|\uBA74|\uC790|\uC138\uC694)|\uC9C0\uC6B8|\uB9CC\uB4E4\uC5B4`);
const activeKorean = text => text.replace(KOREAN_NEGATION, '');

/** Prefer abstention for mixed edit/review requests; this identifies authority, not quality. */
export function isEvaluationRequest(text = '') {
  if (!/\uD3C9\uAC00|\uAC80\uD1A0|\uCC44\uC810|\uB9AC\uBDF0|\b(?:evaluat(?:e|ion|ing)|review(?:er|ing)?|qa|grade|grading)\b/i.test(text)) return false;
  const active = activeKorean(text)
    .replace(/\b(?:do not|don't|without)\s+(?:edit|modify|fix|write|change)(?:ing)?\b/gi, '')
    .replace(/\b(?:the|this|that|existing|completed|proposed)\s+(?:fix|patch|build|change|update)\b/gi, 'artifact');
  return !KOREAN_MUTATION.test(active)
    && !/\b(?:implement|build|develop|fix|refactor|restore|deploy|create|add|edit|modify|write|delete|remove|commit|push|update|patch|change|rename)\b/i.test(active);
}

/** Conservative task signals, not a model-quality judgement. Length is never a signal. */
export function taskProfile(text = '') {
  if (isEvaluationRequest(text)) return { taskType: 'evaluation', complex: false, signals: ['evaluation'], mutating: false };
  const change = KOREAN_MUTATION.test(activeKorean(text))
    || /\uAD6C\uD604|\uAC1C\uBC1C|\uB9CC\uB4E4|\uC218\uC815|\uACE0\uCCD0|\uACE0\uCE58|\uCD94\uAC00|\uBCF5\uAD6C|\uC2E4\uD589|\uC801\uC6A9|implement|build|develop|fix|refactor|restore|deploy|create|add\b/i.test(text);
  const signals = {
    integration: /\uD50C\uB7EC\uADF8\uC778|\uBAA8\uB4C8|\uAE30\uC874.{0,20}(\uC571|\uBA54\uB274|\uCF54\uB4DC)|plugin|cross.module|integrat|architecture/i.test(text),
    workflow: /\uC2B9\uC778|\uAC70\uC808|\uAC80\uC218|\uC0C1\uD0DC|\uC790\uB3D9.{0,10}\uBC1C\uD589|approve|reject|workflow|state.machine/i.test(text),
    scheduling: /\uC2A4\uCF00\uC904|\uC608\uC57D|\uB9E4\uC77C|\uC2DC\uAC04.{0,15}\uBD84|\uC77C.{0,8}(\uB4A4|\uC9C0\uB098)|schedule|cron|background|retry/i.test(text),
    external: /\uC2AC\uB799|\uD648\uD398\uC774\uC9C0|\uBE14\uB85C\uADF8|\uC678\uBD80|\uACB0\uC81C|\uC778\uC99D|slack|publish|payment|auth|external/i.test(text),
    recovery: /\uAE68\uC84C|\uAE68\uBA39|\uB0A0\uB824|\uC0AD\uC81C\uB410|\uD68C\uADC0|\uB370\uC774\uD130.{0,10}(\uC190\uC2E4|\uC720\uC2E4)|regression|data.loss|broke|broken/i.test(text),
  };
  const coupled = Object.entries(signals).filter(([, yes]) => yes).map(([name]) => name);
  const complex = change && (coupled.length >= 3 || (signals.integration && signals.workflow) || signals.recovery);
  const taskType = complex ? 'cross-module-change'
    : change && /\uCF54\uB4DC|\uD568\uC218|\uD14C\uC2A4\uD2B8|\uBC84\uADF8|\uD30C\uC77C|code|function|test|bug|file/i.test(text) ? 'local-code-change'
      : /\uBD84\uC11D|\uAC80\uD1A0|\uD310\uB2E8|analy[sz]|review|diagnos/i.test(text) ? 'analysis'
        : /\uBC88\uC5ED|\uC6D0\uACE0|\uBB38\uC7A5|\uAE00|translate|write|prose/i.test(text) ? 'writing'
          : /\uC870\uC0AC|\uAC80\uC0C9|\uCC3E\uC544|research|search/i.test(text) ? 'research'
            : change ? 'operations' : 'general';
  return { taskType, complex, signals: coupled, mutating: change };
}

/** User instructions authorize selection separately from observed success/failure rules. */
export function selectRoutingPreference({ preferences = [], taskType, cli, externalModels = [], manualEffort = null, policy, now }) {
  if (taskType !== 'evaluation' || manualEffort !== null || !Array.isArray(preferences)) return null;
  for (const preference of preferences) {
    const target = preference?.target;
    if (preference?.sourceCli !== cli || preference.taskType !== taskType || preference.provenance?.kind !== 'user-preference'
      || typeof preference.provenance.source !== 'string' || !preference.provenance.source.trim()
      || typeof preference.id !== 'string' || !preference.id.trim() || typeof preference.reason !== 'string' || !preference.reason.trim()
      || !['claude', 'codex'].includes(target?.cli) || target.cli === cli || typeof target.model !== 'string'
      || !(target.effort === null || typeof target.effort === 'string')) continue;
    const model = externalModels.find(m => m.cli === target.cli && m.id === target.model);
    if (!model?.efforts?.includes(target.effort)) continue;
    if ((policy?.rules ?? []).some(r => r.taskType === taskType && r.cli === target.cli && r.model === target.model
      && r.outcome === 'avoid' && (r.effort === null || r.effort === target.effort) && supportedRule(r, policy, now))) continue;
    return { kind: 'external', target, selection: { kind: 'user-preference', preferenceId: preference.id,
      provenance: preference.provenance, reason: preference.reason } };
  }
  return null;
}

export function loadEvidencePolicy(path) {
  if (!path) return { schemaVersion: 1, rules: [] };
  const policy = JSON.parse(readFileSync(path, 'utf8'));
  if (policy.schemaVersion !== 1 || !Array.isArray(policy.rules)) throw new Error('Unsupported evidence policy schema');
  return policy;
}

export function wilsonLower(successes, n, z = 1.96) {
  if (!n) return 0;
  const p = successes / n;
  return (p + z * z / (2 * n) - z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / (1 + z * z / n);
}

/** Recheck support at consumption time; a manually written 'validated' flag is insufficient. */
export function supportedRule(rule, policy, now = Date.now()) {
  if (rule?.status !== 'validated' || !TASK_TYPES.includes(rule.taskType)) return false;
  if (!['claude', 'codex', 'antigravity', 'glm'].includes(rule.cli) || typeof rule.model !== 'string' || !rule.model) return false;
  if (rule.effort !== null && typeof rule.effort !== 'string') return false;
  if (![rule.sampleSize, rule.successes, rule.failures, rule.unknown].every(n => Number.isInteger(n) && n >= 0)) return false;
  if (rule.sampleSize !== rule.successes + rule.failures + rule.unknown) return false;
  const known = rule.successes + rule.failures;
  if (known < 5 || !Array.isArray(rule.evidenceIds) || new Set(rule.evidenceIds).size < known) return false;
  const date = Date.parse(rule.evidenceAt ?? rule.generatedAt ?? policy.generatedAt);
  if (!Number.isFinite(date) || date > now + 60_000 || now - date > 30 * 86400_000) return false;
  if (rule.outcome === 'prefer') return rule.successes / known >= 0.9 && wilsonLower(rule.successes, known) >= 0.55;
  if (rule.outcome === 'avoid') return rule.failures >= 3 && rule.failures / known >= 0.5;
  return false;
}

export function selectEvidence({ policy, taskType, cli, models = [], efforts = [], manualEffort = null, externalModels = [], now }) {
  const rules = (policy?.rules ?? []).filter(r => r.taskType === taskType && supportedRule(r, policy, now));
  // null means no effort control, not evidence for every reasoning level.
  const supportedEffort = (rule, model, available) => rule.effort === null
    ? !(model?.efforts ?? available).some(e => e !== null)
    : (model?.efforts ?? available).includes(rule.effort);
  const compatible = (r, m, available) => m && supportedEffort(r, m, available) && (!manualEffort || r.effort === manualEffort);
  const avoid = rules.filter(r => r.cli === cli && r.outcome === 'avoid');
  const local = rules.filter(r => r.cli === cli && r.outcome === 'prefer'
    && compatible(r, models.find(m => m.id === r.model), efforts)
    && !avoid.some(a => a.model === r.model && (a.effort === null || a.effort === r.effort)));
  const sorted = list => list.sort((a, b) => wilsonLower(b.successes, b.successes + b.failures) - wilsonLower(a.successes, a.successes + a.failures));
  // Once the quality threshold holds, prefer a cheaper supported tier. Evidence does
  // not contain enough calibrated dollar/latency data to invent finer cost estimates.
  if (local.length) {
    const ranks = { haiku: 0, sonnet: 1, opus: 2, fable: 3 };
    const eligible = sorted(local).sort((a, b) =>
      (ranks[models.find(m => m.id === a.model)?.tier] ?? 9) - (ranks[models.find(m => m.id === b.model)?.tier] ?? 9));
    return { kind: 'local', rule: eligible[0], avoid };
  }
  const external = rules.filter(r => r.cli !== cli && ['claude', 'codex'].includes(r.cli) && r.outcome === 'prefer'
    && compatible(r, externalModels.find(m => m.cli === r.cli && m.id === r.model), [])
    && !rules.some(a => a.cli === r.cli && a.outcome === 'avoid' && a.model === r.model && (a.effort === null || a.effort === r.effort)));
  if (external.length) return { kind: 'external', rule: sorted(external)[0], avoid };
  return { kind: 'fallback', avoid };
}
