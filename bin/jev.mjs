#!/usr/bin/env node
import { runAnti } from "../src/anti-cli.mjs";

const [target, ...args] = process.argv.slice(2);
if (["-A", "-a", "anti", "antigravity"].includes(target)) {
  process.exit(await runAnti(args));
} else {
  process.stderr.write("Usage: jev -A [AGY args]\nOther commands: jev-agy, jev-a, jev-anti, jev-antigravity, jev-claude, jev-codex, jev-glm.\n");
  process.exitCode = target === undefined || target === "--help" || target === "-h" ? 0 : 2;
}
