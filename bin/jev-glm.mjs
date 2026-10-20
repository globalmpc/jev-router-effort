#!/usr/bin/env node
import { runGlm } from "../src/glm-cli.mjs";

process.exit(await runGlm());
