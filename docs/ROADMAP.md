# Roadmap to v1.0

This file is the canonical milestone numbering for ContextPact: M1 through M5.
Every other document, comment and status note in this repository refers to
these numbers; there is no second milestone scheme to reconcile.

M1 is complete. The remaining milestones are listed in order and are marked
complete only when their "Done when" condition below is met and verified,
regardless of which feature areas already appear as implemented in
`README.md`.

## M1 — Foundation

Contracts, workspace layout, SQLite migrations, CLI/MCP skeleton, CI and diagnostics.

**Done when:** clean checkout installs, builds, tests and creates a valid local workspace.

**Status: complete.** Commit `fe31e91` is the first commit whose `Validate`
workflow passed on a clean checkout (GitHub Actions run 34714843188; the
`test` and `public-safety` jobs both succeeded). That run covers `npm ci`,
`npm run format:check`, `npm run check` (typecheck, tests and build) and
`npm pack --dry-run`, including the workspace-creation tests. Re-verified on
`develop`: `npm run check` passes (20 test files, 211 tests) and
`contextpact init` / `contextpact status` create and report a valid local
workspace.

## M2 — Knowledge and retrieval

Markdown lifecycle, provenance, reconciliation, FTS search, supersession and deterministic token-budgeted packs.

**Done when:** approved/current knowledge is retrieved reproducibly and stale decisions are excluded.

## M3 — Coordination

Agents, tasks, renewable leases, conflicts, stale takeover, evidence and structured handoffs.

**Done when:** two local agents coordinate parallel work without overlapping fresh claims.

## M4 — Integrations and portability

Guided client configuration, Obsidian workflow, imports, exports, backup, reindex and recovery.

**Done when:** supported clients and external Markdown edits pass repeatable integration tests.

## M5 — Release proof

Cross-platform clean installs, coding/research demos, security review, documentation and packaging.

**Done when:** every item in `RELEASE_CHECKLIST.md` passes and the first useful v1.0 can be published honestly.
