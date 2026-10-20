import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AGY_AUTO_MODEL, AGY_DEFAULT_UPSTREAM, startAgyProxy } from "./agy-proxy.mjs";
import { loadEnv } from "./codex-cli.mjs";
import { executionWorkspace } from './execution-workspace.mjs';
import { childEnv } from "./child-env.mjs";

// Subcommands manage AGY itself rather than running a conversation, so they need no proxy.
const SUBCOMMANDS = new Set([
  "agent", "agents", "changelog", "help", "install", "mcp", "mic-serve", "models",
  "plugin", "plugins", "remote-control", "update",
]);

/** The official `agy` executable, or the older `antigravity` name when that is all there is. */
export function resolveAnti(path = process.env.PATH ?? "", names = ["agy", "antigravity"]) {
  const win = process.platform === "win32";
  for (const name of names) {
    for (const dir of path.split(win ? ";" : ":")) {
      if (!dir) continue;
      for (const ext of win ? [".exe", ".cmd", ".bat"] : [""]) {
        const file = join(dir.replace(/^"|"$/g, ""), `${name}${ext}`);
        try {
          accessSync(file, constants.X_OK);
          return { file, shell: /\.(cmd|bat)$/i.test(file) };
        } catch { /* Keep searching. */ }
      }
    }
  }
  return null;
}

export function antiFlag(args, name) {
  return args.some((arg) => arg === name || arg.startsWith(`${name}=`));
}

/**
 * Arguments for a routed session. The user's own `--model` wins; otherwise the session starts
 * on the Jev Router row, which the proxy adds to AGY's native model picker.
 */
export const antiArgs = (args) => (antiFlag(args, "--model") ? args : ["--model", AGY_AUTO_MODEL, ...args]);

function execute(command, args, env = childEnv()) {
  return new Promise((resolve) => {
    const child = spawn(command.file, args, { stdio: "inherit", shell: command.shell, env });
    child.on("error", (error) => {
      process.stderr.write(`[jev] could not start AGY: ${error.message}\n`);
      resolve(1);
    });
    child.on("exit", (code, signal) => resolve(signal ? 1 : (code ?? 0)));
  });
}

export async function runAnti(args = process.argv.slice(2)) {
  const command = resolveAnti();
  if (!command) {
    process.stderr.write("[jev] AGY (Antigravity CLI) is not installed, or `agy` is not on your PATH.\n");
    return 1;
  }
  if (SUBCOMMANDS.has(args[0])) return execute(command, args);

  loadEnv();
  if (!process.env.JEV_API_KEY && !process.env.TYPESAFE_API_KEY) {
    process.stderr.write(
      "[jev] no JEV_API_KEY found - starting AGY without routing\n" +
        `[jev] add JEV_API_KEY=... to ${join(homedir(), ".jev-router.env")} and restart jev-agy\n`,
    );
    return execute(command, args);
  }

  // AGY reads CLOUD_CODE_URL as its API server. A value the user already set becomes the
  // proxy's upstream, and the override is given to the child only.
  const proxy = await startAgyProxy({
    ...executionWorkspace('antigravity', args),
    upstream: process.env.CLOUD_CODE_URL || AGY_DEFAULT_UPSTREAM,
    statusId: `agy-${process.pid}`,
  });
  try {
    return await execute(command, antiArgs(args), childEnv(process.env, {
      CLOUD_CODE_URL: `http://127.0.0.1:${proxy.port}`,
    }));
  } finally {
    proxy.close();
  }
}
