import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import {
  getAppliedMigrations,
  getCurrentMigrationVersion,
  migrate,
  openDatabase,
  rollback,
} from "../src/storage/database.js";
import { schemaVersion } from "../src/storage/schema.js";

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "contextpact-migration-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("Migration runner and schema evolution", () => {
  it("migrates a real v1 database file forward to the latest version with no data loss", () => {
    const dir = createTempDir();
    const fixturePath = join(
      process.cwd(),
      "tests",
      "fixtures",
      "v1-database.db",
    );
    const targetDbPath = join(dir, "migrated.db");

    // Start from a REAL v1 database binary file rather than a freshly created in-memory one
    copyFileSync(fixturePath, targetDbPath);

    // Verify v1 baseline state in the real database before migration
    const v1Db = new Database(targetDbPath);
    expect(getCurrentMigrationVersion(v1Db)).toBe(1);

    const initialColumns = v1Db
      .prepare("PRAGMA table_info(context_items)")
      .all() as Array<{ name: string }>;
    expect(initialColumns.some((c) => c.name === "workspace_id")).toBe(false);

    const initialTables = v1Db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as Array<{ name: string }>;
    expect(initialTables.some((t) => t.name === "policies")).toBe(false);

    // Verify schema_migrations table was not strict in v1
    const v1MigrationsSql = v1Db
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
      )
      .get() as { sql: string };
    expect(v1MigrationsSql.sql.toUpperCase().includes("STRICT")).toBe(false);

    v1Db.close();

    // Migrate forward using openDatabase
    const migratedDb = openDatabase(targetDbPath);

    // Verify schema version is at latest
    expect(getCurrentMigrationVersion(migratedDb)).toBe(schemaVersion);
    const applied = getAppliedMigrations(migratedDb);
    expect(applied.map((m) => m.version)).toEqual([1, 2, 3, 4]);

    // 1. Assert workspace_id exists in context_items and was populated with no data loss
    const migratedColumns = migratedDb
      .prepare("PRAGMA table_info(context_items)")
      .all() as Array<{ name: string }>;
    expect(migratedColumns.some((c) => c.name === "workspace_id")).toBe(true);

    const contextRows = migratedDb
      .prepare(
        "SELECT id, workspace_id, title, content FROM context_items ORDER BY id ASC",
      )
      .all() as Array<{
      id: string;
      workspace_id: string;
      title: string;
      content: string;
    }>;

    expect(contextRows).toHaveLength(2);
    expect(contextRows[0]?.id).toBe("ctx-v1-decision");
    expect(contextRows[0]?.workspace_id).toBe("ws-v1-real");
    expect(contextRows[0]?.title).toBe("V1 Decision Title");
    expect(contextRows[0]?.content).toBe("V1 Decision Content");

    expect(contextRows[1]?.id).toBe("ctx-v1-rule");
    expect(contextRows[1]?.workspace_id).toBe("ws-v1-real");
    expect(contextRows[1]?.title).toBe("V1 Rule Title");
    expect(contextRows[1]?.content).toBe("V1 Rule Content");

    // 2. Assert operational state preserved without data loss
    const workspaceRow = migratedDb
      .prepare("SELECT id, name FROM workspace WHERE id = ?")
      .get("ws-v1-real") as { id: string; name: string };
    expect(workspaceRow.name).toBe("Real V1 Workspace");

    const agentRow = migratedDb
      .prepare("SELECT id, display_name FROM agents WHERE id = ?")
      .get("agent-v1-real") as { id: string; display_name: string };
    expect(agentRow.display_name).toBe("Real V1 Agent");

    const taskRow = migratedDb
      .prepare("SELECT id, title FROM tasks WHERE id = ?")
      .get("job_v1_real") as { id: string; title: string };
    expect(taskRow.title).toBe("V1 Task Title");

    const leaseRow = migratedDb
      .prepare("SELECT task_id, agent_id FROM task_leases WHERE task_id = ?")
      .get("job_v1_real") as { task_id: string; agent_id: string };
    expect(leaseRow.agent_id).toBe("agent-v1-real");

    const sessionRow = migratedDb
      .prepare("SELECT id, status FROM sessions WHERE id = ?")
      .get("session_v1_real") as { id: string; status: string };
    expect(sessionRow.status).toBe("active");

    const auditEvents = migratedDb
      .prepare("SELECT id, entity_id FROM audit_events ORDER BY id ASC")
      .all() as Array<{ id: number; entity_id: string }>;
    expect(auditEvents).toHaveLength(2);

    // 3. Assert policies table now exists and is STRICT
    const policiesTableSql = migratedDb
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'policies'",
      )
      .get() as { sql: string };
    expect(policiesTableSql.sql.toUpperCase().includes("STRICT")).toBe(true);

    migratedDb
      .prepare(
        "INSERT INTO policies (id, name, description, policy_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        "pol-1",
        "Global Policy",
        "Allow global scope context",
        JSON.stringify({ allowGlobal: true }),
        new Date().toISOString(),
        new Date().toISOString(),
      );
    const policy = migratedDb
      .prepare("SELECT id, name, policy_json FROM policies WHERE id = ?")
      .get("pol-1") as { id: string; name: string; policy_json: string };
    expect(policy.name).toBe("Global Policy");

    // 4. Assert schema_migrations is STRICT
    const migrationsTableSql = migratedDb
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
      )
      .get() as { sql: string };
    expect(migrationsTableSql.sql.toUpperCase().includes("STRICT")).toBe(true);

    // Verify STRICT rejects wrong types in schema_migrations
    expect(() => {
      migratedDb
        .prepare(
          "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
        )
        .run("not-an-integer", 12345);
    }).toThrow();

    // 5. Assert reversibility of migrations
    const rollbackResult = rollback(migratedDb, 1);
    expect(rollbackResult.currentVersion).toBe(1);
    expect(rollbackResult.reverted).toEqual([4, 3, 2]);

    const revertedColumns = migratedDb
      .prepare("PRAGMA table_info(context_items)")
      .all() as Array<{ name: string }>;
    expect(revertedColumns.some((c) => c.name === "workspace_id")).toBe(false);

    // Migrate back forward to version 4
    const forwardResult = migrate(migratedDb, 4);
    expect(forwardResult.currentVersion).toBe(4);
    expect(forwardResult.applied).toEqual([2, 3, 4]);

    migratedDb.close();
  });
});
