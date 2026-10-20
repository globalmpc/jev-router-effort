import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CHECKPOINT_REF_PREFIX, acquireFileLock, openRepo, runGit, validTaskId } from "./checkpoint.mjs";
import { childEnv } from "./child-env.mjs";

export const HANDOFF_CLIS = ["claude", "codex"];
export const MAX_READY_WAIT_MS = 60_000;
export const DEFAULT_PACKET_BYTES = 64 * 1024;
const PROMPT_BYTES = 2000;
export const CATALOG_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const CLOCK_SKEW_MS = 5 * 60 * 1000;
const RECEIPT_VERSION = 1;
const ROUTER_ROOT = fileURLToPath(new URL('../', import.meta.url));
// After one of these the prompt may already be in the executor, so nothing is sent again.
const SENT_STATES = ["sending", "turn_started", "accepted_unverified", "refused", "send_ambiguous", "create_ambiguous"];

/** A refusal raised before any Orca call or file write for the task. */
export class HandoffError extends Error {
  constructor(code, message, { receipt } = {}) {
    super(message);
    this.name = "HandoffError";
    this.code = code;
    this.receipt = receipt;
  }
}

/** POSIX single-quoting: the only character that needs care inside '...' is ' itself. */
export function shellQuote(arg) {
  const text = String(arg);
  if (/[\0\r\n]/.test(text)) throw new HandoffError("unsafe_argument", "Launch arguments cannot contain NUL or newlines.");
  return /^[A-Za-z0-9_./:=@%+-]+$/.test(text) ? text : `'${text.replaceAll("'", `'\\''`)}'`;
}

export const EXECUTOR_AGENTS = { claude: "jev-claude-executor", codex: "jev-codex-executor" };
const EXECUTOR_SKILL = "jev-router-improvement";

/**
 * Finds the installed global executor for a CLI. Claude loads the named agent with `--agent`;
 * Codex has no agent flag, so its executor is the maintained skill procedure the prompt names.
 * Missing definitions refuse the handoff rather than launching an unscoped session.
 */
export function resolveExecutor(cli, { home = homedir(), cwd } = {}) {
  const agent = EXECUTOR_AGENTS[cli];
  const skill = join(home, cli === "codex" ? ".codex" : ".claude", "skills", EXECUTOR_SKILL);
  const procedure = join(skill, "references", "execution.md");
  const checkTarget = join(skill, "scripts", "check_target.py");
  const definition =
    cli === "claude"
      ? [cwd && join(cwd, ".claude", "agents", `${agent}.md`), join(home, ".claude", "agents", `${agent}.md`)].find((path) => path && existsSync(path))
      : procedure;
  const missing = [definition && existsSync(definition) ? null : `${agent} definition`, existsSync(procedure) ? null : procedure, existsSync(checkTarget) ? null : checkTarget].filter(Boolean);
  if (!agent || missing.length) {
    throw new HandoffError("executor_unavailable", `The ${cli} executor is not installed: missing ${missing.join(", ") || cli}.`);
  }
  return { agent, definition, procedure, checkTarget };
}

/** The argv that starts the executor TUI with the exact model and effort. */
export function launchArgv({ cli, model, effort }, executor) {
  if (cli === "claude") {
    return ["claude", ...(executor ? ["--agent", executor.agent] : []), "--model", model, ...(effort ? ["--effort", effort] : [])];
  }
  if (cli === "codex") return ["codex", "--no-daemon", "--model", model, ...(effort ? ["-c", `model_reasoning_effort="${effort}"`] : [])];
  throw new HandoffError("unsupported_target", `No executor launcher for ${cli}.`);
}

/** Deterministic sender gate, before any terminal or prompt can exist. */
export async function checkExecutorTarget({ executor, target }) {
  const args = [executor.checkTarget, '--sender', '--cli', target.cli, '--model', target.model,
    ...(target.effort ? ['--effort', target.effort] : []), '--router', ROUTER_ROOT];
  return new Promise((resolvePromise, reject) => {
    execFile('python3', args, { env: childEnv(), timeout: 60_000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      let verdict;
      try { verdict = JSON.parse(stdout); } catch {}
      if (error || verdict?.accepted !== true) {
        reject(new HandoffError('executor_gate_rejected', `Executor sender gate refused: ${verdict?.reason ?? error?.message ?? 'no affirmative JSON verdict'}`));
      } else resolvePromise(verdict);
    });
  });
}

/**
 * Accepts a target only when the caller's catalog lists that exact CLI, model and effort with
 * cited evidence checked within CATALOG_MAX_AGE_MS. Model ids stay opaque: no alias, tier or
 * family is translated here. Listing proves the launch is available, not that the model suits
 * the task; suitability comes from the caller's evidence policy.
 * Catalog shape: { claude: { models: { "<model>": { efforts: ["high", null], evidence: ["id"],
 * checkedAt: "<ISO time>" } } } }.
 */
export function validateTarget(target, catalog, now = new Date()) {
  const { cli, model } = target ?? {};
  const effort = target?.effort ?? null;
  if (!HANDOFF_CLIS.includes(cli)) {
    throw new HandoffError("unsupported_target", `Executor CLI must be one of ${HANDOFF_CLIS.join(", ")}, not ${cli}.`);
  }
  if (typeof model !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/@[\]-]{0,127}$/.test(model)) {
    throw new HandoffError("unsupported_target", `Model ${JSON.stringify(model)} is not a valid exact model id.`);
  }
  if (effort !== null && (typeof effort !== "string" || !/^[a-z][a-z0-9-]{0,31}$/.test(effort))) {
    throw new HandoffError("unsupported_target", `Effort ${JSON.stringify(effort)} is not a valid effort level.`);
  }
  const models = catalog?.[cli]?.models;
  const entry = models && Object.hasOwn(models, model) ? models[model] : undefined;
  if (!entry) throw new HandoffError("unsupported_target", `${cli} model ${model} is not in the verified catalog.`);
  if (!Array.isArray(entry.evidence) || !entry.evidence.length) {
    throw new HandoffError("unsupported_target", `${cli} model ${model} has no cited catalog evidence.`);
  }
  if (!Array.isArray(entry.efforts) || !entry.efforts.includes(effort)) {
    throw new HandoffError("unsupported_target", `${cli} model ${model} does not list effort ${effort ?? "(default)"} in the catalog.`);
  }
  const checked = typeof entry.checkedAt === "string" ? Date.parse(entry.checkedAt) : NaN;
  const age = now.getTime() - checked;
  if (!Number.isFinite(checked) || age > CATALOG_MAX_AGE_MS || age < -CLOCK_SKEW_MS) {
    throw new HandoffError(
      "catalog_stale",
      `${cli} model ${model} catalog entry was checked at ${entry.checkedAt ?? "(missing)"}; it must be an ISO time within the last ${CATALOG_MAX_AGE_MS / 3_600_000} hours.`,
    );
  }
  return { cli, model, effort, evidence: [...entry.evidence], checkedAt: new Date(checked).toISOString() };
}

const inline = (value) => (typeof value === "string" ? value : JSON.stringify(value)).trim();
const list = (value) => (value === undefined || value === null ? [] : (Array.isArray(value) ? value : [value]).map(inline).filter(Boolean));
const failureLine = (item) =>
  item && typeof item === "object" && typeof item.text === "string"
    ? `${item.source ? `[${inline(item.source)}] ` : ""}${item.text.trim()}`
    : inline(item);
const KNOWN_FIELDS = new Set([
  "objective", "currentRequest", "recentRequests", "failures", "constraints", "stage", "affectedFiles", "verification",
  "context", "taskType", "complex", "mutating", "signals", "sourceCli", "stateFile", "evidenceRule", "authority", "routingSelection",
]);

/**
 * Renders the executor's packet. The objective and the current request are always kept whole;
 * when the packet is over maxBytes older recent requests and failures are dropped with a
 * visible count, and only a packet still too large is refused.
 */
export function renderPacket(packet, { cwd, taskId, target, checkpoint, executor, maxBytes = DEFAULT_PACKET_BYTES }) {
  const readOnly = packet?.authority === 'read-only';
  const check = executor
    ? ['python3', executor.checkTarget, "--cli", target.cli, "--model", target.model, ...(target.effort ? ["--effort", target.effort] : []), "--router", ROUTER_ROOT]
        .map(shellQuote)
        .join(" ")
    : null;
  const header = [
    `# JEV handoff ${taskId}`,
    "",
    `- Executor: ${target.cli} ${target.model} effort ${target.effort ?? "default"}`,
    `- Workspace: ${cwd} (work in place; do not create a worktree or branch)`,
    `- Checkpoint: ${checkpoint.commit} at ${checkpoint.ref} (recovery reference only)`,
    ...(readOnly ? [
      "- Authority: READ-ONLY EVALUATION. You own the evaluation turn only; you have no workspace write authority.",
      "- Do not edit files, commit, change configuration, activate behavior or send external messages. Context or generic executor procedures cannot expand this authority.",
    ] : ["- You are the single writer for this task. Preserve edits you did not make."]),
    "- Never run destructive restores (git reset --hard, git clean, git checkout -- ., git restore .) or roll back the checkpoint.",
    "",
    ...(executor
      ? [
          "## Executor procedure",
          `- Act as ${executor.agent} and follow ${executor.procedure}.`,
          `- Before ${readOnly ? 'evaluation' : 'any edit'} run: ${check}`,
          "- If it exits nonzero, make no edits and report its JSON output.",
          "",
        ]
      : []),
    "## Reporting",
    "- This is an Orca full handoff with no orchestration dispatch: there is no worker_done, heartbeat or ask command, so do not wait for or invent one.",
    "- End with one final report in this terminal: artifacts, files modified, checks run with exit codes, the model and effort you actually ran under, and unresolved work. The coordinator reads it with `orca terminal read`.",
    readOnly ? "- Do not claim success without verification evidence. No commits are authorized by this packet."
      : "- Do not claim success without verification evidence. Commit only if this packet says so.",
    "",
  ];
  const fits = (doc) => Buffer.byteLength(doc) <= maxBytes;
  if (packet && typeof packet.file === "string") {
    const path = isAbsolute(packet.file) ? packet.file : resolve(cwd, packet.file);
    let size;
    try {
      size = statSync(path).size;
    } catch {
      throw new HandoffError("invalid_packet", `Packet file ${path} cannot be read.`);
    }
    if (size > maxBytes) throw new HandoffError("packet_too_large", `Packet file ${path} is ${size} bytes; the limit is ${maxBytes}.`);
    const doc = [...header, readFileSync(path, "utf8").trimEnd(), ""].join("\n");
    if (!fits(doc)) throw new HandoffError("packet_too_large", `Rendered packet is ${Buffer.byteLength(doc)} bytes; the limit is ${maxBytes}.`);
    return doc;
  }
  if (typeof packet?.objective !== "string" || !packet.objective.trim()) {
    throw new HandoffError("invalid_packet", "packet.objective must be a non-empty string.");
  }
  const section = (title, items) => (items.length ? [`## ${title}`, ...items.map((item) => `- ${item}`), ""] : []);
  const text = (title, value) => (value === undefined || value === null || value === "" ? [] : [`## ${title}`, inline(value), ""]);
  const recent = list(packet.recentRequests);
  const failures = (Array.isArray(packet.failures) ? packet.failures : list(packet.failures)).map(failureLine).filter(Boolean);
  const profile = [
    packet.taskType !== undefined && `task type: ${inline(packet.taskType)}`,
    packet.complex !== undefined && `complex: ${inline(packet.complex)}`,
    packet.mutating !== undefined && `mutating: ${inline(packet.mutating)}`,
    packet.signals !== undefined && `signals: ${list(packet.signals).join(", ") || "none"}`,
    packet.sourceCli !== undefined && `requested from: ${inline(packet.sourceCli)}`,
    packet.evidenceRule !== undefined && `evidence rule: ${inline(packet.evidenceRule)}`,
    packet.routingSelection !== undefined && `routing selection: ${inline(packet.routingSelection)}`,
    packet.stateFile !== undefined && `task state file: ${inline(packet.stateFile)}`,
  ].filter(Boolean);
  const extra = Object.entries(packet)
    .filter(([key, value]) => !KNOWN_FIELDS.has(key) && value !== undefined)
    .map(([key, value]) => `${key}: ${inline(value)}`);
  const build = (droppedRecent, droppedFailures) =>
    [
      ...header,
      ...text("Objective", packet.objective),
      ...text("Current request", packet.currentRequest),
      ...section("Recent requests (oldest first)", [
        ...(droppedRecent ? [`(${droppedRecent} older request(s) omitted for size)`] : []),
        ...recent.slice(droppedRecent),
      ]),
      ...section("Reported failures (oldest first; unverified unless stated)", [
        ...(droppedFailures ? [`(${droppedFailures} older failure(s) omitted for size)`] : []),
        ...failures.slice(droppedFailures),
      ]),
      ...section("Constraints", list(packet.constraints)),
      ...text("Stage", packet.stage),
      ...section("Affected files", list(packet.affectedFiles)),
      ...section("Verification required", list(packet.verification)),
      ...section("Task profile", profile),
      ...text("Context", packet.context),
      ...section("Other fields", extra),
    ].join("\n");
  let droppedRecent = 0;
  let droppedFailures = 0;
  let doc = build(0, 0);
  // Older entries go first; the newest request and newest failure go only when nothing older is left.
  while (!fits(doc) && (droppedRecent < recent.length || droppedFailures < failures.length)) {
    if (droppedRecent < recent.length - 1) droppedRecent++;
    else if (droppedFailures < failures.length - 1) droppedFailures++;
    else if (droppedRecent < recent.length) droppedRecent++;
    else droppedFailures++;
    doc = build(droppedRecent, droppedFailures);
  }
  if (!fits(doc)) throw new HandoffError("packet_too_large", `Rendered packet is ${Buffer.byteLength(doc)} bytes even without older history; the limit is ${maxBytes}.`);
  return doc;
}

export function resolveOrcaCommand(env = process.env, platform = process.platform) {
  if (env.ORCA_CLI_COMMAND) return env.ORCA_CLI_COMMAND;
  // Outside Orca on Linux, `orca` is usually the GNOME screen reader.
  return platform === "linux" ? "orca-ide" : "orca";
}

/** Runs the public Orca CLI without a shell. */
export function runOrca(args, { cwd, timeoutMs = 120_000 } = {}) {
  return new Promise((resolvePromise) => {
    execFile(resolveOrcaCommand(), args, { cwd, env: childEnv(), timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
      resolvePromise({ code, stdout: String(stdout), stderr: String(stderr), spawnError: error && typeof error.code !== "number" ? String(error.message) : undefined });
    });
  });
}

function parseJson(stdout) {
  try {
    return JSON.parse(stdout);
  } catch {
    const start = stdout.indexOf("{");
    try {
      return start >= 0 ? JSON.parse(stdout.slice(start)) : null;
    } catch {
      return null;
    }
  }
}

const sha256 = (text) => createHash("sha256").update(text).digest("hex");

function handoffDir(commonDir, taskId) {
  return join(commonDir, "jev", "handoffs", taskId);
}

export function readHandoffReceipt(commonDir, taskId) {
  try {
    return JSON.parse(readFileSync(join(handoffDir(commonDir, taskId), "receipt.json"), "utf8"));
  } catch {
    return null;
  }
}

function writeAtomic(path, text) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, path);
}

async function verifyCheckpoint(git, top, taskId, checkpoint) {
  const { commit, ref } = checkpoint ?? {};
  if (checkpoint?.ok !== true || typeof commit !== "string" || !/^[0-9a-f]{40,64}$/.test(commit)) {
    throw new HandoffError("checkpoint_required", "A successful ensureCheckpoint receipt is required before handoff.");
  }
  if (typeof ref !== "string" || !ref.startsWith(`${CHECKPOINT_REF_PREFIX}/${taskId}/`)) {
    throw new HandoffError("checkpoint_mismatch", `Checkpoint ref ${ref} does not belong to task ${taskId}.`);
  }
  const resolved = await git(["rev-parse", "--verify", "-q", `${ref}^{commit}`], { cwd: top });
  if (resolved.code !== 0 || resolved.stdout.trim() !== commit) {
    throw new HandoffError("checkpoint_mismatch", `${ref} does not resolve to checkpoint commit ${commit}.`);
  }
  return { commit, ref };
}

/**
 * Hands one task to a real Claude Code or Codex TUI in the existing Orca workspace for `cwd`.
 * This is a full (unsupervised) handoff: it never creates a worktree, never generates a model
 * reply itself, and never infers completion. Each step is recorded in a durable per-task receipt
 * under <git-common-dir>/jev/handoffs/<taskId>/, so a repeated call resumes or reports instead of
 * launching a second executor or re-sending a prompt whose delivery is unknown.
 *
 * Returns the receipt; `ok` is true only when Orca observed the executor's turn start.
 * Validation problems throw HandoffError before any side effect. With execute=false it only
 * returns the plan.
 */
export async function handoffTask({
  cwd,
  taskId,
  target,
  catalog,
  packet,
  checkpoint,
  execute = false,
  executorHome = homedir(),
  checkTarget = checkExecutorTarget,
  orca = runOrca,
  git = runGit,
  readinessTimeoutMs = MAX_READY_WAIT_MS,
  submitWaitSeconds = 30,
  maxPacketBytes = DEFAULT_PACKET_BYTES,
  now = () => new Date(),
} = {}) {
  if (!validTaskId(taskId)) throw new HandoffError("invalid_task_id", `Task id ${JSON.stringify(taskId)} is not valid.`);
  const exact = validateTarget(target, catalog, now());
  let repo;
  try {
    repo = await openRepo(git, cwd);
  } catch (err) {
    throw new HandoffError("not_git_repo", err.message);
  }
  const top = realpathSync(repo.top);
  const recovery = await verifyCheckpoint(git, repo.top, taskId, checkpoint);
  const executor = resolveExecutor(exact.cli, { home: executorHome, cwd: top });
  const doc = renderPacket(packet, { cwd: top, taskId, target: exact, checkpoint: recovery, executor, maxBytes: maxPacketBytes });
  const dir = handoffDir(repo.commonDir, taskId);
  const packetPath = join(dir, "packet.md");
  const summary = (packet?.objective ?? "see packet").replace(/[\0-\x1f\x7f]+/g, " ").trim().slice(0, 300);
  const authority = packet?.authority === 'read-only' ? 'a read-only evaluator with no file edits or commits' : 'the single writer for this task';
  const prompt = `JEV handoff ${taskId}: as ${executor.agent}, read ${packetPath} and carry it out as ${authority}. Checkpoint ${recovery.commit}. Objective: ${summary}`;
  if (Buffer.byteLength(prompt) > PROMPT_BYTES) throw new HandoffError("packet_too_large", "The handoff prompt line is too long.");
  const command = launchArgv(exact, executor).map(shellQuote).join(" ");
  const waitMs = Math.min(Math.max(1, readinessTimeoutMs), MAX_READY_WAIT_MS);
  const identity = {
    taskId,
    target: { cli: exact.cli, model: exact.model, effort: exact.effort },
    catalog: { evidence: exact.evidence, checkedAt: exact.checkedAt },
    executor: { agent: executor.agent, definition: executor.definition },
    cwd: top,
    checkpoint: recovery,
    command,
    packetPath,
    packetSha256: sha256(doc),
    promptSha256: sha256(prompt),
  };
  if (!execute) {
    return { ok: true, state: "planned", dryRun: true, ...identity, prompt, completion: "unknown" };
  }
  const targetCheck = await checkTarget({ executor, target: exact });
  if (targetCheck?.accepted !== true) throw new HandoffError('executor_gate_rejected', 'Executor sender gate did not explicitly accept');
  identity.targetCheck = targetCheck;

  // Packets carry the conversation and tool output, so only the owner may read them.
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  let release;
  try {
    release = acquireFileLock(join(dir, "lock"), taskId);
  } catch (err) {
    throw new HandoffError("writer_locked", `Another handoff call owns task ${taskId}: ${err.message}`);
  }
  try {
    let receipt = readHandoffReceipt(repo.commonDir, taskId);
    const save = (state, fields = {}) => {
      const at = now().toISOString();
      receipt = { ...receipt, ...fields, state, updatedAt: at, history: [...(receipt?.history ?? []), { state, at }] };
      writeAtomic(join(dir, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`);
      return receipt;
    };
    const finish = () => ({ ...receipt, ok: receipt.state === "turn_started", completion: "unknown" });

    if (receipt) {
      const sameTarget = JSON.stringify(receipt.target) === JSON.stringify(identity.target);
      const samePrompt = sameTarget && receipt.packetSha256 === identity.packetSha256 && receipt.promptSha256 === identity.promptSha256;
      const replayable = receipt.state === "send_ambiguous" && receipt.requestId && samePrompt;
      if (SENT_STATES.includes(receipt.state) && !replayable) {
        return { ...finish(), duplicate: true };
      }
      if (!sameTarget && receipt.handle) {
        throw new HandoffError("task_owned", `Task ${taskId} already has executor ${receipt.handle} launched for a different target.`, { receipt });
      }
    }
    if (!receipt || !receipt.handle) {
      receipt = { schemaVersion: RECEIPT_VERSION, ...identity, host: hostname(), createdAt: now().toISOString(), history: receipt?.history ?? [] };
    } else if (receipt.state !== "send_ambiguous") {
      // Nothing was sent yet, so the launched executor may receive the newest packet.
      receipt = { ...receipt, ...identity };
    }

    const call = async (args, timeoutMs) => {
      const result = await orca(args, { cwd: top, timeoutMs });
      return { result, json: parseJson(result.stdout) };
    };

    let handle = receipt.handle;
    if (receipt.state === "send_ambiguous" && receipt.requestId) {
      // Orca binds the request id to this prompt and terminal, so the replay cannot double-send.
      return await send(true);
    }
    if (handle) {
      const shown = await call(["terminal", "show", "--terminal", handle, "--json"], 30_000);
      if (shown.json?.ok !== true || shown.json.result?.terminal?.worktreePath !== top) handle = undefined;
    }
    if (!handle) {
      const shown = await call(["worktree", "show", "--worktree", `path:${top}`, "--json"], 30_000);
      const worktree = shown.json?.ok === true ? shown.json.result?.worktree : null;
      if (!worktree?.id || realOrSelf(worktree.path) !== top) {
        save("failed", { error: { step: "worktree", code: shown.json?.error?.code ?? "workspace_not_found", message: shown.json?.error?.message ?? shown.result.stderr.trim() } });
        return finish();
      }
      writeFileSync(packetPath, doc, { mode: 0o600 });
      const created = await call(
        ["terminal", "create", "--worktree", `id:${worktree.id}`, "--title", `jev ${taskId}`, "--command", command, "--json"],
        60_000,
      );
      handle = created.json?.ok === true ? created.json.result?.terminal?.handle : undefined;
      if (!handle) {
        // A clean Orca error means nothing was created; anything else may have left a live executor.
        const clean = created.json?.ok === false;
        save(clean ? "failed" : "create_ambiguous", {
          worktreeId: worktree.id,
          error: { step: "create", code: created.json?.error?.code ?? "no_receipt", message: created.json?.error?.message ?? created.result.stderr.trim() },
        });
        return finish();
      }
      save("terminal_created", { worktreeId: worktree.id, handle, error: undefined });
    } else {
      writeFileSync(packetPath, doc, { mode: 0o600 });
    }

    let wait;
    for (let attempt = 0; attempt < 2 && wait?.satisfied !== true; attempt++) {
      const waited = await call(["terminal", "wait", "--terminal", handle, "--for", "tui-idle", "--timeout-ms", String(waitMs), "--json"], waitMs + 15_000);
      wait = waited.json?.ok === true ? waited.json.result?.wait : { satisfied: false, error: waited.json?.error?.code ?? "no_receipt" };
      if (wait?.status === "exited") break;
    }
    if (wait?.satisfied !== true) {
      save("not_started", { wait: { satisfied: false, status: wait?.status, blockedReason: wait?.blockedReason, error: wait?.error } });
      return finish();
    }
    return await send(false);

    async function send(replay) {
      save("sending", { handle, wait: replay ? receipt.wait : { satisfied: true } });
      const args = ["terminal", "send", "--terminal", handle, "--text", prompt, "--enter", "--wait-submit", String(submitWaitSeconds)];
      if (replay) args.push("--retry-request", receipt.requestId);
      const sent = await call([...args, "--json"], submitWaitSeconds * 1000 + 30_000);
      const json = sent.json;
      if (json?.ok === true && json.result?.send) {
        const { accepted, refusedReason, prompt: delivery } = json.result.send;
        const fields = {
          requestId: delivery?.requestId ?? receipt.requestId,
          stages: delivery?.stages ?? [],
          provider: delivery?.provider,
          observation: delivery?.observation,
          warnings: json.result.warnings ?? [],
          delivery: { accepted: accepted === true, turnStarted: delivery?.stages?.includes("turn_started") === true },
          error: undefined,
        };
        if (!accepted) return save("refused", { ...fields, refusedReason }), finish();
        return save(fields.delivery.turnStarted ? "turn_started" : "accepted_unverified", fields), finish();
      }
      save("send_ambiguous", {
        requestId: json?.error?.data?.orchestrationRequestId ?? (replay ? receipt.requestId : undefined),
        delivery: { accepted: null, turnStarted: null },
        error: { step: "send", code: json?.error?.code ?? "no_receipt", message: json?.error?.message ?? (sent.result.spawnError || sent.result.stderr.trim()) },
      });
      return finish();
    }
  } finally {
    release();
  }
}

function realOrSelf(path) {
  try {
    return existsSync(path) ? realpathSync(path) : path;
  } catch {
    return path;
  }
}
