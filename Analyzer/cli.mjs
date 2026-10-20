#!/usr/bin/env node
// JEV router evidence analyzer. Local only: reads session files read-only, writes private
// extracts under Analyzer/private/ (Git-ignored) and a redacted report under docs/.
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collect, defaultSources } from './lib/collect.mjs';
import { appendFeedback, importRuntimeFeedback, normalizeFeedback, readFeedback, verifyFeedback } from './lib/feedback.mjs';
import { loadKnownCases, verifyKnownCase } from './lib/known-cases.mjs';
import { compilePolicy, mergeObservations } from './lib/policy.mjs';
import { renderReport } from './lib/report.mjs';
import { deriveEvidence, isCheckOnly, labelTemplate, packetMarkdown, validateLabel } from './lib/review.mjs';
import { stratifiedSample } from './lib/sample.mjs';
import { HOUR, localTimeZone, parseArgs, parseDuration, readJson, readJsonl, writeJson } from './lib/util.mjs';

const ANALYZER = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(ANALYZER, '..');

const USAGE = `usage: node Analyzer/cli.mjs <command> [options]
  analyze   --window 24h|48h [--now ISO] [--seed S] [--rate 0.2]     collect, sample, write review packets
  review    status --run <runId>                                      label progress and validation errors
  review    label --run <runId> --evidence ev-…[,ev-…] --outcome success|failure|unknown
            [--basis user|qa|test|none --citations ref,… --task-type T --cli C --model M --effort E --notes N --reviewer R]
  expand-check --run <runId>                                          decide whether the 48h window is needed
  feedback  add --ref <ev-id|cli:session> --outcome success|failure --source user|qa|test
            [--cli C --model M --effort E --task-type T --authorized-by user|transcript|unknown --reporter R --note N]
  feedback  verify --id fb-… --citations ref1,ref2 [--session ev-…] [--reviewer R --model M --effort E --task-type T]
  feedback  import-runtime [--file ~/.local/state/jev-router/feedback.jsonl]   copy runtime failure reports as unverified
  feedback  list
  compile   [--runs id1,id2]                                          write Analyzer/private/proposed-policy.json
  report    [--runs id1,id2] [--out docs/routing-evidence.md]         redacted aggregate report
common: --private-dir DIR  --home DIR (source home override)  --tz ZONE`;

function paths(args) {
  const priv = resolve(args['private-dir'] ?? join(ANALYZER, 'private'));
  return { priv, runs: join(priv, 'runs'), feedback: join(priv, 'feedback.jsonl'), policy: join(priv, 'proposed-policy.json'), knownCases: join(priv, 'known-cases.json'), cache: join(priv, 'cache', 'antigravity') };
}

const runDir = (p, id) => join(p.runs, id);
const compact = ms => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');

function listRuns(p, wanted) {
  if (wanted) return String(wanted).split(',').filter(Boolean);
  try { return readdirSync(p.runs).filter(d => existsSync(join(p.runs, d, 'sample.json'))).sort(); } catch { return []; }
}

function loadRun(p, id) {
  const dir = runDir(p, id);
  return {
    id,
    manifest: readJson(join(dir, 'manifest.json')),
    inventory: readJson(join(dir, 'inventory.json')),
    sample: readJson(join(dir, 'sample.json')),
    review: readJson(join(dir, 'review.json')),
    known: readJson(join(dir, 'known-cases.json'), []),
  };
}

/** Labels from every run, latest reviewed label per session wins. */
/**
 * Labels from every run, latest reviewed label per session wins. Each label is re-validated
 * against its run's inventory; evidence time and check-only status are recomputed from the
 * cited evidence, never taken from the stored label.
 */
function allLabels(p, runIds) {
  const byKey = new Map();
  const summaries = new Map();
  const problems = [];
  for (const id of runIds) {
    const run = loadRun(p, id);
    const own = new Map((run.inventory?.sessions ?? []).map(s => [s.key, s]));
    for (const [k, v] of own) summaries.set(k, v);
    for (const l of run.review?.labels ?? []) {
      if (!l.reviewed) continue;
      const errors = validateLabel(l, own.get(l.key));
      if (errors.length) { problems.push({ run: id, evidenceId: l.evidenceId, errors }); continue; }
      const evidenceAt = l.outcome === 'unknown' ? null : deriveEvidence(l.basis, l.citations ?? [], own.get(l.key)).evidenceAt;
      byKey.set(l.key, { ...l, evidenceAt, checkOnly: isCheckOnly(l) });
    }
  }
  return { labels: [...byKey.values()], problems, summaries };
}

function analyze(args) {
  const p = paths(args);
  const now = args.now ? Date.parse(args.now) : Date.now();
  if (!Number.isFinite(now)) throw new Error(`invalid --now ${args.now}`);
  const window = args.window ?? '24h';
  const windowMs = parseDuration(window);
  if (windowMs > 48 * HOUR) throw new Error('windows above 48h are out of scope');
  const seed = args.seed ?? 'jev-evidence-v1';
  const rate = Number(args.rate ?? 0.2);
  const tz = args.tz ?? localTimeZone();
  const sources = defaultSources(args.home ?? undefined);
  const id = args['run-id'] ?? `${window}-${compact(now)}`;
  const dir = runDir(p, id);
  // Packets are regenerated from source each run; labels live in review.json and are kept.
  rmSync(join(dir, 'packets'), { recursive: true, force: true });
  mkdirSync(join(dir, 'packets'), { recursive: true, mode: 0o700 });

  const knownCases = loadKnownCases(p.knownCases);
  const knownKeys = knownCases.map(k => k.key);
  const result = collect({ now, windowMs, sources, cacheDir: p.cache, keepRawFor: knownKeys });
  const eligible = result.sessions.filter(s => !s.exclusion);
  const sample = stratifiedSample(eligible, { rate, seed, purposive: knownKeys });
  const byKey = new Map(result.sessions.map(s => [s.key, s]));

  for (const pick of sample.picks) {
    const s = byKey.get(pick.key);
    writeFileSync(join(dir, 'packets', `${s.evidenceId}.md`), packetMarkdown(s, tz), { mode: 0o600 });
  }
  // Keep existing labels; carry labels for the same session from earlier runs at the same --now.
  const existing = new Map((readJson(join(dir, 'review.json'))?.labels ?? []).filter(l => l.reviewed).map(l => [l.key, l]));
  for (const other of listRuns(p)) {
    if (other === id) continue;
    const r = loadRun(p, other);
    if (r.manifest?.now !== new Date(now).toISOString()) continue;
    for (const l of r.review?.labels ?? []) if (l.reviewed && !existing.has(l.key)) existing.set(l.key, { ...l, carriedFrom: other });
  }
  const labels = sample.picks.map(pick => existing.get(pick.key) ?? labelTemplate(byKey.get(pick.key)));
  writeJson(join(dir, 'review.json'), { run: id, instructions: 'Set reviewed:true only after reading the packet/source. success/failure need basis user|qa|test and citations from the packet. Never use the assistant completion claim as evidence.', labels });

  const known = knownCases.map(kc => {
    const s = result.sessions.find(x => x.key === kc.key);
    return { ...verifyKnownCase(kc, s, s ? result.raw[s.key] ?? [] : []), eligible: Boolean(s && !s.exclusion) };
  });
  writeJson(join(dir, 'known-cases.json'), known);
  writeJson(join(dir, 'inventory.json'), { ...result.inventory, sessions: result.sessions });
  writeJson(join(dir, 'sample.json'), sample);
  const manifest = {
    run: id, now: new Date(now).toISOString(), window, windowStart: new Date(result.windowStart).toISOString(), timeZone: tz,
    seed, rate, generatedAt: new Date().toISOString(), analyzer: 'Analyzer/cli.mjs v1',
  };
  writeJson(join(dir, 'manifest.json'), manifest);
  const excluded = {};
  for (const s of result.sessions) if (s.exclusion) excluded[s.exclusion] = (excluded[s.exclusion] ?? 0) + 1;
  return {
    run: id, dir, window, now: manifest.now, sources: result.inventory.sources, dedupe: result.inventory.dedupe,
    distinct: result.sessions.length, eligible: eligible.length, excluded,
    sampledRandom: sample.randomSampled, sampledPurposive: sample.purposiveSampled, coverage: Number(sample.coverage.toFixed(3)),
    knownCases: known.map(k => ({ id: k.id, found: k.found, eligible: k.eligible })),
  };
}

function reviewStatus(args) {
  const p = paths(args);
  const run = loadRun(p, args.run);
  if (!run.review) throw new Error(`no review.json for run ${args.run}`);
  const summaries = new Map(run.inventory.sessions.map(s => [s.key, s]));
  const counts = { total: run.review.labels.length, reviewed: 0, success: 0, failure: 0, unknown: 0 };
  const problems = [];
  for (const l of run.review.labels) {
    if (!l.reviewed) continue;
    counts.reviewed++;
    counts[l.outcome]++;
    const errors = validateLabel(l, summaries.get(l.key));
    if (errors.length) problems.push({ evidenceId: l.evidenceId, errors });
  }
  return { run: args.run, ...counts, problems };
}

/**
 * Record a reviewer's adjudication for one or more sampled sessions. The label is validated
 * against the packet before it is written; an invalid success/failure is refused.
 */
function reviewLabel(args) {
  const p = paths(args);
  const file = join(runDir(p, args.run), 'review.json');
  const review = readJson(file);
  if (!review) throw new Error(`no review.json for run ${args.run}`);
  const summaries = new Map(loadRun(p, args.run).inventory.sessions.map(s => [s.evidenceId, s]));
  const ids = String(args.evidence ?? '').split(',').filter(Boolean);
  if (!ids.length) throw new Error('--evidence ev-…[,ev-…] is required');
  const done = [];
  for (const id of ids) {
    const label = review.labels.find(l => l.evidenceId === id);
    if (!label) throw new Error(`${id} is not in this run's sample`);
    const next = {
      ...label,
      outcome: args.outcome ?? label.outcome,
      basis: args.basis ?? (args.outcome === 'unknown' ? 'none' : label.basis),
      citations: args.citations ? String(args.citations).split(',').filter(Boolean) : label.citations,
      taskType: args['task-type'] ?? label.taskType,
      attribution: {
        cli: args.cli ?? label.attribution.cli,
        model: args.model ?? label.attribution.model,
        effort: args.effort === undefined ? label.attribution.effort : args.effort === 'unknown' ? null : args.effort,
      },
      // A known outcome is attributed from its cited evidence; explicit --model/--effort only
      // pass validation when they agree with it.
      notes: args.notes ?? label.notes,
      reviewer: args.reviewer ?? 'unknown',
      reviewedAt: new Date().toISOString(),
      reviewed: true,
    };
    if (next.outcome !== 'unknown') {
      const derived = deriveEvidence(next.basis, next.citations ?? [], summaries.get(id));
      if (derived.attribution && args.model === undefined && args.effort === undefined) next.attribution = derived.attribution;
      next.checkOnly = isCheckOnly(next);
    } else next.checkOnly = false;
    const errors = validateLabel(next, summaries.get(id));
    if (errors.length) throw new Error(`${id}: ${errors.join('; ')}`);
    Object.assign(label, next);
    done.push(id);
  }
  writeJson(file, review);
  return { run: args.run, labeled: done };
}

/** 48h is used only when the reviewed 24h evidence is insufficient. */
function expandCheck(args) {
  const p = paths(args);
  const run = loadRun(p, args.run);
  const { labels } = allLabels(p, [args.run]);
  const known = labels.filter(l => l.outcome !== 'unknown');
  const eligibleByCli = {};
  for (const s of run.inventory.sessions) if (!s.exclusion) eligibleByCli[s.cli] = (eligibleByCli[s.cli] ?? 0) + 1;
  const knownByCli = {};
  for (const l of known) knownByCli[l.attribution.cli] = (knownByCli[l.attribution.cli] ?? 0) + 1;
  const groups = {};
  for (const l of known) { const k = `${l.taskType}|${l.attribution.cli}|${l.attribution.model}|${l.attribution.effort}`; groups[k] = (groups[k] ?? 0) + 1; }
  const reasons = [];
  for (const cli of ['claude', 'codex', 'antigravity']) {
    if (!eligibleByCli[cli]) reasons.push(`${cli}: no eligible sessions`);
    else if (!knownByCli[cli]) reasons.push(`${cli}: no known outcomes among reviewed sessions`);
  }
  if (run.sample.coverage < run.sample.rate) reasons.push('random coverage below target');
  if (known.length < 10) reasons.push(`only ${known.length} known outcomes (<10)`);
  if (!Object.values(groups).some(n => n >= 5)) reasons.push('no task/cli/model/effort group has >=5 known outcomes');
  const pending = run.review.labels.filter(l => !l.reviewed).length;
  return { run: args.run, pendingReview: pending, known: known.length, eligibleByCli, knownByCli, expand: pending === 0 && reasons.length > 0 && run.manifest.window !== '48h', reasons };
}

function feedbackCmd(args) {
  const p = paths(args);
  const sub = args._[1];
  if (sub === 'add') {
    const rec = normalizeFeedback(args);
    // Resolve the session key from any run inventory so observations join on one identity.
    for (const id of listRuns(p)) {
      const s = loadRun(p, id).inventory?.sessions?.find(x => x.evidenceId === rec.ref || x.key === rec.ref);
      if (s) { rec.sessionKey = s.key; rec.evidenceId = s.evidenceId; break; }
    }
    appendFeedback(p.feedback, rec);
    return { added: rec.id, sessionResolved: Boolean(rec.sessionKey), verified: false, next: `feedback verify --id ${rec.id} --citations <refs from the session packet>` };
  }
  if (sub === 'verify') {
    const citations = String(args.citations ?? '').split(',').filter(Boolean);
    const fb = readFeedback(p.feedback).find(f => f.id === args.id);
    if (!fb) throw new Error(`unknown feedback id ${args.id}`);
    // Runtime reports carry a task id, not a session: the reviewer links the session explicitly.
    const target = args.session ?? fb.sessionKey;
    let summary = null;
    for (const id of listRuns(p)) { summary = loadRun(p, id).inventory?.sessions?.find(s => s.key === target || s.evidenceId === target); if (summary) break; }
    if (!summary) throw new Error(`feedback ${args.id} is not linked to a session in any run inventory (pass --session ev-… after analyzing its window)`);
    // The report is only verified when its citations resolve to the session's real follow-ups or
    // test runs; the model/effort comes from that evidence, not from the report.
    const derived = deriveEvidence(fb.source, citations, summary);
    if (derived.errors.length) throw new Error(derived.errors.join('; '));
    const rec = verifyFeedback(p.feedback, args.id, {
      sessionKey: summary.key, evidenceId: summary.evidenceId, citations, reviewer: args.reviewer,
      cli: derived.attribution.cli, model: derived.attribution.model, effort: derived.attribution.effort ?? 'unknown',
      taskType: args['task-type'], evidenceAt: new Date(derived.evidenceAt).toISOString(),
    });
    return { verified: rec.id, citations: rec.citations, attribution: derived.attribution };
  }
  if (sub === 'import-runtime') {
    const rows = readJsonl(args.file ?? defaultSources(args.home ?? undefined).jev.runtimeFeedback).filter(r => r.value).map(r => r.value);
    const added = importRuntimeFeedback(p.feedback, rows);
    return { runtimeRows: rows.length, imported: added.length, ids: added, next: added.length ? 'feedback verify --id <fb-…> --session ev-… --citations <refs>' : null };
  }
  if (sub === 'list') return readFeedback(p.feedback).map(({ note, ...f }) => ({ ...f, note: note ? `${note.length} chars (private)` : '' }));
  throw new Error('feedback add|verify|list');
}

/**
 * A verified flag in feedback.jsonl is not trusted on its own: the citations are resolved again
 * against the inventory and the attribution/evidence time recomputed. Failing records are dropped.
 */
function checkedFeedback(records, summaries, problems) {
  return records.map(f => {
    if (!f.verified) return f;
    const summary = summaries.get(f.sessionKey);
    const derived = summary ? deriveEvidence(f.source, f.citations ?? [], summary) : { errors: ['session not in any analyzed run'] };
    if (derived.errors.length) { problems.push({ feedback: f.id, errors: derived.errors }); return { ...f, verified: false }; }
    return { ...f, ...derived.attribution, evidenceAt: new Date(derived.evidenceAt).toISOString() };
  });
}

function compile(args) {
  const p = paths(args);
  const runs = listRuns(p, args.runs);
  const { labels, problems, summaries } = allLabels(p, runs);
  const feedback = checkedFeedback(readFeedback(p.feedback), summaries, problems);
  const obs = mergeObservations(labels, feedback);
  const now = args.now ? Date.parse(args.now) : Date.now();
  const policy = compilePolicy(obs, { now });
  policy.provenance = {
    runs, reviewedLabels: labels.length, invalidLabels: problems.length,
    verifiedFeedback: feedback.filter(f => f.verified).length, unverifiedFeedback: feedback.filter(f => !f.verified).length,
    checkOnlyPasses: labels.filter(l => l.checkOnly).length,
    note: 'Proposed only. docs/routing-policy.json is not modified by the analyzer.',
  };
  writeJson(p.policy, policy);
  return { written: p.policy, rules: policy.rules.length, validated: policy.rules.filter(r => r.status === 'validated').length, abstained: policy.abstained.length, problems };
}

function report(args) {
  const p = paths(args);
  const runs = listRuns(p, args.runs).map(id => loadRun(p, id));
  const policy = readJson(p.policy);
  const feedback = readFeedback(p.feedback);
  const { labels, problems } = allLabels(p, runs.map(r => r.id));
  const md = renderReport({ runs, policy, feedback, labels, problems, timeZone: args.tz ?? localTimeZone() });
  const out = resolve(REPO, args.out ?? 'docs/routing-evidence.md');
  writeFileSync(out, md);
  return { written: out, bytes: md.length };
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const cmd = args._[0];
  const run = {
    analyze, 'expand-check': expandCheck, compile, report,
    review: a => {
      if (a._[1] === 'status') return reviewStatus(a);
      if (a._[1] === 'label') return reviewLabel(a);
      throw new Error('review status|label --run <id>');
    },
    feedback: feedbackCmd,
  }[cmd];
  if (!run) { console.error(USAGE); return 2; }
  const out = run(args);
  console.log(JSON.stringify(out, null, 2));
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = main(); } catch (err) { console.error(`analyzer: ${err.message}`); process.exitCode = 1; }
}
