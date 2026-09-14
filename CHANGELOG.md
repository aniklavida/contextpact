# Changelog

All notable changes will be documented here.

## [Unreleased]

### Added

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
