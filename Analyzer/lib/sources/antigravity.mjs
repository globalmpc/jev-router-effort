import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { decodeOrEmpty, first, strings } from '../protobuf.mjs';
import { headTail } from '../util.mjs';
import { parseExitCode, parseJevNotice } from '../signals.mjs';

// Step types observed in antigravity-cli conversation databases (schema is unpublished).
const USER_INPUT = 14;
const MODEL_TURN = 15;
const TOOL_RESULT = 132;

export function antigravityRoot(home = homedir()) {
  return join(home, '.gemini', 'antigravity-cli', 'conversations');
}

export function discoverAntigravity(root, sinceMs) {
  let names = [];
  try { names = readdirSync(root).filter(n => n.endsWith('.db')); } catch { return []; }
  const out = [];
  for (const name of names) {
    const file = join(root, name);
    let m = NaN;
    try { m = Math.max(statSync(file).mtimeMs, existsSync(`${file}-wal`) ? statSync(`${file}-wal`).mtimeMs : 0); } catch { continue; }
    if (m >= sinceMs) out.push({ root, file });
  }
  return out;
}

/**
 * Open a conversation database without writing to it. When a non-empty WAL exists the pair is
 * copied into `cacheDir` first so committed-but-uncheckpointed steps are visible; otherwise the
 * original file is opened immutable.
 */
export function openConversation(file, cacheDir) {
  const wal = `${file}-wal`;
  let walSize = 0;
  try { walSize = statSync(wal).size; } catch { /* none */ }
  if (walSize > 0 && cacheDir) {
    mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
    const copy = join(cacheDir, basename(file));
    copyFileSync(file, copy);
    copyFileSync(wal, `${copy}-wal`);
    return { db: new DatabaseSync(copy, { readOnly: true }), via: 'wal-copy' };
  }
  return { db: new DatabaseSync(`file:${file}?mode=ro&immutable=1`, { readOnly: true }), via: 'immutable' };
}

const tsOf = leaves => {
  const s = first(leaves, '.1.1');
  const n = first(leaves, '.1.2') ?? 0;
  return typeof s === 'number' ? s * 1000 + Math.floor(n / 1e6) : NaN;
};

export function parseAntigravityFile(file, { cacheDir } = {}) {
  const conversationId = basename(file, '.db');
  const session = {
    cli: 'antigravity', sessionId: conversationId, parentId: null, kind: 'interactive', files: [file], account: 'default',
    cwd: null, cliVersion: null, entrypoint: 'antigravity-cli', events: [], parseErrors: 0,
    observedModels: [], modelEnums: [], children: [], openedVia: null,
  };
  let opened;
  try { opened = openConversation(file, cacheDir); } catch (err) { session.parseErrors++; session.openError = String(err.message); return session; }
  const { db, via } = opened;
  session.openedVia = via;
  try {
    const models = new Map();
    const enums = new Map();
    for (const row of db.prepare('select idx, data from gen_metadata').all()) {
      const leaves = decodeOrEmpty(row.data);
      if (!leaves.length) { session.parseErrors++; continue; }
      for (let i = 0; i < leaves.length; i++) {
        const [, t, v] = leaves[i];
        if (t !== 'str') continue;
        if (v === 'model_enum' && leaves[i + 1]?.[1] === 'str') enums.set(leaves[i + 1][2], (enums.get(leaves[i + 1][2]) ?? 0) + 1);
        if (/^(gemini|claude|gpt)-[\w.-]+$/i.test(v)) models.set(v, (models.get(v) ?? 0) + 1);
      }
    }
    session.observedModels = [...models].map(([model, count]) => ({ model, count, source: 'agy.gen_metadata' }));
    session.modelEnums = [...enums].map(([value, count]) => ({ value, count }));

    let notice = null;
    for (const row of db.prepare('select idx, step_type, status, metadata, step_payload from steps order by idx').all()) {
      const meta = decodeOrEmpty(row.metadata);
      const payload = decodeOrEmpty(row.step_payload);
      if (!payload.length && row.step_payload?.length) session.parseErrors++;
      const at = tsOf(meta);
      const ref = `step${row.idx}`;
      if (row.step_type === USER_INPUT) {
        const text = strings(payload, '.19.2')[0] ?? strings(payload, '.19.3.1')[0] ?? '';
        const cwd = strings(payload, '.19.12.1.42.11')[0];
        if (cwd && !session.cwd) session.cwd = cwd.replace(/^\s*\S?\//, '/').trim();
        session.events.push({ at, type: 'user', ref, text });
      } else if (row.step_type === MODEL_TURN) {
        const text = strings(payload, '.20.1')[0] ?? '';
        const parsed = parseJevNotice(text);
        if (parsed) {
          notice = parsed;
          session.events.push({ at, type: 'notice', ref, text: text.split('\n')[0], ...parsed });
        }
        const body = parsed ? text.replace(/^\[Jev\][^\n]*\n*/, '') : text;
        if (body.trim()) {
          session.events.push({
            at, type: 'assistant', ref, text: body,
            model: notice?.model ?? 'unknown', effort: notice?.effort ?? null,
            modelSource: notice ? 'jev-notice' : 'unknown',
          });
        }
        const toolName = strings(payload, '.20.7.2')[0];
        const toolArgs = strings(payload, '.20.7.3')[0];
        if (toolName === 'run_command' && toolArgs) {
          let cmd = toolArgs;
          try { cmd = JSON.parse(toolArgs).CommandLine ?? toolArgs; } catch { /* keep raw */ }
          session.events.push({ at, type: 'command', ref, tool: 'run_command', cmd, exitCode: null, exitSource: 'no-result', model: notice?.model ?? 'unknown', effort: notice?.effort ?? null });
        } else if (/write_to_file|replace_file_content|multi_replace/.test(toolName ?? '') && toolArgs) {
          let path = null;
          try { const j = JSON.parse(toolArgs); path = j.TargetFile ?? j.AbsolutePath ?? null; } catch { /* raw */ }
          session.events.push({ at, type: 'edit', ref, path });
        } else if (/subagent|send_message/.test(toolName ?? '')) {
          session.events.push({ at, type: 'delegate', ref, text: toolName, args: toolArgs?.slice(0, 20000) });
        }
      } else if (row.step_type === TOOL_RESULT) {
        const out = strings(payload, '.140.2.1')[0] ?? '';
        const cmdLine = strings(payload, '.148.4')[0];
        for (const m of out.matchAll(/"conversationId":\s*"([0-9a-f-]{36})"/g)) session.children.push(m[1]);
        const pendingCmd = [...session.events].reverse().find(e => e.type === 'command' && e.exitSource === 'no-result');
        if (pendingCmd && ((cmdLine !== undefined && cmdLine === pendingCmd.cmd) || /command exited with code/.test(out))) {
          const code = parseExitCode(out);
          pendingCmd.exitCode = code;
          pendingCmd.exitSource = code !== null ? 'tool-output' : 'unknown';
          pendingCmd.output = headTail(out);
          pendingCmd.doneAt = at;
          pendingCmd.resultRef = ref;
        }
      } else {
        const text = payload.filter(([, t, v]) => t === 'str' && v.length > 40).map(l => l[2]).sort((a, b) => b.length - a.length)[0];
        if (text) session.events.push({ at, type: 'system', ref, stepType: row.step_type, text: text.slice(0, 4000) });
      }
    }
  } finally {
    db.close();
  }
  return session;
}
