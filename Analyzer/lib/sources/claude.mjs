import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { headTail, mtimeMs, readJsonl, walk } from '../util.mjs';
import { parseExitCode, parseJevNotice } from '../signals.mjs';

/** Claude Code transcript roots: the default config dir plus any CLAUDE_CONFIG_DIR-style homes. */
export function claudeRoots(home = homedir(), extra = []) {
  return [join(home, '.claude', 'projects'), ...extra];
}

export function discoverClaude(roots, sinceMs) {
  const files = [];
  for (const root of roots) {
    for (const file of walk(root, p => p.endsWith('.jsonl'), { maxDepth: 4 })) {
      if (mtimeMs(file) >= sinceMs) files.push({ root, file });
    }
  }
  return files;
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(c => c?.type === 'text').map(c => c.text).join('\n');
}

function toolResultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(c => (typeof c === 'string' ? c : c?.text ?? '')).join('\n');
  return '';
}

/** Parse one Claude JSONL file into a normalized session. */
export function parseClaudeFile(file) {
  const rows = readJsonl(file);
  const isSub = /\/subagents\/agent-[^/]+\.jsonl$/.test(file);
  const session = {
    cli: 'claude',
    sessionId: isSub ? basename(file, '.jsonl') : basename(file, '.jsonl'),
    parentId: isSub ? basename(dirname(dirname(file))) : null,
    kind: isSub ? 'subagent' : 'interactive',
    files: [file],
    account: 'default',
    cwd: null,
    cliVersion: null,
    entrypoint: null,
    events: [],
    parseErrors: 0,
  };
  const pending = new Map();
  for (const { line, value: e, parseError } of rows) {
    if (parseError) { session.parseErrors++; continue; }
    const at = Date.parse(e.timestamp);
    if (e.sessionId && !isSub) session.sessionId = e.sessionId;
    if (e.cwd && !session.cwd) session.cwd = e.cwd;
    if (e.version) session.cliVersion = e.version;
    if (e.entrypoint) {
      session.entrypoint = e.entrypoint;
      if (!isSub && e.entrypoint === 'sdk-cli') session.kind = 'headless';
    }
    if (e.type === 'user' && e.message) {
      const c = e.message.content;
      if (Array.isArray(c)) {
        for (const item of c) {
          if (item?.type !== 'tool_result') continue;
          const cmd = pending.get(item.tool_use_id);
          if (!cmd) continue;
          pending.delete(item.tool_use_id);
          const output = toolResultText(item.content);
          const code = parseExitCode(output);
          cmd.exitCode = code ?? (item.is_error ? null : 0);
          cmd.exitSource = code !== null ? 'tool-output' : item.is_error ? 'is_error-without-code' : 'claude-tool-success';
          cmd.isError = Boolean(item.is_error);
          cmd.output = headTail(output);
          cmd.doneAt = at;
        }
      }
      const text = textOf(c);
      if (text && !e.isMeta && !e.isCompactSummary) {
        session.events.push({ at, type: 'user', ref: `L${line}`, text, sidechain: Boolean(e.isSidechain) });
      }
    } else if (e.type === 'assistant' && e.message) {
      const model = e.message.model;
      const text = textOf(e.message.content);
      const notice = parseJevNotice(text);
      if (notice) session.events.push({ at, type: 'notice', ref: `L${line}`, text: text.split('\n')[0], ...notice });
      session.events.push({
        at, type: 'assistant', ref: `L${line}`, text, model,
        effort: e.effort ?? null, perTurnEffort: e.perTurnEffort ?? null,
        stop: e.message.stop_reason ?? null,
      });
      for (const item of Array.isArray(e.message.content) ? e.message.content : []) {
        if (item?.type !== 'tool_use') continue;
        const input = item.input ?? {};
        if (item.name === 'Bash' && input.command) {
          const cmd = { at, type: 'command', ref: `L${line}`, tool: 'Bash', cmd: input.command, exitCode: null, exitSource: 'no-result', model, effort: e.effort ?? null };
          pending.set(item.id, cmd);
          session.events.push(cmd);
        } else if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(item.name) && (input.file_path || input.notebook_path)) {
          session.events.push({ at, type: 'edit', ref: `L${line}`, path: input.file_path ?? input.notebook_path });
        } else if (item.name === 'Agent' || item.name === 'Task') {
          session.events.push({ at, type: 'delegate', ref: `L${line}`, text: String(input.description ?? input.subagent_type ?? '') });
        }
      }
    }
  }
  return session;
}
