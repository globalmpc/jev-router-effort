import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkKey, KEYCHAIN_SERVICE, loadJevKey, noKeyWarning } from "../src/credentials.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SECRET = "sk-test-not-a-real-key";

// A loadEnvFile stand-in: each "file" is a map of variables, applied without overriding.
const fakeFiles = (contents) => (file) => {
  if (!(file in contents)) throw new Error("ENOENT");
  for (const [k, v] of Object.entries(contents[file])) if (!(k in fakeFiles.env)) fakeFiles.env[k] = v;
};

function run(env, contents = {}, execFile = () => { throw new Error("keychain must not be called"); }, platform = "darwin") {
  fakeFiles.env = env;
  return loadJevKey({ env, platform, files: ["a.env", "b.env"], loadEnvFile: fakeFiles(contents), execFile });
}

test("an environment key wins over env files and the Keychain", () => {
  const env = { JEV_API_KEY: "from-env" };
  assert.equal(run(env, { "a.env": { JEV_API_KEY: "from-file" } }), "env");
  assert.equal(env.JEV_API_KEY, "from-env");
  assert.equal(env.TYPESAFE_API_KEY, undefined);
});

test("an env file key is used and the Keychain is not asked", () => {
  const env = {};
  assert.equal(run(env, { "b.env": { TYPESAFE_API_KEY: "from-file" } }), "env-file");
  assert.equal(env.TYPESAFE_API_KEY, "from-file");
});

test("the Keychain is the last fallback, called with an argument array", () => {
  const env = {};
  const calls = [];
  const source = run(env, {}, (file, args, opts) => {
    calls.push({ file, args, opts });
    return `${SECRET}\n`;
  });
  assert.equal(source, "keychain");
  assert.equal(env.TYPESAFE_API_KEY, SECRET);
  assert.deepEqual(calls[0].args, ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"]);
  assert.equal(calls[0].file, "security");
  assert.ok(calls[0].opts.timeout > 0 && calls[0].opts.timeout <= 5000);
  assert.equal(calls[0].opts.stdio[2], "ignore");
});

test("the Keychain is skipped off macOS and a Keychain failure leaves no key", () => {
  assert.equal(run({}, {}, undefined, "linux"), null);
  const env = {};
  assert.equal(run(env, {}, () => { throw new Error("item not found"); }), null);
  assert.equal(env.TYPESAFE_API_KEY, undefined);
});

test("the no-key warning is several lines and names every place it looked", () => {
  const text = noKeyWarning("jev-claude", { env: {}, home: "/h" });
  assert.ok(text.split("\n").length >= 6);
  assert.match(text, /JEV ROUTER OFF/);
  assert.match(text, /WITHOUT routing/);
  for (const where of ["/h/.jev-router.env", "/h/.jev-claude.env", KEYCHAIN_SERVICE, "JEV_REQUIRE=1"]) {
    assert.ok(text.includes(where), where);
  }
});

test("checkKey falls back by default and returns an exit code under JEV_REQUIRE", () => {
  let out = "";
  const write = (s) => (out += s);
  assert.equal(checkKey("jev-claude", { env: { JEV_API_KEY: "k" }, write }), null);
  assert.equal(out, "");
  assert.equal(checkKey("jev-claude", { env: {}, write }), null);
  assert.match(out, /JEV ROUTER OFF/);
  out = "";
  assert.equal(checkKey("jev-claude", { env: { JEV_REQUIRE: "1" }, write }), 3);
  assert.match(out, /will not start without routing/);
  assert.equal(checkKey("jev-claude", { env: { JEV_REQUIRE: "0" }, write: () => {} }), null);
});

// End to end: jev-claude exec'd with no shell function, as orca and scripts do.
function sandbox({ keychain }) {
  const dir = mkdtempSync(join(tmpdir(), "jev-cred-"));
  const bin = join(dir, "bin");
  spawnSync("mkdir", ["-p", bin, join(dir, "home"), join(dir, "cwd")]);
  const script = (name, body) => {
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  script("claude", 'echo "BASE=$ANTHROPIC_BASE_URL OFF=$JEV_ROUTER_OFF"');
  if (keychain) script("security", `echo ${SECRET}`);
  return { dir, bin };
}

function launch({ keychain, extra = {} }) {
  const { dir, bin } = sandbox({ keychain });
  return spawnSync(process.execPath, [join(ROOT, "bin", "jev-claude.mjs")], {
    cwd: join(dir, "cwd"),
    env: { PATH: bin, HOME: join(dir, "home"), TMPDIR: dir, ...extra },
    encoding: "utf8",
    timeout: 20000,
  });
}

test("jev-claude without a key warns loudly, starts Claude, and marks the status line off", () => {
  const r = launch({ keychain: false });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /JEV ROUTER OFF/);
  assert.match(r.stdout, /BASE= OFF=no key/);
  assert.ok(!r.stderr.includes(SECRET));
});

test("jev-claude with JEV_REQUIRE=1 and no key exits non-zero without starting Claude", () => {
  const r = launch({ keychain: false, extra: { JEV_REQUIRE: "1" } });
  assert.equal(r.status, 3);
  assert.match(r.stderr, /will not start without routing/);
  assert.doesNotMatch(r.stdout, /BASE=/);
});

test("jev-claude exec'd directly reads the Keychain and routes", { skip: process.platform !== "darwin" }, () => {
  const r = launch({ keychain: true });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /BASE=http:\/\/127\.0\.0\.1:\d+ OFF=$/m);
  assert.doesNotMatch(r.stderr, /JEV ROUTER OFF/);
  assert.ok(!r.stdout.includes(SECRET) && !r.stderr.includes(SECRET));
});

test("the status line says Jev Router OFF when the launcher had no key", () => {
  const r = spawnSync(process.execPath, [join(ROOT, "bin", "jev-statusline.mjs")], {
    input: JSON.stringify({ session_id: "none", cwd: "/x/proj" }),
    env: { ...process.env, JEV_ROUTER_OFF: "no key" },
    encoding: "utf8",
  });
  assert.match(r.stdout, /Jev Router OFF: no key/);
});

test("the default env files are user-level only, so a launch-directory .env is never read", (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "jev-cred-cwd-"));
  const home = mkdtempSync(join(tmpdir(), "jev-cred-home-"));
  t.after(() => { rmSync(cwd, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); });
  writeFileSync(join(cwd, ".env"), "CLOUD_CODE_URL=https://attacker.example\nJEV_API_KEY=from-repo\n");
  writeFileSync(join(home, ".jev-router.env"), "JEV_TEST_FROM_HOME=yes\n");
  const script = `import { loadJevKey } from ${JSON.stringify(new URL("../src/credentials.mjs", import.meta.url).href)};
const source = loadJevKey({ platform: "linux" });
console.log(JSON.stringify([source, process.env.CLOUD_CODE_URL ?? null, process.env.JEV_API_KEY ?? null, process.env.JEV_TEST_FROM_HOME ?? null]));`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd, env: { PATH: process.env.PATH, HOME: home }, encoding: "utf8",
  });
  assert.deepEqual(JSON.parse(r.stdout), [null, null, null, "yes"]);
});
