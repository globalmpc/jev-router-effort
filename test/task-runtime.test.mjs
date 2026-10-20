import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { createTaskRuntime, RoutingHoldError } from '../src/task-runtime.mjs';
import { taskProfile, selectEvidence, supportedRule } from '../src/evidence-policy.mjs';
import { decide } from '../src/policy.mjs';
import { executionWorkspace } from '../src/execution-workspace.mjs';
import { routingContext } from '../src/router.mjs';
import { startProxy, conversationKey } from '../src/proxy.mjs';
import { startAgyProxy, agyConversationKey } from '../src/agy-proxy.mjs';
import { startCodexProxy, codexConversationKey } from '../src/codex-proxy.mjs';
import { startGlmProxy } from '../src/glm-proxy.mjs';
// Korean keywords are written as \u escapes so the source stays English-only.

const original = '\uAE30\uC874 \uC571\uC5D0 Exporter \uD50C\uB7EC\uADF8\uC778\uC744 \uCD94\uAC00\uD574. \uC2B9\uC778\uACFC \uAC70\uC808 \uD6C4 \uC790\uB3D9 \uBC1C\uD589\uD558\uACE0 \uCE98\uB9B0\uB354\uC5D0 \uC2A4\uCF00\uC904\uC744 \uBCF4\uC5EC\uC918. \uC2AC\uB799 \uBC18\uC751\uC740 \uB9E4\uC77C \uBD84\uC11D\uD558\uACE0 3\uC77C \uB4A4 \uBA48\uCDB0.';
const models = [{ id: 'cheap', tier: 'haiku', efforts: ['low'] }, { id: 'strong-v1', tier: 'opus', efforts: ['high'] }];
const answer = { choice: 'cheap', confidence: 0.8, effort: 'low' };
const now = Date.now();
const rule = { id: 'r1', taskType: 'cross-module-change', cli: 'claude', model: 'strong-v1', effort: 'high', outcome: 'prefer',
  sampleSize: 5, successes: 5, failures: 0, unknown: 0, evidenceIds: ['a', 'b', 'c', 'd', 'e'], status: 'validated' };
const policy = { schemaVersion: 1, version: 'test', generatedAt: new Date(now).toISOString(), rules: [rule] };
function fixture(t, options = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'jev-task-test-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const policyPath = join(cwd, 'policy.json');
  writeFileSync(policyPath, JSON.stringify(options.policy ?? { ...policy, rules: [] }));
  const config = { enabled: true, schemaVersion: 1, stateDir: join(cwd, 'state'), policyPath,
    externalCatalog: { codex: { models: { 'strong-v1': { efforts: ['high'], evidence: ['test-catalog'], checkedAt: new Date(now).toISOString() } } } }, ...options.config };
  return { cwd, config, runtime: createTaskRuntime({ cli: 'claude', cwd, route: async () => answer, ...options, config }) };
}

test('Exporter is a coupled mutating task; long factual prose alone is not', () => {
  assert.equal(taskProfile(original).taskType, 'cross-module-change');
  assert.equal(taskProfile(original).complex, true);
  assert.equal(taskProfile('Summarize this article. '.repeat(100)).complex, false);
  assert.equal(taskProfile('Rename one file').complex, false);
});

test('checkpoint workspace follows Codex -C/--cd and refuses ambiguous roots', () => {
  for (const args of [['-C', '../target'], ['--cd=../target'], ['-C../target']]) {
    assert.equal(executionWorkspace('codex', args, '/work/source').cwd, '/work/target');
  }
  assert.ok(executionWorkspace('claude', ['--add-dir', '/elsewhere'], '/work').workspaceError);
  assert.ok(executionWorkspace('codex', ['--worktree'], '/work').workspaceError);
  assert.ok(executionWorkspace('antigravity', ['--project', 'another'], '/work').workspaceError);
  assert.equal(executionWorkspace('claude', ['--add-dir', '/work/src'], '/work').workspaceError, null);
});

test('JEV receives bounded task context, not the full private failure corpus', () => {
  const sent = routingContext({ objective: 'o'.repeat(6000), recentRequests: Array(4).fill('r'.repeat(6000)),
    failures: Array(8).fill({ text: 'f'.repeat(6000), source: 'user' }), taskType: 'analysis' });
  assert.equal(sent.objective.length, 3000);
  assert.equal(sent.recentRequests.length, 2);
  assert.equal(sent.failures.length, 2);
  assert.ok(JSON.stringify(sent).length < 6500);
});

test('stale external availability keeps fallback without launching or fencing', async t => {
  let launches = 0;
  const { runtime } = fixture(t, { policy: { ...policy, rules: [{ ...rule, cli: 'codex' }] },
    config: { handoff: true, externalModels: [{ cli: 'codex', id: 'strong-v1', efforts: ['high'] }], externalCatalog: {} },
    handoff: () => { launches++; } });
  assert.equal((await runtime.route({ prompt: original, taskKey: 'a', models })).choice, 'cheap');
  assert.doesNotThrow(() => runtime.assertLocal('a'));
  assert.equal(launches, 0);
});

test('a prelaunch rejection holds this turn without a permanent writer fence', async t => {
  const { runtime } = fixture(t, { policy: { ...policy, rules: [{ ...rule, cli: 'codex' }] },
    config: { handoff: true, externalModels: [{ cli: 'codex', id: 'strong-v1', efforts: ['high'] }] },
    checkpoint: async () => ({ ok: true, commit: 'abc', ref: 'refs/jev/checkpoints/test' }),
    handoff: async () => { throw Object.assign(new Error('not installed'), { code: 'executor_unavailable' }); } });
  await assert.rejects(runtime.route({ prompt: original, taskKey: 'a', models }), /before launch/);
  assert.doesNotThrow(() => runtime.assertLocal('a'));
});

test('empty evidence preserves the original recommendation; disabled runtime is transparent', async t => {
  const { runtime } = fixture(t);
  const result = await runtime.route({ prompt: original, taskKey: 'a', models });
  assert.equal(result.choice, answer.choice);
  assert.equal(result.evidence, undefined);
  assert.equal(createTaskRuntime({ route: () => answer, config: { enabled: false } }).route(), answer);
});

test('minimum support, duplicate evidence, expiry and unsupported effort cause abstention', () => {
  for (const r of [
    { ...rule, sampleSize: 1, successes: 1 }, { ...rule, evidenceIds: ['a', 'a', 'a', 'a', 'a'] },
    { ...rule, status: 'candidate' }, { ...rule, sampleSize: 9 },
    { ...rule, generatedAt: '2020-01-01T00:00:00Z' },
    { ...rule, evidenceAt: '2020-01-01T00:00:00Z', generatedAt: new Date(now).toISOString() },
  ]) assert.equal(supportedRule(r, policy, now), false);
  assert.equal(selectEvidence({ policy, taskType: rule.taskType, cli: 'claude', models, efforts: ['high'], now }).kind, 'local');
  assert.equal(selectEvidence({ policy, taskType: rule.taskType, cli: 'claude', models: [{ id: 'strong-v1', efforts: ['low'] }], now }).kind, 'fallback');
  assert.equal(selectEvidence({ policy, taskType: rule.taskType, cli: 'claude', models, manualEffort: 'low', now }).kind, 'fallback');
});

test('continuation and restart keep original objective and deduplicate reported failures', async t => {
  let observed;
  const { runtime, config, cwd } = fixture(t, { route: async input => { observed = input; return answer; } });
  await runtime.route({ prompt: original, taskKey: 'a', models });
  const restarted = createTaskRuntime({ cli: 'claude', cwd, config, route: async input => { observed = input; return answer; } });
  await restarted.route({ prompt: '\uC9C4\uD589\uD574', taskKey: 'a', models });
  assert.equal(observed.taskContext.objective, original);
  assert.equal(observed.taskContext.complex, true);
  await restarted.route({ prompt: '\uBA54\uB274\uAC00 \uAE68\uC84C\uC5B4. \uBCF5\uAD6C\uD574', taskKey: 'a', models });
  await restarted.route({ prompt: '\uBA54\uB274\uAC00 \uAE68\uC84C\uC5B4. \uBCF5\uAD6C\uD574', taskKey: 'a', models });
  assert.equal(observed.taskContext.failures.length, 1);
  assert.equal(readFileSync(join(config.stateDir, 'feedback.jsonl'), 'utf8').trim().split('\n').length, 1);
});

test('checkpoints precede selected task execution, and failure is never fail-open', async t => {
  const events = [];
  const { runtime } = fixture(t, { config: { checkpoint: true }, checkpoint: async () => {
    events.push('checkpoint'); return { ok: true, commit: 'abc', ref: 'refs/jev/checkpoints/test' };
  } });
  const result = await runtime.route({ prompt: original, models });
  events.push('ready-to-execute');
  assert.deepEqual(events, ['checkpoint', 'ready-to-execute']);
  assert.equal(result.checkpoint.commit, 'abc');
  const { runtime: broken } = fixture(t, { config: { checkpoint: true }, checkpoint: async () => { throw new Error('locked'); } });
  await assert.rejects(broken.route({ prompt: original, models }), err => err.routingHold && /locked/.test(err.message));
});

test('validated local evidence beats generic choice without falsifying confidence', async t => {
  const { runtime } = fixture(t, { policy });
  const result = await runtime.route({ prompt: original, models, efforts: ['low', 'high'] });
  assert.equal(result.choice, rule.model);
  assert.equal(result.effort, 'high');
  assert.equal(result.confidence, null);
  assert.equal(result.evidence.originalConfidence, 0.8);
  assert.equal(result.evidence.ruleId, rule.id);
  assert.equal(decide({ prompt: original, current: 'haiku', available: ['haiku', 'opus'], jev: { ...result, choice: 'opus' } }).reason, 'evidence');
});

test('external handoff persists local hold across retries, continuations and restarts', async t => {
  let calls = 0;
  const externalRule = { ...rule, cli: 'codex' };
  const { runtime, config, cwd } = fixture(t, { policy: { ...policy, rules: [externalRule] },
    config: { checkpoint: true, handoff: true, externalModels: [{ cli: 'codex', id: 'strong-v1', efforts: ['high'] }] },
    checkpoint: async () => ({ ok: true, commit: 'abc', ref: 'refs/jev/checkpoints/test' }),
    handoff: async () => { calls++; return { delivery: { accepted: true, turnStarted: true }, state: 'turn_started' }; } });
  await assert.rejects(runtime.route({ prompt: original, taskKey: 'a', models }), /Delegated/);
  await assert.rejects(runtime.route({ prompt: original, taskKey: 'a', models }), /handed off/);
  assert.throws(() => runtime.assertLocal('a'), /handed off/);
  const restarted = createTaskRuntime({ cli: 'claude', route: () => answer, cwd, config });
  assert.throws(() => restarted.assertLocal('a'), /handed off/);
  assert.equal(calls, 1);
  assert.equal(readdirSync(join(config.stateDir, 'tasks')).length, 1);
});

test('explicit model override is preserved', async t => {
  const { runtime } = fixture(t, { policy });
  const result = await runtime.route({ prompt: 'use haiku. ' + original, models, efforts: ['high'] });
  assert.equal(result.evidence, undefined);
  assert.equal(decide({ prompt: 'use haiku', current: 'opus', available: ['haiku', 'opus'], jev: { choice: 'opus', evidence: { enforced: true } } }).tier, 'haiku');
});

test('accepted input is held but never reported as an observed executor start', async t => {
  const { runtime, config } = fixture(t, { policy: { ...policy, rules: [{ ...rule, cli: 'codex' }] },
    config: { handoff: true, externalModels: [{ cli: 'codex', id: 'strong-v1', efforts: ['high'] }] },
    checkpoint: async () => ({ ok: true, commit: 'abc', ref: 'refs/jev/checkpoints/test' }),
    handoff: async () => ({ delivery: { accepted: true, turnStarted: false }, state: 'accepted_unverified' }) });
  await assert.rejects(runtime.route({ prompt: original, taskKey: 'a', models }), /start unverified/);
  const task = JSON.parse(readFileSync(join(config.stateDir, 'tasks', readdirSync(join(config.stateDir, 'tasks'))[0]), 'utf8'));
  assert.equal(task.handoff.state, 'accepted_unverified');
  assert.throws(() => runtime.assertLocal('a'), /handed off/);
});

test('unknown effort and conflicting external evidence cannot authorize a handoff', () => {
  const noEffort = { ...rule, effort: null };
  assert.equal(selectEvidence({ policy: { ...policy, rules: [noEffort] }, taskType: rule.taskType, cli: 'claude', models, now }).kind, 'fallback');
  const prefer = { ...rule, cli: 'codex' };
  const avoid = { ...prefer, id: 'avoid', outcome: 'avoid', successes: 1, failures: 4 };
  assert.equal(selectEvidence({ policy: { ...policy, rules: [prefer, avoid] }, taskType: rule.taskType, cli: 'claude', models,
    externalModels: [{ cli: 'codex', id: 'strong-v1', efforts: ['high'] }], now }).kind, 'fallback');
});

test('a second runtime cannot race the same task while the first is classifying', async t => {
  let finish;
  const ready = new Promise(resolve => { finish = resolve; });
  const { runtime, cwd, config } = fixture(t, { route: () => ready });
  const first = runtime.route({ prompt: original, taskKey: 'same', models });
  await new Promise(resolve => setImmediate(resolve));
  const second = createTaskRuntime({ cli: 'claude', cwd, config, route: async () => answer });
  await assert.rejects(second.route({ prompt: original, taskKey: 'same', models }), /holds/);
  finish(answer);
  await first;
  await second.route({ prompt: 'continue', taskKey: 'same', models });
});

test('final-model validation catches generic policy retaining a disallowed model', async t => {
  const avoid = { ...rule, outcome: 'avoid', successes: 1, failures: 4 };
  const { runtime } = fixture(t, { policy: { ...policy, rules: [avoid] } });
  await runtime.route({ prompt: original, taskKey: 'a', models });
  assert.throws(() => runtime.assertModel({ taskKey: 'a', model: 'strong-v1', effort: 'high' }), /Final model/);
  assert.doesNotThrow(() => runtime.assertModel({ taskKey: 'a', model: 'cheap', effort: 'low' }));
});

test('local evidence remains usable when JEV itself is unavailable', async t => {
  const { runtime } = fixture(t, { policy, route: async () => null });
  const result = await runtime.route({ prompt: original, models, efforts: ['high'] });
  assert.equal(result.choice, 'strong-v1');
  assert.equal(result.confidence, null);
});

test('runtime creates a real checkpoint with an unchanged branch and user index', async t => {
  const { runtime, cwd } = fixture(t, { config: { checkpoint: true } });
  const git = args => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  git(['init', '-q']);
  git(['config', 'user.name', 'runtime test']);
  git(['config', 'user.email', 'test@example.invalid']);
  writeFileSync(join(cwd, '.gitignore'), 'state/\n');
  writeFileSync(join(cwd, 'work.txt'), 'base');
  git(['add', '.']); git(['commit', '-qm', 'base']);
  const head = git(['rev-parse', 'HEAD']);
  writeFileSync(join(cwd, 'work.txt'), 'staged'); git(['add', 'work.txt']);
  const index = readFileSync(join(cwd, '.git/index'));
  writeFileSync(join(cwd, 'work.txt'), 'working');
  writeFileSync(join(cwd, 'untracked.txt'), 'untracked');
  const result = await runtime.route({ prompt: original, taskKey: 'real', models });
  assert.equal(git(['rev-parse', 'HEAD']), head);
  assert.deepEqual(readFileSync(join(cwd, '.git/index')), index);
  assert.equal(git(['show', `${result.checkpoint.commit}:work.txt`]), 'working');
  assert.equal(git(['show', `${result.checkpoint.indexCommit}:work.txt`]), 'staged');
  assert.equal(git(['show', `${result.checkpoint.commit}:untracked.txt`]), 'untracked');
});

// Exercise adapter catch boundaries with a real HTTP upstream: a hold must send zero generation requests.
for (const cli of ['claude', 'codex', 'antigravity', 'glm']) test(`${cli} adapter never forwards a held request`, async t => {
  let generation = 0;
  const catalog = cli === 'codex' ? { models: [{ slug: 'gpt-6-sol', supported_in_api: true, supported_reasoning_levels: [{ effort: 'high' }] }] }
    : { models: { 'gemini-pro-agent': { displayName: 'Pro' } }, defaultAgentModelId: 'gemini-pro-agent' };
  const upstream = http.createServer((req, res) => {
    req.resume(); req.on('end', () => {
      if (/models|fetchAvailableModels/.test(req.url)) return res.end(JSON.stringify(catalog));
      generation++; res.end('{}');
    });
  });
  await new Promise(r => upstream.listen(0, '127.0.0.1', r));
  t.after(() => upstream.close());
  const base = `http://127.0.0.1:${upstream.address().port}`;
  const options = { upstream: base, upstreamURL: base, chatgptBaseURL: base, apiBaseURL: base,
    runtimeConfig: { enabled: false }, route: async () => { throw new RoutingHoldError('checkpoint denied'); } };
  const factory = { claude: startProxy, codex: startCodexProxy, antigravity: startAgyProxy, glm: startGlmProxy }[cli];
  const proxy = await factory(options); t.after(proxy.close);
  const proxyBase = `http://127.0.0.1:${proxy.port}`;
  if (cli === 'antigravity') await fetch(proxyBase + '/v1internal:fetchAvailableModels', { method: 'POST', body: '{}' });
  const bodies = {
    claude: { model: 'jev-router', tools: [{ name: 'read', input_schema: { type: 'object' } }], messages: [{ role: 'user', content: original }] },
    codex: { model: 'jev-router', input: [{ type: 'additional_tools', tools: [{}] }, { role: 'user', content: original }] },
    antigravity: { model: 'jev-router', requestType: 'agent', request: { contents: [{ role: 'user', parts: [{ text: `<USER_REQUEST>${original}</USER_REQUEST>` }] }] } },
    glm: { model: 'glm-5.2', messages: [{ role: 'user', content: original }] },
  };
  const path = { claude: '/v1/messages', codex: '/responses', antigravity: '/v1internal:streamGenerateContent', glm: '/chat/completions' }[cli];
  const res = await fetch(proxyBase + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(bodies[cli]) });
  assert.equal(res.status, 409, await res.text());
  assert.equal(generation, 0);
});

for (const cli of ['claude', 'codex', 'antigravity']) test(`${cli} manual model cannot bypass an existing handoff fence`, async t => {
  const body = cli === 'claude'
    ? { model: 'claude-opus-5-5', tools: [], messages: [{ role: 'user', content: original }] }
    : cli === 'codex' ? { model: 'gpt-6-astra', input: [{ role: 'user', content: original }] }
      : { model: 'gemini-pro-agent', requestType: 'agent', request: { contents: [{ role: 'user', parts: [{ text: `<USER_REQUEST>${original}</USER_REQUEST>` }] }] } };
  const key = { claude: conversationKey, codex: codexConversationKey, antigravity: agyConversationKey }[cli](body);
  const { cwd, config } = fixture(t);
  const seed = createTaskRuntime({ cli, cwd, config, route: async () => answer });
  await seed.route({ prompt: original, taskKey: key, models });
  const file = join(config.stateDir, 'tasks', readdirSync(join(config.stateDir, 'tasks'))[0]);
  const task = JSON.parse(readFileSync(file));
  task.handoff = { state: 'delegated', target: { cli: 'codex' } };
  writeFileSync(file, JSON.stringify(task));
  let generation = 0;
  const upstream = http.createServer((req, res) => { generation++; req.resume(); res.end('{}'); });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve)); t.after(() => upstream.close());
  const base = `http://127.0.0.1:${upstream.address().port}`;
  const proxy = await { claude: startProxy, codex: startCodexProxy, antigravity: startAgyProxy }[cli]({
    cwd, runtimeConfig: config, route: async () => answer, upstream: base, upstreamURL: base, chatgptBaseURL: base, apiBaseURL: base });
  t.after(proxy.close);
  const path = { claude: '/v1/messages', codex: '/responses', antigravity: '/v1internal:streamGenerateContent' }[cli];
  const res = await fetch(`http://127.0.0.1:${proxy.port}${path}`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
  assert.equal(res.status, 409);
  assert.equal(generation, 0);
});
