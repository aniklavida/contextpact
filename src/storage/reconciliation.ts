import { createHash } from "node:crypto";
import {
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { basename, join } from "node:path";

import type Database from "better-sqlite3";

import { type ContextItem } from "../domain/context.js";
import { readWorkspaceStatus, workspacePaths } from "../workspace/layout.js";
import { isDatabaseHealthy, openDatabase } from "./database.js";
import { parseMarkdownKnowledgeItem } from "./markdown.js";

export interface ReconciliationConflict {
  id: string;
  type:
    | "stale_version"
    | "ambiguous_conflict"
    | "id_collision"
    | "unparseable_file";
  filePath: string;
  diskVersion?: number | undefined;
  dbVersion?: number | undefined;
  message: string;
}

export interface ReconciliationResult {
  indexed: string[];
  updated: string[];
  unchanged: string[];
  deleted: string[];
  conflicts: ReconciliationConflict[];
}

export interface ReindexResult extends ReconciliationResult {}

export interface ReconcileOptions {
  cleanDeleted?: boolean | undefined;
}

export interface ReindexOptions extends ReconcileOptions {}

export interface RecoveryResult {
  recovered: boolean;
  corruptedBackupPath?: string | undefined;
  reindexResult: ReindexResult;
}

export function computeDocumentHash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function findMarkdownFiles(dir: string): string[] {
  if (!existsSync(dir)) {
    return [];
  }
  const entries = readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...findMarkdownFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(fullPath);
    }
  }
  return files;
}

export function getWorkspaceMarkdownFiles(workspaceRoot: string): string[] {
  const paths = workspacePaths(workspaceRoot);
  const knowledgeFiles = findMarkdownFiles(paths.knowledge);
  const handoffFiles = findMarkdownFiles(paths.handoffs);
  return Array.from(new Set([...knowledgeFiles, ...handoffFiles]));
}

export function reconcileWorkspace(
  workspaceRoot: string,
  database?: Database.Database,
  options?: ReconcileOptions,
): ReconciliationResult {
  const paths = workspacePaths(workspaceRoot);
  const ownsDatabase = !database;
  const db = database ?? openDatabase(paths.database);

  try {
    const markdownFiles = getWorkspaceMarkdownFiles(workspaceRoot);
    const seenIds = new Map<string, string>();
    const parsedFiles: Array<{
      filePath: string;
      item: ContextItem;
      diskHash: string;
    }> = [];
    const conflicts: ReconciliationConflict[] = [];

    for (const filePath of markdownFiles) {
      let raw: string;
      try {
        raw = readFileSync(filePath, "utf8");
      } catch (err) {
        conflicts.push({
          id: basename(filePath, ".md"),
          type: "unparseable_file",
          filePath,
          message: `Cannot read Markdown file '${filePath}': ${(err as Error).message}`,
        });
        continue;
      }

      const diskHash = computeDocumentHash(raw);
      let item: ContextItem;
      try {
        item = parseMarkdownKnowledgeItem(raw);
      } catch (err) {
        conflicts.push({
          id: basename(filePath, ".md"),
          type: "unparseable_file",
          filePath,
          message: `Cannot parse Markdown knowledge item in '${filePath}': ${(err as Error).message}`,
        });
        continue;
      }

      const existingFile = seenIds.get(item.id);
      if (existingFile) {
        conflicts.push({
          id: item.id,
          type: "id_collision",
          filePath,
          message: `Conflict: Duplicate context item ID '${item.id}' in '${filePath}' (already seen in '${existingFile}').`,
        });
        continue;
      }

      seenIds.set(item.id, filePath);
      parsedFiles.push({ filePath, item, diskHash });
    }

    const indexed: string[] = [];
    const updated: string[] = [];
    const unchanged: string[] = [];

    const selectItemStmt = db.prepare(
      "SELECT id, version, document_path, document_hash FROM context_items WHERE id = ?",
    );
    const insertItemStmt = db.prepare(`
      INSERT INTO context_items (
        id, type, scope, workspace_id, title, content, source, actor, status,
        importance, visibility_json, tags_json, document_path, document_hash,
        version, created_at, updated_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const updateItemStmt = db.prepare(`
      UPDATE context_items SET
        type = ?, scope = ?, workspace_id = ?, title = ?, content = ?,
        source = ?, actor = ?, status = ?, importance = ?,
        visibility_json = ?, tags_json = ?, document_path = ?,
        document_hash = ?, version = ?, created_at = ?, updated_at = ?,
        expires_at = ?
      WHERE id = ?
    `);

    const deleteFtsStmt = db.prepare(
      "DELETE FROM context_fts WHERE context_id = ?",
    );
    const insertFtsStmt = db.prepare(
      "INSERT INTO context_fts (context_id, title, content, tags) VALUES (?, ?, ?, ?)",
    );

    const deleteSupersedesStmt = db.prepare(
      "DELETE FROM context_supersedes WHERE context_id = ?",
    );
    const insertSupersedesStmt = db.prepare(
      "INSERT OR IGNORE INTO context_supersedes (context_id, superseded_id) VALUES (?, ?)",
    );

    const reconcileTx = db.transaction(() => {
      for (const { filePath, item, diskHash } of parsedFiles) {
        const dbRow = selectItemStmt.get(item.id) as
          | {
              id: string;
              version: number;
              document_path: string | null;
              document_hash: string | null;
            }
          | undefined;

        if (!dbRow) {
          // New file not in database -> index it
          insertItemStmt.run(
            item.id,
            item.type,
            item.scope,
            item.workspaceId,
            item.title,
            item.content,
            item.source,
            item.actor,
            item.status,
            item.importance,
            JSON.stringify(item.visibility ?? []),
            JSON.stringify(item.tags ?? []),
            filePath,
            diskHash,
            item.version,
            item.createdAt,
            item.updatedAt,
            item.expiresAt ?? null,
          );

          try {
            deleteFtsStmt.run(item.id);
            insertFtsStmt.run(
              item.id,
              item.title,
              item.content,
              (item.tags ?? []).join(" "),
            );
          } catch {
            // Ignore FTS error if virtual table index is unavailable
          }

          if (item.supersedes && item.supersedes.length > 0) {
            deleteSupersedesStmt.run(item.id);
            for (const supId of item.supersedes) {
              insertSupersedesStmt.run(item.id, supId);
            }
          }

          indexed.push(item.id);
        } else {
          // Row exists in database
          if (dbRow.document_hash === diskHash) {
            unchanged.push(item.id);
          } else {
            // Document hash changed or was missing
            if (item.version < dbRow.version) {
              // Stale version conflict - file on disk carries an older version
              conflicts.push({
                id: item.id,
                type: "stale_version",
                filePath,
                diskVersion: item.version,
                dbVersion: dbRow.version,
                message: `Conflict: Markdown file '${filePath}' carries stale version ${item.version}, but database index is at version ${dbRow.version}. File will not overwrite database.`,
              });
            } else {
              // Forward version or updated content
              updateItemStmt.run(
                item.type,
                item.scope,
                item.workspaceId,
                item.title,
                item.content,
                item.source,
                item.actor,
                item.status,
                item.importance,
                JSON.stringify(item.visibility ?? []),
                JSON.stringify(item.tags ?? []),
                filePath,
                diskHash,
                item.version,
                item.createdAt,
                item.updatedAt,
                item.expiresAt ?? null,
                item.id,
              );

              try {
                deleteFtsStmt.run(item.id);
                insertFtsStmt.run(
                  item.id,
                  item.title,
                  item.content,
                  (item.tags ?? []).join(" "),
                );
              } catch {
                // Ignore FTS error
              }

              if (item.supersedes && item.supersedes.length > 0) {
                deleteSupersedesStmt.run(item.id);
                for (const supId of item.supersedes) {
                  insertSupersedesStmt.run(item.id, supId);
                }
              }

              updated.push(item.id);
            }
          }
        }
      }
    });

    reconcileTx();

    const deleted: string[] = [];
    if (options?.cleanDeleted !== false) {
      const allIndexedRows = db
        .prepare("SELECT id, document_path FROM context_items")
        .all() as Array<{ id: string; document_path: string | null }>;

      const cleanDeletedTx = db.transaction(() => {
        for (const row of allIndexedRows) {
          if (
            row.document_path &&
            !seenIds.has(row.id) &&
            !existsSync(row.document_path)
          ) {
            db.prepare("DELETE FROM context_items WHERE id = ?").run(row.id);
            try {
              deleteFtsStmt.run(row.id);
            } catch {
              // Ignore FTS error
            }
            deleteSupersedesStmt.run(row.id);
            deleted.push(row.id);
          }
        }
      });
      cleanDeletedTx();
    }

    return {
      indexed,
      updated,
      unchanged,
      deleted,
      conflicts,
    };
  } finally {
    if (ownsDatabase) {
      db.close();
    }
  }
}

export function reindexWorkspace(
  workspaceRoot: string,
  database?: Database.Database,
  options?: ReindexOptions,
): ReindexResult {
  return reconcileWorkspace(workspaceRoot, database, {
    cleanDeleted: true,
    ...options,
  });
}

export function recoverDatabase(workspaceRoot: string): RecoveryResult {
  const paths = workspacePaths(workspaceRoot);
  let corruptedBackupPath: string | undefined;

  if (existsSync(paths.database)) {
    const healthy = isDatabaseHealthy(paths.database);
    if (!healthy) {
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      corruptedBackupPath = `${paths.database}.corrupt.${timestamp}`;
      renameSync(paths.database, corruptedBackupPath);
      if (existsSync(`${paths.database}-wal`)) {
        unlinkSync(`${paths.database}-wal`);
      }
      if (existsSync(`${paths.database}-shm`)) {
        unlinkSync(`${paths.database}-shm`);
      }
    }
  }

  const status = readWorkspaceStatus(workspaceRoot);
  const db = openDatabase(paths.database);
  if (status.manifest) {
    db.prepare(
      "INSERT OR IGNORE INTO workspace(id, name, created_at) VALUES (?, ?, ?)",
    ).run(status.manifest.id, status.manifest.name, status.manifest.createdAt);
  }

  const reindexResult = reindexWorkspace(workspaceRoot, db, {
    cleanDeleted: true,
  });
  db.close();

  return {
    recovered: true,
    corruptedBackupPath,
    reindexResult,
  };
}
