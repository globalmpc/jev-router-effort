import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeDump } from "../src/log.mjs";

test("JEV_DUMP files are owner-only and never written through an existing path", { skip: process.platform === "win32" }, (t) => {
  const dir = mkdtempSync(join(tmpdir(), "jev-dump-"));
  t.after(() => { rmSync(dir, { recursive: true, force: true }); delete process.env.JEV_DUMP; });
  process.env.JEV_DUMP = join(dir, "dump");
  const file = writeDump('{"prompt":"secret"}');
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(readFileSync(file, "utf8"), '{"prompt":"secret"}');

  const target = join(dir, "victim.txt");
  writeFileSync(target, "untouched");
  const planted = join(dir, "planted.json");
  symlinkSync(target, planted);
  assert.equal(writeDump("x", planted), null, "an existing path or symlink is refused");
  assert.equal(readFileSync(target, "utf8"), "untouched");
  assert.equal(readdirSync(dir).length, 3);
});
