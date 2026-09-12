import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

import YAML from "yaml";

import {
  workspaceManifestSchema,
  type WorkspaceManifest,
} from "../domain/workspace.js";
import { openDatabase } from "../storage/database.js";

const knowledgeFolders = [
  "rules",
  "preferences",
  "facts",
  "goals",
  "sources",
  "decisions",
] as const;

export interface WorkspacePaths {
  root: string;
  contextRoot: string;
  manifest: string;
  database: string;
  knowledge: string;
  handoffs: string;
  exports: string;
}

export interface WorkspaceStatus {
  initialized: boolean;
  root: string;
  manifest: WorkspaceManifest | null;
  databaseExists: boolean;
}

export function workspacePaths(inputRoot = process.cwd()): WorkspacePaths {
  const root = resolve(inputRoot);
  const contextRoot = join(root, ".contextpact");
  return {
    root,
    contextRoot,
    manifest: join(contextRoot, "pact.yaml"),
    database: join(contextRoot, "contextpact.db"),
    knowledge: join(contextRoot, "knowledge"),
    handoffs: join(contextRoot, "handoffs"),
    exports: join(contextRoot, "exports"),
  };
}

export function initializeWorkspace(
  inputRoot = process.cwd(),
  inputName?: string,
): WorkspaceStatus {
  const paths = workspacePaths(inputRoot);
  if (existsSync(paths.manifest)) {
    return readWorkspaceStatus(paths.root);
  }

  mkdirSync(paths.root, { recursive: true });
  mkdirSync(paths.knowledge, { recursive: true });
  mkdirSync(paths.handoffs, { recursive: true });
  mkdirSync(paths.exports, { recursive: true });
  for (const folder of knowledgeFolders) {
    mkdirSync(join(paths.knowledge, folder), { recursive: true });
  }

  const manifest: WorkspaceManifest = {
    schemaVersion: 1,
    id: randomUUID(),
    name: inputName?.trim() || basename(paths.root),
    createdAt: new Date().toISOString(),
    storage: { knowledge: "markdown", operations: "sqlite", search: "fts5" },
  };
  writeFileSync(paths.manifest, YAML.stringify(manifest), {
    encoding: "utf8",
    flag: "wx",
  });

  const database = openDatabase(paths.database);
  database
    .prepare(
      "INSERT OR IGNORE INTO workspace(id, name, created_at) VALUES (?, ?, ?)",
    )
    .run(manifest.id, manifest.name, manifest.createdAt);
  database.close();

  return readWorkspaceStatus(paths.root);
}

export function readWorkspaceStatus(
  inputRoot = process.cwd(),
): WorkspaceStatus {
  const paths = workspacePaths(inputRoot);
  if (!existsSync(paths.manifest)) {
    return {
      initialized: false,
      root: paths.root,
      manifest: null,
      databaseExists: false,
    };
  }
  const raw = YAML.parse(readFileSync(paths.manifest, "utf8"));
  const manifest = workspaceManifestSchema.parse(raw);
  return {
    initialized: true,
    root: paths.root,
    manifest,
    databaseExists: existsSync(paths.database),
  };
}
