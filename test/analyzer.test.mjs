import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { bandOf, collect, dedupeSessions } from '../Analyzer/lib/collect.mjs';
import { appendFeedback, importRuntimeFeedback, normalizeFeedback, readFeedback, verifyFeedback } from '../Analyzer/lib/feedback.mjs';
import { loadKnownCases, verifyKnownCase } from '../Analyzer/lib/known-cases.mjs';
import { compilePolicy, mergeObservations } from '../Analyzer/lib/policy.mjs';
import { decode } from '../Analyzer/lib/protobuf.mjs';
import { deriveEvidence, labelTemplate, validateLabel } from '../Analyzer/lib/review.mjs';
import { stratifiedSample } from '../Analyzer/lib/sample.mjs';
import { destructiveKinds, isSyntheticUserText, parseJevNotice, parseTestOutput } from '../Analyzer/lib/signals.mjs';
import { parseAntigravityFile } from '../Analyzer/lib/sources/antigravity.mjs';
import { parseClaudeFile } from '../Analyzer/lib/sources/claude.mjs';
import { extractCodexCommands, parseCodexFile } from '../Analyzer/lib/sources/codex.mjs';
import { jevPaths } from '../Analyzer/lib/sources/jev.mjs';
import { formatLocal, HOUR } from '../Analyzer/lib/util.mjs';
import { supportedRule } from '../src/evidence-policy.mjs';
// Korean keywords are written as \u escapes so the source stays English-only.

const CLI = fileURLToPath(new URL('../Analyzer/cli.mjs', import.meta.url));
const NOW = Date.parse('2026-09-29T21:16:04Z');
const iso = ms => new Date(ms).toISOString();

// ---- protobuf fixture encoder (the inverse of Analyzer/lib/protobuf.mjs) ----
const varint = n => {
  const out = [];
  let v = BigInt(n);
  do { let b = Number(v & 0x7fn); v >>= 7n; if (v) b |= 0x80; out.push(b); } while (v);
  return Buffer.from(out);
};
const field = (num, val) => {
  if (typeof val === 'number') return Buffer.concat([varint((num << 3) | 0), varint(val)]);
  const b = Buffer.isBuffer(val) ? val : Buffer.from(val, 'utf8');
  return Buffer.concat([varint((num << 3) | 2), varint(b.length), b]);
};
const msg = (...parts) => Buffer.concat(parts);
const stepMeta = ms => msg(field(1, msg(field(1, Math.floor(ms / 1000)), field(2, (ms % 1000) * 1e6))));

function makeAgyDb(file, t0) {
  const db = new DatabaseSync(file);
  db.exec('create table steps (idx integer primary key, step_type integer, status integer, has_subtrajectory numeric, metadata blob, error_details blob, permissions blob, task_details blob, render_info blob, step_payload blob, step_format integer)');
  db.exec('create table gen_metadata (idx integer primary key, data blob, size integer)');
  const put = db.prepare('insert into steps (idx, step_type, status, metadata, step_payload) values (?, ?, 3, ?, ?)');
  const cmd = 'git reset --hard HEAD && git clean -fd';
  put.run(0, 14, stepMeta(t0), msg(field(1, 14), field(19, msg(field(2, 'Exporter \uD50C\uB7EC\uADF8\uC778\uC744 \uCD94\uAC00\uD574\uC918')))));
  put.run(1, 15, stepMeta(t0 + 1000), msg(field(1, 15), field(20, msg(field(1, '[Jev] routed this turn to gemini-pro-agent (jev, confidence 0.57).\n\nAdding the plugin now.')))));
  put.run(2, 14, stepMeta(t0 + 60_000), msg(field(1, 14), field(19, msg(field(2, 'UI \uB97C \uAE68\uBA39\uC5C8\uC5B4. \uC774\uC804 \uCEE4\uBC0B\uC744 \uD655\uC778\uD574\uC11C \uC6D0\uC0C1 \uBCF5\uADC0\uD574')))));
  put.run(3, 15, stepMeta(t0 + 61_000), msg(field(1, 15), field(20, msg(
    field(1, 'Restoring the previous state.'),
    field(7, msg(field(1, 'call_1'), field(2, 'run_command'), field(3, JSON.stringify({ CommandLine: cmd, Cwd: '/w' })))),
  ))));
  put.run(4, 132, stepMeta(t0 + 62_000), msg(field(1, 132),
    field(140, msg(field(2, msg(field(1, '\nThe command exited with code 0.\nOutput:\n<truncated 3 lines>\nRemoving docs/a.md\nRemoving issue/old/\n'))))),
    field(148, msg(field(4, cmd)))));
  db.prepare('insert into gen_metadata (idx, data, size) values (0, ?, 0)').run(msg(field(1, msg(
    field(20, msg(field(1, 'model_enum'), field(2, 'MODEL_PLACEHOLDER_M1'))),
    field(20, msg(field(1, 'model'), field(2, 'gemini-pro-default'))),
  ))));
  db.close();
}

function jsonl(file, rows) {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
}

function claudeRows(t0, sessionId = 'sess-claude-1') {
  const base = { sessionId, cwd: '/w/app', version: '2.1.0', entrypoint: 'cli' };
  return [
    { ...base, type: 'user', timestamp: iso(t0), message: { role: 'user', content: 'parser.js \uC758 \uC2E4\uD328\uD558\uB294 \uD14C\uC2A4\uD2B8\uB97C \uACE0\uCCD0\uC918' } },
    { ...base, type: 'assistant', timestamp: iso(t0 + 1000), effort: 'high', message: { model: 'claude-opus-5-5', content: [
      { type: 'text', text: '[Jev] routed this turn to claude-opus-5-5 (jev, confidence 0.80, effort auto → high).' },
      { type: 'tool_use', id: 'e1', name: 'Edit', input: { file_path: '/w/app/src/parser.js' } },
    ] } },
    { ...base, type: 'assistant', timestamp: iso(t0 + 2000), effort: 'high', message: { model: 'claude-opus-5-5', content: [
      { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } },
    ] } },
    { ...base, type: 'user', timestamp: iso(t0 + 3000), message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 't1', content: 'ℹ pass 12\nℹ fail 0', is_error: false },
    ] } },
    { ...base, type: 'assistant', timestamp: iso(t0 + 4000), effort: 'high', message: { model: 'claude-opus-5-5', content: [{ type: 'text', text: 'Done. All tests pass.' }] } },
    { ...base, type: 'user', timestamp: iso(t0 + 5000), message: { role: 'user', content: '<system-reminder>ignored</system-reminder>' } },
    { ...base, type: 'user', timestamp: iso(t0 + 6000), message: { role: 'user', content: '\uC798 \uB41C\uB2E4 \uACE0\uB9C8\uC6CC' } },
    { ...base, type: 'assistant', timestamp: iso(t0 + 7000), effort: 'high', message: { model: 'claude-opus-5-5', content: [{ type: 'text', text: 'Glad it works.' }] } },
  ];
}

function codexRows(t0, id = 'codex-thread-1') {
  return [
    { timestamp: iso(t0), type: 'session_meta', payload: { id, cwd: '/w/router', originator: 'codex-tui', source: 'cli', model_provider: 'jev', cli_version: '0.158.0' } },
    { timestamp: iso(t0), type: 'turn_context', payload: { model: 'jev-router', collaboration_mode: { settings: { reasoning_effort: 'auto' } } } },
    { timestamp: iso(t0 + 100), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>cwd</environment_context>' }] } },
    { timestamp: iso(t0 + 200), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'explain the routing tests' }] } },
    { timestamp: iso(t0 + 300), type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '[Jev] routed this turn to gpt-6-sol (jev, confidence 0.60, effort auto → low (0.74)).' }] } },
    { timestamp: iso(t0 + 400), type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'c1', input: 'const r = await tools.exec_command({"cmd":"npm test","workdir":"/w/router"}); text(r.output)' } },
    { timestamp: iso(t0 + 500), type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c1', output: [{ type: 'input_text', text: 'Script completed\nOutput:\n' }, { type: 'input_text', text: '# pass 5\n# fail 1' }] } },
    { timestamp: iso(t0 + 600), type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'One test fails; here is why.' }] } },
  ];
}

function fixtureHome() {
  const home = mkdtempSync(join(tmpdir(), 'jev-analyzer-'));
  const t0 = NOW - 2 * HOUR;
  jsonl(join(home, '.claude', 'projects', '-w-app', 'sess-claude-1.jsonl'), claudeRows(t0));
  // The same session copied into a second file (resume) must dedupe to one session.
  jsonl(join(home, '.claude', 'projects', '-w-app-copy', 'sess-claude-1.jsonl'), claudeRows(t0));
  // A session entirely after `now` belongs to post-freeze traffic and is excluded.
  jsonl(join(home, '.claude', 'projects', '-w-app', 'sess-late.jsonl'), claudeRows(NOW + HOUR, 'sess-late'));
  jsonl(join(home, '.codex', 'sessions', '2026', '09', '29', 'rollout-codex-thread-1.jsonl'), codexRows(t0));
  jsonl(join(home, '.codex', 'sessions', '2026', '09', '28', 'rollout-old.jsonl'), codexRows(NOW - 30 * HOUR, 'codex-old'));
  const agy = join(home, '.gemini', 'antigravity-cli', 'conversations');
  mkdirSync(agy, { recursive: true });
  makeAgyDb(join(agy, 'exporter-fixture.db'), t0);
  const status = join(home, 'tmp', 'jev-claude');
  mkdirSync(status, { recursive: true });
  writeFileSync(join(status, 'sess-claude-1.json'), JSON.stringify({ tier: 'opus', model: 'claude-opus-5-5', effort: 'high', confidence: 0.8, reason: 'jev', at: t0, prompt: 'parser.js \uC758 \uC2E4\uD328\uD558\uB294 \uD14C\uC2A4\uD2B8\uB97C \uACE0\uCCD0\uC918' }));
  return home;
}

const sourcesFor = home => ({
  claudeRoots: [join(home, '.claude', 'projects')],
  codexRoots: [{ root: join(home, '.codex', 'sessions'), account: 'default' }],
  antigravityRoot: join(home, '.gemini', 'antigravity-cli', 'conversations'),
  jev: jevPaths(home),
});

const cli = (args, env = {}) => JSON.parse(execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'ignore'] }));

// ---------------------------------------------------------------- parsers

test('protobuf decoder keeps text fields and nested messages apart', () => {
  const leaves = decode(msg(field(1, 15), field(20, msg(field(1, 'hello'), field(7, msg(field(2, 'run_command')))))));
  assert.deepEqual(leaves.filter(l => l[1] === 'str'), [['.20.1', 'str', 'hello'], ['.20.7.2', 'str', 'run_command']]);
  assert.equal(decode(Buffer.from([0x08])), null, 'truncated varint is not a message');
});

test('Claude parser records exact model, effort, commands, exit status and notices', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jev-claude-'));
  const file = join(dir, 'sess-claude-1.jsonl');
  jsonl(file, claudeRows(NOW - HOUR));
  const s = parseClaudeFile(file);
  assert.equal(s.sessionId, 'sess-claude-1');
  const a = s.events.find(e => e.type === 'assistant');
  assert.equal(a.model, 'claude-opus-5-5');
  assert.equal(a.effort, 'high');
  const cmd = s.events.find(e => e.type === 'command');
  assert.equal(cmd.cmd, 'npm test');
  assert.equal(cmd.exitCode, 0);
  assert.equal(cmd.exitSource, 'claude-tool-success');
  assert.equal(s.events.filter(e => e.type === 'notice')[0].effort, 'high');
  assert.equal(s.events.filter(e => e.type === 'edit').length, 1);
});

test('Codex parser resolves the routed model from the JEV notice and reads quoted exec commands', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jev-codex-'));
  const file = join(dir, 'rollout.jsonl');
  jsonl(file, codexRows(NOW - HOUR));
  const s = parseCodexFile(file, 'orca-acct');
  assert.equal(s.sessionId, 'codex-thread-1');
  const users = s.events.filter(e => e.type === 'user');
  assert.equal(users.length, 1, 'environment_context is harness text, not a user');
  const a = s.events.find(e => e.type === 'assistant');
  assert.deepEqual([a.model, a.effort, a.modelSource], ['gpt-6-sol', 'low', 'jev-notice']);
  assert.deepEqual(extractCodexCommands('tools.exec_command({cmd:"ls -la", workdir:"/"})'), ['ls -la']);
  assert.equal(s.events.find(e => e.type === 'command').cmd, 'npm test');
});

test('Antigravity parser reads user/model/tool steps from a read-only SQLite conversation', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jev-agy-'));
  const file = join(dir, 'conv.db');
  makeAgyDb(file, NOW - HOUR);
  const before = readFileSync(file);
  const s = parseAntigravityFile(file);
  assert.deepEqual(readFileSync(file), before, 'source database is not modified');
  assert.equal(s.events.filter(e => e.type === 'user').length, 2);
  assert.equal(s.events.find(e => e.type === 'notice').model, 'gemini-pro-agent');
  const cmd = s.events.find(e => e.type === 'command');
  assert.equal(cmd.exitCode, 0);
  assert.equal(cmd.resultRef, 'step4');
  assert.deepEqual(s.observedModels.map(m => m.model), ['gemini-pro-default']);
  assert.deepEqual(s.modelEnums.map(m => m.value), ['MODEL_PLACEHOLDER_M1']);
});

test('signal helpers: notices, runner summaries, destructive commands, harness text', () => {
  assert.deepEqual(parseJevNotice('[Jev] routed this turn to gpt-5.6-luna (jev, confidence 0.60, effort auto → low (0.74)).'),
    { model: 'gpt-5.6-luna', reason: 'jev', confidence: 0.6, effort: 'low' });
  assert.equal(parseTestOutput('# pass 97\n# fail 0').verdict, 'pass');
  assert.equal(parseTestOutput('Ran 101 tests in 3.2s\n\nFAILED (failures=1, errors=24)').failed, 25);
  assert.equal(parseTestOutput('ok 1 - a\nnot ok 2 - b').verdict, 'unknown', 'TAP lines alone are not a verdict');
  assert.deepEqual(destructiveKinds('git reset --hard HEAD && git clean -fd'), ['git reset --hard', 'git clean -f']);
  assert.equal(isSyntheticUserText('<task-notification>done</task-notification>'), true);
});

// ---------------------------------------------------------------- denominator, dedupe, sample

test('collect: window, same-session dedupe, post-now exclusion and routing split', () => {
  const home = fixtureHome();
  const r = collect({ now: NOW, windowMs: 24 * HOUR, sources: sourcesFor(home) });
  const byKey = new Map(r.sessions.map(s => [s.key, s]));
  assert.equal(r.inventory.dedupe.mergedFiles, 1);
  assert.equal(byKey.get('claude:sess-claude-1').routing, 'jev-routed');
  assert.equal(byKey.get('claude:sess-claude-1').exclusion, null);
  assert.equal(byKey.get('claude:sess-late').exclusion, 'started-after-now');
  assert.equal(byKey.get('codex:codex-thread-1').routing, 'jev-routed');
  assert.ok(!byKey.has('codex:codex-old') || byKey.get('codex:codex-old').exclusion, 'older than the window');
  const agy = byKey.get('antigravity:exporter-fixture');
  assert.equal(agy.destructive.length, 1);
  const claude = byKey.get('claude:sess-claude-1');
  assert.equal(claude.followUps.length, 1, 'system-reminder is not a human follow-up');
  assert.deepEqual(claude.followUps[0].priorModels, [{ model: 'claude-opus-5-5', effort: 'high', turns: 3 }]);
  assert.equal(claude.testRuns[0].afterLastEdit, true);
});

test('dedupeSessions merges files and drops identical events', () => {
  const ev = { type: 'user', at: 1, text: 'x', ref: 'L1' };
  const { sessions, mergedFiles, droppedEvents } = dedupeSessions([
    { cli: 'claude', sessionId: 'a', files: ['f1'], events: [ev], parseErrors: 0 },
    { cli: 'claude', sessionId: 'a', files: ['f2'], events: [ev], parseErrors: 0 },
  ]);
  assert.equal(sessions.length, 1);
  assert.equal(mergedFiles, 1);
  assert.equal(droppedEvents, 1);
});

test('stratified sample covers >=20% of every stratum, is deterministic and band-stable', () => {
  const mk = (n, band, cli) => Array.from({ length: n }, (_, i) => ({ key: `${cli}:${band}:${i}`, band, cli, routing: 'jev-routed', kind: 'interactive' }));
  const day1 = [...mk(11, '0-24h', 'claude'), ...mk(3, '0-24h', 'codex')];
  const both = [...day1, ...mk(9, '24-48h', 'claude')];
  const a = stratifiedSample(day1, { seed: 's' });
  const b = stratifiedSample(both, { seed: 's' });
  for (const st of b.strata) assert.ok(st.sampled >= 0.2 * st.eligible && st.sampled >= 1);
  assert.deepEqual(a, stratifiedSample(day1, { seed: 's' }));
  const firstDay = p => p.filter(x => x.stratum.startsWith('0-24h')).map(x => x.key).sort();
  assert.deepEqual(firstDay(a.picks), firstDay(b.picks), '48h run keeps the 24h picks');
  assert.ok(a.coverage >= 0.2);
  const withKnown = stratifiedSample(day1, { seed: 's', purposive: ['codex:0-24h:0', 'codex:0-24h:1', 'codex:0-24h:2'] });
  assert.equal(withKnown.randomSampled, a.randomSampled, 'purposive picks do not inflate coverage');
});

test('bandOf and local dates use the configured time zone', () => {
  assert.equal(bandOf(NOW - HOUR, NOW), '0-24h');
  assert.equal(bandOf(NOW - 30 * HOUR, NOW), '24-48h');
  assert.equal(formatLocal(NOW, 'Asia/Kolkata'), '2026-09-30 02:46 (Asia/Kolkata)');
  assert.equal(formatLocal(NOW, 'UTC'), '2026-09-29 21:16 (UTC)');
});

// ---------------------------------------------------------------- provenance and unknowns

test('labels need cited user/QA/test provenance; assistant completion never counts', () => {
  const home = fixtureHome();
  const r = collect({ now: NOW, windowMs: 24 * HOUR, sources: sourcesFor(home) });
  const s = r.sessions.find(x => x.key === 'claude:sess-claude-1');
  const opus = { cli: 'claude', model: 'claude-opus-5-5', effort: 'high' };
  const base = { ...labelTemplate(s), reviewed: true, attribution: opus };
  const fu = s.followUps[0].ref;
  assert.deepEqual(validateLabel(base, s), [], 'unknown is always acceptable');
  assert.match(validateLabel({ ...base, outcome: 'success' }, s).join(), /basis/);
  assert.match(validateLabel({ ...base, outcome: 'success', basis: 'user', citations: ['L99'] }, s).join(), /not present/);
  assert.match(validateLabel({ ...base, outcome: 'success', basis: 'user', citations: [s.lastAssistant.ref] }, s).join(), /human follow-up/, 'assistant text is not user evidence');
  assert.match(validateLabel({ ...base, outcome: 'success', basis: 'qa', citations: [s.lastAssistant.ref] }, s).join(), /human follow-up/, 'relabelling a completion claim as qa fails');
  assert.match(validateLabel({ ...base, outcome: 'success', basis: 'user', citations: [fu, 'notes.md'] }, s).join(), /not present/, 'free-form citations are rejected');
  assert.match(validateLabel({ ...base, outcome: 'success', basis: 'user', citations: [fu], reviewed: false }, s).join(), /reviewed/);
  assert.deepEqual(validateLabel({ ...base, outcome: 'success', basis: 'user', citations: [fu] }, s), []);
  assert.match(validateLabel({ ...base, outcome: 'success', basis: 'user', citations: [fu], attribution: { ...opus, model: 'claude-sonnet-5-5' } }, s).join(), /does not match/);
  const testRef = s.testRuns[0].ref;
  assert.deepEqual(validateLabel({ ...base, outcome: 'success', basis: 'test', citations: [testRef] }, s), []);
  assert.match(validateLabel({ ...base, outcome: 'failure', basis: 'test', citations: [testRef] }, s).join(), /test basis/);
  assert.match(validateLabel({ ...base, outcome: 'success', basis: 'assistant', citations: [testRef] }, s).join(), /invalid basis/);
  const at = deriveEvidence('user', [fu], s);
  assert.deepEqual([at.attribution, at.evidenceAt], [opus, s.followUps[0].at], 'attribution and time come from the cited turn');
});

test('mixed sessions are not attributed by majority', () => {
  const home = fixtureHome();
  const r = collect({ now: NOW, windowMs: 24 * HOUR, sources: sourcesFor(home) });
  const s = structuredClone(r.sessions.find(x => x.key === 'claude:sess-claude-1'));
  s.followUps[0].priorModels = [{ model: 'claude-opus-5-5', effort: 'high', turns: 9 }, { model: 'claude-sonnet-5-5', effort: 'low', turns: 1 }];
  const d = deriveEvidence('user', [s.followUps[0].ref], s);
  assert.equal(d.attribution, null);
  assert.match(d.errors.join(), /more than one model/);
  s.followUps[0].priorModels = [];
  assert.match(deriveEvidence('user', [s.followUps[0].ref], s).errors.join(), /no observed model/);
});

test('policy compile abstains on unknown outcomes and unattributable models', () => {
  const obs = [
    { key: 'a', evidenceId: 'ev-a', outcome: 'unknown', basis: 'none', taskType: 'analysis', cli: 'claude', model: 'claude-opus-5-5', effort: 'high' },
    { key: 'b', evidenceId: 'ev-b', outcome: 'failure', basis: 'user', taskType: 'analysis', cli: 'antigravity', model: 'unknown', effort: null },
    { key: 'c', evidenceId: 'ev-c', outcome: 'success', basis: 'user', taskType: 'analysis', cli: 'codex', model: 'mixed', effort: null },
  ];
  const p = compilePolicy(obs, { now: NOW });
  assert.deepEqual(p.rules, []);
  assert.equal(p.abstained.length, 3);
});

test('policy compile validates only with enough independent known outcomes', () => {
  const mk = (n, outcome, extra = {}) => Array.from({ length: n }, (_, i) => ({ key: `${outcome}${i}`, evidenceId: `ev-${outcome}${i}`, outcome, basis: 'user', taskType: 'local-code-change', cli: 'claude', model: 'claude-opus-5-5', effort: 'high', evidenceAt: NOW - HOUR, ...extra }));
  const single = compilePolicy(mk(1, 'failure'), { now: NOW });
  assert.equal(single.rules[0].status, 'candidate', 'one failure is never a broad ban');
  const five = compilePolicy(mk(5, 'success'), { now: NOW });
  assert.equal(five.rules[0].status, 'validated');
  assert.ok(supportedRule(five.rules[0], five, NOW), 'runtime accepts what the compiler validated');
  const noEffort = compilePolicy(mk(5, 'success', { effort: null }), { now: NOW });
  assert.equal(noEffort.rules[0].status, 'candidate', 'unknown effort never validates as "any"');
  const fewAvoid = compilePolicy([...mk(3, 'failure'), ...mk(1, 'success')], { now: NOW });
  assert.deepEqual([fewAvoid.rules[0].outcome, fewAvoid.rules[0].status], ['avoid', 'candidate'], 'avoid needs >=5 known sessions too');
  const avoid = compilePolicy([...mk(4, 'failure'), ...mk(1, 'success')], { now: NOW });
  assert.deepEqual([avoid.rules[0].outcome, avoid.rules[0].status], ['avoid', 'validated']);
  const alias = compilePolicy(mk(5, 'failure', { cli: 'antigravity', model: 'gemini-pro-agent', effort: null }), { now: NOW });
  assert.equal(alias.rules[0].status, 'candidate', 'a JEV/AGY alias never backs a version-specific rule');
  const agyExact = compilePolicy(mk(5, 'success', { cli: 'antigravity', model: 'gemini-3.8-flash-low', effort: null }), { now: NOW });
  assert.equal(agyExact.rules[0].status, 'validated', 'an AGY model name that encodes its effort is specific');
});

test('check-level passes never count as policy success', () => {
  const mk = (n, extra = {}) => Array.from({ length: n }, (_, i) => ({ key: `k${i}`, evidenceId: `ev-k${i}`, outcome: 'success', basis: 'test', checkOnly: true, taskType: 'local-code-change', cli: 'claude', model: 'claude-opus-5-5', effort: 'high', evidenceAt: NOW - HOUR, ...extra }));
  const onlyChecks = compilePolicy(mk(6), { now: NOW });
  assert.deepEqual(onlyChecks.rules, []);
  assert.equal(onlyChecks.abstained[0].reason, 'only check-level passes');
  const mixed = compilePolicy([...mk(2), ...mk(1, { key: 'u', evidenceId: 'ev-u', basis: 'user', checkOnly: false })], { now: NOW });
  assert.deepEqual([mixed.rules[0].successes, mixed.rules[0].unknown, mixed.rules[0].checkOnlyPasses], [1, 2, 2]);
});

test('evidenceAt is the evidence time: recompiling does not renew it and old outcomes expire', () => {
  const day = 24 * HOUR;
  const mk = (n, at) => Array.from({ length: n }, (_, i) => ({ key: `e${at}${i}`, evidenceId: `ev-${at}-${i}`, outcome: 'success', basis: 'user', taskType: 'analysis', cli: 'codex', model: 'gpt-6-sol', effort: 'high', evidenceAt: at + i }));
  const obs = mk(5, NOW - 10 * day);
  const first = compilePolicy(obs, { now: NOW });
  const later = compilePolicy(obs, { now: NOW + 5 * day });
  assert.equal(first.rules[0].evidenceAt, new Date(NOW - 10 * day).toISOString());
  assert.equal(later.rules[0].evidenceAt, first.rules[0].evidenceAt, 'recompile keeps the evidence time');
  assert.equal(supportedRule(first.rules[0], first, NOW + 25 * day), false, 'runtime expires it 30 days after the evidence');
  const expired = compilePolicy(obs, { now: NOW + 45 * day });
  assert.deepEqual(expired.rules, []);
  assert.ok(expired.abstained.every(a => a.reason === 'evidence older than 30 days'));
  const undated = compilePolicy(obs.map(o => ({ ...o, evidenceAt: undefined })), { now: NOW });
  assert.deepEqual(undated.rules, [], 'an outcome without an evidence time is not counted');
});

// ---------------------------------------------------------------- feedback and known case

test('feedback intake validates, verifies with citations and imports runtime reports once', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jev-fb-'));
  const file = join(dir, 'feedback.jsonl');
  assert.throws(() => normalizeFeedback({ ref: 'ev-x', outcome: 'meh', source: 'user' }), /outcome/);
  assert.throws(() => normalizeFeedback({ ref: 'ev-x', outcome: 'failure', source: 'assistant' }), /source/);
  const rec = appendFeedback(file, normalizeFeedback({ ref: 'ev-x', outcome: 'failure', source: 'qa', 'authorized-by': 'transcript', note: 'broke UI' }, NOW));
  assert.equal(readFeedback(file)[0].verified, false);
  assert.throws(() => verifyFeedback(file, rec.id, { citations: [] }), /citations/);
  verifyFeedback(file, rec.id, { citations: ['step22'], reviewer: 'r', model: 'm1', sessionKey: 'antigravity:x' }, NOW);
  const [v] = readFeedback(file);
  assert.deepEqual([v.verified, v.model, v.sessionKey, v.authorizedBy], [true, 'm1', 'antigravity:x', 'transcript']);
  const rows = [{ id: 'r1', at: NOW, source: 'user-or-qa-report', text: 'still broken', taskId: 't1', cli: 'claude', model: 'claude-opus-5-5', verified: false }];
  assert.equal(importRuntimeFeedback(file, rows).length, 1);
  assert.equal(importRuntimeFeedback(file, rows).length, 0, 'runtime ids import once');
  const obs = mergeObservations([{ key: 'antigravity:x', evidenceId: 'ev-x', outcome: 'unknown', basis: 'none', taskType: 'cross-module-change', attribution: { cli: 'antigravity', model: 'm1', effort: null } }], readFeedback(file));
  assert.equal(obs.find(o => o.key === 'antigravity:x').outcome, 'failure', 'verified feedback overrides an unknown review label');
  assert.ok(!obs.some(o => o.key === 'runtime-task:t1'), 'unverified runtime reports are not counted');
});

test('known Exporter case separates the authorizing user from transcript instructions', () => {
  const home = fixtureHome();
  const file = join(home, 'known-cases.json');
  writeFileSync(file, JSON.stringify([{ id: 'exporter-destructive-recovery', key: 'antigravity:exporter-fixture', expected: 'failure', reportedBy: 'fixture' }]));
  const [kc] = loadKnownCases(file);
  assert.deepEqual(loadKnownCases(join(home, 'absent.json')), [], 'no private config means no known cases');
  writeFileSync(join(home, 'bad.json'), JSON.stringify([{ id: 'x' }]));
  assert.throws(() => loadKnownCases(join(home, 'bad.json')), /key/);
  const r = collect({ now: NOW, windowMs: 24 * HOUR, sources: sourcesFor(home), keepRawFor: [kc.key] });
  const summary = r.sessions.find(s => s.key === kc.key);
  const raw = r.raw[summary.key];
  const v = verifyKnownCase(kc, summary, raw);
  assert.equal(v.found, true);
  assert.deepEqual(v.destructive[0].kinds, ['git reset --hard', 'git clean -f']);
  assert.equal(v.destructive[0].exitCode, 0);
  assert.equal(v.deletionLinesShown, 2);
  assert.equal(v.deletionLinesTruncated, 3);
  assert.equal(v.reportedBy, 'fixture');
  assert.deepEqual(v.authorization.userAskedToRestore, ['step2']);
  assert.deepEqual(v.authorization.userAskedToDiscardOrClean, []);
  assert.match(v.authorization.conclusion, /^agent-chosen/);
  assert.equal(v.routingNotices[0].confidence, 0.57);
  const explicit = verifyKnownCase(kc, summary, [...raw, { type: 'user', ref: 'stepX', at: 0, text: 'git clean \uD574\uC11C untracked \uB2E4 \uC9C0\uC6CC' }]);
  assert.match(explicit.authorization.conclusion, /explicitly requested/);
  assert.equal(verifyKnownCase(kc, null).found, false);
});

// ---------------------------------------------------------------- CLI end to end and cold start

test('CLI cold start: empty home yields an empty sample and no rules', () => {
  const home = mkdtempSync(join(tmpdir(), 'jev-empty-'));
  const priv = join(home, 'private');
  const a = cli(['analyze', '--window', '24h', '--now', iso(NOW), '--home', home, '--private-dir', priv]);
  assert.deepEqual([a.distinct, a.eligible, a.sampledRandom], [0, 0, 0]);
  const c = cli(['compile', '--private-dir', priv, '--now', iso(NOW)]);
  assert.deepEqual([c.rules, c.validated], [0, 0]);
  const policy = JSON.parse(readFileSync(join(priv, 'proposed-policy.json'), 'utf8'));
  assert.equal(policy.schemaVersion, 1);
  assert.deepEqual(policy.rules, []);
});

test('CLI end to end: analyze → label → feedback → compile → redacted report', () => {
  const home = fixtureHome();
  const priv = join(home, 'private');
  const common = ['--home', home, '--private-dir', priv];
  mkdirSync(priv, { recursive: true });
  writeFileSync(join(priv, 'known-cases.json'), JSON.stringify([{ id: 'exporter-destructive-recovery', key: 'antigravity:exporter-fixture', expected: 'failure', reportedBy: 'fixture review' }]));
  const a = cli(['analyze', '--window', '24h', '--now', iso(NOW), ...common]);
  assert.equal(a.eligible, 3);
  assert.deepEqual(a.knownCases, [{ id: 'exporter-destructive-recovery', found: true, eligible: true }]);
  assert.ok(a.coverage >= 0.2);
  const review = JSON.parse(readFileSync(join(priv, 'runs', a.run, 'review.json'), 'utf8'));
  const claude = review.labels.find(l => l.key === 'claude:sess-claude-1');
  const inv = JSON.parse(readFileSync(join(priv, 'runs', a.run, 'inventory.json'), 'utf8'));
  const s = inv.sessions.find(x => x.key === 'claude:sess-claude-1');
  assert.throws(() => cli(['review', 'label', '--run', a.run, '--evidence', claude.evidenceId, '--outcome', 'success', '--basis', 'user', '--citations', 'L999', ...common]));
  cli(['review', 'label', '--run', a.run, '--evidence', claude.evidenceId, '--outcome', 'success', '--basis', 'user', '--citations', s.followUps[0].ref, '--task-type', 'local-code-change', '--reviewer', 'test', ...common]);
  const status = cli(['review', 'status', '--run', a.run, ...common]);
  assert.deepEqual([status.reviewed, status.success, status.problems.length], [1, 1, 0]);
  const fb = cli(['feedback', 'add', '--ref', 'antigravity:exporter-fixture', '--outcome', 'failure', '--source', 'user', '--cli', 'antigravity', '--model', 'gemini-pro-agent', '--task-type', 'cross-module-change', '--authorized-by', 'transcript', '--note', 'private text', ...common]);
  assert.equal(fb.sessionResolved, true);
  assert.throws(() => cli(['feedback', 'verify', '--id', fb.added, '--citations', 'step99', ...common]), 'unknown ref');
  assert.throws(() => cli(['feedback', 'verify', '--id', fb.added, '--citations', 'notes.md', ...common]), 'free-form string');
  assert.throws(() => cli(['feedback', 'verify', '--id', fb.added, '--citations', 'step3', ...common]), 'a command is not a user report');
  const ok = cli(['feedback', 'verify', '--id', fb.added, '--citations', 'step2,step3', '--reviewer', 'test', ...common]);
  assert.deepEqual(ok.attribution, { cli: 'antigravity', model: 'gemini-pro-agent', effort: null });
  // A hand-written "verified" record with made-up citations is dropped at compile time.
  appendFileSync(join(priv, 'feedback.jsonl'), JSON.stringify({ id: 'fb-forged', ref: 'claude:sess-claude-1', sessionKey: 'claude:sess-claude-1', outcome: 'failure', source: 'user', verified: true, citations: ['L1', 'made-up'], taskType: 'analysis' }) + '\n');
  const c = cli(['compile', '--now', iso(NOW), ...common]);
  assert.equal(c.rules, 2);
  assert.equal(c.validated, 0);
  assert.ok(c.problems.some(p => p.feedback === 'fb-forged'));
  const policy = JSON.parse(readFileSync(join(priv, 'proposed-policy.json'), 'utf8'));
  assert.equal(policy.provenance.verifiedFeedback, 1);
  assert.ok(policy.rules.every(r => Date.parse(r.evidenceAt) <= NOW), 'rules carry the evidence time, not the compile time');
  const out = join(home, 'report.md');
  cli(['report', '--out', out, ...common]);
  const md = readFileSync(out, 'utf8');
  assert.match(md, /Known case: exporter-destructive-recovery/);
  assert.match(md, /reported in fixture review/);
  assert.doesNotMatch(md, /sess-claude-1|exporter-fixture|private text|parser\.js|\/w\/app/, 'no raw ids, prompts, notes or paths');
});

test('shipped analyzer sources hold no raw session identifiers', () => {
  const root = fileURLToPath(new URL('../Analyzer/', import.meta.url));
  const files = [];
  const walk = d => { for (const e of readdirSync(d, { withFileTypes: true })) { if (e.name === 'private') continue; const p = join(d, e.name); e.isDirectory() ? walk(p) : files.push(p); } };
  walk(root);
  for (const f of files) {
    assert.doesNotMatch(readFileSync(f, 'utf8'), /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i, f);
  }
});
