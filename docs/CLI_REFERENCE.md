# CLI reference

Complete reference for the `contextpact` command-line interface.

## Overview

ContextPact exposes a single binary `contextpact` that manages local workspaces, durable context items, single-machine task leases, structured handoffs, and MCP server connectivity.

All commands support the global options:

- `-V, --version`: Output the version number.
- `-h, --help`: Display help for command.

## Commands

### contextpact init

Create an experimental local ContextPact workspace foundation.

**Arguments:**

- `[directory]`: Workspace directory (optional, default: current working directory).

**Options:**

- `--name <name>`: Workspace display name.

**Status:** experimental

**Example:**

```bash
contextpact init ./my-workspace --name "Project Alpha"
```

---

### contextpact status

Inspect the current local workspace foundation and storage health.

**Arguments:**

- `[directory]`: Workspace directory (optional, default: current working directory).

**Status:** implemented and tested

**Example:**

```bash
contextpact status ./my-workspace
```

---

### contextpact propose

Propose a durable context item or record operational state in the workspace.

**Options:**

- `-d, --dir <directory>`: Workspace directory (default: current working directory).
- `--id <id>`: Context item ID (generated automatically if omitted).
- `-t, --type <type>`: Context type (`rule`, `preference`, `fact`, `goal`, `source`, `decision`, `task_note`, `handoff`) (required).
- `--title <title>`: Context item title (required).
- `--content <content>`: Context item content markdown body (default: empty).
- `-s, --scope <scope>`: Context scope (`global`, `workspace`, `task`, `session`) (default: `workspace`).
- `-i, --importance <importance>`: Importance level (`low`, `normal`, `high`, `critical`) (default: `normal`).
- `--tags <tags...>`: Context tags (space-separated list).
- `--supersedes <ids...>`: Context item IDs that this item supersedes.
- `-a, --actor <actor>`: Proposer actor identity (default: `cli-user`).

**Status:** implemented and tested

**Example:**

```bash
contextpact propose --type rule --title "Code Formatting" --content "Enforce strict linting." --scope workspace
```

---

### contextpact get

Retrieve a context item by its ID across all lifecycle states (including proposed, approved, superseded, and archived).

**Arguments:**

- `<id>`: Unique context item ID (required).

**Options:**

- `-d, --dir <directory>`: Workspace directory (default: current working directory).

**Status:** implemented and tested

**Example:**

```bash
contextpact get rule-code-formatting
```

---

### contextpact approve

Approve a proposed durable context item through the approval gate. Elevated or human operator identity required.

**Arguments:**

- `<id>`: Unique context item ID to approve (required).

**Options:**

- `-d, --dir <directory>`: Workspace directory (default: current working directory).
- `-a, --actor <actor>`: Approver actor identity (default: `operator`).

**Status:** implemented and tested

**Example:**

```bash
contextpact approve rule-code-formatting --actor lead-dev
```

---

### contextpact archive

Archive an approved context item when it is no longer relevant.

**Arguments:**

- `<id>`: Unique context item ID to archive (required).

**Options:**

- `-d, --dir <directory>`: Workspace directory (default: current working directory).
- `-a, --actor <actor>`: Archiver actor identity (default: `operator`).

**Status:** implemented and tested

**Example:**

```bash
contextpact archive rule-code-formatting
```

---

### contextpact search

Search workspace context items using SQLite FTS5 full-text search with BM25 ranking.

**Arguments:**

- `<query>`: Search query expression (required).

**Options:**

- `-d, --dir <directory>`: Workspace directory (default: current working directory).
- `-s, --scope <scope>`: Filter by scope (`global`, `workspace`, `task`, `session`).
- `--allow-global`: Include global items when filtering by workspace scope.
- `-l, --limit <number>`: Maximum number of search results to return (default: `10`).

**Status:** implemented and tested

**Example:**

```bash
contextpact search "formatting rules" --limit 5
```

---

### contextpact pack

Build and inspect the deterministic token-budgeted context pack of approved knowledge.

**Options:**

- `-d, --dir <directory>`: Workspace directory (default: current working directory).
- `-q, --query <query>`: Context search query for relevance scoring.
- `-s, --scope <scope>`: Target scope filter (default: `workspace`).
- `-t, --task <taskId>`: Active task ID to include task context.
- `-S, --session <sessionId>`: Active session ID to include session context.
- `-c, --client <clientId>`: Target client identifier.
- `-b, --budget <tokens>`: Maximum token budget (default: `4000`).
- `--allow-global`: Allow global scope items in the pack.
- `-f, --format <format>`: Output format (`json` or `markdown`, default: `markdown`).

**Status:** implemented and tested

**Example:**

```bash
contextpact pack --budget 2000 --format markdown
```

---

### contextpact decision

Command group for proposing and inspecting architectural or product decisions.

**Subcommands:**

- `propose`: Propose an architectural or product decision.

**Status:** implemented and tested

---

### contextpact decision propose

Propose an architectural or product decision for durable knowledge in the workspace.

**Options:**

- `-d, --dir <directory>`: Workspace directory (default: current working directory).
- `--id <id>`: Decision item ID (generated automatically if omitted).
- `--title <title>`: Decision title (required).
- `--content <content>`: Decision body and rationale (default: empty).
- `-s, --scope <scope>`: Context scope (`global`, `workspace`, `task`, `session`) (default: `workspace`).
- `-i, --importance <importance>`: Importance level (`low`, `normal`, `high`, `critical`) (default: `normal`).
- `--tags <tags...>`: Decision tags (space-separated list).
- `--supersedes <ids...>`: Prior decision IDs that this decision supersedes.
- `-a, --actor <actor>`: Proposer actor identity (default: `cli-user`).

**Status:** implemented and tested

**Example:**

```bash
contextpact decision propose --title "Adopt SQLite WAL" --content "Use WAL mode for atomic operational concurrency."
```

---

### contextpact task

Command group for managing coordination tasks and single-machine leases.

**Subcommands:**

- `create`: Create a coordination task.
- `claim`: Claim, renew, or takeover a task lease.
- `release`: Release an active task lease.
- `get`: Retrieve a task by ID.
- `list`: List tasks in the workspace.

**Status:** implemented and tested

---

### contextpact task create

Create a coordination task with declared scopes.

**Options:**

- `-d, --dir <directory>`: Workspace directory (default: current working directory).
- `--id <id>`: Task ID (generated automatically if omitted).
- `--title <title>`: Task title (required).
- `--desc, --description <description>`: Detailed task description (default: empty).
- `-s, --status <status>`: Initial task status (`planned`, `active`, `review`, `done`, `blocked`) (default: `planned`).
- `--scope <scopes...>`: File or directory paths declared in this task's scope.
- `-a, --actor <actor>`: Creator identity (default: `cli-user`).

**Status:** implemented and tested

**Example:**

```bash
contextpact task create --title "Implement search" --scope src/core/ docs/
```

---

### contextpact task claim

Claim, renew, or takeover a single-machine task lease for an agent process.

**Arguments:**

- `<taskId>`: ID of the task to claim (required).

**Options:**

- `-d, --dir <directory>`: Workspace directory (default: current working directory).
- `-a, --agent <agentId>`: Claiming agent identifier (default: `cli-agent`).
- `--ttl <seconds>`: Lease duration in seconds before expiration (default: `300`).
- `--scope <scopes...>`: Declared file/directory scopes for lease contention detection.
- `--takeover-reason <reason>`: Required justification when taking over a stale expired lease.

**Status:** implemented and tested

**Example:**

```bash
contextpact task claim task-123 --agent agent-worker-1 --ttl 600
```

---

### contextpact task release

Release an active task lease and transition task status.

**Arguments:**

- `<taskId>`: ID of the task to release (required).

**Options:**

- `-d, --dir <directory>`: Workspace directory (default: current working directory).
- `-a, --agent <agentId>`: Releasing agent identifier (default: `cli-agent`).
- `-s, --status <status>`: New task status (`planned`, `active`, `review`, `done`, `blocked`) (default: `review`).

**Status:** implemented and tested

**Example:**

```bash
contextpact task release task-123 --agent agent-worker-1 --status done
```

---

### contextpact task get

Retrieve a task by ID along with its active lease state.

**Arguments:**

- `<taskId>`: ID of the task to inspect (required).

**Options:**

- `-d, --dir <directory>`: Workspace directory (default: current working directory).

**Status:** implemented and tested

**Example:**

```bash
contextpact task get task-123
```

---

### contextpact task list

List tasks in the workspace, optionally filtered by status.

**Options:**

- `-d, --dir <directory>`: Workspace directory (default: current working directory).
- `-s, --status <status>`: Filter tasks by status (`planned`, `active`, `review`, `done`, `blocked`).

**Status:** implemented and tested

**Example:**

```bash
contextpact task list --status active
```

---

### contextpact handoff

Command group for creating, inspecting, and managing evidence-bearing structured handoffs.

**Subcommands:**

- `create`: Record a new evidence-bearing structured handoff.
- `get`: Retrieve a structured handoff by ID.
- `inspect`: Inspect a structured handoff by ID directly.

**Status:** implemented and tested

---

### contextpact handoff create

Record an evidence-bearing structured handoff across a context boundary.

**Options:**

- `-d, --dir <directory>`: Workspace directory (default: current working directory).
- `--id <id>`: Handoff ID (generated automatically if omitted).
- `-t, --task <taskId>`: Task ID associated with this handoff (required).
- `-a, --agent <agentId>`: Agent creating the handoff (default: `cli-agent`).
- `--title <title>`: Handoff title.
- `-o, --outcome <outcome>`: Handoff outcome (`success`, `blocked`, `in_progress`) (required).
- `-m, --summary <summary>`: Summary narrative of work completed (required).
- `-n, --next-action <action>`: Recommended single next action for resuming agent (required).
- `--blockers <blockers...>`: List of blocking issues encountered.
- `--evidence <items...>`: Evidence items supporting outcome claims (e.g. test runs, commit hashes).
- `--tags <tags...>`: Handoff tags.
- `--keep-lease`: Do not automatically release the active task lease upon handoff creation.

**Status:** implemented and tested

**Example:**

```bash
contextpact handoff create --task task-123 --outcome success --summary "Finished parser implementation." --next-action "Run integration test suite."
```

---

### contextpact handoff get

Retrieve a structured handoff by ID, returning metadata, evidence, and narrative.

**Arguments:**

- `<id>`: Unique handoff ID (required).

**Options:**

- `-d, --dir <directory>`: Workspace directory (default: current working directory).

**Status:** implemented and tested

**Example:**

```bash
contextpact handoff get handoff-456
```

---

### contextpact handoff inspect

Inspect a structured handoff by ID directly (hidden default command).

**Arguments:**

- `[id]`: Unique handoff ID (optional).

**Options:**

- `-d, --dir <directory>`: Workspace directory (default: current working directory).

**Status:** implemented and tested

**Example:**

```bash
contextpact handoff inspect handoff-456
```

---

### contextpact resume

Resume work from a structured handoff: claim the task lease and inspect handoff context.

**Arguments:**

- `<handoffId>`: Handoff ID to resume from (required).

**Options:**

- `-d, --dir <directory>`: Workspace directory (default: current working directory).
- `-a, --agent <agentId>`: Resuming agent identifier (default: `agent-resuming`).
- `--ttl <seconds>`: Lease duration in seconds (default: `300`).

**Status:** implemented and tested

**Example:**

```bash
contextpact resume handoff-456 --agent agent-worker-2
```

---

### contextpact reindex

Rebuild SQLite search index and reconcile Markdown knowledge items from disk.

**Arguments:**

- `[directory]`: Workspace directory (optional, default: current working directory).

**Options:**

- `--clean-deleted`: Remove database rows for files deleted from disk (default: `true`).
- `--no-clean-deleted`: Preserve database rows for files deleted from disk.

**Status:** implemented and tested

**Example:**

```bash
contextpact reindex ./my-workspace --clean-deleted
```

---

### contextpact backup

Create a point-in-time dual-store snapshot bundle covering both Markdown vault and SQLite database.

**Arguments:**

- `[outputPath]`: Backup destination directory path (optional, generated under `.contextpact/backups/` if omitted).

**Options:**

- `-d, --dir <directory>`: Workspace directory (default: current working directory).

**Status:** implemented and tested

**Example:**

```bash
contextpact backup ./backups/snapshot-01
```

---

### contextpact restore

Restore both Markdown vault and SQLite database from a dual-store backup snapshot.

**Arguments:**

- `<sourcePath>`: Path to backup snapshot directory to restore (required).

**Options:**

- `-d, --dir <directory>`: Target workspace directory (default: current working directory).
- `--clean`: Remove existing workspace files before restoring (default: `false`).

**Status:** implemented and tested

**Example:**

```bash
contextpact restore ./backups/snapshot-01 --clean
```

---

### contextpact doctor

Diagnose workspace health, schema versions, index freshness, orphaned files, expired leases, missing provenance, and rebuilt database state.

**Arguments:**

- `[directory]`: Workspace directory (optional, default: current working directory).

**Status:** implemented and tested

**Example:**

```bash
contextpact doctor ./my-workspace
```

---

### contextpact reconcile

Reconcile external Markdown knowledge items with SQLite index, identifying conflicts without modifying files.

**Arguments:**

- `[directory]`: Workspace directory (optional, default: current working directory).

**Status:** implemented and tested

**Example:**

```bash
contextpact reconcile ./my-workspace
```

---

### contextpact export

Export workspace including Markdown vault and SQLite operational state into a structured archive.

**Arguments:**

- `[outputPath]`: Export destination file path (optional, generated under `.contextpact/exports/` if omitted).

**Options:**

- `-d, --dir <directory>`: Workspace directory (default: current working directory).
- `--stdout`: Print raw export JSON to stdout.

**Status:** implemented and tested

**Example:**

```bash
contextpact export ./exports/workspace-export.json
```

---

### contextpact import

Import workspace data from an export archive with deterministic ID collision policies.

**Arguments:**

- `<sourceFile>`: Path to export JSON file to import (required).

**Options:**

- `-d, --dir <directory>`: Workspace directory (default: current working directory).
- `--on-collision <policy>`: ID collision policy (`skip`, `replace`, `error`) (default: `skip`).

**Status:** implemented and tested

**Example:**

```bash
contextpact import ./exports/workspace-export.json --on-collision skip
```

---

### contextpact connect

Connect ContextPact MCP server to host AI clients (Claude Code, Codex, Cursor) or print generic MCP configuration.

**Arguments:**

- `[client]`: Client identifier (`claude`, `codex`, `cursor`, or generic/other) (optional).

**Options:**

- `--check`: Spawn MCP server over stdio, invoke a real tool, and report connection status.
- `--base-dir <directory>`: Base directory for locating client configuration file (default: user home).
- `--command <command>`: Custom MCP server command executable.
- `--args <args...>`: Custom MCP server arguments.

**Status:** experimental (host connection adapters implemented; host verification planned for v1.0)

**Example:**

```bash
contextpact connect claude
contextpact connect --check
```

---

### contextpact mcp

Run the experimental ContextPact Model Context Protocol (MCP) server over standard I/O (stdio).

**Status:** experimental

**Example:**

```bash
contextpact mcp
```
