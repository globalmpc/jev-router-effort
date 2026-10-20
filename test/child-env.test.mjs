import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { childEnv, ROUTER_KEYS } from "../src/child-env.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const KEYS = { JEV_API_KEY: "sentinel-jev-not-a-secret", TYPESAFE_API_KEY: "sentinel-typesafe-not-a-secret" };

test("childEnv drops router keys, keeps the rest and leaves the source untouched", () => {
  const source = { PATH: "/bin", ...KEYS };
  const env = childEnv(source, { ZAI_BASE_URL: "http://127.0.0.1:1" });
  assert.deepEqual(env, { PATH: "/bin", ZAI_BASE_URL: "http://127.0.0.1:1" });
  assert.deepEqual(source, { PATH: "/bin", ...KEYS });
  assert.deepEqual(ROUTER_KEYS, ["JEV_API_KEY", "TYPESAFE_API_KEY"]);
});

// Each fake CLI records its routing variable and whether a router key reached it. The parent
// still holds the keys, so the routing variable proves the proxy started.
function fakeClis(t) {
  const temp = mkdtempSync(join(tmpdir(), "jev-child-env-"));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  for (const name of ["claude", "codex", "agy", "glm"]) {
    writeFileSync(join(temp, name), `#!/usr/bin/env node
const e = process.env;
require("fs").writeFileSync(${JSON.stringify(join(temp, `${name}.json`))}, JSON.stringify({
  keys: ${JSON.stringify(Object.keys(KEYS))}.filter((k) => k in e),
  routed: Boolean(e.ANTHROPIC_BASE_URL || e.CLOUD_CODE_URL || e.ZAI_BASE_URL || process.argv.some((a) => a.includes("127.0.0.1"))),
}));
`);
    chmodSync(join(temp, name), 0o755);
  }
  return (entry, name) => {
    const env = { PATH: `${temp}:${dirname(process.execPath)}`, HOME: temp, JEV_NO_STATUSLINE: "1", ...KEYS };
    spawnSync(process.execPath, [join(root, entry)], { cwd: temp, env, stdio: "ignore", timeout: 15000 });
    return JSON.parse(readFileSync(join(temp, `${name}.json`), "utf8"));
  };
}

for (const [entry, name] of [
  ["bin/jev-claude.mjs", "claude"],
  ["bin/jev-codex.mjs", "codex"],
  ["bin/jev-anti.mjs", "agy"],
  ["bin/jev-glm.mjs", "glm"],
]) {
  test(`${name} child gets the proxy but no router key`, (t) => {
    const launch = fakeClis(t)(entry, name);
    assert.equal(launch.routed, true);
    assert.deepEqual(launch.keys, []);
  });
}

// Git, the executor gate and Orca are subprocesses of the launcher too. A repository's own
// git config (aliases, filters, fsmonitor) or a gate script must not read the router keys.
function withRouterKeys(t) {
  const saved = Object.fromEntries(Object.keys(KEYS).map((k) => [k, process.env[k]]));
  Object.assign(process.env, KEYS);
  t.after(() => { for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v; });
}

test("git subprocesses do not receive router keys", async (t) => {
  withRouterKeys(t);
  const { runGit } = await import("../src/checkpoint.mjs");
  const dumped = await runGit(["-c", "alias.envdump=!env", "envdump"], { cwd: root });
  assert.equal(dumped.code, 0, dumped.stderr);
  for (const key of ROUTER_KEYS) assert.ok(!dumped.stdout.includes(`${key}=`), `${key} reached git`);
  assert.match(dumped.stdout, /GIT_TERMINAL_PROMPT=0/);
});

test("the executor gate and Orca CLI do not receive router keys", async (t) => {
  withRouterKeys(t);
  const temp = mkdtempSync(join(tmpdir(), "jev-sub-env-"));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const gate = join(temp, "check_target.py");
  writeFileSync(gate, `import json, os\nprint(json.dumps({"accepted": True, "keys": [k for k in ${JSON.stringify(ROUTER_KEYS)} if k in os.environ]}))\n`);
  const orca = join(temp, "orca");
  writeFileSync(orca, `#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify(${JSON.stringify(ROUTER_KEYS)}.filter((k) => k in process.env)));\n`);
  chmodSync(orca, 0o755);
  const savedOrca = process.env.ORCA_CLI_COMMAND;
  process.env.ORCA_CLI_COMMAND = orca;
  t.after(() => { if (savedOrca === undefined) delete process.env.ORCA_CLI_COMMAND; else process.env.ORCA_CLI_COMMAND = savedOrca; });
  const { checkExecutorTarget, runOrca } = await import("../src/handoff.mjs");
  const verdict = await checkExecutorTarget({ executor: { checkTarget: gate }, target: { cli: "claude", model: "m" } });
  assert.deepEqual(verdict.keys, []);
  const ran = await runOrca([], { cwd: temp });
  assert.equal(ran.code, 0, ran.stderr);
  assert.deepEqual(JSON.parse(ran.stdout), []);
});
