---
name: jev-explain
description: Show why Jev Router selected the model used for the last prompt.
disable-model-invocation: true
allowed-tools: Bash(node *)
---

<jev-explain>
Return the report below verbatim in a plain text code block. Do not add analysis or use tools.

!`node "${CLAUDE_SKILL_DIR}/../../../bin/jev-explain.mjs" "${CLAUDE_SESSION_ID}"`
