import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ContextService,
  doctorWorkspace,
  initializeWorkspace,
  type ActorContext,
} from "../src/index.js";
import {
  readWorkspaceStatus,
  workspacePaths,
} from "../src/workspace/layout.js";

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "contextpact-obsidian-test-"));
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

describe("Obsidian and external editor compatibility", () => {
  const humanActor: ActorContext = {
    actor: "operator-1",
    source: "human",
    profile: "human",
  };

  const agentActor: ActorContext = {
    actor: "agent-writer",
    source: "agent",
    profile: "default",
  };

  it("Obsidian edits reconcile and become searchable", () => {
    const root = createTempDir();
    initializeWorkspace(root, "External Edits Workspace");
    const paths = workspacePaths(root);

    // 1. Initial item created by ContextPact
    const initialService = new ContextService(root);
    const item = initialService.create(
      {
        id: "rule-clean-arch",
        type: "rule",
        title: "Clean Architecture Principles",
        content: "Initial draft of architecture guidelines.",
        status: "approved",
      },
      humanActor,
    );
    expect(item.version).toBe(1);

    // 2. Shut down ContextPact completely - nothing about the vault requires ContextPact to be running
    initialService.close();

    // 3. Simulate user opening the vault directly in Obsidian or any plain text editor
    // Edit the body only, leaving frontmatter intact
    const filePath = join(paths.knowledge, "rules", "rule-clean-arch.md");
    expect(existsSync(filePath)).toBe(true);

    const externalContent = [
      "---",
      "id: rule-clean-arch",
      "type: rule",
      "scope: workspace",
      `workspaceId: ${item.workspaceId}`,
      "title: Clean Architecture Principles",
      "source: human",
      "actor: operator-1",
      "status: approved",
      "importance: normal",
      "visibility: []",
      "tags: []",
      "version: 1",
      `createdAt: '${item.createdAt}'`,
      `updatedAt: '${item.updatedAt}'`,
      "expiresAt: null",
      "supersedes: []",
      "---",
      "",
      "Clean architecture with explicit domain boundaries and offline resilience.",
      "",
    ].join("\n");

    writeFileSync(filePath, externalContent, "utf8");

    // 4. Start ContextPact and reindex the workspace
    const reindexedService = new ContextService(root);
    const reindexResult = reindexedService.reindex();

    expect(reindexResult.conflicts).toEqual([]);
    expect(reindexResult.updated).toContain("rule-clean-arch");

    // 5. Assert: The external edit is reconciled and becomes searchable
    const searchResults = reindexedService.search("domain boundaries");
    expect(searchResults.length).toBeGreaterThanOrEqual(1);
    expect(searchResults.some((r) => r.item.id === "rule-clean-arch")).toBe(
      true,
    );

    const reloaded = reindexedService.getItem("rule-clean-arch");
    expect(reloaded).not.toBeNull();
    expect(reloaded?.content).toBe(
      "Clean architecture with explicit domain boundaries and offline resilience.",
    );

    reindexedService.close();
  });

  it("an edit that changes a frontmatter field the product owns is adopted and searchable", () => {
    const root = createTempDir();
    initializeWorkspace(root, "Frontmatter Edit Workspace");
    const paths = workspacePaths(root);

    const service = new ContextService(root);
    const item = service.create(
      {
        id: "dec-auth-tokens",
        type: "decision",
        title: "Initial Auth Decision",
        content: "Drafting authentication approach.",
        status: "approved",
      },
      humanActor,
    );
    service.close();

    // User edits frontmatter fields that ContextPact owns (title, importance, tags)
    const filePath = join(paths.knowledge, "decisions", "dec-auth-tokens.md");
    const editedFile = [
      "---",
      "id: dec-auth-tokens",
      "type: decision",
      "scope: workspace",
      `workspaceId: ${item.workspaceId}`,
      "title: Mandatory Scoped Bearer Tokens",
      "source: human",
      "actor: operator-1",
      "status: approved",
      "importance: critical",
      "visibility: []",
      "tags:",
      "  - security",
      "  - credentials",
      "  - offline-auth",
      "version: 1",
      `createdAt: '${item.createdAt}'`,
      `updatedAt: '${item.updatedAt}'`,
      "expiresAt: null",
      "supersedes: []",
      "---",
      "",
      "Drafting authentication approach.",
      "",
    ].join("\n");

    writeFileSync(filePath, editedFile, "utf8");

    const reloadedService = new ContextService(root);
    const result = reloadedService.reindex();
    expect(result.conflicts).toEqual([]);
    expect(result.updated).toContain("dec-auth-tokens");

    // Search by newly edited title and tags
    const titleSearch = reloadedService.search("Bearer Tokens");
    expect(titleSearch.some((r) => r.item.id === "dec-auth-tokens")).toBe(true);

    const tagSearch = reloadedService.search("offline-auth");
    expect(tagSearch.some((r) => r.item.id === "dec-auth-tokens")).toBe(true);

    const fetched = reloadedService.getItem("dec-auth-tokens");
    expect(fetched?.title).toBe("Mandatory Scoped Bearer Tokens");
    expect(fetched?.importance).toBe("critical");
    expect(fetched?.tags).toEqual(["security", "credentials", "offline-auth"]);

    reloadedService.close();
  });

  it("a file added by hand with a valid id that does not yet exist in the index is adopted", () => {
    const root = createTempDir();
    initializeWorkspace(root, "Hand Added Valid Workspace");
    const wsStatus = readWorkspaceStatus(root);
    const workspaceId = wsStatus.manifest?.id ?? "workspace-default";
    const paths = workspacePaths(root);

    // Write file by hand before opening service
    const now = new Date().toISOString();
    const filePath = join(paths.knowledge, "facts", "fact-node-runtime.md");
    const content = [
      "---",
      "id: fact-node-runtime",
      "type: fact",
      "scope: workspace",
      `workspaceId: ${workspaceId}`,
      "title: Node Runtime Requirements",
      "source: human",
      "actor: operator-1",
      "status: approved",
      "importance: high",
      "visibility: []",
      "tags:",
      "  - runtime",
      "version: 1",
      `createdAt: '${now}'`,
      `updatedAt: '${now}'`,
      "expiresAt: null",
      "supersedes: []",
      "---",
      "",
      "ContextPact targets Node 22.12 and newer for deterministic local execution.",
      "",
    ].join("\n");

    writeFileSync(filePath, content, "utf8");

    const service = new ContextService(root);
    const result = service.reindex();

    expect(result.conflicts).toEqual([]);
    expect(result.indexed).toContain("fact-node-runtime");

    const item = service.getItem("fact-node-runtime");
    expect(item).not.toBeNull();
    expect(item?.title).toBe("Node Runtime Requirements");
    expect(item?.content).toContain("ContextPact targets Node 22.12");

    const search = service.search("deterministic local execution");
    expect(search.some((r) => r.item.id === "fact-node-runtime")).toBe(true);

    service.close();
  });

  it("a file added by hand with an id that collides with an existing one surfaces a conflict and leaves both untouched", () => {
    const root = createTempDir();
    initializeWorkspace(root, "ID Collision Workspace");
    const paths = workspacePaths(root);

    const service = new ContextService(root);
    service.create(
      {
        id: "goal-zero-telemetry",
        type: "goal",
        title: "Canonical Zero Telemetry Goal",
        content: "No analytics or phone-home requests.",
        status: "approved",
      },
      humanActor,
    );
    service.close();

    const existingFilePath = join(
      paths.knowledge,
      "goals",
      "goal-zero-telemetry.md",
    );
    const collidingFilePath = join(
      paths.knowledge,
      "rules",
      "colliding-rule.md",
    );

    const collidingContent = [
      "---",
      "id: goal-zero-telemetry",
      "type: rule",
      "scope: workspace",
      "workspaceId: ws-collision-test",
      "title: Conflicting Telemetry Rule",
      "source: external",
      "actor: external-user",
      "status: proposed",
      "importance: normal",
      "visibility: []",
      "tags: []",
      "version: 1",
      `createdAt: '${new Date().toISOString()}'`,
      `updatedAt: '${new Date().toISOString()}'`,
      "expiresAt: null",
      "supersedes: []",
      "---",
      "",
      "Conflicting duplicate ID content written by external editor.",
      "",
    ].join("\n");

    writeFileSync(collidingFilePath, collidingContent, "utf8");

    // Capture exact bytes before reconciliation
    const existingBytesBefore = readFileSync(existingFilePath);
    const collidingBytesBefore = readFileSync(collidingFilePath);

    const recheckService = new ContextService(root);
    const result = recheckService.reindex();

    expect(result.conflicts).toHaveLength(1);
    const conflict = result.conflicts[0]!;
    expect(conflict.type).toBe("id_collision");
    expect(conflict.id).toBe("goal-zero-telemetry");
    expect(conflict.message).toContain("Duplicate context item ID");
    expect(conflict.message).toContain("goal-zero-telemetry");

    // Byte-for-byte assertions: Neither file is rewritten, quarantined, or deleted
    const existingBytesAfter = readFileSync(existingFilePath);
    const collidingBytesAfter = readFileSync(collidingFilePath);
    expect(existingBytesAfter.equals(existingBytesBefore)).toBe(true);
    expect(collidingBytesAfter.equals(collidingBytesBefore)).toBe(true);

    // Canonical item in database remains the original one
    const loaded = recheckService.getItem("goal-zero-telemetry");
    expect(loaded?.title).toBe("Canonical Zero Telemetry Goal");

    recheckService.close();
  });

  it("malformed hand-edits produce actionable messages naming the file and problem, leaving files byte-for-byte untouched", () => {
    const root = createTempDir();
    initializeWorkspace(root, "Malformed Hand Edits Workspace");
    const paths = workspacePaths(root);

    // Case 1: Invalid YAML frontmatter (syntax error - unclosed array)
    const invalidYamlPath = join(
      paths.knowledge,
      "rules",
      "broken-yaml-syntax.md",
    );
    const invalidYamlContent = [
      "---",
      "id: rule-invalid-yaml",
      "type: rule",
      "title: [unclosed array syntax",
      "status: approved",
      "---",
      "",
      "Body text under malformed YAML frontmatter.",
      "",
    ].join("\n");
    writeFileSync(invalidYamlPath, invalidYamlContent, "utf8");
    const invalidYamlBytesBefore = readFileSync(invalidYamlPath);

    // Case 2: Valid YAML frontmatter, but missing required fields (id, type)
    const missingFieldPath = join(
      paths.knowledge,
      "decisions",
      "missing-fields.md",
    );
    const missingFieldContent = [
      "---",
      "title: Missing ID and Type Decision",
      "scope: workspace",
      "status: approved",
      "---",
      "",
      "Valid YAML mapping, but missing required product fields.",
      "",
    ].join("\n");
    writeFileSync(missingFieldPath, missingFieldContent, "utf8");
    const missingFieldBytesBefore = readFileSync(missingFieldPath);

    const service = new ContextService(root);
    const result = service.reindex();

    // Two distinct failures with distinct, actionable messages
    expect(result.conflicts).toHaveLength(2);

    const yamlConflict = result.conflicts.find((c) =>
      c.filePath.includes("broken-yaml-syntax.md"),
    );
    expect(yamlConflict).toBeDefined();
    expect(yamlConflict?.type).toBe("invalid_yaml");
    expect(yamlConflict?.message).toContain("broken-yaml-syntax.md");
    expect(yamlConflict?.message).toContain("Invalid YAML frontmatter");

    const schemaConflict = result.conflicts.find((c) =>
      c.filePath.includes("missing-fields.md"),
    );
    expect(schemaConflict).toBeDefined();
    expect(schemaConflict?.type).toBe("invalid_frontmatter");
    expect(schemaConflict?.message).toContain("missing-fields.md");
    expect(schemaConflict?.message).toContain(
      "Missing required frontmatter field",
    );

    // Byte-for-byte assertions: Files are left exactly as the user wrote them
    const invalidYamlBytesAfter = readFileSync(invalidYamlPath);
    const missingFieldBytesAfter = readFileSync(missingFieldPath);

    expect(invalidYamlBytesAfter.equals(invalidYamlBytesBefore)).toBe(true);
    expect(missingFieldBytesAfter.equals(missingFieldBytesBefore)).toBe(true);

    // Confirm neither was indexed into SQLite context items
    expect(service.getItem("rule-invalid-yaml")).toBeNull();
    expect(service.getItem("broken-yaml-syntax")).toBeNull();
    expect(service.getItem("missing-fields")).toBeNull();

    service.close();
  });

  it("a file with no frontmatter at all is an ordinary note the user keeps in the folder and is left alone", () => {
    const root = createTempDir();
    initializeWorkspace(root, "User Plain Notes Workspace");
    const paths = workspacePaths(root);

    // User creates a scratch note directly in knowledge vault without any frontmatter
    const notePath = join(paths.knowledge, "rules", "meeting-notes.md");
    const noteContent = [
      "# Architecture Discussion Notes",
      "",
      "Discussed local storage, SQLite WAL mode, and Obsidian vault interoperability.",
      "- No cloud dependency required",
      "- Plain text markdown first",
    ].join("\n");

    writeFileSync(notePath, noteContent, "utf8");
    const noteBytesBefore = readFileSync(notePath);

    const service = new ContextService(root);
    const result = service.reindex();

    // Must NOT be treated as a conflict or error
    expect(result.conflicts).toEqual([]);
    expect(result.indexed).not.toContain("meeting-notes");

    // Byte-for-byte assertion: File is untouched
    const noteBytesAfter = readFileSync(notePath);
    expect(noteBytesAfter.equals(noteBytesBefore)).toBe(true);

    // Doctor check: Workspace is considered healthy, user note is not flagged as orphaned
    const report = doctorWorkspace(root, service.getDatabase());
    expect(report.healthy).toBe(true);
    expect(
      report.issues.filter((i) => i.kind === "orphaned_file"),
    ).toHaveLength(0);

    service.close();
  });

  it("a rename outside the product preserves stable id and updates document path in index", () => {
    const root = createTempDir();
    initializeWorkspace(root, "External Rename Workspace");
    const paths = workspacePaths(root);

    const service = new ContextService(root);
    const item = service.create(
      {
        id: "dec-query-engine",
        type: "decision",
        title: "SQLite Full-Text Search Engine",
        content: "Use SQLite FTS5 for local-first search.",
        status: "approved",
      },
      humanActor,
    );
    service.close();

    const originalPath = join(
      paths.knowledge,
      "decisions",
      "dec-query-engine.md",
    );
    const renamedPath = join(
      paths.knowledge,
      "decisions",
      "my-custom-fts5-decision-note.md",
    );

    expect(existsSync(originalPath)).toBe(true);
    renameSync(originalPath, renamedPath);
    expect(existsSync(originalPath)).toBe(false);
    expect(existsSync(renamedPath)).toBe(true);

    const reloadedService = new ContextService(root);
    const result = reloadedService.reindex();

    expect(result.conflicts).toEqual([]);
    expect(result.updated).toContain("dec-query-engine");

    // The item remains accessible by its stable id
    const loaded = reloadedService.getItem("dec-query-engine");
    expect(loaded).not.toBeNull();
    expect(loaded?.title).toBe("SQLite Full-Text Search Engine");

    // The document_path in SQLite context_items has been updated to renamedPath
    const dbRow = reloadedService
      .getDatabase()
      .prepare("SELECT document_path FROM context_items WHERE id = ?")
      .get("dec-query-engine") as { document_path: string };
    expect(dbRow.document_path).toBe(renamedPath);

    // Search continues to find the item
    const search = reloadedService.search("FTS5");
    expect(search.some((r) => r.item.id === "dec-query-engine")).toBe(true);

    // Doctor reports no broken or orphaned file paths
    const doctorReport = doctorWorkspace(root, reloadedService.getDatabase());
    expect(doctorReport.healthy).toBe(true);
    expect(
      doctorReport.issues.filter((i) => i.kind === "orphaned_file"),
    ).toHaveLength(0);

    reloadedService.close();
  });

  it("a hand-edited item conflicting with a newer indexed version is surfaced as a conflict with both sides identified", () => {
    const root = createTempDir();
    initializeWorkspace(root, "Stale Hand Edit Workspace");
    const paths = workspacePaths(root);

    // 1. ContextPact creates and advances item to version 2 (proposed then approved)
    const service = new ContextService(root);
    const created = service.create(
      {
        id: "rule-mutation-versioning",
        type: "rule",
        title: "Mutation Versioning Rule",
        content: "Every mutation increments version.",
      },
      agentActor,
    );
    expect(created.version).toBe(1);

    const approved = service.approve(created.id, humanActor);
    expect(approved.version).toBe(2);

    service.close();

    // 2. User outside ContextPact hand-edits the file, but their file was an older checkout or draft at version 1
    const filePath = join(
      paths.knowledge,
      "rules",
      "rule-mutation-versioning.md",
    );
    const staleContent = [
      "---",
      "id: rule-mutation-versioning",
      "type: rule",
      "scope: workspace",
      `workspaceId: ${approved.workspaceId}`,
      "title: Stale Hand Edit Title",
      "source: external",
      "actor: external-user",
      "status: proposed",
      "importance: normal",
      "visibility: []",
      "tags: []",
      "version: 1",
      `createdAt: '${approved.createdAt}'`,
      `updatedAt: '${approved.updatedAt}'`,
      "expiresAt: null",
      "supersedes: []",
      "---",
      "",
      "External edit based on obsolete version 1 content.",
      "",
    ].join("\n");

    writeFileSync(filePath, staleContent, "utf8");
    const diskBytesBefore = readFileSync(filePath);

    // 3. Reconcile
    const reloadedService = new ContextService(root);
    const result = reloadedService.reconcile();

    // 4. Assert: Surfaced as a conflict with both sides identified
    expect(result.conflicts).toHaveLength(1);
    const conflict = result.conflicts[0]!;
    expect(conflict.type).toBe("stale_version");
    expect(conflict.id).toBe("rule-mutation-versioning");
    expect(conflict.filePath).toBe(filePath);
    expect(conflict.diskVersion).toBe(1);
    expect(conflict.dbVersion).toBe(2);
    expect(conflict.message).toContain("stale version 1");
    expect(conflict.message).toContain("database index is at version 2");

    // 5. Assert: Never silently resolved by whichever side wrote last
    // The database index retains its version 2 content
    const dbItem = reloadedService.getItem("rule-mutation-versioning");
    expect(dbItem?.version).toBe(2);
    expect(dbItem?.title).toBe("Mutation Versioning Rule");

    // The disk file remains untouched byte-for-byte
    const diskBytesAfter = readFileSync(filePath);
    expect(diskBytesAfter.equals(diskBytesBefore)).toBe(true);

    reloadedService.close();
  });
});
