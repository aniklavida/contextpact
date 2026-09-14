import Database from "better-sqlite3";

import {
  migrate,
  rollback,
  getCurrentMigrationVersion,
  getAppliedMigrations,
  type Migration,
} from "./migrations.js";
import { schemaVersion } from "./schema.js";

export function isDatabaseHealthy(path: string): boolean {
  try {
    const db = new Database(path, { timeout: 1000 });
    try {
      const result = db.pragma("quick_check") as Array<{ quick_check: string }>;
      return result.length === 1 && result[0]?.quick_check === "ok";
    } finally {
      db.close();
    }
  } catch {
    return false;
  }
}

export function ensureFtsIndex(database: Database.Database): void {
  database.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS context_fts USING fts5(
      context_id UNINDEXED,
      title,
      content,
      tags
    );

    CREATE TRIGGER IF NOT EXISTS trg_context_items_ai AFTER INSERT ON context_items BEGIN
      DELETE FROM context_fts WHERE context_id = new.id;
      INSERT INTO context_fts (context_id, title, content, tags)
      VALUES (new.id, new.title, new.content, new.tags_json);
    END;

    CREATE TRIGGER IF NOT EXISTS trg_context_items_au AFTER UPDATE ON context_items BEGIN
      DELETE FROM context_fts WHERE context_id = old.id;
      INSERT INTO context_fts (context_id, title, content, tags)
      VALUES (new.id, new.title, new.content, new.tags_json);
    END;

    CREATE TRIGGER IF NOT EXISTS trg_context_items_ad AFTER DELETE ON context_items BEGIN
      DELETE FROM context_fts WHERE context_id = old.id;
    END;

    INSERT INTO context_fts (context_id, title, content, tags)
    SELECT id, title, content, tags_json FROM context_items
    WHERE id NOT IN (SELECT context_id FROM context_fts);
  `);
}

export function rebuildFtsIndex(database: Database.Database): void {
  database.transaction(() => {
    database.exec("DELETE FROM context_fts;");
    database.exec(`
      INSERT INTO context_fts (context_id, title, content, tags)
      SELECT id, title, content, tags_json FROM context_items;
    `);
  })();
}

export function openDatabase(path: string): Database.Database {
  const database = new Database(path, { timeout: 5000 });
  database.pragma("foreign_keys = ON");
  database.pragma("journal_mode = WAL");
  database.pragma("synchronous = NORMAL");
  database.pragma("busy_timeout = 5000");
  migrate(database, schemaVersion);
  ensureFtsIndex(database);
  return database;
}

export {
  migrate,
  rollback,
  getCurrentMigrationVersion,
  getAppliedMigrations,
  type Migration,
};
