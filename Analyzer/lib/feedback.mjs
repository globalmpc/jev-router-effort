import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { TASK_TYPES } from '../../src/evidence-policy.mjs';
import { readJsonl, sha } from './util.mjs';

export const FEEDBACK_SOURCES = ['user', 'qa', 'test'];
export const CLIS = ['claude', 'codex', 'antigravity', 'glm'];
// Who asked for the action the feedback is about: the person operating the session, or an
// instruction that only appeared inside the transcript (tool output, subagent prompt, file).
export const AUTHORIZERS = ['user', 'transcript', 'unknown'];

/** Validate and normalize a feedback record. Throws with every problem listed. */
export function normalizeFeedback(input, now = Date.now()) {
  const errors = [];
  const rec = {
    ref: String(input.ref ?? '').trim(),
    outcome: input.outcome,
    source: input.source,
    cli: input.cli ?? null,
    model: input.model ?? null,
    effort: input.effort === undefined || input.effort === 'unknown' ? null : input.effort,
    taskType: input['task-type'] ?? input.taskType ?? null,
    authorizedBy: input['authorized-by'] ?? input.authorizedBy ?? 'unknown',
    reporter: input.reporter ?? null,
    note: input.note ?? '',
    at: new Date(now).toISOString(),
    verified: false,
    citations: [],
  };
  if (!rec.ref) errors.push('--ref is required (evidence id ev-… or cli:sessionId)');
  if (!['success', 'failure'].includes(rec.outcome)) errors.push('--outcome must be success or failure');
  if (!FEEDBACK_SOURCES.includes(rec.source)) errors.push(`--source must be one of ${FEEDBACK_SOURCES.join('|')}`);
  if (rec.cli !== null && !CLIS.includes(rec.cli)) errors.push(`--cli must be one of ${CLIS.join('|')}`);
  if (rec.taskType !== null && !TASK_TYPES.includes(rec.taskType)) errors.push(`--task-type must be one of ${TASK_TYPES.join('|')}`);
  if (!AUTHORIZERS.includes(rec.authorizedBy)) errors.push(`--authorized-by must be one of ${AUTHORIZERS.join('|')}`);
  if (errors.length) throw new Error(errors.join('; '));
  rec.id = `fb-${sha(`${rec.ref}|${rec.outcome}|${rec.source}|${rec.at}|${rec.note}`).slice(0, 10)}`;
  return rec;
}

export function appendFeedback(file, rec) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  appendFileSync(file, JSON.stringify(rec) + '\n', { mode: 0o600 });
  return rec;
}

/** Latest state per feedback id (verification is appended as a new row, never rewritten). */
export function readFeedback(file) {
  const byId = new Map();
  for (const { value } of readJsonl(file)) if (value?.id) byId.set(value.id, { ...byId.get(value.id), ...value });
  return [...byId.values()];
}

/**
 * Copy failure reports captured by the router at runtime (~/.local/state/jev-router/feedback.jsonl,
 * `verified: false`) into the intake as unverified records. Each runtime id is imported once.
 */
export function importRuntimeFeedback(file, runtimeRows, now = Date.now()) {
  const seen = new Set(readFeedback(file).map(f => f.runtimeId).filter(Boolean));
  const added = [];
  for (const r of runtimeRows) {
    if (!r?.id || seen.has(r.id)) continue;
    const rec = {
      id: `fb-${sha(`runtime|${r.id}`).slice(0, 10)}`,
      ref: `runtime-task:${r.taskId ?? 'unknown'}`,
      outcome: 'failure',
      source: 'user',
      cli: CLIS.includes(r.cli) ? r.cli : null,
      model: r.model ?? null,
      effort: null,
      taskType: null,
      authorizedBy: 'unknown',
      reporter: r.source ?? 'user-or-qa-report',
      note: r.text ?? '',
      at: r.at ? new Date(r.at).toISOString() : new Date(now).toISOString(),
      verified: false,
      citations: [],
      origin: 'runtime',
      runtimeId: r.id,
    };
    appendFeedback(file, rec);
    seen.add(r.id);
    added.push(rec.id);
  }
  return added;
}

/**
 * Mark feedback verified after a reviewer tied it to concrete evidence refs in a session packet.
 * The report itself is the user's/QA's word; verification records that it was adjudicated.
 */
export function verifyFeedback(file, id, { citations, reviewer, model, effort, cli, taskType, sessionKey, evidenceId, evidenceAt }, now = Date.now()) {
  const current = readFeedback(file).find(f => f.id === id);
  if (!current) throw new Error(`unknown feedback id ${id}`);
  if (!citations?.length) throw new Error('verification needs --citations');
  const update = {
    id, verified: true, citations, verifiedBy: reviewer ?? 'unknown', verifiedAt: new Date(now).toISOString(),
    ...(model ? { model } : {}), ...(effort ? { effort: effort === 'unknown' ? null : effort } : {}),
    ...(cli ? { cli } : {}), ...(taskType ? { taskType } : {}),
    ...(sessionKey ? { sessionKey } : {}), ...(evidenceId ? { evidenceId } : {}), ...(evidenceAt ? { evidenceAt } : {}),
  };
  appendFeedback(file, update);
  return { ...current, ...update };
}
