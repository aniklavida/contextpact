# Troubleshooting

This guide documents the four primary failure modes encountered in ContextPact workspaces, detailing the exact error messages produced by the codebase and actionable remediation steps.

---

## 1. Failed native-module install

ContextPact uses `better-sqlite3` for local operational storage, task leasing, and FTS5 search indexing. `better-sqlite3` is a C++ Node-API native addon.

### Symptoms and error messages

#### Node.js version floor refusal

```text
ContextPact requires Node.js >=22.14.0 (detected v22.12.0). Please upgrade Node.js.
```

Or, on Node.js versions below 22.14.0 (such as 22.12.0 or 22.13.0) without the guard:

```text
Segmentation fault (core dumped)
```

_Why this occurs:_ While `better-sqlite3` declares `engines: { "node": ">=22" }`, invoking `new Database(":memory:")` segfaults the process on Node versions 22.12.0 and 22.13.0. Node 22.14.0 is the minimum verified engine floor.

#### Missing C++ compiler toolchain on source rebuild

When prebuilt binaries are unavailable or when compiling with `--build-from-source`:

**Windows:**

```text
gyp ERR! find VS could not find a version of Visual Studio 2017 or newer to use
gyp ERR! find VS unknown version "undefined" found at "C:\Program Files\Microsoft Visual Studio\..."
```

**macOS:**

```text
xcode-select: error: tool 'xcodebuild' requires Xcode, but active developer directory is a command line tools instance
fatal error: 'node.h' file not found
```

**Linux:**

```text
make: g++: Command not found
gyp ERR! build error
```

#### Windows filesystem locking (EBUSY / EPERM)

```text
EBUSY: resource busy or locked, unlink '.../contextpact.db-wal'
EPERM: operation not permitted, rmdir '...'
```

_Why this occurs:_ Windows enforces mandatory byte-range file locking and prevents unlinking or renaming files that have active open handles in any process. If SQLite WAL shared memory handles (`-shm` or `-wal`) remain open, workspace operations fail.

### Solutions

1. **Upgrade Node.js to >= 22.14.0**:
   ```bash
   node --version # Must be >= 22.14.0
   ```
2. **Install compiler toolchains if source build is triggered**:
   - **macOS**: Install Apple Command Line Tools:
     ```bash
     xcode-select --install
     ```
   - **Linux**: Install Python 3 and build tools:
     ```bash
     # Ubuntu / Debian
     sudo apt-get install -y build-essential python3
     # Fedora / RHEL
     sudo dnf groupinstall -y "Development Tools" && sudo dnf install -y python3
     ```
   - **Windows**: Install Visual Studio Build Tools 2019 or 2022 with the "Desktop development with C++" workload and ensure Python 3 is in your `PATH`.
3. **Resolve Windows file locking**:
   - Ensure all running agent, CLI, or MCP processes connected to the workspace are stopped before performing administrative restores, clean installations, or workspace deletions.

---

## 2. Host that will not connect

ContextPact connects to AI hosts (Claude Code, Codex, Cursor) via MCP over standard I/O (`stdio`).

### Symptoms and error messages

#### Stdio connection self-check failure

```text
MCP connection check failed: <reason>
```

Common reasons include:

- `spawn ENOENT`: The `contextpact` command or executable could not be found by the system.
- `MCP server started over stdio but did not expose the expected tool 'context_status'. Available tools: <tools>`: Server started but failed to register expected bootstrap tools.

#### Host configuration syntax errors

When running `contextpact connect claude`, `contextpact connect cursor`, or `contextpact connect codex`:

```text
Malformed JSON configuration at ~/.claude.json: Unexpected token ...
Malformed JSON configuration at ~/.cursor/mcp.json: Unexpected token ...
Failed to parse TOML configuration at ~/.codex/config.toml: Expected valid TOML ...
```

ContextPact validates host configuration files before modifying them. If an existing host configuration file contains syntax errors, ContextPact fails without writing to protect existing configurations.

#### Unsupported client

```text
Unsupported client '<name>'. Supported clients: claude, codex, cursor. Use generic MCP configuration for other clients.
```

### Solutions

1. **Run the live diagnostic connection check**:
   ```bash
   contextpact connect --check
   ```
   This spawns the server over stdio, verifies tool registration, and executes `context_status`.
2. **Ensure executable path is resolved by the host**:
   If the host runs in a restricted environment where `contextpact` is not in the default system `PATH`, configure the absolute path:
   ```bash
   contextpact connect claude --command /usr/local/bin/node --args /path/to/contextpact/dist/cli.js mcp
   ```
3. **Prevent standard output pollution**:
   MCP communication over stdio requires pristine JSON-RPC messages on stdout. If your shell profile (`~/.bashrc`, `~/.zshrc`) prints text or banner messages during subshell initialization, the MCP client will fail to parse JSON-RPC responses. Silence all interactive output in non-interactive shells.
4. **Fix host configuration syntax**:
   Inspect the indicated JSON or TOML file and correct syntax errors before re-running `contextpact connect`.

---

## 3. A corrupt database

SQLite operational storage (`.contextpact/contextpact.db`) can become corrupted due to unexpected power loss, interrupted filesystem writes, or manual edits to the database binary.

### Symptoms and error messages

#### Doctor health check failure

```text
SQLite database at '.contextpact/contextpact.db' failed integrity check (corrupted).
```

`contextpact doctor` reports:

- `kind: invalid_workspace`
- `severity: error`
- `repair: Restore from a valid dual-store backup using 'contextpact restore <backupPath>', or recover database using 'contextpact recover'.`

#### Backup or restore failure

```text
Cannot backup workspace at '.contextpact': SQLite database is missing or corrupt.
Cannot restore from corrupted backup: SQLite database failed integrity check.
```

#### Rebuilt database warning

```text
Database was rebuilt from Markdown rather than restored from a dual-store backup. Search index was reconstructed, but historical task leases and audit events cannot be rebuilt from Markdown and have been lost. Do not assume historical audit trail is intact.
```

`contextpact doctor` reports:

- `kind: rebuilt_database`
- `severity: warning`

### Solutions

1. **Preferred: Restore from dual-store backup**:
   An atomic backup snapshot captures both the Markdown vault and SQLite operational state:
   ```bash
   contextpact restore ./backups/snapshot-01 --clean
   ```
2. **Fallback: Rebuild from Markdown vault**:
   If no backup is available, recover the workspace database:
   ```bash
   contextpact reindex --clean-deleted
   ```
   During database recovery:
   - The corrupted database is safely moved aside to `.contextpact/contextpact.db.corrupt.<timestamp>`.
   - Sidecar WAL and SHM files are unlinked.
   - A fresh database is created and schema migrations are applied.
   - Markdown knowledge items in `.contextpact/knowledge/` are reindexed into SQLite FTS5 search indexes.
   - A `database_rebuilt` audit event is recorded. Note that historical task leases, active agent sessions, and past audit records cannot be rebuilt from Markdown and are lost.

---

## 4. A conflicted external edit

ContextPact allows editing Markdown files in `.contextpact/knowledge/` using Obsidian, VS Code, or any text editor. When external edits conflict with the storage contract, ContextPact surfaces actionable conflicts.

### Non-destructive guarantee

**ContextPact never overwrites, truncates, or deletes conflicted external edits.** Files with syntax errors, schema mismatches, or conflicting versions remain **byte-for-byte untouched** on disk. Plain notes created without frontmatter are preserved and never treated as conflicts.

### Symptoms and error messages

When running `contextpact reconcile` or `contextpact reindex`:

#### 1. Invalid YAML frontmatter

```text
Invalid YAML frontmatter in '<path>': <parser error>
```

_Cause:_ The frontmatter opening `---` exists, but the YAML syntax is invalid (e.g. unclosed brackets, improper indentation).

#### 2. Missing required frontmatter fields

```text
Missing required frontmatter field(s) in '<path>': <details>
```

_Cause:_ The file has valid YAML frontmatter, but lacks required product fields such as `id` or `type`.

#### 3. Duplicate ID collision

```text
Conflict: Duplicate context item ID '<id>' in '<path>' (already seen in '<otherPath>').
```

_Cause:_ A file created or copied externally carries an `id` identical to an existing file in the workspace.

#### 4. Stale version conflict

```text
Conflict: File '<path>' has stale version 1, but database index is at version 2.
```

_Cause:_ A file on disk was modified based on an obsolete version while the database or another agent advanced the item to a newer version.

#### 5. Handoff operational record conflict

```text
Conflict: Handoff narrative in '<path>' has no corresponding operational record in SQLite table 'handoffs'.
Conflict: Handoff narrative in '<path>' references task '<taskId>', but SQLite record is linked to task '<dbTaskId>'.
Conflict: Handoff '<id>' in '<path>' asserts success without evidence in SQLite record.
```

### Solutions

1. **Inspect conflicts**:
   ```bash
   contextpact reconcile
   ```
   Or run the workspace doctor:
   ```bash
   contextpact doctor
   ```
2. **Resolve by editing the file**:
   - **Syntax errors**: Fix the YAML frontmatter syntax at the top of the Markdown file.
   - **Missing fields**: Add missing `id` and `type` fields to the frontmatter.
   - **ID collisions**: Change the `id` field in one of the conflicting files to a unique identifier.
   - **Stale versions**: If the external edit is authoritative, increment the `version` field in the frontmatter to match or exceed the indexed database version, or merge changes from the database.
3. **Reindex the workspace**:
   After correcting the file, reindex to apply the updates:
   ```bash
   contextpact reindex
   ```
