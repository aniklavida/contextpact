# Changelog

All notable changes will be documented here.

## [Unreleased]

### Added

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

[Unreleased]: https://github.com/aniklavida/contextpact/commits/main
