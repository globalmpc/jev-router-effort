import { readJson } from './util.mjs';
// Korean keywords are written as \u escapes so the source stays English-only.

// Known cases are hypotheses checked against the raw source on every run; nothing is asserted
// unless the matching evidence is found again in the local transcript. The case list names real
// sessions, so it lives only in Analyzer/private/known-cases.json (Git-ignored), e.g.
// [{ "id": "exporter-destructive-recovery", "key": "antigravity:<conversation id>",
//    "expected": "failure", "taskType": "cross-module-change", "reportedBy": "maintainer incident review" }]

export function loadKnownCases(file) {
  const cases = readJson(file, []);
  if (!Array.isArray(cases)) throw new Error(`${file} must hold a JSON array of known cases`);
  for (const c of cases) {
    if (!c?.id || !/^[a-z]+:\S+$/.test(c.key ?? '')) throw new Error(`known case needs id and key "cli:sessionId": ${JSON.stringify(c)}`);
  }
  return cases;
}

const RESTORE_REQUEST = /\uC6D0\uC0C1\s?\uBCF5\uADC0|\uB418\uB3CC\uB824|\uBCF5\uAD6C|restore|revert/i;
const DESTROY_REQUEST = /reset\s+--hard|git\s+clean|untracked|\uC804\uBD80\s*(\uC9C0\uC6CC|\uC0AD\uC81C)|\uB2E4\s*(\uC9C0\uC6CC|\uC0AD\uC81C)|discard|\uD3D0\uAE30/i;
const AUTONOMY_GRANT = /\uC54C\uC544\uC11C\s?\uD574|\uAD8C\uD55C\s?(\uC904|\uCD9C)|\uB098\uD55C\uD14C\uB294\s*\uBC1B\uC744\s*\uD544\uC694\s*\uC5C6/i;

/**
 * Re-verify a known case from its session summary. Returns what was found, with refs, and
 * separates what the operating user wrote from instructions that only exist in the transcript
 * (model-written directives, subagent prompts, tool output).
 */
export function verifyKnownCase(kc, summary, rawEvents = []) {
  if (!summary) return { id: kc.id, found: false, reason: 'session not present in the scanned sources/window' };
  const destructive = summary.destructive.filter(d => d.kinds.includes('git reset --hard') || d.kinds.includes('git clean -f'));
  const users = rawEvents.filter(e => e.type === 'user');
  const userRestore = users.filter(u => RESTORE_REQUEST.test(u.text)).map(u => u.ref);
  const userDestroy = users.filter(u => DESTROY_REQUEST.test(u.text)).map(u => u.ref);
  const userAutonomy = users.filter(u => AUTONOMY_GRANT.test(u.text)).map(u => u.ref);
  const firstDestructive = destructive[0];
  const cmdEvent = firstDestructive ? rawEvents.find(e => e.type === 'command' && e.ref === firstDestructive.ref) : null;
  const deletions = cmdEvent?.output ? (cmdEvent.output.match(/^Removing /gm) ?? []).length : 0;
  const truncated = /<truncated (\d+) lines>/.exec(cmdEvent?.output ?? '')?.[1];
  const transcriptMentions = rawEvents
    .filter(e => (e.type === 'delegate' && /reset|clean|revert|restore|\uC6D0\uC0C1/i.test(e.args ?? '')) || (e.type === 'assistant' && /git reset --hard|git clean/i.test(e.text ?? '')))
    .map(e => e.ref);
  const preCommandUsers = firstDestructive ? users.filter(u => u.at <= (cmdEvent?.at ?? Infinity)).map(u => u.ref) : [];
  const notices = rawEvents.filter(e => e.type === 'notice').map(e => ({ ref: e.ref, model: e.model, reason: e.reason, confidence: e.confidence }));
  return {
    id: kc.id,
    evidenceId: summary.evidenceId,
    found: Boolean(firstDestructive),
    expected: kc.expected,
    reportedBy: kc.reportedBy ?? null,
    destructive: destructive.map(d => ({ ref: d.ref, resultRef: d.resultRef, kinds: d.kinds, exitCode: d.exitCode })),
    deletionLinesShown: deletions,
    deletionLinesTruncated: truncated ? Number(truncated) : 0,
    routingNotices: notices,
    observedModels: summary.observedModels.map(m => m.model),
    modelEnums: summary.modelEnums.map(m => m.value),
    authorization: {
      userMessagesBeforeCommand: preCommandUsers,
      userAskedToRestore: userRestore,
      userAskedToDiscardOrClean: userDestroy,
      userGrantedGeneralAutonomy: userAutonomy,
      transcriptOnlyMentions: transcriptMentions,
      conclusion: !firstDestructive ? 'not applicable'
        : userDestroy.length ? 'user message explicitly requested discard/clean'
          : 'agent-chosen: the user asked to restore the broken part and granted general autonomy; no user message requested discarding untracked or pre-existing work',
    },
  };
}
