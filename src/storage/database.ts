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

export function openDatabase(path: string): Database.Database {
  const database = new Database(path);
  database.pragma("foreign_keys = ON");
  database.pragma("journal_mode = WAL");
  database.pragma("synchronous = NORMAL");
  migrate(database, schemaVersion);
  return database;
}

export {
  migrate,
  rollback,
  getCurrentMigrationVersion,
  getAppliedMigrations,
  type Migration,
};
