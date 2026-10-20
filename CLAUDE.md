# Contributing with an agent

- Run `npm test` before proposing a change; add or update a test for every behavior change.
- Keep secrets out of the repository: no API keys, tokens, personal paths or real session data in code, tests, fixtures or docs. Use neutral example names in fixtures.
- Router credentials (`JEV_API_KEY`, `TYPESAFE_API_KEY`) stay in the launcher process. Child CLIs get their environment through `childEnv()` in `src/child-env.mjs`.
- Raw sessions and evidence collected by `Analyzer/` stay in Git-ignored paths such as `Analyzer/private/`.
- When evidence is missing or insufficient, keep the existing routing choice. Model confidence is not a task-success probability.
- Preserve unrelated edits and keep each change scoped to one purpose.
