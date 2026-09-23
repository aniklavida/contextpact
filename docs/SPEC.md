# ContextPact product specification v1.0

## Product promise

**Any agent. Same approved context.**

ContextPact is a local-first context and coordination layer for people who move between AI tools or run several agents in parallel. Coding is the first demanding proof workflow, but the model also supports research, business, study and writing.

## Complete v1 scope

1. Workspace initialization and global, workspace, task and session scopes.
2. Markdown context types: rule, preference, fact, goal, source, decision, task note and handoff.
3. Lifecycle states: draft, proposed, approved, superseded and archived.
4. SQLite agents, sessions, tasks, leases, policies, versions and audit events.
5. FTS5 search and deterministic token-budgeted context packs with provenance.
6. Task creation, claims, lease renewal/release, stale takeover and conflict rejection.
7. Evidence-bearing structured handoffs.
8. CLI and MCP interfaces over one core.
9. Guided Claude Code, Codex and Cursor configuration plus generic MCP output.
10. Obsidian-compatible external edits without requiring Obsidian.
11. Import/export, backup, reindex, migrations and diagnostics.
12. Coding and research end-to-end proof workflows.

## Storage contract

- Markdown is canonical for durable human-readable content.
- SQLite is canonical for structured operational state and audit history.
- FTS5 and future optional embeddings are rebuildable indexes.
- Every data type has one owner; reconciliation never silently overwrites ambiguity.
- Dual-store backups capture both Markdown vault and SQLite database atomically; restoring one without the other is not a restore.
- Workspace exports serialize both Markdown knowledge items and SQLite operational state (tasks, leases, agents, sessions, policies, and audit history).
- Workspace imports enforce deterministic ID collision policies: `skip` (default: preserves existing canonical local state), `replace` (overwrites local state with incoming records), and `error` (fails closed on any collision).
- Reindexing rebuilds search indexes from Markdown, but cannot restore leases or audit history; diagnostics report rebuilt databases plainly and never claim recovered history.

## Safety contract

- Agent-authored durable knowledge defaults to proposed.
- Operational task state and handoffs may write immediately with provenance.
- Global context is included only when policy allows it.
- Retrieved content is data, not a higher-priority instruction.
- Plaintext local storage is not a secrets vault.
- Every mutation records actor, source, time and previous version.

## Coordination contract

- One active renewable lease per task.
- Fresh conflicting claims fail.
- Stale takeover requires a reason and audit event.
- Parallel work declares non-overlapping scopes when practical.
- Release states are review, done, blocked and planned.
- Handoffs include outcome, evidence, blockers and one next action.

## Team and remote sync

Planned for v1.0 as a self-hosted adapter: a local server, optionally exposed on the network, authenticated by a shared key or password. Not yet implemented — the protocol, conflict resolution model and test coverage are future work, to be scoped in a later implementation effort.

## Deferred

Hosted accounts, a cloud relay, realtime multi-human teams, large dashboard/Kanban, autonomous routing/swarm, required vector/graph databases, automatic capture of every conversation and mobile apps.

## v1 acceptance

- Clean install/init passes on macOS, Linux and Windows.
- Claude Code, Codex and Cursor connection flows are experimental (host verification planned for v1.0); generic MCP setup is documented.
- Two local agents coordinate non-overlapping tasks and resume from handoff.
- Conflict rejection and audited stale takeover pass.
- Proposed knowledge requires approval; superseded decisions stay out of default packs.
- [x] Obsidian edits reconcile and become searchable (proven in tests/obsidian.test.ts).
- Recovery, export and backup pass.
- [x] Coding and research demos complete from clean workspaces (proven in tests/proof-demos.test.ts, demos/coding-demo.mjs, and demos/research-demo.mjs).
