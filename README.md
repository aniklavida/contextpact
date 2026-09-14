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
- Complete knowledge lifecycle, context-pack retrieval, and supersession.
- Task leases, conflict handling, and structured handoffs.
- Transport-independent core with 1:1 parity between CLI commands and MCP tools across bootstrap, context, decisions, tasks, and handoffs.
- Profile-based tool exposure ensuring default agent profiles never see approval tools.
- Parity test suite enforcing zero undocumented gaps across interfaces.

Planned for v1.0 and not yet advertised as supported:

- Guided Claude Code, Codex and Cursor connection.
- Obsidian edit reconciliation workflow and packaging.
- Import, export, backup and recovery.
- Cross-platform clean-install and end-to-end proof.

## Intended experience

```bash
contextpact init
contextpact connect claude
contextpact connect codex
contextpact status
```

The connection commands above describe the planned v1 experience; only the documented foundation commands should be treated as implemented before the release checklist passes.

## Command and tool surface

ContextPact exposes its command surface identically through CLI commands and MCP tools over one transport-independent core:

| Category  | CLI Command                         | MCP Tool           | Description                                             |
| --------- | ----------------------------------- | ------------------ | ------------------------------------------------------- |
| Bootstrap | `contextpact status`                | `context_status`   | Inspect workspace initialization and storage health     |
| Context   | `contextpact propose`               | `context_propose`  | Propose durable context or record operational notes     |
| Context   | `contextpact get <id>`              | `context_get`      | Retrieve context item by ID across lifecycle states     |
| Context   | `contextpact search <query>`        | `context_search`   | FTS5 full-text search with BM25 ranking                 |
| Context   | `contextpact pack`                  | `context_pack`     | Retrieve deterministic token-budgeted context pack      |
| Context   | `contextpact archive <id>`          | `context_archive`  | Archive approved context item                           |
| Context   | `contextpact approve <id>`          | `context_approve`  | Approve proposed context (elevated/human profiles only) |
| Decisions | `contextpact decision propose`      | `decision_propose` | Propose architectural or product decision               |
| Tasks     | `contextpact task create`           | `task_create`      | Create coordination task with declared scopes           |
| Tasks     | `contextpact task claim <taskId>`   | `task_claim`       | Claim, renew, or takeover single-machine task lease     |
| Tasks     | `contextpact task release <taskId>` | `task_release`     | Release task lease with terminal status                 |
| Tasks     | `contextpact task get <taskId>`     | `task_get`         | Inspect task and active lease state                     |
| Handoffs  | `contextpact handoff create`        | `handoff_create`   | Record evidence-bearing structured handoff              |
| Handoffs  | `contextpact handoff get <id>`      | `handoff_get`      | Retrieve handoff narrative and evidence by ID           |
| Handoffs  | `contextpact resume <id>`           | `handoff_resume`   | Resume task from handoff and claim lease                |

### Profile-based tool exposure

Default agent profiles connecting via MCP hold execution leases and propose knowledge, but cannot see or invoke approval tools. The `context_approve` tool is registered only for elevated reviewer or human operator profiles.

### Documented interface differences

Four CLI maintenance and runner commands have no MCP counterpart:

1. `init`: Workspace filesystem initialization executed from the terminal before agent processes launch.
2. `mcp`: CLI transport launcher running the MCP server over stdio.
3. `reindex`: Offline administrative tool to rebuild SQLite FTS5 search indexes from disk.
4. `reconcile`: Offline administrative tool to reconcile external Markdown knowledge edits with SQLite state.

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
