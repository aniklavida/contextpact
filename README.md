# ContextPact

**Any agent. Same approved context.**

ContextPact is a local-first context and coordination layer for people who move between AI tools or run several agents in parallel. It is designed to keep durable knowledge, current decisions, task ownership and handoffs outside any one AI product.

## Project status

ContextPact is under active pre-release development. The repository currently contains the approved v1 specification, architecture, repository foundation and an experimental workspace bootstrap. It is **not yet a production-ready context system and has not been released to npm**.

Implemented and tested in the current foundation:

- TypeScript build and test pipeline.
- Context item and workspace contracts.
- Local workspace layout creation.
- SQLite schema bootstrap with WAL and FTS5.
- Experimental `init`, `status` and MCP bootstrap/status surfaces.

Planned for v1.0 and not yet advertised as supported:

- Complete knowledge lifecycle, context-pack retrieval and supersession.
- Task leases, conflict handling and structured handoffs.
- Guided Claude Code, Codex and Cursor connection.
- Obsidian edit reconciliation, import/export, backup and recovery.
- Cross-platform clean-install and end-to-end proof.

## Intended experience

```bash
contextpact init
contextpact connect claude
contextpact connect codex
contextpact status
```

The connection commands above describe the planned v1 experience; only the documented foundation commands should be treated as implemented before the release checklist passes.

## Architecture

- Markdown owns human-readable knowledge, rules, goals, decisions and handoff narratives.
- SQLite owns agents, sessions, tasks, leases, policies, versions and audit events.
- FTS5 is a rebuildable search index; semantic retrieval is optional future work.
- CLI and MCP call the same transport-independent core.
- Obsidian may edit the Markdown layer but is never required.

See [the product specification](docs/SPEC.md), [architecture](docs/ARCHITECTURE.md), [roadmap](docs/ROADMAP.md) and [release checklist](docs/RELEASE_CHECKLIST.md).

## Development

Requires Node.js 22.12 or newer.

```bash
npm install
npm run check
npm run dev -- init ./scratch-workspace
npm run dev -- status ./scratch-workspace
```

## Licence

MIT. See [LICENSE](LICENSE).
