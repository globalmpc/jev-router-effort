import { readdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { mtimeMs, readJson, readJsonl, sha } from '../util.mjs';

// A non-default home (tests, another account) gets its own status dir so the live one is not read.
export function jevPaths(home = homedir(), statusDir = process.env.JEV_STATUS_DIR
  ?? (home === homedir() ? join(tmpdir(), 'jev-claude') : join(home, 'tmp', 'jev-claude'))) {
  return {
    statusDir,
    audit: join(home, '.jev-router-audit.jsonl'),
    runtimeDecisions: join(home, '.local', 'state', 'jev-router', 'decisions.jsonl'),
    runtimeFeedback: join(home, '.local', 'state', 'jev-router', 'feedback.jsonl'),
  };
}

export const normPrompt = text => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
export const promptKey = text => sha(normPrompt(text)).slice(0, 16);

/** Status keys: Claude uses its session id; Codex/AGY proxies use `codex-<pid>` / `agy-<pid>`. */
export function statusCli(key) {
  if (key.startsWith('codex-')) return 'codex';
  if (key.startsWith('agy-')) return 'antigravity';
  if (key.startsWith('glm-')) return 'glm';
  return 'claude';
}

/** Read the per-session routing status files, expanding their bounded decision history. */
export function readStatusDecisions(statusDir) {
  let names = [];
  try { names = readdirSync(statusDir).filter(n => n.endsWith('.json')); } catch { return { files: 0, decisions: [], manual: [] }; }
  const decisions = [];
  const manual = [];
  for (const name of names) {
    const file = join(statusDir, name);
    const key = basename(name, '.json');
    const status = readJson(file);
    if (!status) continue;
    const cli = statusCli(key);
    if (status.manual) { manual.push({ key, cli, at: status.at ?? mtimeMs(file), model: status.model ?? null }); continue; }
    const history = Array.isArray(status.history) && status.history.length ? status.history : [status];
    for (const d of history) {
      decisions.push({
        source: 'jev-status', key, cli, at: d.at ?? mtimeMs(file),
        tier: d.tier ?? null, model: d.model ?? null, effort: d.effort ?? null, effortMode: d.effortMode ?? null,
        confidence: d.confidence ?? null, effortConfidence: d.effortConfidence ?? null, reason: d.reason ?? null,
        metrics: d.metrics ?? null, promptKey: d.prompt ? promptKey(d.prompt) : null, prompt: d.prompt ?? null,
      });
    }
  }
  return { files: names.length, decisions, manual };
}

export function readAudit(file) {
  return readJsonl(file).filter(r => r.value).map(r => ({ source: 'jev-audit', ...r.value, at: Date.parse(r.value.at) }));
}

export function readRuntimeEvents(file) {
  return readJsonl(file).filter(r => r.value).map(r => ({ ...r.value }));
}
