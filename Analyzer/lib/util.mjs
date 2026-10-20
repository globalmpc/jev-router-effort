import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const HOUR = 3600_000;

/** Stable, non-reversible public identifier for a private session/file reference. */
export function redactId(value, prefix = 'ev') {
  return `${prefix}-${createHash('sha256').update(`jev-evidence:${value}`).digest('hex').slice(0, 10)}`;
}

export function sha(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

/** Parse "24h", "48h", "90m", "2d" into milliseconds. */
export function parseDuration(text) {
  const m = /^(\d+(?:\.\d+)?)\s*(m|h|d)$/i.exec(String(text).trim());
  if (!m) throw new Error(`Invalid duration: ${text}`);
  return Number(m[1]) * { m: 60_000, h: HOUR, d: 24 * HOUR }[m[2].toLowerCase()];
}

export function localTimeZone() {
  return process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

/** Local calendar date/time in the given zone, e.g. "2026-09-30 02:46 (Asia/Kolkata)". */
export function formatLocal(ms, timeZone = localTimeZone()) {
  if (!Number.isFinite(ms)) return 'unknown';
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(ms)).map(p => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute} (${timeZone})`;
}

export function localDate(ms, timeZone = localTimeZone()) {
  return formatLocal(ms, timeZone).slice(0, 10);
}

export function readJsonl(file) {
  const out = [];
  let text;
  try { text = readFileSync(file, 'utf8'); } catch { return out; }
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i]) continue;
    try { out.push({ line: i + 1, value: JSON.parse(lines[i]) }); } catch { out.push({ line: i + 1, parseError: true }); }
  }
  return out;
}

export function readJson(file, fallback = null) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; }
}

export function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
}

/** Recursively list files matching `test`, skipping unreadable directories. */
export function walk(root, test, { maxDepth = 8 } = {}) {
  const out = [];
  const visit = (dir, depth) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { if (depth < maxDepth) visit(p, depth + 1); } else if (test(p)) out.push(p);
    }
  };
  if (existsSync(root)) visit(root, 0);
  return out;
}

export function mtimeMs(file) {
  try { return statSync(file).mtimeMs; } catch { return NaN; }
}

export function clip(text, n = 240) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/** Minimal `--flag value` / `--flag` / positional parser. */
export function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, inline] = a.slice(2).split(/=(.*)/s);
      if (inline !== undefined) args[k] = inline;
      else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) args[k] = argv[++i];
      else args[k] = true;
    } else args._.push(a);
  }
  return args;
}

/** Keep the start and end of long tool output (runners print summaries last, markers first). */
export function headTail(text, head = 2000, tail = 4000) {
  const s = String(text ?? '');
  return s.length <= head + tail ? s : `${s.slice(0, head)}\n…[${s.length - head - tail} chars omitted]…\n${s.slice(-tail)}`;
}
