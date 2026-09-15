# Changelog

All notable changes will be documented here.

## [Unreleased]

### Added

- Workspace export command (`export`) and core API serializing Markdown knowledge items and SQLite-owned operational state (tasks, leases, agents, sessions, policies, and audit events) to schema-validated JSON archives.
- Workspace import command (`import`) and core API with deterministic ID collision policies (`skip` as canonical default, `replace` to overwrite, and `error` to fail closed).
- Dual-store workspace backup command (`backup`) and core API creating point-in-time snapshot bundles covering both Markdown vault and SQLite database.
- Workspace restore command (`restore`) and core API recovering both Markdown vault and SQLite database from backup snapshots, rejecting incomplete single-store archives.
- Diagnostic workspace doctor (`doctor`) command and core API identifying invalid workspace layout, wrong schema versions, stale index hashes, orphaned files, expired leases, missing provenance, and rebuilt database state.
- Explicit detection and clear reporting of databases rebuilt from Markdown rather than restored, asserting that historical audit trails and task leases cannot be rebuilt.
- Enhanced reindex command (`reindex`) supporting explicit options for cleaning deleted rows.
- Documented interface differences for administrative commands (`export`, `import`, `backup`, `restore`, `doctor`) in the surface contract.
- Guided connection command (`connect`) with dedicated host adapters for Claude Code (`~/.claude.json`), Codex (`~/.codex/config.toml`), and Cursor (`~/.cursor/mcp.json`) merging MCP server configuration idempotently without clobbering unrelated entries.
- Generic MCP server configuration output validated against Model Context Protocol stdio contract schema.
- Live MCP connection check (`contextpact connect --check`) spawning the local MCP server over stdio and verifying real tool execution.
- Documented interface difference for the `connect` setup command in the surface registry.
- Transport-independent core command surface exposed identically across CLI commands and MCP tools covering bootstrap, context, decisions, tasks, and handoffs.
- Profile-based tool exposure ensuring default agent profiles never see approval tools, while elevated reviewer and human profiles retain approval capability.
- Parity test suite enumerating CLI commands and MCP tools to prevent undocumented interface drift over time.
- Expanded CLI surface with `propose`, `get`, `archive`, `decision` (`propose`), `task` (`create`, `claim`, `release`, `get`, `list`), and `handoff` (`create`, `get`, `resume`).
- Expanded MCP surface with `decision_propose`, `task_create`, `task_claim`, `task_release`, and `task_get`, holding the tool surface inside the 10-15 composable tool band.
- Documented interface differences for offline maintenance (`reindex`, `reconcile`), filesystem bootstrap (`init`), and stdio runner (`mcp`).
- Evidence-bearing structured handoffs split between human-readable Markdown narratives and atomic SQLite operational records, requiring verified evidence for success claims, enforcing single next action discipline, and enabling multi-process task resumption.
- Single-machine task leases with atomic SQLite claim transactions, conflict rejection, renewal, terminal release states and audited stale takeover.

- Approved v1 product specification and architecture.
- Buildable TypeScript repository foundation.
- Experimental workspace initialization, status and MCP bootstrap surfaces.
- Lifecycle state machine enforcing valid transitions across draft, proposed, approved, superseded and archived states.
- Approval gate requiring human or elevated review for durable knowledge proposals and preventing agent self-approval.
- Immediate writes with provenance for operational task and handoff state.
- Supersession tracking via the context_supersedes table with automatic exclusion from default context packs.
- Complete mutation audit logging in the audit_events table recording actor, source, timestamp and previous version.
- Deterministic context pack builder and expanded CLI/MCP tools for proposing, approving and retrieving context packs.
- Ordered and reversible SQLite migration runner with STRICT migrations table.
- Added workspace_id column to context_items table matching domain contract.
- Added policies table for SQLite-owned permissions state.
- Markdown vault reconciliation and reindexing into SQLite search index with document hash tracking.
- Optimistic version conflict detection protecting against stale external file edits.
- Corrupted database recovery reconstructing search index and context items from Markdown vault.
- SQLite FTS5 search index maintenance with automatic synchronization triggers and BM25 relevance ranking.
- Deterministic retrieval pipeline ranking context by scope, relevance, importance and recency with stable tie-breaking.
- Deterministic token budgeting for context packs with explicit reporting of omissions and reasons.
- Exclusion of superseded and archived items from default packs with tracking of replacement decisions.
- Policy enforcement guaranteeing workspace-local context isolation by default unless global scope is explicitly permitted.
- Untrusted data framing and safety notice ensuring retrieved context is legible to consuming models as data rather than instructions.
- CLI search command and enhanced pack command supporting full-text query, token budgets and Markdown rendering.
- MCP context_search tool and enhanced context_pack tool supporting full-text search and token budgets.

[Unreleased]: https://github.com/aniklavida/contextpact/commits/main
