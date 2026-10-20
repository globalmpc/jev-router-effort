#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runtimeConfig } from '../src/task-runtime.mjs';
import { loadEvidencePolicy, supportedRule } from '../src/evidence-policy.mjs';

const args = process.argv.slice(2);
const command = args.shift();
function option(name, fallback) {
  const index = args.indexOf(`--${name}`);
  if (index < 0) return fallback;
  if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`--${name} needs a value`);
  return args[index + 1];
}
const json = value => process.stdout.write(JSON.stringify(value, null, 2) + '\n');
try {
  if (command === 'status') {
    const config = runtimeConfig();
    const policy = loadEvidencePolicy(config.policyPath);
    json({ enabled: !!config.enabled, checkpoint: !!config.checkpoint, handoff: !!config.handoff,
      policyVersion: policy.version ?? null, candidateRules: policy.rules.length,
      supportedRules: policy.rules.filter(r => supportedRule(r, policy)).map(r => ({ id: r.id, cli: r.cli, model: r.model, effort: r.effort, taskType: r.taskType })),
      stateDir: config.stateDir ?? '~/.local/state/jev-router' });
  } else if (command === 'checkpoint') {
    const { ensureCheckpoint } = await import('../src/checkpoint.mjs');
    json(await ensureCheckpoint({ cwd: option('cwd', process.cwd()), taskId: option('task', 'manual'), reason: option('reason', 'User-requested pre-execution checkpoint') }));
  } else if (command === 'handoff') {
    const { handoffTask, ensureCheckpoint } = { ...(await import('../src/handoff.mjs')), ...(await import('../src/checkpoint.mjs')) };
    const config = runtimeConfig();
    const cwd = option('cwd', process.cwd());
    const taskId = option('task');
    const packetFile = option('packet');
    if (!taskId || !packetFile) throw new Error('handoff needs --task ID --packet packet.json');
    const target = { cli: option('cli'), model: option('model'), effort: option('effort', null) };
    const packet = JSON.parse(readFileSync(packetFile, 'utf8'));
    const catalogFile = option('catalog');
    const catalog = catalogFile ? JSON.parse(readFileSync(catalogFile, 'utf8')) : config.externalCatalog;
    const execute = args.includes('--execute');
    const checkpoint = await ensureCheckpoint({ cwd, taskId, reason: 'Before cross-CLI delegation' });
    json(await handoffTask({ cwd, taskId, target, catalog, packet, checkpoint, execute }));
  } else if (command === 'capabilities') {
    const { discoverCatalog, catalogSummary, capabilityConfig } = await import('../src/capabilities.mjs');
    const config = runtimeConfig();
    const cli = option('cli', 'claude');
    json({ mode: capabilityConfig(config).mode, ...catalogSummary(discoverCatalog({ cli, cwd: option('cwd', process.cwd()), config: config.capabilityRouting ?? {} })) });
  } else if (command === 'routing-label') {
    const { addLabel } = await import('../src/routing-log.mjs');
    const config = runtimeConfig();
    const stateDir = option('state-dir', config.stateDir);
    json(addLabel({ stateDir, requestId: option('request'), dimension: option('dimension'), expected: option('expected', undefined),
      outcome: option('outcome', undefined), source: option('source'), evidence: option('evidence'), labeler: option('labeler', null) }));
  } else if (command === 'routing-report') {
    const { routingReport } = await import('../src/routing-log.mjs');
    const config = runtimeConfig();
    const since = option('since', null);
    const match = since && /^(\d+)(h|d)$/.exec(since);
    if (since && !match) throw new Error('--since needs a value like 24h or 7d');
    json(routingReport({ stateDir: option('state-dir', config.stateDir), dataset: option('dataset', 'live'),
      since: match ? Number(match[1]) * (match[2] === 'd' ? 86400_000 : 3600_000) : null }));
  } else if (command === 'routing-prune') {
    const { pruneLog } = await import('../src/routing-log.mjs');
    const { capabilityConfig } = await import('../src/capabilities.mjs');
    const config = runtimeConfig();
    json(pruneLog({ stateDir: option('state-dir', config.stateDir), days: Number(option('days', capabilityConfig(config).retentionDays)) }));
  } else if (['analyze', 'feedback', 'compile', 'report', 'review', 'expand-check'].includes(command)) {
    const [major, minor] = process.versions.node.split('.').map(Number);
    if (major < 22 || major === 22 && minor < 15) throw new Error('Analyzer commands require Node.js 22.15+ (node:sqlite). Core routing still supports Node.js 20.12+.');
    const child = spawn(process.execPath, [fileURLToPath(new URL('../Analyzer/cli.mjs', import.meta.url)), command, ...args], { stdio: 'inherit' });
    process.exitCode = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', code => resolve(code ?? 1)); });
  } else {
    process.stdout.write('JEV maintenance\n  status\n  analyze --window 24h\n  expand-check --run ID\n  feedback add ... | feedback list\n  compile ... | report ... | review ...\n  checkpoint --cwd PATH --task ID\n  handoff --task ID --packet packet.json --cli claude|codex --model ID [--effort LEVEL] [--catalog FILE] [--execute]\n  capabilities [--cli claude|codex]\n  routing-label --request ID --dimension model|effort|skills|agent|task [--expected X|none] [--outcome success|failure|unknown] --source user|qa|executable --evidence TEXT\n  routing-report [--since 7d] [--dataset live|regression|all]\n  routing-prune [--days 30]\nSee docs/improvement-harness.md for evidence, feedback and activation.\n');
    if (command && command !== '--help') process.exitCode = 1;
  }
} catch (error) { json({ ok: false, error: error.message, code: error.code ?? null }); process.exitCode = 1; }
