import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, openSync, readFileSync, readlinkSync, unlinkSync, writeSync, closeSync } from "node:fs";
import { hostname } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { childEnv } from "./child-env.mjs";

export const CHECKPOINT_REF_PREFIX = "refs/jev/checkpoints";
export const DEFAULT_MAX_FILE_BYTES = 100 * 1024 * 1024;
const LIST_LIMIT = 1000;
const SNAPSHOT_ATTEMPTS = 2;
const IDENTITY = {
  GIT_AUTHOR_NAME: "jev-checkpoint",
  GIT_AUTHOR_EMAIL: "jev-checkpoint@localhost",
  GIT_COMMITTER_NAME: "jev-checkpoint",
  GIT_COMMITTER_EMAIL: "jev-checkpoint@localhost",
};

/** A refusal the caller must act on before complex execution may start. */
export class CheckpointError extends Error {
  constructor(code, message, { remedy, paths, cause } = {}) {
    super(remedy ? `${message} ${remedy}` : message, cause ? { cause } : undefined);
    this.name = "CheckpointError";
    this.code = code;
    this.remedy = remedy;
    this.paths = paths ?? [];
  }
}

/**
 * Runs git without a shell or prompts. GIT_OPTIONAL_LOCKS=0 keeps `git status` from
 * refreshing the user's index file, so a snapshot never rewrites it.
 */
export function runGit(args, { cwd, env = {}, input } = {}) {
  return new Promise((resolvePromise) => {
    const child = execFile(
      "git",
      args,
      {
        cwd,
        env: childEnv(process.env, { GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C", ...env }),
        maxBuffer: 512 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
        resolvePromise({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
    if (input !== undefined) child.stdin.end(input);
  });
}

export function validTaskId(taskId) {
  return (
    typeof taskId === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(taskId) &&
    !taskId.includes("..") &&
    !taskId.endsWith(".lock")
  );
}

/**
 * Names that usually hold credentials. Matching is by file name only: content is not
 * scanned, so an unusual secret file name is not detected.
 */
export function isSensitivePath(path) {
  const name = basename(path).toLowerCase();
  if (/^\.env(\..+)?$/.test(name)) return !/\.(example|sample|template|dist)$/.test(name);
  return (
    /\.(pem|key|p12|pfx|jks|keystore|kdbx|ppk|asc|gpg)$/.test(name) ||
    /^id_(rsa|dsa|ecdsa|ed25519)$/.test(name) ||
    [".npmrc", ".pypirc", ".netrc", ".git-credentials", ".htpasswd", "credentials", "credentials.json"].includes(name) ||
    /^secrets?\.(json|ya?ml|toml|env|txt)$/.test(name) ||
    /^service[-_]?account.*\.json$/.test(name)
  );
}

/**
 * Snapshots every tracked and non-ignored untracked change into a durable local commit
 * under refs/jev/checkpoints/<taskId>/ before complex execution. HEAD, the user's index
 * bytes and the working tree are left untouched; nothing is pushed or restored.
 *
 * The commit is stash-shaped (not stash-compatible): its tree is the working tree, its second parent records
 * the staged index, so either state can be inspected or recovered by hand. Anything the
 * snapshot cannot really cover (nested repositories, dirty submodules, credential-looking
 * files, very large files, assume-unchanged entries, unresolved conflicts) throws before
 * execution unless the caller chose an explicit handling for it.
 */
export async function ensureCheckpoint({
  cwd,
  taskId,
  reason,
  sensitive = "fail",
  acknowledgeUncovered = [],
  maxFileBytes = DEFAULT_MAX_FILE_BYTES,
  git = runGit,
  now = () => new Date(),
} = {}) {
  if (!validTaskId(taskId)) {
    throw new CheckpointError("invalid_task_id", `Task id ${JSON.stringify(taskId)} cannot name a checkpoint ref.`, {
      remedy: "Use 1-100 characters from [A-Za-z0-9._-], starting with a letter or digit.",
    });
  }
  if (typeof reason !== "string" || !reason.trim()) {
    throw new CheckpointError("invalid_reason", "A checkpoint needs a non-empty reason.");
  }
  if (!["fail", "exclude", "include-local"].includes(sensitive)) {
    throw new CheckpointError("invalid_option", `sensitive must be fail, exclude or include-local, not ${sensitive}.`);
  }
  const repo = await openRepo(git, cwd);
  const release = acquireFileLock(join(repo.commonDir, "jev-checkpoint.lock"), taskId);
  try {
    for (let attempt = 1; ; attempt++) {
      try {
        return await snapshot({ git, repo, taskId, reason, sensitive, acknowledgeUncovered, maxFileBytes, now });
      } catch (err) {
        if (err.code !== "concurrent_change" || attempt >= SNAPSHOT_ATTEMPTS) throw err;
      }
    }
  } finally {
    release();
  }
}

export async function openRepo(git, cwd) {
  const probe = await git(["rev-parse", "--show-toplevel", "--absolute-git-dir", "--git-common-dir"], { cwd });
  const [top, gitDir, common] = probe.stdout.trim().split("\n");
  if (probe.code !== 0 || !top || !gitDir || !common) {
    throw new CheckpointError("not_git_repo", `${cwd} is not inside a Git working tree.`, {
      remedy: "Run the task from a non-bare Git checkout, or initialise one before complex execution.",
    });
  }
  return { top, gitDir, commonDir: isAbsolute(common) ? common : resolve(cwd, common) };
}

/**
 * An exclusive lock file; a holder that was a process on this host and is gone is stale.
 * Returns a release function that removes the file only while it still holds our token.
 */
export function acquireFileLock(path, taskId) {
  const token = randomBytes(8).toString("hex");
  const body = JSON.stringify({ pid: process.pid, host: hostname(), taskId, token, at: new Date().toISOString() });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, "wx");
      writeSync(fd, body);
      closeSync(fd);
      return () => {
        try {
          if (JSON.parse(readFileSync(path, "utf8")).token === token) unlinkSync(path);
        } catch {}
      };
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      let holder = {};
      try {
        holder = JSON.parse(readFileSync(path, "utf8"));
      } catch {}
      if (attempt === 0 && holder.host === hostname() && Number.isInteger(holder.pid) && !processAlive(holder.pid)) {
        try {
          unlinkSync(path);
        } catch {}
        continue;
      }
      throw new CheckpointError("locked", `Another checkpoint holds ${path} (pid ${holder.pid ?? "?"}, task ${holder.taskId ?? "?"}).`, {
        remedy: "Wait for it to finish; if no checkpoint is running, inspect and remove that lock file.",
      });
    }
  }
  throw new CheckpointError("locked", `Could not acquire ${path}.`);
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

function fileDigest(path) {
  return existsSync(path) ? createHash("sha256").update(readFileSync(path)).digest("hex") : "absent";
}

async function gitOk(git, args, opts, code = "git_failed") {
  const result = await git(args, opts);
  if (result.code !== 0) {
    throw new CheckpointError(code, `git ${args[0]} failed: ${result.stderr.trim() || `exit ${result.code}`}.`);
  }
  return result.stdout;
}

async function resolveHead(git, top) {
  const head = await git(["rev-parse", "--verify", "-q", "HEAD^{commit}"], { cwd: top });
  const branch = await git(["symbolic-ref", "-q", "HEAD"], { cwd: top });
  return { head: head.code === 0 ? head.stdout.trim() : null, branch: branch.code === 0 ? branch.stdout.trim() : null };
}

/** Parses `git status --porcelain=v2 -z --no-renames` into the paths a snapshot must cover. */
export function parseStatus(output) {
  const entries = { changed: [], deleted: [], untracked: [], staged: [], unmerged: [], nested: [], submodules: [] };
  const records = output.split("\0");
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (!record) continue;
    const kind = record[0];
    if (kind === "?") {
      const path = record.slice(2);
      if (path.endsWith("/")) entries.nested.push(path.slice(0, -1));
      else entries.untracked.push(path);
      continue;
    }
    if (kind === "u") {
      entries.unmerged.push(record.split(" ").slice(10).join(" "));
      continue;
    }
    if (kind !== "1" && kind !== "2") continue;
    const fields = record.split(" ");
    const path = fields.slice(kind === "1" ? 8 : 9).join(" ");
    if (kind === "2") i++;
    const [x, y] = fields[1];
    const sub = fields[2];
    if (sub.startsWith("S")) {
      entries.submodules.push({ path, commitChanged: sub[1] === "C", modified: sub[2] === "M", untracked: sub[3] === "U" });
    } else if (x !== "." && x !== "D") {
      entries.staged.push(path);
    }
    if (y === "D" || (x === "D" && y === ".")) entries.deleted.push(path);
    else entries.changed.push(path);
  }
  // A staged deletion whose file was recreated is reported again as untracked.
  const recreated = new Set(entries.untracked);
  entries.deleted = entries.deleted.filter((path) => !recreated.has(path));
  return entries;
}

async function snapshot({ git, repo, taskId, reason, sensitive, acknowledgeUncovered, maxFileBytes, now }) {
  const { top, gitDir } = repo;
  if (existsSync(join(gitDir, "index.lock"))) {
    throw new CheckpointError("locked", `${join(gitDir, "index.lock")} exists, so another Git process is writing the index.`, {
      remedy: "Let that Git command finish before starting complex execution.",
    });
  }
  const indexFile = join(gitDir, "index");
  const before = { ...(await resolveHead(git, top)), index: fileDigest(indexFile) };
  const acknowledged = new Set(acknowledgeUncovered.map((path) => String(path).replace(/\/+$/, "")));
  const status = parseStatus(
    await gitOk(git, ["status", "--porcelain=v2", "-z", "--no-renames", "--untracked-files=all", "--ignore-submodules=none"], { cwd: top }),
  );

  if (status.unmerged.length) {
    throw new CheckpointError("unmerged_index", "The index has unresolved merge conflicts, so the staged state cannot be recorded.", {
      remedy: "Resolve or abort the merge/rebase before complex execution.",
      paths: status.unmerged,
    });
  }
  const indexEntries = parseIndex(await gitOk(git, ["ls-files", "-s", "-v", "-z"], { cwd: top }));
  const assumed = indexEntries.filter((entry) => /^[a-z]$/.test(entry.tag)).map((entry) => entry.path);
  if (assumed.length) {
    throw new CheckpointError("assume_unchanged", "Some tracked files are marked assume-unchanged, so their edits would be invisible to a snapshot.", {
      remedy: "Run `git update-index --no-assume-unchanged <path>` for them first.",
      paths: assumed,
    });
  }

  const excluded = [];
  const warnings = [];
  const uncovered = (list, code, message, remedy, why) => {
    const blocking = list.filter((path) => !acknowledged.has(path));
    if (blocking.length) throw new CheckpointError(code, message, { remedy, paths: blocking });
    for (const path of list) excluded.push({ path, reason: why });
  };
  uncovered(
    status.nested,
    "nested_repo",
    "Untracked nested Git repositories would be stored as bare gitlinks without their files.",
    "Commit or ignore them, or pass their paths in acknowledgeUncovered to proceed without protecting them.",
    "nested repository not captured",
  );
  const dirtySubmodules = status.submodules.filter((sub) => sub.modified || sub.untracked).map((sub) => sub.path);
  uncovered(
    dirtySubmodules,
    "dirty_submodule",
    "Submodules have uncommitted work, which a gitlink cannot record.",
    "Commit or stash inside each submodule, or pass their paths in acknowledgeUncovered to proceed without protecting that work.",
    "dirty submodule content not captured",
  );
  for (const sub of status.submodules.filter((item) => item.commitChanged && !dirtySubmodules.includes(item.path))) {
    warnings.push(`submodule ${sub.path} is recorded at its checked-out commit, which lives only in the submodule repository`);
  }

  // Skip-worktree entries are invisible to `git add -A`, so an edited one would be silently lost.
  const skipModified = await modifiedSkipWorktree(git, top, indexEntries.filter((entry) => entry.tag === "S"));
  uncovered(
    skipModified,
    "skip_worktree_modified",
    "Files marked skip-worktree differ from the index, so a snapshot would record the index version instead of the edit.",
    "Run `git update-index --no-skip-worktree <path>` for them first, or pass their paths in acknowledgeUncovered to proceed without protecting those edits.",
    "skip-worktree edit not captured",
  );

  const present = [...status.changed, ...status.untracked].filter((path) => !status.submodules.some((sub) => sub.path === path));
  // Staged content enters the index commit even when its working file is gone, so it is screened too.
  const screened = [...new Set([...present, ...status.staged])];
  const revert = new Set();
  const secrets = screened.filter(isSensitivePath);
  if (secrets.length && sensitive === "fail") {
    throw new CheckpointError("sensitive_paths", "Credential-looking files are staged or not ignored, so a snapshot would copy them into Git objects.", {
      remedy: "Ignore them, or choose sensitive: 'exclude' (leave them unprotected) or 'include-local' (store them in the local-only checkpoint ref).",
      paths: secrets,
    });
  }
  if (sensitive === "exclude") {
    for (const path of secrets) {
      excluded.push({ path, reason: "sensitive file excluded by request" });
      revert.add(path);
    }
  }
  if (secrets.length && sensitive === "include-local") {
    warnings.push("credential-looking files are stored in the local checkpoint; never push refs/jev/* or mirror this repository");
  }
  const stagedSizes = await blobSizes(
    git,
    top,
    indexEntries.filter((entry) => status.staged.includes(entry.path) && entry.mode !== "160000"),
  );
  const oversized = screened.filter((path) => {
    if ((stagedSizes.get(path) ?? 0) > maxFileBytes) return true;
    try {
      const stat = lstatSync(join(top, path));
      return stat.isFile() && stat.size > maxFileBytes;
    } catch {
      return false;
    }
  });
  for (const path of oversized) revert.add(path);
  uncovered(
    oversized,
    "oversized_paths",
    `Files exceed the ${maxFileBytes}-byte checkpoint limit.`,
    "Ignore them, raise maxFileBytes, or pass their paths in acknowledgeUncovered to proceed without protecting them.",
    "file exceeds checkpoint size limit",
  );

  const tag = `${process.pid}-${randomBytes(4).toString("hex")}`;
  const indexCopy = join(gitDir, `jev-checkpoint-index-${tag}`);
  const worktreeCopy = join(gitDir, `jev-checkpoint-worktree-${tag}`);
  try {
    const seedIndex = (path) => {
      if (existsSync(indexFile)) copyFileSync(indexFile, path);
    };
    seedIndex(indexCopy);
    seedIndex(worktreeCopy);
    if (revert.size) {
      // Excluded paths go back to their HEAD version (or out) in both snapshots, staged content included.
      const info = await headIndexInfo(git, top, before.head, [...revert]);
      for (const file of [indexCopy, worktreeCopy]) {
        await gitOk(git, ["update-index", "-z", "--index-info"], { cwd: top, env: { GIT_INDEX_FILE: file }, input: info });
      }
    }
    const indexTree = (await gitOk(git, ["write-tree"], { cwd: top, env: { GIT_INDEX_FILE: indexCopy } })).trim();
    const pathspec = [".", ...excluded.map(({ path }) => `:(top,exclude,literal)${path}`)];
    const addAll = () => gitOk(git, ["add", "-A", "--", ...pathspec], { cwd: top, env: { GIT_INDEX_FILE: worktreeCopy } }, "add_failed");
    const writeTree = async () => (await gitOk(git, ["write-tree"], { cwd: top, env: { GIT_INDEX_FILE: worktreeCopy } })).trim();
    await addAll();
    const worktreeTree = await writeTree();
    // A second pass rehashes anything whose stat changed; a different tree means files moved under us.
    await addAll();
    const recheck = await writeTree();
    const after = { ...(await resolveHead(git, top)), index: fileDigest(indexFile) };
    if (recheck !== worktreeTree || after.head !== before.head || after.index !== before.index || after.branch !== before.branch) {
      throw new CheckpointError("concurrent_change", "The working tree, index or HEAD changed while the checkpoint was being taken.", {
        remedy: "Stop other writers in this checkout and retry.",
      });
    }

    const skip = new Set(excluded.map(({ path }) => path));
    const listed = new Set(
      (await gitOk(git, ["ls-tree", "-r", "-z", "--name-only", worktreeTree], { cwd: top })).split("\0").filter(Boolean),
    );
    const missing = present.filter((path) => !skip.has(path) && !listed.has(path));
    const lingering = status.deleted.filter((path) => !skip.has(path) && listed.has(path));
    if (missing.length || lingering.length) {
      throw new CheckpointError("coverage_verify_failed", "The snapshot tree does not match the working tree it was taken from.", {
        remedy: "Report this with the listed paths; do not start complex execution.",
        paths: [...missing, ...lingering],
      });
    }

    const ignoredList = (
      await gitOk(git, ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"], { cwd: top })
    )
      .split("\0")
      .filter(Boolean);
    if (ignoredList.length) warnings.push(`${ignoredList.length} ignored path(s) are not protected; \`git clean -x\` would still delete them`);

    const receipt = {
      ok: true,
      taskId,
      reason,
      cwd: top,
      head: before.head,
      branch: before.branch,
      indexTree,
      worktreeTree,
      files: summarize({ changed: status.changed, deleted: status.deleted, untracked: status.untracked }, skip),
      excluded,
      ignored: { count: ignoredList.length, covered: false, sample: ignoredList.slice(0, 20) },
      sensitive: sensitive === "exclude" ? [] : secrets,
      submodules: status.submodules,
      warnings,
      coverage: "tracked and non-ignored untracked files; ignored files, excluded paths and other repositories are not protected",
    };

    const reusable = await latestMatching(git, top, taskId, before.head, indexTree, worktreeTree);
    if (reusable) {
      return { ...receipt, ...reusable, reused: true };
    }

    const env = IDENTITY;
    const headParents = before.head ? ["-p", before.head] : [];
    const indexCommit = (
      await gitOk(git, ["commit-tree", indexTree, ...headParents, "-m", `jev checkpoint index: ${taskId}`], { cwd: top, env })
    ).trim();
    const message = [
      `jev checkpoint: ${taskId}`,
      "",
      reason.replace(/\s+/g, " ").trim().slice(0, 500),
      "",
      `Jev-Task: ${taskId}`,
      `Jev-Head: ${before.head ?? "unborn"}`,
      `Jev-Branch: ${before.branch ?? "detached"}`,
      `Jev-Excluded: ${excluded.length}`,
    ].join("\n");
    const commit = (
      await gitOk(git, ["commit-tree", worktreeTree, ...headParents, "-p", indexCommit, "-F", "-"], { cwd: top, env, input: message })
    ).trim();
    const createdAt = now().toISOString();
    const ref = `${CHECKPOINT_REF_PREFIX}/${taskId}/${createdAt.replace(/[-:.]/g, "")}-${commit.slice(0, 12)}`;
    await gitOk(git, ["update-ref", "-m", `jev checkpoint ${taskId}`, ref, commit, ""], { cwd: top }, "ref_create_failed");
    const verified = await git(["rev-parse", "--verify", "-q", `${ref}^{commit}`], { cwd: top });
    if (verified.code !== 0 || verified.stdout.trim() !== commit) {
      throw new CheckpointError("ref_verify_failed", `${ref} does not resolve to the checkpoint commit ${commit}.`);
    }
    return { ...receipt, commit, indexCommit, ref, createdAt, reused: false };
  } finally {
    for (const path of [indexCopy, worktreeCopy]) {
      try {
        unlinkSync(path);
      } catch {}
    }
  }
}

/** Parses `git ls-files -s -v -z`: "<tag> <mode> <oid> <stage>\t<path>". */
export function parseIndex(output) {
  return output
    .split("\0")
    .filter(Boolean)
    .map((record) => {
      const tab = record.indexOf("\t");
      const [tag, mode, oid, stage] = record.slice(0, tab).split(" ");
      return { tag, mode, oid, stage, path: record.slice(tab + 1) };
    });
}

async function modifiedSkipWorktree(git, top, entries) {
  const regular = [];
  const changed = [];
  for (const entry of entries) {
    let stat;
    try {
      stat = lstatSync(join(top, entry.path));
    } catch {
      continue; // Absent under sparse checkout: the index version is the content.
    }
    if (entry.mode === "120000" || stat.isSymbolicLink()) {
      const target = stat.isSymbolicLink() ? readlinkSync(join(top, entry.path)) : null;
      const hashed = target === null ? null : await git(["hash-object", "--stdin"], { cwd: top, input: target });
      if (entry.mode !== "120000" || !hashed || hashed.stdout.trim() !== entry.oid) changed.push(entry.path);
    } else if (stat.isFile()) {
      regular.push(entry);
    } else {
      changed.push(entry.path);
    }
  }
  if (regular.length) {
    const hashes = (await gitOk(git, ["hash-object", "--stdin-paths"], { cwd: top, input: `${regular.map((entry) => entry.path).join("\n")}\n` }))
      .trim()
      .split("\n");
    regular.forEach((entry, i) => {
      if (hashes[i] !== entry.oid) changed.push(entry.path);
    });
  }
  return changed;
}

async function blobSizes(git, top, entries) {
  const sizes = new Map();
  if (!entries.length) return sizes;
  const out = await gitOk(git, ["cat-file", "--batch-check=%(objectsize)"], { cwd: top, input: `${entries.map((entry) => entry.oid).join("\n")}\n` });
  out
    .trim()
    .split("\n")
    .forEach((line, i) => sizes.set(entries[i].path, Number(line) || 0));
  return sizes;
}

/** `update-index --index-info` input that restores each path to HEAD, or removes it when HEAD lacks it. */
async function headIndexInfo(git, top, head, paths) {
  const format = (await gitOk(git, ["rev-parse", "--show-object-format"], { cwd: top })).trim();
  const zero = "0".repeat(format === "sha256" ? 64 : 40);
  const inHead = new Map();
  if (head) {
    const listed = await gitOk(git, ["ls-tree", "-z", "--full-tree", head, "--", ...paths], { cwd: top });
    for (const line of listed.split("\0").filter(Boolean)) inHead.set(line.slice(line.indexOf("\t") + 1), line);
  }
  return paths.map((path) => (inHead.has(path) ? inHead.get(path) : `0 ${zero}\t${path}`)).join("\0") + "\0";
}

function summarize(groups, skip) {
  const out = { count: 0, truncated: false };
  for (const [name, paths] of Object.entries(groups)) {
    const kept = paths.filter((path) => !skip.has(path));
    out.count += kept.length;
    out[name] = kept.slice(0, LIST_LIMIT);
    if (kept.length > LIST_LIMIT) out.truncated = true;
  }
  return out;
}

/** Reuses the task's newest checkpoint only when HEAD, staged tree and working tree all match it. */
async function latestMatching(git, top, taskId, head, indexTree, worktreeTree) {
  const refs = await git(
    ["for-each-ref", "--sort=-refname", "--count=1", "--format=%(refname) %(objectname)", `${CHECKPOINT_REF_PREFIX}/${taskId}`],
    { cwd: top },
  );
  const [ref, commit] = refs.stdout.trim().split(" ");
  if (refs.code !== 0 || !ref || !commit) return null;
  const parsed = await readCommit(git, top, commit);
  if (!parsed || parsed.tree !== worktreeTree) return null;
  const indexCommit = parsed.parents.at(-1);
  const index = indexCommit ? await readCommit(git, top, indexCommit) : null;
  const expectedParents = head ? [head, indexCommit] : [indexCommit];
  if (!index || index.tree !== indexTree || parsed.parents.join() !== expectedParents.join()) return null;
  if (head ? index.parents.join() !== head : index.parents.length) return null;
  return { commit, indexCommit, ref, createdAt: new Date(parsed.committerTime * 1000).toISOString() };
}

async function readCommit(git, top, oid) {
  const result = await git(["cat-file", "commit", oid], { cwd: top });
  if (result.code !== 0) return null;
  const header = result.stdout.split("\n\n")[0].split("\n");
  const tree = header.find((line) => line.startsWith("tree "))?.slice(5);
  const parents = header.filter((line) => line.startsWith("parent ")).map((line) => line.slice(7));
  const committer = header.find((line) => line.startsWith("committer ")) ?? "";
  return { tree, parents, committerTime: Number(committer.split(" ").at(-2)) || 0 };
}
