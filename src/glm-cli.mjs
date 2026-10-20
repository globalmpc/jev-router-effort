import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveAnti } from "./anti-cli.mjs";
import { loadEnv } from "./codex-cli.mjs";
import { GLM_DEFAULT_UPSTREAM, startGlmProxy } from "./glm-proxy.mjs";
import { executionWorkspace } from './execution-workspace.mjs';
import { childEnv } from "./child-env.mjs";

/**
 * Prefers the `glm` launcher, which reads the z.ai key from the Keychain, over bare `zai`.
 * Both honour ZAI_BASE_URL ahead of the saved settings, which is how the proxy slots in.
 */
function resolveGlm() {
  for (const name of ["glm", "zai"]) {
    const found = resolveAnti(process.env.PATH, [name]);
    if (found) return found;
  }
  return null;
}

// The ZAI CLI reads the whole model stream before it renders anything, so a note injected
// into the stream only appears when the answer does. The terminal title is outside Ink's
// redraw region, so the decision can be shown there the moment Jev returns.
const setTitle = (text) => {
  if (process.stdout.isTTY) process.stdout.write(`\x1b]0;${text.replace(/[\x00-\x1f\x7f]/g, " ")}\x07`);
};

export const glmTitle = ({ model, effort }) => `[Jev] ${model}${effort ? ` · ${effort}` : ""}`;

function execute(command, args, env = childEnv()) {
  return new Promise((resolve) => {
    const child = spawn(command.file, args, { stdio: "inherit", shell: command.shell, env });
    child.on("error", (error) => {
      process.stderr.write(`[jev] could not start the ZAI CLI: ${error.message}\n`);
      resolve(1);
    });
    child.on("exit", (code, signal) => resolve(signal ? 1 : (code ?? 0)));
  });
}

export async function runGlm(args = process.argv.slice(2)) {
  const command = resolveGlm();
  if (!command) {
    process.stderr.write("[jev] the ZAI CLI is not installed, or neither `glm` nor `zai` is on your PATH.\n");
    return 1;
  }

  loadEnv();
  if (!process.env.JEV_API_KEY && !process.env.TYPESAFE_API_KEY) {
    process.stderr.write(
      "[jev] no JEV_API_KEY found - starting the ZAI CLI without routing\n" +
        `[jev] add JEV_API_KEY=... to ${join(homedir(), ".jev-router.env")} and restart jev-glm\n`,
    );
    return execute(command, args);
  }

  const proxy = await startGlmProxy({
    ...executionWorkspace('glm', args),
    upstream: process.env.ZAI_BASE_URL || GLM_DEFAULT_UPSTREAM,
    statusId: `glm-${process.pid}`,
    onDecision: (routing) => setTitle(glmTitle(routing)),
  });
  setTitle("[Jev] GLM router");
  try {
    return await execute(command, args, childEnv(process.env, { ZAI_BASE_URL: `http://127.0.0.1:${proxy.port}` }));
  } finally {
    setTitle("");
    proxy.close();
  }
}
