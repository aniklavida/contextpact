import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  initializeWorkspace,
  readWorkspaceStatus,
  workspacePaths,
} from "../src/workspace/layout.js";
import { openDatabase } from "../src/storage/database.js";

const created: string[] = [];

afterEach(() => {
  for (const directory of created.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("workspace foundation", () => {
  it("creates a readable manifest and SQLite database", () => {
    const root = mkdtempSync(join(tmpdir(), "contextpact-test-"));
    created.push(root);

    const initialized = initializeWorkspace(root, "Research Workspace");
    const status = readWorkspaceStatus(root);
    const paths = workspacePaths(root);

    expect(initialized.initialized).toBe(true);
    expect(status.manifest?.name).toBe("Research Workspace");
    expect(status.databaseExists).toBe(true);
    expect(paths.contextRoot).toContain(".contextpact");
  });

  it("is idempotent when initialization is repeated", () => {
    const root = mkdtempSync(join(tmpdir(), "contextpact-test-"));
    created.push(root);

    const first = initializeWorkspace(root);
    const second = initializeWorkspace(root);

    expect(second.manifest?.id).toBe(first.manifest?.id);
  });

  it("normalizes paths across platforms and trailing separators", () => {
    const root = mkdtempSync(join(tmpdir(), "contextpact-test-"));
    created.push(root);

    const trailingPath = `${root}/`;
    const pathsFromTrailing = workspacePaths(trailingPath);
    const pathsStandard = workspacePaths(root);

    expect(pathsFromTrailing.root).toBe(pathsStandard.root);
    expect(pathsFromTrailing.contextRoot).toBe(pathsStandard.contextRoot);
    expect(pathsFromTrailing.database).toBe(pathsStandard.database);
  });

  it("operates SQLite with WAL journal mode and supports clean closure", () => {
    const root = mkdtempSync(join(tmpdir(), "contextpact-test-"));
    created.push(root);

    initializeWorkspace(root, "WAL Test");
    const paths = workspacePaths(root);

    const db1 = openDatabase(paths.database);
    const journalMode = db1.pragma("journal_mode") as Array<{
      journal_mode: string;
    }>;
    expect(journalMode[0]?.journal_mode).toBe("wal");

    const db2 = openDatabase(paths.database);
    const row = db2.prepare("SELECT name FROM workspace LIMIT 1").get() as {
      name: string;
    };
    expect(row.name).toBe("WAL Test");

    db1.close();
    db2.close();
  });
});
