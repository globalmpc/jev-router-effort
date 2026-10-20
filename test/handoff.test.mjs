import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from 'node:url';
import { ensureCheckpoint } from "../src/checkpoint.mjs";
import { handoffTask, launchArgv, readHandoffReceipt, renderPacket, resolveOrcaCommand, shellQuote, validateTarget } from "../src/handoff.mjs";

const CHECKED = new Date(Date.now() - 60_000).toISOString();
const CATALOG = {
  claude: { models: { "claude-opus-5-5": { efforts: ["high", "xhigh"], evidence: ["issue/2026-09-30-x#case-1"], checkedAt: CHECKED } } },
  codex: { models: { "gpt-6-astra": { efforts: ["xhigh", null], evidence: ["issue/2026-09-30-x#case-2"], checkedAt: CHECKED } } },
  antigravity: { models: { "gemini-pro": { efforts: [null], evidence: ["e"], checkedAt: CHECKED } } },
};
const TARGET = { cli: "codex", model: "gpt-6-astra", effort: "xhigh" };
const PACKET = {
  objective: "Fix the exporter's retry loop",
  constraints: ["Keep the public API", "No destructive git commands"],
  affectedFiles: ["src/exporter.mjs"],
  verification: ["npm test"],
  failures: ["QA: retry loop posts twice"],
};

/** A disposable home holding the installed executor definitions handoff requires. */
function executorHome({ claude = true, codex = true } = {}) {
  const home = mkdtempSync(join(tmpdir(), "jev-home-"));
  for (const [cli, present] of [["claude", claude], ["codex", codex]]) {
    if (!present) continue;
    const skill = join(home, `.${cli}`, "skills", "jev-router-improvement");
    mkdirSync(join(skill, "references"), { recursive: true });
    mkdirSync(join(skill, "scripts"), { recursive: true });
    writeFileSync(join(skill, "references", "execution.md"), "# procedure\n");
    writeFileSync(join(skill, "scripts", "check_target.py"), "");
    if (cli === "claude") {
      mkdirSync(join(home, ".claude", "agents"), { recursive: true });
      writeFileSync(join(home, ".claude", "agents", "jev-claude-executor.md"), "---\nname: jev-claude-executor\n---\n");
    }
  }
  return home;
}
const HOME = executorHome();
process.on("exit", () => rmSync(HOME, { recursive: true, force: true }));

function git(cwd, ...args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
  }).trim();
}

async function workspace(t, taskId = "task-1") {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "jev-handoff-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "a.txt"), "a\n");
  git(dir, "add", ".");
  git(dir, "-c", "commit.gpgsign=false", "commit", "-q", "-m", "base");
  writeFileSync(join(dir, "wip.txt"), "user work\n");
  const checkpoint = await ensureCheckpoint({ cwd: dir, taskId, reason: "before handoff" });
  return { dir, checkpoint };
}

/** A scripted stand-in for the Orca CLI: each subcommand pops its next scripted JSON reply. */
function fakeOrca(dir, script = {}) {
  const calls = [];
  const replies = {
    "worktree show": [{ ok: true, result: { worktree: { id: `repo-1::${dir}`, path: dir } } }],
    "terminal create": [{ ok: true, result: { terminal: { handle: "term_exec" } } }],
    "terminal wait": [{ ok: true, result: { wait: { handle: "term_exec", condition: "tui-idle", satisfied: true, status: "idle" } } }],
    "terminal send": [{ ok: true, result: { send: { handle: "term_exec", accepted: true, prompt: { requestId: "req-1", stages: ["input_accepted", "turn_started"], provider: "codex", observation: "observed" } } } }],
    "terminal show": [{ ok: true, result: { terminal: { handle: "term_exec", worktreePath: dir } } }],
    ...script,
  };
  const orca = async (args) => {
    calls.push(args);
    const key = args.slice(0, 2).join(" ");
    const queue = replies[key];
    const reply = queue.length > 1 ? queue.shift() : queue[0];
    if (reply instanceof Error) return { code: 1, stdout: "", stderr: reply.message };
    return { code: reply.ok ? 0 : 1, stdout: JSON.stringify(reply), stderr: "" };
  };
  return { orca, calls, kinds: () => calls.map((args) => args.slice(0, 2).join(" ")) };
}

const run = (dir, checkpoint, orca, extra = {}) =>
  handoffTask({ cwd: dir, taskId: "task-1", target: TARGET, catalog: CATALOG, packet: PACKET, checkpoint, execute: true, orca, executorHome: HOME, checkTarget: async () => ({ accepted: true, testFixture: true }), ...extra });

test('deterministic sender rejection makes zero Orca calls', async t => {
  const { dir, checkpoint } = await workspace(t);
  const fake = fakeOrca(dir);
  await assert.rejects(run(dir, checkpoint, fake.orca, { checkTarget: async () => ({ accepted: false }) }), { code: 'executor_gate_rejected' });
  assert.deepEqual(fake.kinds(), []);
  assert.equal(readHandoffReceipt(join(dir, '.git'), 'task-1'), null);
});

test("happy path uses the existing workspace, waits for readiness and proves the turn started", async (t) => {
  const { dir, checkpoint } = await workspace(t);
  const fake = fakeOrca(dir);
  const receipt = await run(dir, checkpoint, fake.orca);

  assert.equal(receipt.ok, true);
  assert.equal(receipt.state, "turn_started");
  assert.equal(receipt.completion, "unknown");
  assert.deepEqual(fake.kinds(), ["worktree show", "terminal create", "terminal wait", "terminal send"]);
  assert.ok(!fake.calls.some((args) => args[0] === "worktree" && args[1] === "create"));
  assert.ok(!fake.calls.some((args) => args[0] === "orchestration"));
  const create = fake.calls[1];
  assert.equal(create[create.indexOf("--worktree") + 1], `id:repo-1::${dir}`);
  assert.equal(create[create.indexOf("--command") + 1], `codex --no-daemon --model gpt-6-astra -c 'model_reasoning_effort="xhigh"'`);
  const wait = fake.calls[2];
  assert.equal(wait[wait.indexOf("--timeout-ms") + 1], "60000");
  const send = fake.calls[3];
  const text = send[send.indexOf("--text") + 1];
  assert.doesNotMatch(text, /\n/);
  assert.match(text, new RegExp(checkpoint.commit));
  assert.ok(send.includes("--enter") && send.includes("--wait-submit"));

  const packet = readFileSync(receipt.packetPath, "utf8");
  assert.match(text, /as jev-codex-executor/);
  assert.ok(packet.includes(`Act as jev-codex-executor and follow ${join(HOME, ".codex", "skills", "jev-router-improvement", "references", "execution.md")}`));
  assert.ok(packet.includes(`check_target.py --cli codex --model gpt-6-astra --effort xhigh --router ${fileURLToPath(new URL('../', import.meta.url))}`));
  assert.match(packet, /no orchestration dispatch: there is no worker_done/);
  assert.deepEqual(receipt.executor, { agent: "jev-codex-executor", definition: join(HOME, ".codex", "skills", "jev-router-improvement", "references", "execution.md") });
  assert.match(packet, /Fix the exporter's retry loop/);
  assert.match(packet, /QA: retry loop posts twice/);
  assert.match(packet, new RegExp(checkpoint.ref));
  assert.equal(git(dir, "status", "--porcelain"), "?? wip.txt", "receipts and packets live under .git, not the worktree");
  const stored = readHandoffReceipt(join(dir, ".git"), "task-1");
  assert.deepEqual(stored.history.map((h) => h.state), ["terminal_created", "sending", "turn_started"]);
  assert.deepEqual(stored.target, TARGET);
  assert.deepEqual(stored.catalog, { evidence: ["issue/2026-09-30-x#case-2"], checkedAt: CHECKED });
});

test("a repeated call never launches a second executor or re-sends", async (t) => {
  const { dir, checkpoint } = await workspace(t);
  const fake = fakeOrca(dir);
  await run(dir, checkpoint, fake.orca);
  const again = await run(dir, checkpoint, fake.orca);
  assert.equal(again.duplicate, true);
  assert.equal(again.state, "turn_started");
  assert.equal(fake.kinds().filter((kind) => kind === "terminal send").length, 1);
  assert.equal(fake.kinds().filter((kind) => kind === "terminal create").length, 1);

  const other = await run(dir, checkpoint, fake.orca, { target: { cli: "claude", model: "claude-opus-5-5", effort: "high" } });
  assert.equal(other.duplicate, true, "a delivered task is not re-targeted");
  assert.equal(fake.kinds().filter((kind) => kind === "terminal send").length, 1);
});

test("an executor that never becomes idle is reported not started and receives nothing", async (t) => {
  const { dir, checkpoint } = await workspace(t);
  const unsatisfied = { ok: true, result: { wait: { handle: "term_exec", satisfied: false, status: "running" } } };
  const fake = fakeOrca(dir, { "terminal wait": [unsatisfied] });
  const receipt = await run(dir, checkpoint, fake.orca, { readinessTimeoutMs: 999_999 });
  assert.equal(receipt.ok, false);
  assert.equal(receipt.state, "not_started");
  assert.equal(fake.kinds().filter((kind) => kind === "terminal wait").length, 2);
  assert.ok(fake.calls.filter((args) => args[1] === "wait").every((args) => args[args.indexOf("--timeout-ms") + 1] === "60000"));
  assert.ok(!fake.kinds().includes("terminal send"));

  // A later call resumes on the same terminal instead of creating another.
  const ready = fakeOrca(dir);
  const resumed = await run(dir, checkpoint, ready.orca);
  assert.equal(resumed.state, "turn_started");
  assert.deepEqual(ready.kinds(), ["terminal show", "terminal wait", "terminal send"]);
});

test("accepted input without a proven turn is not success and is never re-sent", async (t) => {
  const { dir, checkpoint } = await workspace(t);
  const unproven = { ok: true, result: { send: { handle: "term_exec", accepted: true, prompt: { requestId: "req-9", stages: ["input_accepted"], provider: "codex", observation: "timeout" } } } };
  const fake = fakeOrca(dir, { "terminal send": [unproven] });
  const receipt = await run(dir, checkpoint, fake.orca);
  assert.equal(receipt.ok, false);
  assert.equal(receipt.state, "accepted_unverified");
  assert.deepEqual(receipt.delivery, { accepted: true, turnStarted: false });
  const again = await run(dir, checkpoint, fake.orca);
  assert.equal(again.duplicate, true);
  assert.equal(fake.kinds().filter((kind) => kind === "terminal send").length, 1);
});

test("an ambiguous send replays only through Orca's retry request id with the identical text", async (t) => {
  const { dir, checkpoint } = await workspace(t);
  const transport = { ok: false, error: { code: "runtime_error", message: "socket closed", data: { orchestrationRequestId: "req-amb" } } };
  const fake = fakeOrca(dir, { "terminal send": [transport] });
  const first = await run(dir, checkpoint, fake.orca);
  assert.equal(first.state, "send_ambiguous");
  assert.equal(first.requestId, "req-amb");

  const replay = fakeOrca(dir);
  const second = await run(dir, checkpoint, replay.orca);
  assert.equal(second.state, "turn_started");
  assert.deepEqual(replay.kinds(), ["terminal send"]);
  const args = replay.calls[0];
  assert.equal(args[args.indexOf("--retry-request") + 1], "req-amb");
  const firstSend = fake.calls.find((call) => call[1] === "send");
  assert.equal(args[args.indexOf("--text") + 1], firstSend[firstSend.indexOf("--text") + 1]);
});

test("a send failure without a request id is final", async (t) => {
  const { dir, checkpoint } = await workspace(t);
  const fake = fakeOrca(dir, { "terminal send": [new Error("orca crashed")] });
  const first = await run(dir, checkpoint, fake.orca);
  assert.equal(first.state, "send_ambiguous");
  assert.equal(first.requestId, undefined);
  const again = await run(dir, checkpoint, fake.orca);
  assert.equal(again.duplicate, true);
  assert.equal(fake.kinds().filter((kind) => kind === "terminal send").length, 1);
});

test("an unknown workspace or an ambiguous terminal create stops without sending", async (t) => {
  const { dir, checkpoint } = await workspace(t);
  const missing = fakeOrca(dir, { "worktree show": [{ ok: false, error: { code: "selector_not_found", message: "no worktree" } }] });
  const receipt = await run(dir, checkpoint, missing.orca);
  assert.equal(receipt.state, "failed");
  assert.deepEqual(missing.kinds(), ["worktree show"]);

  const elsewhere = fakeOrca(dir, { "worktree show": [{ ok: true, result: { worktree: { id: "r::/other", path: "/other" } } }] });
  assert.equal((await run(dir, checkpoint, elsewhere.orca)).state, "failed");

  const crash = fakeOrca(dir, { "terminal create": [new Error("killed")] });
  const ambiguous = await run(dir, checkpoint, crash.orca);
  assert.equal(ambiguous.state, "create_ambiguous");
  const again = await run(dir, checkpoint, crash.orca);
  assert.equal(again.duplicate, true);
  assert.equal(crash.kinds().filter((kind) => kind === "terminal create").length, 1);
});

test("targets outside the verified catalog are rejected before any Orca call", async (t) => {
  const { dir, checkpoint } = await workspace(t);
  const fake = fakeOrca(dir);
  for (const target of [
    { cli: "antigravity", model: "gemini-pro", effort: null },
    { cli: "codex", model: "gpt-6-sol", effort: "xhigh" },
    { cli: "codex", model: "gpt-6-astra", effort: "low" },
    { cli: "claude", model: "opus", effort: "high" },
    { cli: "claude", model: "claude-opus-5-5'; rm -rf ~", effort: "high" },
  ]) {
    await assert.rejects(run(dir, checkpoint, fake.orca, { target }), { code: "unsupported_target" }, JSON.stringify(target));
  }
  await assert.rejects(run(dir, checkpoint, fake.orca, { catalog: undefined }), { code: "unsupported_target" });
  await assert.rejects(
    run(dir, checkpoint, fake.orca, { catalog: { codex: { models: { "gpt-6-astra": { efforts: ["xhigh"], evidence: [], checkedAt: CHECKED } } } } }),
    { code: "unsupported_target" },
  );
  const entry = (checkedAt) => ({ codex: { models: { "gpt-6-astra": { efforts: ["xhigh"], evidence: ["e"], checkedAt } } } });
  for (const checkedAt of [undefined, "yesterday", new Date(Date.now() - 25 * 3_600_000).toISOString(), new Date(Date.now() + 3_600_000).toISOString()]) {
    await assert.rejects(run(dir, checkpoint, fake.orca, { catalog: entry(checkedAt) }), { code: "catalog_stale" }, String(checkedAt));
  }
  assert.equal(fake.calls.length, 0);
});

test("a missing, foreign or moved checkpoint is rejected", async (t) => {
  const { dir, checkpoint } = await workspace(t);
  const fake = fakeOrca(dir);
  await assert.rejects(run(dir, undefined, fake.orca), { code: "checkpoint_required" });
  await assert.rejects(run(dir, { ...checkpoint, ok: false }, fake.orca), { code: "checkpoint_required" });
  await assert.rejects(handoffTask({ cwd: dir, taskId: "task-2", target: TARGET, catalog: CATALOG, packet: PACKET, checkpoint, execute: true, orca: fake.orca }), {
    code: "checkpoint_mismatch",
  });
  await assert.rejects(run(dir, { ...checkpoint, commit: git(dir, "rev-parse", "HEAD") }, fake.orca), { code: "checkpoint_mismatch" });
  assert.equal(fake.calls.length, 0);
});

test("packets are bounded and a dry run touches nothing", async (t) => {
  const { dir, checkpoint } = await workspace(t);
  const fake = fakeOrca(dir);
  await assert.rejects(run(dir, checkpoint, fake.orca, { packet: { objective: "x".repeat(70_000) } }), { code: "packet_too_large" });
  await assert.rejects(run(dir, checkpoint, fake.orca, { packet: {} }), { code: "invalid_packet" });
  writeFileSync(join(dir, "big.md"), "y".repeat(5000));
  await assert.rejects(run(dir, checkpoint, fake.orca, { packet: { file: "big.md" }, maxPacketBytes: 4096 }), { code: "packet_too_large" });

  const plan = await run(dir, checkpoint, fake.orca, { execute: false });
  assert.equal(plan.state, "planned");
  assert.equal(plan.dryRun, true);
  assert.equal(fake.calls.length, 0);
  assert.equal(readHandoffReceipt(join(dir, ".git"), "task-1"), null);
});

test("a concurrent writer for the same task is refused", async (t) => {
  const { dir, checkpoint } = await workspace(t);
  const fake = fakeOrca(dir);
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const slow = async (args, opts) => {
    if (args[1] === "wait") await gate;
    return fake.orca(args, opts);
  };
  const first = run(dir, checkpoint, slow);
  await new Promise((resolve) => setTimeout(resolve, 200));
  await assert.rejects(run(dir, checkpoint, fake.orca), { code: "writer_locked" });
  release();
  assert.equal((await first).state, "turn_started");
});

test("the runtime packet keeps objective, current request, history, failures and profile", () => {
  const options = { cwd: "/w", taskId: "t", target: TARGET, checkpoint: { commit: "c".repeat(40), ref: "refs/jev/checkpoints/t/x" } };
  const runtime = {
    objective: "Ship the exporter fix",
    recentRequests: ["first ask", "second ask"],
    failures: [{ text: "QA: posts twice", source: "user-or-qa-report" }, "plain failure"],
    taskType: "cross-module-change",
    complex: true,
    mutating: true,
    signals: ["cross-module", "state-transition"],
    currentRequest: "now also fix the retry",
    sourceCli: "antigravity",
    stateFile: "/state/task.json",
    evidenceRule: "rule-7",
    reviewer: "qa",
  };
  const doc = renderPacket(runtime, options);
  for (const text of [
    "Ship the exporter fix", "now also fix the retry", "- first ask", "- second ask", "- [user-or-qa-report] QA: posts twice",
    "- plain failure", "task type: cross-module-change", "complex: true", "signals: cross-module, state-transition",
    "requested from: antigravity", "evidence rule: rule-7", "task state file: /state/task.json", "- reviewer: qa",
  ]) {
    assert.ok(doc.includes(text), text);
  }

  const long = { ...runtime, recentRequests: ["r".repeat(3000), "latest-history"], failures: [{ text: "f".repeat(3000), source: "qa" }, { text: "newest failure", source: "qa" }] };
  const trimmed = renderPacket(long, { ...options, maxBytes: 2500 });
  assert.ok(trimmed.includes("now also fix the retry"));
  assert.ok(trimmed.includes("latest-history") && trimmed.includes("newest failure"));
  assert.ok(!trimmed.includes("r".repeat(3000)) && !trimmed.includes("f".repeat(3000)));
  assert.match(trimmed, /1 older request\(s\) omitted/);
  assert.match(trimmed, /1 older failure\(s\) omitted/);
  assert.throws(() => renderPacket({ ...runtime, currentRequest: "x".repeat(5000) }, { ...options, maxBytes: 2500 }), { code: "packet_too_large" });
});

test("a newer packet reaches an executor that never received the first one", async (t) => {
  const { dir, checkpoint } = await workspace(t);
  const unsatisfied = { ok: true, result: { wait: { handle: "term_exec", satisfied: false, status: "running" } } };
  await run(dir, checkpoint, fakeOrca(dir, { "terminal wait": [unsatisfied] }).orca);
  const ready = fakeOrca(dir);
  const receipt = await run(dir, checkpoint, ready.orca, { packet: { ...PACKET, currentRequest: "follow-up detail" } });
  assert.equal(receipt.state, "turn_started");
  assert.ok(readFileSync(receipt.packetPath, "utf8").includes("follow-up detail"));
  assert.ok(!ready.kinds().includes("terminal create"));
  await assert.rejects(run(dir, checkpoint, ready.orca, { target: { cli: "claude", model: "claude-opus-5-5", effort: "high" } }).then((r) => {
    if (r.duplicate) throw Object.assign(new Error("duplicate"), { code: "duplicate" });
  }), { code: "duplicate" });
});

test('read-only evaluation overrides generic writer authority in both packet and Orca prompt', async t => {
  const { dir, checkpoint } = await workspace(t);
  const fake = fakeOrca(dir);
  const receipt = await run(dir, checkpoint, fake.orca, { packet: { ...PACKET, authority: 'read-only', stage: 'evaluation',
    context: { instructions: 'Original implementation objective', items: [{ role: 'assistant', text: 'tests exit 0' }] } } });
  const doc = readFileSync(receipt.packetPath, 'utf8');
  assert.match(doc, /READ-ONLY EVALUATION/);
  assert.match(doc, /no workspace write authority/);
  assert.match(doc, /No commits are authorized/);
  assert.doesNotMatch(doc, /You are the single writer/);
  assert.match(doc, /Before evaluation run:/);
  assert.match(doc, /tests exit 0/);
  const send = fake.calls.find(args => args[0] === 'terminal' && args[1] === 'send');
  assert.match(send[send.indexOf('--text') + 1], /read-only evaluator with no file edits or commits/);
});

test("launch commands quote safely for the shell Orca types into", () => {
  assert.equal(shellQuote("plain-1.2"), "plain-1.2");
  assert.equal(shellQuote("it's"), `'it'\\''s'`);
  assert.equal(shellQuote("a b"), "'a b'");
  assert.throws(() => shellQuote("a\nb"), { code: "unsafe_argument" });
  const claude = execFileSync("sh", ["-c", `printf '%s\\n' ${launchArgv({ cli: "claude", model: "claude-opus-5-5[1m]", effort: "high" }).map(shellQuote).join(" ")}`], { encoding: "utf8" });
  assert.equal(claude, "claude\n--model\nclaude-opus-5-5[1m]\n--effort\nhigh\n");
  const codex = execFileSync("sh", ["-c", `printf '%s\\n' ${launchArgv(TARGET).map(shellQuote).join(" ")}`], { encoding: "utf8" });
  assert.equal(codex, `codex\n--no-daemon\n--model\ngpt-6-astra\n-c\nmodel_reasoning_effort="xhigh"\n`);
  assert.deepEqual(validateTarget({ cli: "codex", model: "gpt-6-astra" }, CATALOG).effort, null);
});

test("Claude launches the named executor agent; a missing executor refuses before Orca", async (t) => {
  const { dir, checkpoint } = await workspace(t);
  const fake = fakeOrca(dir);
  const receipt = await run(dir, checkpoint, fake.orca, { target: { cli: "claude", model: "claude-opus-5-5", effort: "high" } });
  assert.equal(receipt.command, "claude --agent jev-claude-executor --model claude-opus-5-5 --effort high");
  assert.match(readFileSync(receipt.packetPath, "utf8"), /check_target\.py --cli claude --model claude-opus-5-5 --effort high/);

  const bare = executorHome({ claude: false, codex: false });
  t.after(() => rmSync(bare, { recursive: true, force: true }));
  const none = fakeOrca(dir);
  for (const target of [TARGET, { cli: "claude", model: "claude-opus-5-5", effort: "high" }]) {
    await assert.rejects(run(dir, checkpoint, none.orca, { executorHome: bare, target }), { code: "executor_unavailable" });
  }
  assert.equal(none.calls.length, 0);
});

test("the Orca executable follows the documented resolution order", () => {
  assert.equal(resolveOrcaCommand({ ORCA_CLI_COMMAND: "/opt/orca" }, "linux"), "/opt/orca");
  assert.equal(resolveOrcaCommand({}, "linux"), "orca-ide");
  assert.equal(resolveOrcaCommand({}, "darwin"), "orca");
});
