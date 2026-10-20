import { relative, resolve } from 'node:path';

/** Resolve documented primary-root options; refuse ambiguous multi-root protection. */
export function executionWorkspace(cli, args, launchCwd = process.cwd()) {
  let cwd = resolve(launchCwd);
  const extras = [];
  let workspaceError = null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') break;
    if (cli === 'codex' && (arg === '-C' || arg === '--cd')) {
      if (!args[i + 1] || args[i + 1].startsWith('-')) throw new Error(`${arg} needs a directory`);
      cwd = resolve(launchCwd, args[++i]);
    } else if (cli === 'codex' && /^(--cd=|-C=?).+/.test(arg)) {
      cwd = resolve(launchCwd, arg.replace(/^(--cd=|-C=?)/, ''));
    } else if (arg === '--add-dir') {
      if (args[i + 1]) extras.push(resolve(launchCwd, args[++i]));
      if (cli === 'claude') while (args[i + 1] && !args[i + 1].startsWith('-')) extras.push(resolve(launchCwd, args[++i]));
    } else if (arg.startsWith('--add-dir=')) extras.push(resolve(launchCwd, arg.slice(10)));
    else if (/^(--worktree(?:=|$)|-w$|--cloud(?:=|$)|--remote(?:=|$))/.test(arg)
      || cli === 'antigravity' && /^(--project(?:=|$)|--new-project(?:=|$))/.test(arg)) {
      workspaceError = 'The native CLI can change the workspace after launch. Start JEV inside the actual checkout without project/worktree/remote overrides to obtain a verified checkpoint.';
    }
  }
  if (extras.some(path => { const rel = relative(cwd, path); return rel === '..' || rel.startsWith('../') || rel.startsWith('..\\'); })) {
    workspaceError = 'Additional writable directories outside the primary workspace are not checkpointed. Run a separate JEV session from the target checkout for complex changes.';
  }
  return { cwd, workspaceError };
}
