// Korean keywords are written as \u escapes so the source stays English-only.
// Lexical signal extraction. Everything here produces *candidates* for review: a phrase match
// is never a verified outcome label (see review.mjs for adjudicated labels).

const TEST_COMMAND = /(^|[\s;&|(])(npm (run )?test|npm run (test|check|e2e|lint)[\w:-]*|pnpm (run )?test|yarn test|bun test|node --test|npx (jest|vitest|playwright)|jest|vitest|pytest|python3? -m (pytest|unittest)|go test|cargo test|swift test|swift build|xcodebuild[^|;&]*\b(test|build)\b|make (test|check)|mvn test|gradle test|deno test|tsc\b)/i;
const DESTRUCTIVE = [
  [/git\s+reset\s+--hard/i, 'git reset --hard'],
  [/git\s+clean\s+-[a-z]*f/i, 'git clean -f'],
  [/git\s+checkout\s+(--\s+)?\.(\s|$)/i, 'git checkout .'],
  [/git\s+restore\s+(--staged\s+)?\.(\s|$)/i, 'git restore .'],
  [/git\s+stash\s+(drop|clear)/i, 'git stash drop/clear'],
  [/git\s+push\s+[^\n]*--force|git\s+push\s+-f\b/i, 'git push --force'],
  [/git\s+branch\s+-D\b/i, 'git branch -D'],
  [/\brm\s+-[a-z]*r[a-z]*f?\b|\brm\s+-[a-z]*f[a-z]*r\b/i, 'rm -r'],
];
const EXTERNAL = [
  [/git\s+push\b/i, 'git push'],
  [/\bgh\s+(pr|issue|release)\s+(create|merge|comment|edit)|gh\s+api\s+[^\n]*-X\s*(POST|PATCH|PUT|DELETE)/i, 'github write'],
  [/\bnpm\s+publish\b/i, 'npm publish'],
  [/slack|chat\.postMessage/i, 'slack'],
  [/curl\s+[^\n]*-X\s*(POST|PUT|PATCH|DELETE)|curl\s+[^\n]*(--data|-d\s)/i, 'http write'],
];

export function isTestCommand(cmd) {
  return TEST_COMMAND.test(String(cmd ?? ''));
}

export function destructiveKinds(cmd) {
  return DESTRUCTIVE.filter(([re]) => re.test(String(cmd ?? ''))).map(([, name]) => name);
}

export function externalKinds(cmd) {
  return EXTERNAL.filter(([re]) => re.test(String(cmd ?? ''))).map(([, name]) => name);
}

/**
 * Parse a test/build runner summary. Returns {passed, failed, verdict} where verdict is
 * 'pass' | 'fail' | 'unknown'. Only explicit runner summaries count; exit status alone is
 * handled by the caller.
 */
export function parseTestOutput(text) {
  const s = String(text ?? '');
  let passed = null;
  let failed = null;
  const num = re => { const m = re.exec(s); return m ? Number(m[1]) : null; };
  // node:test (TAP and spec reporters)
  const tapPass = num(/^# pass (\d+)/m) ?? num(/^ℹ pass (\d+)/m);
  const tapFail = num(/^# fail (\d+)/m) ?? num(/^ℹ fail (\d+)/m);
  if (tapPass !== null || tapFail !== null) { passed = tapPass ?? 0; failed = tapFail ?? 0; }
  // jest / vitest
  const jest = /Tests?:?\s+(?:(\d+) failed,?\s*)?(?:\d+ skipped,?\s*)?(\d+) passed/i.exec(s);
  if (passed === null && jest) { failed = Number(jest[1] ?? 0); passed = Number(jest[2]); }
  // python unittest: "Ran 101 tests" then "OK" or "FAILED (failures=1, errors=24)"
  const ran = num(/^Ran (\d+) tests? in /m);
  if (passed === null && ran !== null) {
    const bad = /^FAILED \(([^)]*)\)/m.exec(s);
    failed = bad ? [...bad[1].matchAll(/(?:failures|errors)=(\d+)/g)].reduce((n, m) => n + Number(m[1]), 0) : /^OK\b/m.test(s) ? 0 : null;
    passed = failed === null ? null : ran - failed;
  }
  // pytest / mocha
  if (passed === null) {
    const p = num(/(\d+) (?:passed|passing)\b/);
    const f = num(/(\d+) (?:failed|failing)\b/);
    if (p !== null || f !== null) { passed = p ?? 0; failed = f ?? 0; }
  }
  let verdict = passed === null && failed === null ? 'unknown' : failed > 0 ? 'fail' : passed > 0 ? 'pass' : 'unknown';
  if (verdict === 'unknown') {
    if (/\*\* (TEST|BUILD) FAILED \*\*|test result: FAILED|Test Suite '.*' failed|^FAIL\b|error: build failed|Build failed/m.test(s)) verdict = 'fail';
    else if (/\*\* (TEST|BUILD) SUCCEEDED \*\*|test result: ok\.|Test Suite 'All tests' passed|Build complete!|^ok\s+\S+\s+[\d.]+s\b/m.test(s)) verdict = 'pass';
  }
  return { passed, failed, verdict };
}

/** Exit code phrases emitted by the CLIs' tool wrappers. */
export function parseExitCode(text) {
  const s = String(text ?? '');
  const m = /(?:command exited with code|Process exited with code|Exit code:?|exit code:?|exited with code)\s*(-?\d+)/i.exec(s);
  return m ? Number(m[1]) : null;
}

const NEGATIVE = /\uAE68\uBA39|\uAE68\uC84C|\uAE68\uC9C4|\uB9DD\uAC00|\uC548\s?\uB3FC|\uC548\s?\uB418|\uC548\s?\uB098\uC640|\uC548\s?\uBCF4\uC5EC|\uD2C0\uB838|\uD2C0\uB9B0|\uC798\uBABB|\uC5C9\uB9DD|\uB0A0\uB824|\uC6D0\uC0C1\s?\uBCF5\uADC0|\uB418\uB3CC\uB824|\uBCF5\uAD6C\uD574|\uC65C \uC774\uB807\uAC8C|\uC544\uC9C1\uB3C4|\uC5EC\uC804\uD788|\uB2E4\uC2DC \uD574|\uC2E4\uD328|\uBABB \uBBFF|\uBBFF\uAE30\uC9C0|not working|doesn'?t work|didn'?t work|broken|broke|wrong|still (fail|broken|not)|regress|revert|undo|that'?s not|incorrect|failed|you (deleted|removed|broke)/i;
const POSITIVE = /\uC88B\uC544|\uC88B\uB124|\uC644\uBCBD|\uC798\s?\uB41C\uB2E4|\uC798\s?\uB410|\uC798\s?\uB3FC|\uC798\uD588|\uACE0\uB9C8\uC6CC|\uAC10\uC0AC|\uB410\uC5B4|\uC131\uACF5|\uD1B5\uACFC|\uD655\uC778\uD588|lgtm|looks good|works( now)?|perfect|great|thanks|thank you|nice|confirmed|approved/i;

/** Classify a user follow-up as a *candidate* reaction. Review decides the label. */
export function reactionCandidate(text) {
  const s = String(text ?? '');
  const neg = NEGATIVE.test(s);
  const pos = POSITIVE.test(s);
  if (neg && !pos) return 'negative';
  if (pos && !neg) return 'positive';
  if (pos && neg) return 'mixed';
  return 'none';
}

const COMPLETE = /\uC644\uB8CC|\uB05D\uB0AC|\uB9C8\uCCE4|\uAD6C\uD604\uD588|\uC218\uC815\uD588|\uD1B5\uACFC|successfully|completed?|done|implemented|fixed|all tests pass|passed/i;
export const claimsComplete = text => COMPLETE.test(String(text ?? ''));

/** Parse the Jev routing notice printed into Codex/Antigravity transcripts. */
export function parseJevNotice(text) {
  const m = /\[Jev\] routed this turn to ([\w.:/-]+)\s*\(([^,)]*)(?:,\s*confidence\s*([\d.]+))?(?:,\s*effort\s*([^)]*))?\)/.exec(String(text ?? ''));
  if (!m) return null;
  let effort = null;
  if (m[4]) {
    // "effort auto → low (0.74)": the resolved effort is after the arrow.
    const s = m[4].trim();
    effort = (/(?:→|->)\s*([\w-]+)/.exec(s) ?? /^([\w-]+)/.exec(s))?.[1] ?? null;
  }
  return { model: m[1], reason: m[2].trim(), confidence: m[3] ? Number(m[3]) : null, effort };
}

/** Text that is harness scaffolding rather than a person typing. */
export function isSyntheticUserText(text) {
  const s = String(text ?? '').trimStart();
  return !s
    || /^<(environment_context|user_instructions|skills_instructions|permissions|turn_aborted|system-reminder|task-notification|cross-session-message|command-name|command-message|command-args|local-command-stdout|local-command-caveat|user-prompt-submit-hook|subagent_notification|collaboration_mode)/i.test(s)
    || /^(Caveat: The messages below|\[Request interrupted|# AGENTS\.md instructions|<INSTRUCTIONS>)/.test(s);
}

export const isOrcaDispatch = text => /You are working inside Orca, a multi-agent IDE\. You are a dispatched worker\./.test(String(text ?? ''));
