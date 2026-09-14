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

[Unreleased]: https://github.com/aniklavida/contextpact/commits/main
