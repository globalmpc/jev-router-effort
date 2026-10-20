import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { antiArgs, antiFlag, resolveAnti } from "../src/anti-cli.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

test("starts on the Jev Router row unless the user chose a model", () => {
  assert.deepEqual(antiArgs([]), ["--model", "jev-router"]);
  assert.deepEqual(antiArgs(["-p", "hi"]), ["--model", "jev-router", "-p", "hi"]);
  assert.deepEqual(antiArgs(["--model", "claude-sonnet-4-6"]), ["--model", "claude-sonnet-4-6"]);
  assert.deepEqual(antiArgs(["--model=gemini-3.1-pro-low"]), ["--model=gemini-3.1-pro-low"]);
  assert.equal(antiFlag(["--effort", "high"], "--model"), false);
});

test("aliases dispatch to the AGY CLI and do not rename the upstream executable", () => {
  const bins = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).bin;
  assert.equal(bins.jev, "bin/jev.mjs");
  assert.equal(bins["jev-a"], "bin/jev-anti.mjs");
  assert.equal(bins["jev-agy"], bins["jev-a"]);
  assert.equal(bins["jev-antigravity"], bins["jev-anti"]);
  assert.equal(bins.anti, undefined);
  assert.equal(bins.agy, undefined);
  assert.equal(spawnSync(process.execPath, [join(root, "bin/jev.mjs"), "--help"], { stdio: "ignore" }).status, 0);
});

// The fake records how it was launched, so the test sees exactly what AGY would receive.
function fakeAgy(t) {
  const temp = mkdtempSync(join(tmpdir(), "jev-agy-native-"));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const record = join(temp, "launch.json");
  const script = `#!/usr/bin/env node
require("fs").writeFileSync(${JSON.stringify(record)}, JSON.stringify({ args: process.argv.slice(2), url: process.env.CLOUD_CODE_URL ?? null }));
process.exit(44);
`;
  for (const name of ["agy", "antigravity"]) {
    writeFileSync(join(temp, name), script);
    chmodSync(join(temp, name), 0o755);
  }
  const run = (entry, args, extraEnv) => {
    // HOME and cwd point at the temp dir so no real .env or Keychain key leaks in; PATH holds
    // only the fake and node, which also hides the macOS `security` tool.
    const env = { PATH: `${temp}:${dirname(process.execPath)}`, HOME: temp, ...extraEnv };
    const status = spawnSync(process.execPath, [join(root, entry), ...args], { cwd: temp, env, stdio: "ignore", timeout: 10000 }).status;
    return { status, ...JSON.parse(readFileSync(record, "utf8")) };
  };
  return { temp, run };
}

test("prefers the official agy binary over the antigravity name", (t) => {
  const { temp } = fakeAgy(t);
  assert.equal(resolveAnti(temp)?.file, join(temp, "agy"));
  rmSync(join(temp, "agy"));
  assert.equal(resolveAnti(temp)?.file, join(temp, "antigravity"));
});

test("with a Jev key every entry point routes the native UI through the proxy", (t) => {
  const { run } = fakeAgy(t);
  for (const [entry, ...args] of [["bin/jev.mjs", "-A"], ["bin/jev-anti.mjs"]]) {
    const launch = run(entry, args, { TYPESAFE_API_KEY: "test" });
    assert.equal(launch.status, 44, `${entry} should forward AGY's exit status`);
    assert.deepEqual(launch.args, ["--model", "jev-router"]);
    assert.match(launch.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  }
  const manual = run("bin/jev-anti.mjs", ["--model", "claude-sonnet-4-6"], { TYPESAFE_API_KEY: "test" });
  assert.deepEqual(manual.args, ["--model", "claude-sonnet-4-6"]);
  assert.match(manual.url, /^http:\/\/127\.0\.0\.1:/, "manual sessions keep the picker's Jev Router row");
});

test("without a key, and for subcommands, AGY runs unchanged", (t) => {
  const { run } = fakeAgy(t);
  const plain = run("bin/jev-anti.mjs", []);
  assert.deepEqual([plain.status, plain.args, plain.url], [44, [], null]);
  const models = run("bin/jev-anti.mjs", ["models"], { TYPESAFE_API_KEY: "test" });
  assert.deepEqual([models.args, models.url], [["models"], null]);
});
