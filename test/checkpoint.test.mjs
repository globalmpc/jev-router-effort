import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureCheckpoint, isSensitivePath, parseStatus, runGit } from "../src/checkpoint.mjs";

// Every repository here is a disposable directory under the OS temp dir.
function git(cwd, ...args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
  }).trim();
}

function repo(t, { commit = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "jev-checkpoint-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "commit.gpgsign", "false");
  if (commit) {
    writeFileSync(join(dir, "a.txt"), "one\n");
    writeFileSync(join(dir, "b.txt"), "two\n");
    writeFileSync(join(dir, ".gitignore"), "ignored/\n*.log\n");
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", "base");
  }
  return dir;
}

function state(dir) {
  return {
    head: git(dir, "rev-parse", "HEAD"),
    index: readFileSync(join(dir, ".git", "index")).toString("hex"),
    status: git(dir, "status", "--porcelain=v1", "--untracked-files=all"),
  };
}

const show = (dir, spec) => git(dir, "show", spec);

test("snapshot keeps staged, unstaged, deleted and untracked work without touching HEAD or the index", async (t) => {
  const dir = repo(t);
  writeFileSync(join(dir, "a.txt"), "staged\n");
  git(dir, "add", "a.txt");
  writeFileSync(join(dir, "a.txt"), "staged then edited\n");
  rmSync(join(dir, "b.txt"));
  mkdirSync(join(dir, "new dir"));
  writeFileSync(join(dir, "new dir", "c file.txt"), "untracked\n");
  mkdirSync(join(dir, "ignored"));
  writeFileSync(join(dir, "ignored", "cache.bin"), "x");
  const before = state(dir);

  const receipt = await ensureCheckpoint({ cwd: dir, taskId: "task-1", reason: "before refactor" });

  assert.deepEqual(state(dir), before);
  assert.equal(receipt.ok, true);
  assert.equal(receipt.reused, false);
  assert.equal(receipt.head, before.head);
  assert.match(receipt.ref, /^refs\/jev\/checkpoints\/task-1\/\d{8}T\d{9}Z-[0-9a-f]{12}$/);
  assert.equal(git(dir, "rev-parse", receipt.ref), receipt.commit);
  assert.equal(show(dir, `${receipt.commit}:a.txt`), "staged then edited");
  assert.equal(show(dir, `${receipt.commit}:new dir/c file.txt`), "untracked");
  assert.throws(() => show(dir, `${receipt.commit}:b.txt`));
  assert.throws(() => show(dir, `${receipt.commit}:ignored/cache.bin`));
  assert.equal(show(dir, `${receipt.indexCommit}:a.txt`), "staged");
  assert.equal(git(dir, "rev-parse", `${receipt.commit}^1`), before.head);
  assert.equal(git(dir, "rev-parse", `${receipt.commit}^2`), receipt.indexCommit);
  assert.deepEqual(receipt.files.untracked, ["new dir/c file.txt"]);
  assert.deepEqual(receipt.files.deleted, ["b.txt"]);
  assert.equal(receipt.ignored.count, 1);
  assert.equal(receipt.ignored.covered, false);
  assert.equal(git(dir, "branch", "--list").trim(), "* main");
});

test("an unchanged tree reuses the proven snapshot; any change or another task makes a new one", async (t) => {
  const dir = repo(t);
  writeFileSync(join(dir, "note.md"), "draft\n");
  const first = await ensureCheckpoint({ cwd: dir, taskId: "task-1", reason: "first" });
  const again = await ensureCheckpoint({ cwd: dir, taskId: "task-1", reason: "second" });
  assert.equal(again.reused, true);
  assert.equal(again.commit, first.commit);
  assert.equal(again.ref, first.ref);

  const other = await ensureCheckpoint({ cwd: dir, taskId: "task-2", reason: "other task" });
  assert.equal(other.reused, false);
  assert.match(other.ref, /\/task-2\//);

  writeFileSync(join(dir, "note.md"), "draft 2\n");
  const changed = await ensureCheckpoint({ cwd: dir, taskId: "task-1", reason: "after edit" });
  assert.equal(changed.reused, false);
  assert.notEqual(changed.commit, first.commit);

  git(dir, "add", "note.md");
  const staged = await ensureCheckpoint({ cwd: dir, taskId: "task-1", reason: "same files, new staging" });
  assert.equal(staged.reused, false, "a different staged tree is not the proven snapshot");
});

test("an unborn repository is checkpointed with no parent", async (t) => {
  const dir = repo(t, { commit: false });
  writeFileSync(join(dir, "first.txt"), "hello\n");
  const receipt = await ensureCheckpoint({ cwd: dir, taskId: "fresh", reason: "empty repo" });
  assert.equal(receipt.head, null);
  assert.equal(show(dir, `${receipt.commit}:first.txt`), "hello");
  assert.equal(git(dir, "rev-list", "--count", receipt.commit), "2");
  assert.equal(existsSync(join(dir, ".git", "index")), false, "the user's missing index is not created");
});

test("credential-looking files refuse by default and follow the explicit choice", async (t) => {
  const dir = repo(t);
  writeFileSync(join(dir, ".env"), "TOKEN=secret\n");
  writeFileSync(join(dir, ".env.example"), "TOKEN=\n");
  await assert.rejects(ensureCheckpoint({ cwd: dir, taskId: "s", reason: "r" }), (err) => {
    assert.equal(err.code, "sensitive_paths");
    assert.deepEqual(err.paths, [".env"]);
    return true;
  });
  assert.equal(git(dir, "for-each-ref", "refs/jev"), "", "a refusal leaves no ref");

  const excluded = await ensureCheckpoint({ cwd: dir, taskId: "s", reason: "r", sensitive: "exclude" });
  assert.throws(() => show(dir, `${excluded.commit}:.env`));
  assert.equal(show(dir, `${excluded.commit}:.env.example`), "TOKEN=");
  assert.deepEqual(excluded.excluded, [{ path: ".env", reason: "sensitive file excluded by request" }]);

  const included = await ensureCheckpoint({ cwd: dir, taskId: "s2", reason: "r", sensitive: "include-local" });
  assert.equal(show(dir, `${included.commit}:.env`), "TOKEN=secret");
  assert.deepEqual(included.sensitive, [".env"]);
  assert.match(included.warnings.join("\n"), /never push refs\/jev/);
});

test("sensitive name matching", () => {
  for (const path of [".env", "app/.env.local", "id_ed25519", "server.pem", "secrets.yaml", ".npmrc", "service-account-prod.json"]) {
    assert.equal(isSensitivePath(path), true, path);
  }
  for (const path of [".env.example", "README.md", "src/key.mjs", "keys.txt"]) {
    assert.equal(isSensitivePath(path), false, path);
  }
});

test("an untracked nested repository refuses unless acknowledged as unprotected", async (t) => {
  const dir = repo(t);
  const nested = join(dir, "vendor", "lib");
  mkdirSync(nested, { recursive: true });
  git(nested, "init", "-q");
  writeFileSync(join(nested, "x.txt"), "x\n");
  await assert.rejects(ensureCheckpoint({ cwd: dir, taskId: "n", reason: "r" }), { code: "nested_repo", paths: ["vendor/lib"] });
  const receipt = await ensureCheckpoint({ cwd: dir, taskId: "n", reason: "r", acknowledgeUncovered: ["vendor/lib/"] });
  assert.deepEqual(receipt.excluded, [{ path: "vendor/lib", reason: "nested repository not captured" }]);
  assert.throws(() => show(dir, `${receipt.commit}:vendor/lib`));
});

test("a dirty submodule refuses before execution", async (t) => {
  const dir = repo(t);
  const upstream = repo(t);
  git(dir, "-c", "protocol.file.allow=always", "submodule", "add", "-q", upstream, "sub");
  git(dir, "commit", "-q", "-m", "add sub");
  writeFileSync(join(dir, "sub", "a.txt"), "dirty\n");
  await assert.rejects(ensureCheckpoint({ cwd: dir, taskId: "sm", reason: "r" }), { code: "dirty_submodule", paths: ["sub"] });
});

test("assume-unchanged, merge conflicts, oversized files and non-repositories refuse", async (t) => {
  const dir = repo(t);
  git(dir, "update-index", "--assume-unchanged", "a.txt");
  await assert.rejects(ensureCheckpoint({ cwd: dir, taskId: "x", reason: "r" }), { code: "assume_unchanged" });
  git(dir, "update-index", "--no-assume-unchanged", "a.txt");

  writeFileSync(join(dir, "big.bin"), Buffer.alloc(2048));
  await assert.rejects(ensureCheckpoint({ cwd: dir, taskId: "x", reason: "r", maxFileBytes: 1024 }), { code: "oversized_paths" });
  rmSync(join(dir, "big.bin"));

  git(dir, "checkout", "-q", "-b", "side");
  writeFileSync(join(dir, "a.txt"), "side\n");
  git(dir, "commit", "-q", "-am", "side");
  git(dir, "checkout", "-q", "main");
  writeFileSync(join(dir, "a.txt"), "main\n");
  git(dir, "commit", "-q", "-am", "main");
  assert.throws(() => git(dir, "merge", "-q", "side"));
  await assert.rejects(ensureCheckpoint({ cwd: dir, taskId: "x", reason: "r" }), { code: "unmerged_index" });

  const plain = mkdtempSync(join(tmpdir(), "jev-plain-"));
  t.after(() => rmSync(plain, { recursive: true, force: true }));
  await assert.rejects(ensureCheckpoint({ cwd: plain, taskId: "x", reason: "r" }), { code: "not_git_repo" });
  await assert.rejects(ensureCheckpoint({ cwd: dir, taskId: "../x", reason: "r" }), { code: "invalid_task_id" });
});

test("a live lock or index.lock refuses; a dead holder's lock is cleared", async (t) => {
  const dir = repo(t);
  const lock = join(dir, ".git", "jev-checkpoint.lock");
  writeFileSync(lock, JSON.stringify({ pid: process.pid, host: (await import("node:os")).hostname(), taskId: "busy" }));
  await assert.rejects(ensureCheckpoint({ cwd: dir, taskId: "l", reason: "r" }), { code: "locked" });
  writeFileSync(lock, JSON.stringify({ pid: 2 ** 22 + 12345, host: (await import("node:os")).hostname(), taskId: "gone" }));
  const receipt = await ensureCheckpoint({ cwd: dir, taskId: "l", reason: "r" });
  assert.equal(receipt.ok, true);
  assert.equal(existsSync(lock), false);

  writeFileSync(join(dir, ".git", "index.lock"), "");
  await assert.rejects(ensureCheckpoint({ cwd: dir, taskId: "l2", reason: "r" }), { code: "locked" });
  rmSync(join(dir, ".git", "index.lock"));
});

test("a working tree that keeps changing during the snapshot is refused, not half-recorded", async (t) => {
  const dir = repo(t);
  let edits = 0;
  const racingGit = async (args, opts) => {
    const result = await runGit(args, opts);
    if (args[0] === "write-tree" && opts.env?.GIT_INDEX_FILE?.includes("worktree")) {
      writeFileSync(join(dir, "a.txt"), `racing ${++edits}\n`);
    }
    return result;
  };
  await assert.rejects(ensureCheckpoint({ cwd: dir, taskId: "race", reason: "r", git: racingGit }), { code: "concurrent_change" });
  assert.equal(git(dir, "for-each-ref", "refs/jev"), "");
  assert.equal(existsSync(join(dir, ".git", "jev-checkpoint.lock")), false);

  let once = true;
  const settlingGit = async (args, opts) => {
    const result = await runGit(args, opts);
    if (once && args[0] === "write-tree" && opts.env?.GIT_INDEX_FILE?.includes("worktree")) {
      once = false;
      writeFileSync(join(dir, "a.txt"), "settled\n");
    }
    return result;
  };
  const receipt = await ensureCheckpoint({ cwd: dir, taskId: "race", reason: "r", git: settlingGit });
  assert.equal(show(dir, `${receipt.commit}:a.txt`), "settled");
});

test("staged credential content is screened even after its working file is deleted", async (t) => {
  const dir = repo(t);
  writeFileSync(join(dir, ".env"), "TOKEN=staged\n");
  git(dir, "add", "-f", ".env");
  rmSync(join(dir, ".env"));
  const before = state(dir);
  await assert.rejects(ensureCheckpoint({ cwd: dir, taskId: "st", reason: "r" }), { code: "sensitive_paths", paths: [".env"] });

  const excluded = await ensureCheckpoint({ cwd: dir, taskId: "st", reason: "r", sensitive: "exclude" });
  assert.throws(() => show(dir, `${excluded.indexCommit}:.env`), "the staged secret stays out of the index commit");
  assert.throws(() => show(dir, `${excluded.commit}:.env`));
  assert.deepEqual(state(dir), before, "the user's staged secret is untouched");

  const included = await ensureCheckpoint({ cwd: dir, taskId: "st2", reason: "r", sensitive: "include-local" });
  assert.equal(show(dir, `${included.indexCommit}:.env`), "TOKEN=staged");
  assert.deepEqual(included.sensitive, [".env"]);
});

test("excluding a tracked credential file keeps its committed version in both snapshots", async (t) => {
  const dir = repo(t);
  writeFileSync(join(dir, "secrets.json"), "{\"v\":1}\n");
  git(dir, "add", "secrets.json");
  git(dir, "commit", "-q", "-m", "tracked secret");
  writeFileSync(join(dir, "secrets.json"), "{\"v\":2}\n");
  git(dir, "add", "secrets.json");
  writeFileSync(join(dir, "secrets.json"), "{\"v\":3}\n");
  const receipt = await ensureCheckpoint({ cwd: dir, taskId: "tr", reason: "r", sensitive: "exclude" });
  assert.equal(show(dir, `${receipt.indexCommit}:secrets.json`), "{\"v\":1}");
  assert.equal(show(dir, `${receipt.commit}:secrets.json`), "{\"v\":1}");
  assert.equal(readFileSync(join(dir, "secrets.json"), "utf8"), "{\"v\":3}\n");
  assert.equal(git(dir, "show", ":secrets.json"), "{\"v\":2}", "the user's index still holds the staged edit");
});

test("an oversized blob that is only staged is refused or, when acknowledged, left out of both snapshots", async (t) => {
  const dir = repo(t);
  writeFileSync(join(dir, "big.bin"), Buffer.alloc(4096, 1));
  git(dir, "add", "big.bin");
  rmSync(join(dir, "big.bin"));
  await assert.rejects(ensureCheckpoint({ cwd: dir, taskId: "big", reason: "r", maxFileBytes: 1024 }), {
    code: "oversized_paths",
    paths: ["big.bin"],
  });
  const receipt = await ensureCheckpoint({ cwd: dir, taskId: "big", reason: "r", maxFileBytes: 1024, acknowledgeUncovered: ["big.bin"] });
  assert.throws(() => show(dir, `${receipt.indexCommit}:big.bin`));
  assert.deepEqual(receipt.excluded, [{ path: "big.bin", reason: "file exceeds checkpoint size limit" }]);
});

test("an edited skip-worktree file is refused; absent or unchanged ones are fine", async (t) => {
  const dir = repo(t);
  git(dir, "update-index", "--skip-worktree", "a.txt");
  const unchanged = await ensureCheckpoint({ cwd: dir, taskId: "sw", reason: "r" });
  assert.equal(unchanged.ok, true);

  writeFileSync(join(dir, "a.txt"), "hidden edit\n");
  assert.equal(git(dir, "status", "--porcelain"), "", "git status cannot see the edit");
  await assert.rejects(ensureCheckpoint({ cwd: dir, taskId: "sw", reason: "r" }), { code: "skip_worktree_modified", paths: ["a.txt"] });
  const acknowledged = await ensureCheckpoint({ cwd: dir, taskId: "sw", reason: "r", acknowledgeUncovered: ["a.txt"] });
  assert.deepEqual(acknowledged.excluded, [{ path: "a.txt", reason: "skip-worktree edit not captured" }]);

  rmSync(join(dir, "a.txt"));
  const sparse = await ensureCheckpoint({ cwd: dir, taskId: "sw2", reason: "r" });
  assert.equal(show(dir, `${sparse.commit}:a.txt`), "one", "an absent skip-worktree file keeps its index version");
});

test("porcelain v2 parsing handles spaces, submodules and nested repositories", () => {
  const out = [
    "1 .M N... 100644 100644 100644 aaa bbb dir/with space.txt",
    "1 D. N... 100644 000000 000000 aaa 000 gone.txt",
    "1 .M S.M. 160000 160000 160000 aaa aaa sub",
    "? nested/",
    "? new.txt",
    "u UU N... 100644 100644 100644 100644 a b c conflict.txt",
    "",
  ].join("\0");
  const parsed = parseStatus(out);
  assert.deepEqual(parsed.changed, ["dir/with space.txt", "sub"]);
  assert.deepEqual(parsed.deleted, ["gone.txt"]);
  assert.deepEqual(parsed.untracked, ["new.txt"]);
  assert.deepEqual(parsed.staged, []);
  assert.deepEqual(parsed.nested, ["nested"]);
  assert.deepEqual(parsed.unmerged, ["conflict.txt"]);
  assert.deepEqual(parsed.submodules, [{ path: "sub", commitChanged: false, modified: true, untracked: false }]);
});
