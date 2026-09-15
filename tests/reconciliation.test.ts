import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ContextService,
  initializeWorkspace,
  readMarkdownKnowledgeItem,
  recoverDatabase,
  reindexWorkspace,
  writeMarkdownKnowledgeItem,
  type ActorContext,
  type ContextItem,
} from "../src/index.js";
import { workspacePaths } from "../src/workspace/layout.js";

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "contextpact-reconcile-test-"));
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

describe("Reconciliation, reindexing and database recovery", () => {
  const humanActor: ActorContext = {
    actor: "anik",
    source: "human",
    profile: "human",
  };

  const agentActor: ActorContext = {
    actor: "agent-builder",
    source: "agent",
    profile: "default",
  };

  it("deleting the database file and reindexing reproduces every context row from Markdown - and loses leases and audit history, which the test asserts in as many words", () => {
    const root = createTempDir();
    initializeWorkspace(root, "Rebuild Test Workspace");
    const service = new ContextService(root);

    // 1. Create durable context items in the workspace (saved to Markdown and SQLite index)
    const rule1 = service.create(
      {
        id: "rule-clean-arch",
        type: "rule",
        title: "Clean architecture boundary",
        content:
          "Markdown owns durable knowledge; SQLite owns operational state.",
        status: "approved",
      },
      humanActor,
    );

    const decision1 = service.create(
      {
        id: "dec-sqlite-wal",
        type: "decision",
        title: "SQLite WAL mode",
        content: "Use WAL mode for atomic operational state.",
        status: "approved",
      },
      humanActor,
    );

    // 2. Create operational state that lives ONLY in SQLite (task leases and audit events)
    const db = service.getDatabase();
    db.prepare(
      "INSERT INTO tasks (id, title, description, status, scope_json, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      "job_lease_proof",
      "Lease loss verification task",
      "Operational lease data",
      "active",
      "[]",
      1,
      new Date().toISOString(),
      new Date().toISOString(),
    );

    db.prepare(
      "INSERT INTO agents (id, display_name, client_kind, profile, last_seen_at, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(
      "agent-worker-1",
      "Worker Agent 1",
      "test-cli",
      "default",
      new Date().toISOString(),
      new Date().toISOString(),
    );

    db.prepare(
      "INSERT INTO task_leases (task_id, agent_id, acquired_at, heartbeat_at, expires_at, version) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(
      "job_lease_proof",
      "agent-worker-1",
      new Date().toISOString(),
      new Date().toISOString(),
      new Date().toISOString(),
      1,
    );

    // Verify initial operational state exists before database deletion
    const initialLeases = db
      .prepare("SELECT COUNT(*) as count FROM task_leases")
      .get() as { count: number };
    expect(initialLeases.count).toBe(1);

    const initialAudits = service.getAuditEvents();
    expect(initialAudits.length).toBeGreaterThanOrEqual(2);

    service.close();

    // 3. Delete the SQLite database file and auxiliary files
    const paths = workspacePaths(root);
    unlinkSync(paths.database);
    if (existsSync(`${paths.database}-wal`)) {
      unlinkSync(`${paths.database}-wal`);
    }
    if (existsSync(`${paths.database}-shm`)) {
      unlinkSync(`${paths.database}-shm`);
    }
    expect(existsSync(paths.database)).toBe(false);

    // 4. Reindex from Markdown into a fresh database
    const reindexedService = new ContextService(root);
    const reindexResult = reindexedService.reindex();

    expect(reindexResult.conflicts).toEqual([]);
    expect(reindexResult.indexed).toContain(rule1.id);
    expect(reindexResult.indexed).toContain(decision1.id);

    // 5. Assert: Every context row is reproduced faithfully from Markdown
    const loadedRule = reindexedService.getItem(rule1.id);
    expect(loadedRule).not.toBeNull();
    expect(loadedRule?.title).toBe(rule1.title);
    expect(loadedRule?.content).toBe(rule1.content);
    expect(loadedRule?.status).toBe("approved");

    const loadedDecision = reindexedService.getItem(decision1.id);
    expect(loadedDecision).not.toBeNull();
    expect(loadedDecision?.title).toBe(decision1.title);
    expect(loadedDecision?.content).toBe(decision1.content);

    // 6. Plain-words assertion:
    // Deleting the database file and reindexing reproduces every context row from Markdown - and loses leases and audit history.
    // The search index is rebuildable and disposable, but operational coordination state is not:
    // task leases and audit events cannot be recovered from Markdown and are permanently lost.
    const reindexedDb = reindexedService.getDatabase();

    const leasesAfterReindex = reindexedDb
      .prepare("SELECT COUNT(*) as count FROM task_leases")
      .get() as { count: number };
    expect(
      leasesAfterReindex.count,
      "Deleting the database file and reindexing reproduces every context row from Markdown and loses task leases",
    ).toBe(0);

    const auditsAfterReindex = reindexedDb
      .prepare("SELECT COUNT(*) as count FROM audit_events")
      .get() as { count: number };
    expect(
      auditsAfterReindex.count,
      "Deleting the database file and reindexing reproduces every context row from Markdown and loses audit history",
    ).toBe(0);

    reindexedService.close();
  });

  it("a file edited outside ContextPact carrying a stale version is reported as a conflict, not overwritten", () => {
    const root = createTempDir();
    initializeWorkspace(root, "Conflict Test Workspace");
    const service = new ContextService(root);

    // 1. Create and approve an item inside ContextPact, giving it version 2
    const created = service.create(
      {
        id: "dec-cache-layer",
        type: "decision",
        title: "Original Cache Decision",
        content: "In-memory caching is enabled.",
      },
      agentActor,
    );
    expect(created.status).toBe("proposed");
    expect(created.version).toBe(1);

    const approved = service.approve(created.id, humanActor);
    expect(approved.status).toBe("approved");
    expect(approved.version).toBe(2);

    // Verify DB and disk are at version 2
    const dbItemBefore = service.getItem("dec-cache-layer");
    expect(dbItemBefore?.version).toBe(2);
    expect(dbItemBefore?.content).toBe("In-memory caching is enabled.");

    // 2. Simulate an external editor (e.g., Obsidian or external tool) editing the Markdown file
    // carrying a STALE version (version 1), which conflicts with the current database version 2
    const paths = workspacePaths(root);
    const filePath = join(paths.knowledge, "decisions", "dec-cache-layer.md");
    const staleExternalItem: ContextItem = {
      ...approved,
      version: 1, // Stale version!
      title: "Stale External Edit Title",
      content:
        "Stale external content that should never overwrite the database.",
    };
    writeMarkdownKnowledgeItem(filePath, staleExternalItem);

    // Verify file on disk now has stale version 1
    const fileOnDisk = readMarkdownKnowledgeItem(filePath);
    expect(fileOnDisk.version).toBe(1);

    // 3. Run reconciliation
    const result = service.reconcile();

    // 4. Assert: Conflict is detected and surfaced
    expect(result.conflicts).toHaveLength(1);
    const conflict = result.conflicts[0]!;
    expect(conflict.id).toBe("dec-cache-layer");
    expect(conflict.type).toBe("stale_version");
    expect(conflict.diskVersion).toBe(1);
    expect(conflict.dbVersion).toBe(2);
    expect(conflict.message).toContain("carries stale version 1");
    expect(conflict.message).toContain("database index is at version 2");

    // 5. Assert: The database row was NOT overwritten
    const dbItemAfter = service.getItem("dec-cache-layer");
    expect(dbItemAfter?.version).toBe(2);
    expect(dbItemAfter?.title).toBe("Original Cache Decision");
    expect(dbItemAfter?.content).toBe("In-memory caching is enabled.");

    const rowInSqlite = service
      .getDatabase()
      .prepare("SELECT version, title, content FROM context_items WHERE id = ?")
      .get("dec-cache-layer") as {
      version: number;
      title: string;
      content: string;
    };
    expect(rowInSqlite.version).toBe(2);
    expect(rowInSqlite.title).toBe("Original Cache Decision");
    expect(rowInSqlite.content).toBe("In-memory caching is enabled.");

    service.close();
  });

  it("reindexing from an empty database populates all context rows and search indexes", () => {
    const root = createTempDir();
    initializeWorkspace(root, "Empty DB Reindex Workspace");

    // Clear all context_items in DB to simulate an empty index
    const service = new ContextService(root);
    const db = service.getDatabase();
    db.prepare("DELETE FROM context_items").run();
    db.prepare("DELETE FROM context_fts").run();

    // Write three markdown items directly to disk
    const paths = workspacePaths(root);
    const rulePath = join(paths.knowledge, "rules", "rule-ts-strict.md");
    const factPath = join(paths.knowledge, "facts", "fact-node-version.md");
    const goalPath = join(paths.knowledge, "goals", "goal-offline-first.md");

    const now = new Date().toISOString();
    writeMarkdownKnowledgeItem(rulePath, {
      id: "rule-ts-strict",
      type: "rule",
      scope: "workspace",
      workspaceId: "ws-test",
      title: "Strict TypeScript",
      content: "Enable exactOptionalPropertyTypes and strict mode.",
      source: "spec",
      actor: "anik",
      status: "approved",
      importance: "high",
      visibility: [],
      tags: ["typescript", "compiler"],
      version: 1,
      createdAt: now,
      updatedAt: now,
      expiresAt: null,
      supersedes: [],
    });

    writeMarkdownKnowledgeItem(factPath, {
      id: "fact-node-version",
      type: "fact",
      scope: "workspace",
      workspaceId: "ws-test",
      title: "Minimum Node Runtime",
      content: "ContextPact requires Node.js 22.12 or newer.",
      source: "spec",
      actor: "anik",
      status: "approved",
      importance: "critical",
      visibility: [],
      tags: ["runtime", "node"],
      version: 1,
      createdAt: now,
      updatedAt: now,
      expiresAt: null,
      supersedes: [],
    });

    writeMarkdownKnowledgeItem(goalPath, {
      id: "goal-offline-first",
      type: "goal",
      scope: "workspace",
      workspaceId: "ws-test",
      title: "Local First Resilience",
      content:
        "Full functionality without internet or third-party cloud services.",
      source: "spec",
      actor: "anik",
      status: "approved",
      importance: "high",
      visibility: [],
      tags: ["offline", "architecture"],
      version: 1,
      createdAt: now,
      updatedAt: now,
      expiresAt: null,
      supersedes: [],
    });

    // Reindex
    const reindexResult = service.reindex();

    expect(reindexResult.conflicts).toEqual([]);
    expect(reindexResult.indexed).toHaveLength(3);
    expect(reindexResult.indexed).toContain("rule-ts-strict");
    expect(reindexResult.indexed).toContain("fact-node-version");
    expect(reindexResult.indexed).toContain("goal-offline-first");

    // Check all three items are in database
    expect(service.getItem("rule-ts-strict")?.title).toBe("Strict TypeScript");
    expect(service.getItem("fact-node-version")?.title).toBe(
      "Minimum Node Runtime",
    );
    expect(service.getItem("goal-offline-first")?.title).toBe(
      "Local First Resilience",
    );

    // Check FTS index is populated
    const ftsRows = db
      .prepare(
        "SELECT context_id FROM context_fts WHERE context_fts MATCH 'offline'",
      )
      .all() as Array<{ context_id: string }>;
    expect(ftsRows.some((r) => r.context_id === "goal-offline-first")).toBe(
      true,
    );

    service.close();
  });

  it("reindexing after files changed underneath updates the SQLite index and search tables", () => {
    const root = createTempDir();
    initializeWorkspace(root, "Files Changed Workspace");
    const service = new ContextService(root);

    // Create item
    const item = service.create(
      {
        id: "dec-logging-lib",
        type: "decision",
        title: "Initial Logging Framework",
        content: "Use basic console logging.",
        status: "approved",
      },
      humanActor,
    );
    expect(item.version).toBe(1);

    // Modify file underneath outside ContextPact
    const paths = workspacePaths(root);
    const filePath = join(paths.knowledge, "decisions", "dec-logging-lib.md");
    const updatedDiskItem: ContextItem = {
      ...item,
      version: 2,
      title: "Structured JSON Logging Framework",
      content: "Use structured NDJSON log formatter for auditability.",
      updatedAt: new Date().toISOString(),
    };
    writeMarkdownKnowledgeItem(filePath, updatedDiskItem);

    // Reindex
    const result = service.reindex();

    expect(result.conflicts).toEqual([]);
    expect(result.updated).toContain("dec-logging-lib");

    // Verify SQLite index has the updated fields
    const reloaded = service.getItem("dec-logging-lib");
    expect(reloaded?.version).toBe(2);
    expect(reloaded?.title).toBe("Structured JSON Logging Framework");
    expect(reloaded?.content).toBe(
      "Use structured NDJSON log formatter for auditability.",
    );

    // Verify FTS search finds the updated content
    const db = service.getDatabase();
    const ftsSearch = db
      .prepare(
        "SELECT context_id FROM context_fts WHERE context_fts MATCH 'NDJSON'",
      )
      .all() as Array<{ context_id: string }>;
    expect(ftsSearch.some((r) => r.context_id === "dec-logging-lib")).toBe(
      true,
    );

    service.close();
  });

  it("recovering a corrupt database by rebuilding the index from Markdown", () => {
    const root = createTempDir();
    initializeWorkspace(root, "Corruption Recovery Workspace");
    const service = new ContextService(root);

    // Create knowledge items
    service.create(
      {
        id: "fact-durable-survives",
        type: "fact",
        title: "Durable Knowledge Survives Corruption",
        content:
          "Files in Markdown vault survive even when SQLite database is corrupted.",
        status: "approved",
      },
      humanActor,
    );

    service.close();

    // Intentionally corrupt the database file
    const paths = workspacePaths(root);
    writeFileSync(
      paths.database,
      "CORRUPTED_MALFORMED_GARBAGE_BYTES_THAT_BREAK_SQLITE",
    );

    // Call recoverDatabase
    const recoveryResult = recoverDatabase(root);
    expect(recoveryResult.recovered).toBe(true);
    expect(recoveryResult.corruptedBackupPath).toBeDefined();
    expect(existsSync(recoveryResult.corruptedBackupPath!)).toBe(true);
    expect(recoveryResult.reindexResult.indexed).toContain(
      "fact-durable-survives",
    );

    // Open recovered database and verify
    const recoveredService = new ContextService(root);
    const recoveredItem = recoveredService.getItem("fact-durable-survives");
    expect(recoveredItem).not.toBeNull();
    expect(recoveredItem?.title).toBe("Durable Knowledge Survives Corruption");
    expect(recoveredItem?.content).toBe(
      "Files in Markdown vault survive even when SQLite database is corrupted.",
    );

    // Verify FTS search works on recovered database
    const db = recoveredService.getDatabase();
    const fts = db
      .prepare(
        "SELECT context_id FROM context_fts WHERE context_fts MATCH 'vault'",
      )
      .all() as Array<{ context_id: string }>;
    expect(fts.some((r) => r.context_id === "fact-durable-survives")).toBe(
      true,
    );

    recoveredService.close();
  });

  it("surfaces duplicate ID collisions across multiple files as an ambiguous conflict", () => {
    const root = createTempDir();
    initializeWorkspace(root, "Duplicate Collision Workspace");
    const paths = workspacePaths(root);

    const now = new Date().toISOString();
    // Two files with the exact same context item ID 'collision-01' in different folders
    writeMarkdownKnowledgeItem(join(paths.knowledge, "rules", "rule-one.md"), {
      id: "collision-01",
      type: "rule",
      scope: "workspace",
      workspaceId: "ws-test",
      title: "First Duplicate",
      content: "Content 1",
      source: "spec",
      actor: "anik",
      status: "approved",
      importance: "normal",
      visibility: [],
      tags: [],
      version: 1,
      createdAt: now,
      updatedAt: now,
      expiresAt: null,
      supersedes: [],
    });

    writeMarkdownKnowledgeItem(join(paths.knowledge, "facts", "fact-two.md"), {
      id: "collision-01",
      type: "fact",
      scope: "workspace",
      workspaceId: "ws-test",
      title: "Second Duplicate",
      content: "Content 2",
      source: "spec",
      actor: "anik",
      status: "approved",
      importance: "normal",
      visibility: [],
      tags: [],
      version: 1,
      createdAt: now,
      updatedAt: now,
      expiresAt: null,
      supersedes: [],
    });

    const service = new ContextService(root);
    const result = service.reconcile();

    // Conflict surfaced
    expect(result.conflicts.some((c) => c.id === "collision-01")).toBe(true);
    const conflict = result.conflicts.find((c) => c.id === "collision-01")!;
    expect(conflict.type).toBe("id_collision");
    expect(conflict.message).toContain(
      "Duplicate context item ID 'collision-01'",
    );

    service.close();
  });
});
