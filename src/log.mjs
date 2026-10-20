import { appendFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const LOG_FILE = join(homedir(), ".jev-claude.log");

// Claude Code owns the terminal in interactive mode and redraws over anything we print, so
// writing to stderr there corrupts its UI. Log to a file instead and leave stderr alone.
// In print mode (`-p`) there is no TUI to damage, so stderr stays convenient for piping.
const interactive = process.stdout.isTTY;

export function log(line) {
  const text = `[jev] ${line}\n`;
  if (!interactive) return void process.stderr.write(text);
  try {
    // Debug lines can include prompt excerpts, so a new log file is owner-only.
    appendFileSync(LOG_FILE, `${new Date().toISOString()} ${text}`, { mode: 0o600 });
  } catch {
    // A broken log file must never take down the session.
  }
}

export const debug = (line) => process.env.JEV_DEBUG && log(line);

/**
 * Writes a JEV_DUMP request body and returns its path, or null if it was skipped. Dumps hold
 * prompts and tool output, so they are owner-only and never written through an existing
 * file or symlink. `path` is for tests; callers use the JEV_DUMP prefix.
 */
export function writeDump(text, path = `${process.env.JEV_DUMP}.${Date.now()}.${process.pid}.json`) {
  try {
    writeFileSync(path, text, { mode: 0o600, flag: "wx" });
    return path;
  } catch (err) {
    log(`JEV_DUMP skipped: ${err.code ?? err.message}`);
    return null;
  }
}
