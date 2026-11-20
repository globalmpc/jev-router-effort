import { spawn } from "node:child_process";
import { accessSync, constants, copyFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CODEX_AUTO_EFFORT, CODEX_AUTO_MODEL, isCodexRouterModel, startCodexProxy } from "./codex-proxy.mjs";
import { childEnv } from "./child-env.mjs";
import { executionWorkspace } from './execution-workspace.mjs';
import { checkKey, loadJevKey, userEnvFiles } from "./credentials.mjs";

const PROVIDER = "jev";
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const EXPLAIN_SKILL = join(ROOT, "skills", "codex", "jev-explain", "SKILL.md");

export function installCodexSkill(home = homedir()) {
  const target = join(home, ".agents", "skills", "jev-router-explain", "SKILL.md");
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(EXPLAIN_SKILL, target);
  return target;
}

// Re-exported for existing importers; the rule itself lives in credentials.mjs.
export { userEnvFiles };

/** Loads the user's env files and, on macOS, the Keychain key. See `loadJevKey` for the order. */
export function loadEnv(home = homedir()) {
  return loadJevKey({ files: userEnvFiles(home) });
}

export function resolveCodex() {
  const win = process.platform === "win32";
  const exts = win ? [".exe", ".ps1", ".cmd", ".bat"] : [""];
  for (const dir of (process.env.PATH ?? "").split(win ? ";" : ":")) {
    if (!dir) continue;
    for (const ext of exts) {
      const file = join(dir.replace(/^"|"$/g, ""), `codex${ext}`);
      try {
        accessSync(file, constants.F_OK);
        if (/\.ps1$/i.test(file)) {
          return { file: "powershell.exe", prefix: ["-NoProfile", "-File", file], shell: false };
        }
        return { file, prefix: [], shell: /\.(cmd|bat)$/i.test(file) };
      } catch {
        // Not here; keep looking.
      }
    }
  }
  return null;
}

export const codexArgs = (baseURL, args) => {
  const modelIndex = args.findIndex((arg) => arg === "--model" || arg === "-m");
  const inlineModel = args.find((arg) => arg.startsWith("--model=") || arg.startsWith("-m="));
  const selectedModel = modelIndex >= 0
    ? args[modelIndex + 1]
    : inlineModel?.slice(inlineModel.indexOf("=") + 1);
  return [
  ...(selectedModel ? [] : ["--model", CODEX_AUTO_MODEL]),
  ...(!selectedModel || isCodexRouterModel(selectedModel)
    ? ["--config", `model_reasoning_effort="${CODEX_AUTO_EFFORT}"`, "--config", 'service_tier="default"']
    : []),
  "--config",
  `model_provider="${PROVIDER}"`,
  "--config",
  `model_providers.${PROVIDER}.name="Jev Router"`,
  "--config",
  `model_providers.${PROVIDER}.base_url="${baseURL}"`,
  "--config",
  `model_providers.${PROVIDER}.wire_api="responses"`,
  "--config",
  `model_providers.${PROVIDER}.requires_openai_auth=true`,
  "--config",
  `model_providers.${PROVIDER}.supports_websockets=false`,
  ...args,
  ];
};

// Loads configuration, starts the optional routing proxy, and launches the Codex CLI.
export async function runCodex() {
  loadEnv();
  try {
    installCodexSkill();
  } catch (err) {
    process.stderr.write(`[jev] could not install the Codex explanation skill: ${err.message}\n`);
  }
  const command = resolveCodex();
  if (!command) {
    process.stderr.write(
      "[jev] OpenAI Codex is not installed, or `codex` is not on your PATH.\n" +
        "[jev] jev-codex runs the real Codex CLI; install it first:\n" +
        "[jev]   https://developers.openai.com/codex/cli\n",
    );
    process.exitCode = 1;
    return;
  }

  let args = process.argv.slice(2);
  // Orca's account-specific CODEX_HOME can exceed the macOS Unix socket path
  // limit. Avoid the managed daemon without altering running sessions.
  if (!args.includes("--no-daemon")) args = ["--no-daemon", ...args];
  let close = () => {};
  const statusId = `codex-${process.pid}`;
  process.env.JEV_CODEX_STATUS_ID = statusId;
  if (process.env.JEV_API_KEY || process.env.TYPESAFE_API_KEY) {
    const proxy = await startCodexProxy({ statusId, ...executionWorkspace('codex', args) });
    close = proxy.close;
    args = codexArgs(`http://127.0.0.1:${proxy.port}`, args);
  } else {
    const code = checkKey("jev-codex");
    if (code != null) {
      process.exitCode = code;
      return;
    }
  }

  const childArgs = [...command.prefix, ...args];
  const child = spawn(
    command.file,
    command.shell ? childArgs.map((arg) => (/\s/.test(arg) ? `"${arg}"` : arg)) : childArgs,
    { stdio: "inherit", shell: command.shell, env: childEnv() },
  );
  child.on("error", (err) => {
    close();
    process.stderr.write(`[jev] could not start Codex: ${err.message}\n`);
    process.exitCode = 1;
  });
  child.on("exit", (code, signal) => {
    close();
    process.exitCode = signal ? 1 : (code ?? 0);
  });
}
