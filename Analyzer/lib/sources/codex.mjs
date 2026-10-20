import { readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { headTail, mtimeMs, readJsonl, walk } from '../util.mjs';
import { isSyntheticUserText, parseExitCode, parseJevNotice } from '../signals.mjs';

/** Codex session homes: ~/.codex plus Orca's per-account and runtime homes. */
export function codexRoots(home = homedir()) {
  const orca = join(home, 'Library', 'Application Support', 'orca');
  const roots = [
    { root: join(home, '.codex', 'sessions'), account: 'default' },
    { root: join(home, '.codex', 'archived_sessions'), account: 'default' },
    { root: join(orca, 'codex-runtime-home', 'home', 'sessions'), account: 'orca-runtime' },
  ];
  try {
    for (const d of readdirSync(join(orca, 'codex-accounts'), { withFileTypes: true })) {
      if (d.isDirectory()) roots.push({ root: join(orca, 'codex-accounts', d.name, 'home', 'sessions'), account: `orca-${d.name}` });
    }
  } catch { /* no Orca accounts */ }
  // CODEX_HOME describes this process's own account; only honour it for the real home, and
  // skip it when it is one of the Orca homes already listed.
  const env = process.env.CODEX_HOME && home === homedir() ? join(process.env.CODEX_HOME, 'sessions') : null;
  if (env && !roots.some(r => r.root === env)) roots.push({ root: env, account: 'CODEX_HOME' });
  return roots;
}

export function discoverCodex(roots, sinceMs) {
  const files = [];
  for (const { root, account } of roots) {
    for (const file of walk(root, p => p.endsWith('.jsonl'), { maxDepth: 5 })) {
      if (mtimeMs(file) >= sinceMs) files.push({ root, file, account });
    }
  }
  return files;
}

/** Extract shell commands from a Codex `exec` script or function-call arguments. */
export function extractCodexCommands(input) {
  const s = String(input ?? '');
  const cmds = [];
  const re = /\b(?:cmd|command)["']?\s*:\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|\[[^\]]*\])/g;
  for (const m of s.matchAll(re)) {
    const lit = m[1];
    try {
      if (lit.startsWith('"')) cmds.push(JSON.parse(lit));
      else if (lit.startsWith('[')) { const arr = JSON.parse(lit); cmds.push(Array.isArray(arr) ? arr.join(' ') : String(arr)); }
      else cmds.push(lit.slice(1, -1).replace(/\\(.)/g, '$1'));
    } catch {
      cmds.push(lit.slice(1, -1));
    }
  }
  if (!cmds.length) {
    try {
      const j = JSON.parse(s);
      if (j.cmd) cmds.push(Array.isArray(j.cmd) ? j.cmd.join(' ') : j.cmd);
      else if (j.command) cmds.push(Array.isArray(j.command) ? j.command.join(' ') : j.command);
    } catch { /* not JSON */ }
  }
  return cmds;
}

function outputText(output) {
  if (typeof output === 'string') return output;
  if (Array.isArray(output)) return output.map(o => o?.text ?? '').join('\n');
  if (output && typeof output === 'object') return output.output ?? JSON.stringify(output);
  return '';
}

export function parseCodexFile(file, account = 'default') {
  const rows = readJsonl(file);
  const session = {
    cli: 'codex', sessionId: null, parentId: null, kind: 'interactive', files: [file], account,
    cwd: null, cliVersion: null, entrypoint: null, provider: null, events: [], parseErrors: 0,
  };
  let turn = { model: null, effort: null, notice: null };
  const pending = new Map();
  for (const { line, value: e, parseError } of rows) {
    if (parseError) { session.parseErrors++; continue; }
    const at = Date.parse(e.timestamp);
    const p = e.payload ?? {};
    if (e.type === 'session_meta') {
      session.sessionId = p.id ?? p.session_id ?? session.sessionId;
      session.cwd = p.cwd ?? session.cwd;
      session.cliVersion = p.cli_version ?? null;
      session.entrypoint = p.originator ?? null;
      session.provider = p.model_provider ?? null;
      const spawn = p.source?.subagent?.thread_spawn;
      if (spawn) { session.kind = 'subagent'; session.parentId = spawn.parent_thread_id ?? null; }
      else if (p.source === 'exec' || p.originator === 'codex_exec') session.kind = 'headless';
    } else if (e.type === 'turn_context') {
      turn = {
        model: p.model ?? null,
        effort: p.effort ?? p.collaboration_mode?.settings?.reasoning_effort ?? null,
        notice: null,
      };
      session.events.push({ at, type: 'turn', ref: `L${line}`, requestedModel: turn.model, requestedEffort: turn.effort });
    } else if (e.type === 'response_item' && p.type === 'message') {
      const text = (p.content ?? []).map(c => c?.text ?? '').join('\n');
      if (p.role === 'user') {
        if (!isSyntheticUserText(text)) session.events.push({ at, type: 'user', ref: `L${line}`, text });
      } else if (p.role === 'assistant') {
        const notice = parseJevNotice(text);
        if (notice) {
          turn.notice = notice;
          session.events.push({ at, type: 'notice', ref: `L${line}`, text, ...notice });
          continue;
        }
        const routed = turn.model === 'jev-router';
        session.events.push({
          at, type: 'assistant', ref: `L${line}`, text,
          model: routed ? (turn.notice?.model ?? 'unknown') : turn.model,
          effort: routed ? (turn.notice?.effort ?? null) : turn.effort,
          modelSource: routed ? (turn.notice ? 'jev-notice' : 'jev-router-without-notice') : 'turn_context',
          requestedModel: turn.model, requestedEffort: turn.effort,
        });
      }
    } else if (e.type === 'response_item' && (p.type === 'custom_tool_call' || p.type === 'function_call')) {
      const input = p.input ?? p.arguments ?? '';
      if (p.name === 'exec' || p.name === 'exec_command' || p.name === 'shell' || p.name === 'local_shell') {
        const cmds = extractCodexCommands(input);
        const routed = turn.model === 'jev-router';
        const model = routed ? (turn.notice?.model ?? 'unknown') : turn.model;
        const effort = routed ? (turn.notice?.effort ?? null) : turn.effort;
        const evs = cmds.map(cmd => ({ at, type: 'command', ref: `L${line}`, tool: p.name, cmd, exitCode: null, exitSource: 'no-result', model, effort }));
        if (/apply_patch|\*\*\* (Update|Add) File:/.test(input)) {
          for (const m of String(input).matchAll(/\*\*\* (?:Update|Add) File: ([^\n\\]+)/g)) session.events.push({ at, type: 'edit', ref: `L${line}`, path: m[1] });
        }
        session.events.push(...evs);
        pending.set(p.call_id, evs);
      } else if (/spawn_agent|followup_task|send_message/.test(p.name)) {
        session.events.push({ at, type: 'delegate', ref: `L${line}`, text: p.name });
      }
    } else if (e.type === 'response_item' && (p.type === 'custom_tool_call_output' || p.type === 'function_call_output')) {
      const evs = pending.get(p.call_id);
      if (!evs) continue;
      pending.delete(p.call_id);
      const text = outputText(p.output);
      const status = /^Script (completed|failed|error|running)/m.exec(text)?.[1] ?? null;
      const code = parseExitCode(text);
      for (const ev of evs) {
        ev.output = headTail(text);
        ev.doneAt = at;
        ev.scriptStatus = status;
        if (code !== null && evs.length === 1) { ev.exitCode = code; ev.exitSource = 'tool-output'; }
        else if (status === 'failed' || status === 'error') { ev.exitSource = `script-${status}`; ev.isError = true; }
        else ev.exitSource = status ? `script-${status}` : 'unknown';
      }
    } else if (e.type === 'event_msg' && p.type === 'turn_aborted') {
      session.events.push({ at, type: 'aborted', ref: `L${line}` });
    }
  }
  if (!session.sessionId) session.sessionId = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/.exec(file)?.[1] ?? file;
  return session;
}
