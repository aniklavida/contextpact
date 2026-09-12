import Database from "better-sqlite3";

import { schemaSql, schemaVersion } from "./schema.js";

export function openDatabase(path: string): Database.Database {
  const database = new Database(path);
  database.pragma("foreign_keys = ON");
  database.pragma("journal_mode = WAL");
  database.pragma("synchronous = NORMAL");
  database.exec(schemaSql);
  database
    .prepare(
      "INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)",
    )
    .run(schemaVersion, new Date().toISOString());
  return database;
}
