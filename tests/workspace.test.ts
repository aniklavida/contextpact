import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  initializeWorkspace,
  readWorkspaceStatus,
  workspacePaths,
} from "../src/workspace/layout.js";

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
});
