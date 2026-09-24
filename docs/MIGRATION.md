# Workspace schema migrations

This document describes how ContextPact handles workspace schema evolution across versions, covering the migration runner, registered migrations, automatic upgrades, rollback semantics, and diagnostics.

---

## 1. Migration architecture

ContextPact uses a dual-store model:

- **Markdown vault**: Human-readable knowledge files and handoff narratives stored as plain files. File formats remain backward compatible, and new frontmatter fields default gracefully.
- **SQLite operational store**: Structured operational data (agents, tasks, leases, policies, handoffs, audit trails, and FTS5 search indexes) stored in `.contextpact/contextpact.db`.

### The migration runner

Database schema evolution is managed by an ordered, transactional migration runner in `src/storage/migrations.ts`.

All applied migrations are recorded in the `schema_migrations` table:

```sql
CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
) STRICT;
```

Each migration defines:

- `version`: Monotonically increasing integer identifier.
- `name`: Human-readable description.
- `up`: Transactional forward migration function modifying tables, indexes, or columns.
- `down`: Transactional rollback function reversing changes where practical.

---

## 2. Registered schema migrations

The current database schema is at **version 5** (`schemaVersion = 5`):

### Migration 1: `001_initial_schema`

Establishes core SQLite tables and indexes:

- `schema_migrations`: Version tracking table.
- `workspace`: Workspace ID, display name, and initialization timestamp.
- `agents`: Registered agent identities, client kinds, and profiles.
- `sessions`: Agent execution sessions tied to tasks.
- `tasks`: Coordination tasks with lifecycle statuses (`planned`, `active`, `review`, `done`, `blocked`).
- `task_leases`: Renewable single-machine task leases with TTL heartbeats.
- `context_items`: Structured metadata for durable knowledge items.
- `context_supersedes`: Directed graph tracking supersession links between context items.
- `audit_events`: Append-only audit log capturing actor, source, entity mutations, and previous versions.
- `context_fts`: SQLite FTS5 full-text search index with automatic trigger synchronization.

### Migration 2: `002_add_context_items_workspace_id`

- Adds `workspace_id TEXT NOT NULL DEFAULT 'workspace-default'` column to `context_items`.
- Populates `workspace_id` from existing workspace records.
- Creates composite index `idx_context_workspace_scope_status` on `(workspace_id, scope, status)`.
- _Rollback:_ Drops index and removes `workspace_id` column.

### Migration 3: `003_add_policies_table`

- Adds `policies` table in SQLite `STRICT` mode for storing scope access policies.
- Creates index `idx_policies_name` on `policies(name)`.
- _Rollback:_ Drops index and deletes `policies` table.

### Migration 4: `004_make_schema_migrations_strict`

- Recreates `schema_migrations` table enforcing SQLite `STRICT` table mode, ensuring type integrity for version numbers and timestamps.
- Preserves existing migration history.
- _Rollback:_ Reverts `schema_migrations` to a lenient table.

### Migration 5: `005_add_handoffs_table`

- Adds `handoffs` table in SQLite `STRICT` mode for structured operational handoff tracking:
  - `outcome CHECK (outcome IN ('success', 'blocked', 'in_progress'))`.
  - `evidence_json` for verified evidence items.
- Creates indexes: `idx_handoffs_task`, `idx_handoffs_agent`, and `idx_handoffs_outcome`.
- _Rollback:_ Drops indexes and deletes `handoffs` table.

---

## 3. Runtime behavior

### Automatic forward migrations

Whenever ContextPact accesses a workspace database:

1. `openDatabase()` connects to `.contextpact/contextpact.db`.
2. PRAGMAs are applied: `foreign_keys = ON`, `journal_mode = WAL`, `synchronous = NORMAL`, and `busy_timeout = 5000`.
3. The migration runner executes `migrate(database, targetVersion)`.
4. Any unapplied migrations with `version <= targetVersion` run in sequential order.
5. Search triggers and virtual tables are refreshed via `ensureFtsIndex()`.

No manual upgrade step is required during normal software updates; the local database updates automatically to match the binary.

### Administrative reindexing

Running `contextpact reindex` explicitly reapplies pending migrations and reconciles all Markdown files from `.contextpact/knowledge/` into the search index.

### Reversibility and rollbacks

Rollbacks are supported programmatically via `rollback(database, targetVersion)`:

- Migrations are reverted in reverse numerical order.
- If an unapplied migration lacks a `down` implementation, rollback terminates immediately with an error rather than leaving the schema in an ambiguous partial state.

---

## 4. Diagnostics and drift detection

The workspace doctor (`contextpact doctor`) inspects database version health against the declared code schema:

- If `currentVersion < schemaVersion`, doctor reports:
  ```text
  Database schema version (<current>) does not match expected schema version (<expected>).
  ```
  - `kind: wrong_schema_version`
  - `severity: error`
  - `repair: Run 'contextpact reindex' to apply pending database migrations, or restore a compatible database backup.`

### Rebuilt database state

If a database becomes corrupted and is reconstructed from Markdown files via `contextpact reindex` or database recovery:

- The database schema is fully upgraded to the latest version.
- Markdown knowledge items and search indexes are restored.
- **Historical state is not restored**: Task leases, session records, and past audit events cannot be reconstructed from Markdown.
- Doctor flags this with a warning:
  ```text
  Database was rebuilt from Markdown rather than restored from a dual-store backup. Search index was reconstructed, but historical task leases and audit events cannot be rebuilt from Markdown and have been lost. Do not assume historical audit trail is intact.
  ```

To preserve operational history across catastrophic hardware or filesystem incidents, always restore from atomic dual-store backups created with `contextpact backup`.
