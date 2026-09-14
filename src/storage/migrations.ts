import type Database from "better-sqlite3";

import { schemaVersion } from "./schema.js";

export interface Migration {
  version: number;
  name: string;
  up: (db: Database.Database) => void;
  down?: (db: Database.Database) => void;
}

const migration1: Migration = {
  version: 1,
  name: "001_initial_schema",
  up: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS workspace (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        client_kind TEXT NOT NULL,
        profile TEXT NOT NULL,
        last_seen_at TEXT,
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL REFERENCES agents(id),
        task_id TEXT REFERENCES tasks(id),
        status TEXT NOT NULL CHECK (status IN ('active', 'ended', 'failed')),
        started_at TEXT NOT NULL,
        ended_at TEXT
      ) STRICT;

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL CHECK (status IN ('planned', 'active', 'review', 'done', 'blocked')),
        scope_json TEXT NOT NULL DEFAULT '[]',
        version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS task_leases (
        task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
        agent_id TEXT NOT NULL REFERENCES agents(id),
        acquired_at TEXT NOT NULL,
        heartbeat_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1
      ) STRICT;

      CREATE TABLE IF NOT EXISTS context_items (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        scope TEXT NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        source TEXT NOT NULL,
        actor TEXT NOT NULL,
        status TEXT NOT NULL,
        importance TEXT NOT NULL,
        visibility_json TEXT NOT NULL DEFAULT '[]',
        tags_json TEXT NOT NULL DEFAULT '[]',
        document_path TEXT,
        document_hash TEXT,
        version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        expires_at TEXT
      ) STRICT;

      CREATE TABLE IF NOT EXISTS context_supersedes (
        context_id TEXT NOT NULL REFERENCES context_items(id) ON DELETE CASCADE,
        superseded_id TEXT NOT NULL REFERENCES context_items(id),
        PRIMARY KEY (context_id, superseded_id)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS audit_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type TEXT NOT NULL,
        actor TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        previous_version INTEGER,
        payload_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE VIRTUAL TABLE IF NOT EXISTS context_fts USING fts5(
        context_id UNINDEXED,
        title,
        content,
        tags
      );

      CREATE INDEX IF NOT EXISTS idx_context_scope_status ON context_items(scope, status);
      CREATE INDEX IF NOT EXISTS idx_context_updated ON context_items(updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
      CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_events(entity_type, entity_id, id DESC);
    `);
  },
};

const migration2: Migration = {
  version: 2,
  name: "002_add_context_items_workspace_id",
  up: (db) => {
    const columns = db
      .prepare("PRAGMA table_info(context_items)")
      .all() as Array<{ name: string }>;
    const hasWorkspaceId = columns.some((c) => c.name === "workspace_id");
    if (!hasWorkspaceId) {
      db.exec(
        "ALTER TABLE context_items ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'workspace-default';",
      );
      db.exec(`
        UPDATE context_items
        SET workspace_id = (SELECT id FROM workspace LIMIT 1)
        WHERE (SELECT id FROM workspace LIMIT 1) IS NOT NULL;
      `);
    }
    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_context_workspace_scope_status ON context_items(workspace_id, scope, status);",
    );
  },
  down: (db) => {
    db.exec("DROP INDEX IF EXISTS idx_context_workspace_scope_status;");
    const columns = db
      .prepare("PRAGMA table_info(context_items)")
      .all() as Array<{ name: string }>;
    const hasWorkspaceId = columns.some((c) => c.name === "workspace_id");
    if (hasWorkspaceId) {
      db.exec("ALTER TABLE context_items DROP COLUMN workspace_id;");
    }
  },
};

const migration3: Migration = {
  version: 3,
  name: "003_add_policies_table",
  up: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS policies (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        policy_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_policies_name ON policies(name);
    `);
  },
  down: (db) => {
    db.exec("DROP INDEX IF EXISTS idx_policies_name;");
    db.exec("DROP TABLE IF EXISTS policies;");
  },
};

const migration4: Migration = {
  version: 4,
  name: "004_make_schema_migrations_strict",
  up: (db) => {
    const tableInfo = db
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
      )
      .get() as { sql: string } | undefined;
    if (tableInfo && !tableInfo.sql.toUpperCase().includes("STRICT")) {
      db.exec(`
        CREATE TABLE schema_migrations_strict (
          version INTEGER PRIMARY KEY,
          applied_at TEXT NOT NULL
        ) STRICT;
        INSERT INTO schema_migrations_strict (version, applied_at)
          SELECT version, applied_at FROM schema_migrations;
        DROP TABLE schema_migrations;
        ALTER TABLE schema_migrations_strict RENAME TO schema_migrations;
      `);
    } else if (!tableInfo) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version INTEGER PRIMARY KEY,
          applied_at TEXT NOT NULL
        ) STRICT;
      `);
    }
  },
  down: (db) => {
    const tableInfo = db
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
      )
      .get() as { sql: string } | undefined;
    if (tableInfo && tableInfo.sql.toUpperCase().includes("STRICT")) {
      db.exec(`
        CREATE TABLE schema_migrations_lenient (
          version INTEGER PRIMARY KEY,
          applied_at TEXT NOT NULL
        );
        INSERT INTO schema_migrations_lenient (version, applied_at)
          SELECT version, applied_at FROM schema_migrations;
        DROP TABLE schema_migrations;
        ALTER TABLE schema_migrations_lenient RENAME TO schema_migrations;
      `);
    }
  },
};

export const migrations: readonly Migration[] = [
  migration1,
  migration2,
  migration3,
  migration4,
];

export function ensureMigrationsTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);
}

export function getAppliedMigrations(
  db: Database.Database,
): Array<{ version: number; applied_at: string }> {
  ensureMigrationsTable(db);
  return db
    .prepare(
      "SELECT version, applied_at FROM schema_migrations ORDER BY version ASC",
    )
    .all() as Array<{ version: number; applied_at: string }>;
}

export function getCurrentMigrationVersion(db: Database.Database): number {
  ensureMigrationsTable(db);
  const row = db
    .prepare("SELECT MAX(version) as current_version FROM schema_migrations")
    .get() as { current_version: number | null } | undefined;
  return row?.current_version ?? 0;
}

export function migrate(
  db: Database.Database,
  targetVersion = schemaVersion,
): { applied: number[]; currentVersion: number } {
  ensureMigrationsTable(db);
  const appliedRows = getAppliedMigrations(db);
  const appliedVersions = new Set(appliedRows.map((r) => r.version));

  const pendingMigrations = migrations
    .filter(
      (m) => m.version <= targetVersion && !appliedVersions.has(m.version),
    )
    .sort((a, b) => a.version - b.version);

  const applied: number[] = [];

  for (const migration of pendingMigrations) {
    const runInTransaction = db.transaction(() => {
      migration.up(db);
      db.prepare(
        "INSERT OR REPLACE INTO schema_migrations (version, applied_at) VALUES (?, ?)",
      ).run(migration.version, new Date().toISOString());
    });
    runInTransaction();
    applied.push(migration.version);
  }

  return {
    applied,
    currentVersion: getCurrentMigrationVersion(db),
  };
}

export function rollback(
  db: Database.Database,
  targetVersion = 0,
): { reverted: number[]; currentVersion: number } {
  ensureMigrationsTable(db);
  const appliedRows = getAppliedMigrations(db);
  const appliedVersions = new Set(appliedRows.map((r) => r.version));

  const migrationsToRevert = migrations
    .filter((m) => m.version > targetVersion && appliedVersions.has(m.version))
    .sort((a, b) => b.version - a.version);

  const reverted: number[] = [];

  for (const migration of migrationsToRevert) {
    if (!migration.down) {
      throw new Error(
        `Cannot roll back migration ${migration.version} (${migration.name}): rollback not supported.`,
      );
    }
    const runInTransaction = db.transaction(() => {
      migration.down!(db);
      db.prepare("DELETE FROM schema_migrations WHERE version = ?").run(
        migration.version,
      );
    });
    runInTransaction();
    reverted.push(migration.version);
  }

  return {
    reverted,
    currentVersion: getCurrentMigrationVersion(db),
  };
}
