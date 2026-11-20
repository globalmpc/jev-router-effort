import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

export const KEYCHAIN_SERVICE = "typesafe-ai-api";
const KEYCHAIN_TIMEOUT_MS = 3000;

/**
 * User-level env files, in precedence order. A `.env` in the launch directory is deliberately
 * not read: it belongs to whatever repository the user opened, and could redirect upstream
 * URLs such as CLOUD_CODE_URL or ZAI_BASE_URL together with the user's credentials.
 */
export function userEnvFiles(home = homedir()) {
  return [join(home, ".jev-router.env"), join(home, ".jev-claude.env")];
}

const hasKey = (env) => Boolean(env.JEV_API_KEY || env.TYPESAFE_API_KEY);

/**
 * Finds the Jev key. Order: the real environment, `~/.jev-router.env`, `~/.jev-claude.env`,
 * then the macOS Keychain. The Keychain step exists because launchers
 * are often exec'd directly (scripts, `orca terminal create --command`, agent launchers),
 * which skips the shell function that used to read it; those sessions then ran unrouted.
 * The key is put in `env` only and never printed.
 *
 * @returns {"env"|"env-file"|"keychain"|null} where the key came from
 */
export function loadJevKey({
  env = process.env,
  platform = process.platform,
  files = userEnvFiles(),
  loadEnvFile = (file) => process.loadEnvFile(file),
  execFile = execFileSync,
} = {}) {
  if (hasKey(env)) {
    // Still load the files: they may carry other settings (JEV_DEBUG, upstream URLs).
    for (const file of files) tryLoad(loadEnvFile, file);
    return "env";
  }
  for (const file of files) tryLoad(loadEnvFile, file);
  if (hasKey(env)) return "env-file";
  if (platform !== "darwin") return null;
  try {
    const key = String(
      execFile("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: KEYCHAIN_TIMEOUT_MS,
      }) ?? "",
    ).trim();
    if (key) {
      env.TYPESAFE_API_KEY = key;
      return "keychain";
    }
  } catch {
    // Locked, missing item, no `security`, or timed out: no key.
  }
  return null;
}

function tryLoad(loadEnvFile, file) {
  try {
    loadEnvFile(file);
  } catch {
    // Missing or unreadable; the key may come from elsewhere.
  }
}

export const requireKey = (env = process.env) => Boolean(env.JEV_REQUIRE && env.JEV_REQUIRE !== "0");

/** The no-key warning. Several lines on purpose: one line scrolled away under the TUI. */
export function noKeyWarning(cli, { env = process.env, home = homedir() } = {}) {
  const required = requireKey(env);
  const bar = "[jev] " + "=".repeat(64);
  return [
    bar,
    `[jev] JEV ROUTER OFF: no JEV_API_KEY or TYPESAFE_API_KEY found.`,
    required
      ? `[jev] JEV_REQUIRE is set, so ${cli} will not start without routing.`
      : `[jev] ${cli} starts WITHOUT routing. Every turn uses the CLI's own model.`,
    `[jev] Looked in: environment, ${join(home, ".jev-router.env")},`,
    `[jev]   ${join(home, ".jev-claude.env")}, macOS Keychain service "${KEYCHAIN_SERVICE}".`,
    `[jev] Fix: add JEV_API_KEY=... to ${join(home, ".jev-router.env")}, or`,
    `[jev]   security add-generic-password -s ${KEYCHAIN_SERVICE} -a "$USER" -w`,
    required ? null : `[jev] Set JEV_REQUIRE=1 to exit instead of starting unrouted.`,
    bar,
    "",
  ]
    .filter((line) => line !== null)
    .join("\n");
}

/**
 * Writes the warning when there is no key. Returns null when the launcher should continue
 * (key present, or fallback allowed) and an exit code when `JEV_REQUIRE` forbids fallback.
 */
export function checkKey(cli, { env = process.env, write = (s) => process.stderr.write(s) } = {}) {
  if (hasKey(env)) return null;
  write(noKeyWarning(cli, { env }));
  return requireKey(env) ? 3 : null;
}
