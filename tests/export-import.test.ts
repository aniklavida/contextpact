import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ContextService,
  ImportCollisionError,
  initializeWorkspace,
  type ActorContext,
  type ContextItem,
  type TaskRecord,
  type WorkspaceExportData,
} from "../src/index.js";

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "contextpact-export-import-test-"));
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

describe("Workspace export, import and ID collision handling", () => {
  const humanActor: ActorContext = {
    actor: "operator-1",
    source: "human",
    profile: "human",
  };

  it("export → wipe → import reproduces the workspace, comparing context items, task state and audit history separately", () => {
    const root = createTempDir();
    initializeWorkspace(root, "Export Roundtrip Workspace");
    const service = new ContextService(root);

    // 1. Context items category
    const rule1 = service.create(
      {
        id: "rule-data-portability",
        type: "rule",
        title: "Data portability guarantee",
        content:
          "Export covers both Markdown vault and SQLite operational state.",
        tags: ["portability", "core"],
        status: "approved",
      },
      humanActor,
    );

    const fact1 = service.create(
      {
        id: "fact-sqlite-storage",
        type: "fact",
        title: "SQLite operational ownership",
        content: "Tasks, leases, and audit logs are canonical in SQLite.",
        tags: ["storage"],
        status: "approved",
      },
      humanActor,
    );

    const decision1 = service.create(
      {
        id: "dec-export-format",
        type: "decision",
        title: "Standard JSON export format",
        content:
          "Use human-readable, schema-validated JSON for complete portability.",
        status: "approved",
      },
      humanActor,
    );

    // 2. Task state category (tasks + leases + agents + sessions)
    const task1 = service.createTask(
      {
        id: "task-rt-verify",
        title: "Roundtrip verification task",
        description: "Verify export and import separately across categories",
        status: "active",
        scope: ["src/core", "src/storage"],
      },
      humanActor,
    );

    service.ensureAgent("agent-worker-roundtrip", { clientKind: "cli" });

    const lease1 = service.claimTask({
      taskId: task1.id,
      agentId: "agent-worker-roundtrip",
      ttlSeconds: 600,
    });

    const session1 = service.startSession({
      agentId: "agent-worker-roundtrip",
      taskId: task1.id,
    });

    // 3. Audit history category
    // Audit events are generated automatically by context item creation, task creation, lease claim, session start
    const originalAudits = service.getAllAuditEvents();
    expect(originalAudits.length).toBeGreaterThanOrEqual(3);

    // Snapshot pre-wipe data
    const preWipeItems = [rule1, fact1, decision1];
    const preWipeTask = service.getTask(task1.id)!;
    const preWipeLease = service.getTaskWithLease(task1.id)!.lease!;

    // Export workspace to file
    const exportResult = service.exportWorkspace();
    expect(existsSync(exportResult.exportPath)).toBe(true);
    service.close();

    // WIPE: delete entire workspace directory
    rmSync(root, { recursive: true, force: true });
    expect(existsSync(root)).toBe(false);

    // Re-initialize clean workspace
    initializeWorkspace(root, "Export Roundtrip Workspace");
    const restoredService = new ContextService(root);

    // Import the exported archive
    const importResult = restoredService.importWorkspace(exportResult.data);
    expect(importResult.imported.contextItems).toBe(3);
    expect(importResult.imported.tasks).toBe(1);
    expect(importResult.imported.auditEvents).toBe(originalAudits.length);

    // COMPARISON 1: Context items category compared explicitly
    const restoredRule = restoredService.getItem(rule1.id);
    const restoredFact = restoredService.getItem(fact1.id);
    const restoredDecision = restoredService.getItem(decision1.id);

    expect(
      restoredRule,
      "Category 1: Context item rule restored",
    ).not.toBeNull();
    expect(restoredRule?.title).toBe(rule1.title);
    expect(restoredRule?.content).toBe(rule1.content);
    expect(restoredRule?.status).toBe(rule1.status);
    expect(restoredRule?.tags).toEqual(rule1.tags);

    expect(
      restoredFact,
      "Category 1: Context item fact restored",
    ).not.toBeNull();
    expect(restoredFact?.title).toBe(fact1.title);
    expect(restoredFact?.content).toBe(fact1.content);

    expect(
      restoredDecision,
      "Category 1: Context item decision restored",
    ).not.toBeNull();
    expect(restoredDecision?.title).toBe(decision1.title);
    expect(restoredDecision?.content).toBe(decision1.content);

    // COMPARISON 2: Task state category compared explicitly
    const restoredTask = restoredService.getTask(task1.id);
    const restoredTaskWithLease = restoredService.getTaskWithLease(task1.id);

    expect(restoredTask, "Category 2: Task record restored").not.toBeNull();
    expect(restoredTask?.id).toBe(preWipeTask.id);
    expect(restoredTask?.title).toBe(preWipeTask.title);
    expect(restoredTask?.description).toBe(preWipeTask.description);
    expect(restoredTask?.status).toBe(preWipeTask.status);
    expect(restoredTask?.scope).toEqual(preWipeTask.scope);

    expect(
      restoredTaskWithLease?.lease,
      "Category 2: Task lease restored",
    ).not.toBeNull();
    expect(restoredTaskWithLease?.lease?.taskId).toBe(preWipeLease.taskId);
    expect(restoredTaskWithLease?.lease?.agentId).toBe(preWipeLease.agentId);

    // COMPARISON 3: Audit history category compared explicitly
    const restoredAudits = restoredService.getAllAuditEvents();
    expect(
      restoredAudits.length,
      "Category 3: Audit history count matches original",
    ).toBe(originalAudits.length);

    for (let i = 0; i < originalAudits.length; i++) {
      const orig = originalAudits[i]!;
      const rest = restoredAudits.find((a) => a.id === orig.id);
      expect(rest, `Category 3: Audit event ${orig.id} restored`).toBeDefined();
      expect(rest?.event_type).toBe(orig.event_type);
      expect(rest?.actor).toBe(orig.actor);
      expect(rest?.entity_type).toBe(orig.entity_type);
      expect(rest?.entity_id).toBe(orig.entity_id);
    }

    restoredService.close();
  });

  it("negative proof: removing context items from the export makes context comparison fail", () => {
    const root = createTempDir();
    initializeWorkspace(root, "Context Omission Test");
    const service = new ContextService(root);

    service.create(
      {
        id: "rule-sample",
        type: "rule",
        title: "Sample rule",
        content: "Rule content",
        status: "approved",
      },
      humanActor,
    );

    const exportResult = service.exportWorkspace();
    service.close();

    // Create corrupted export data with context items stripped
    const corruptedExport: WorkspaceExportData = {
      ...exportResult.data,
      contextItems: [],
    };

    // Wipe and import corrupted export
    rmSync(root, { recursive: true, force: true });
    initializeWorkspace(root, "Context Omission Test");
    const testService = new ContextService(root);
    testService.importWorkspace(corruptedExport);

    // Context item comparison fails
    const item = testService.getItem("rule-sample");
    expect(item).toBeNull();

    testService.close();
  });

  it("negative proof: removing task state from the export makes task comparison fail", () => {
    const root = createTempDir();
    initializeWorkspace(root, "Task Omission Test");
    const service = new ContextService(root);

    service.createTask(
      {
        id: "task-sample",
        title: "Sample task",
        description: "Task content",
      },
      humanActor,
    );

    const exportResult = service.exportWorkspace();
    service.close();

    // Corrupted export with tasks stripped
    const corruptedExport: WorkspaceExportData = {
      ...exportResult.data,
      operational: {
        ...exportResult.data.operational,
        tasks: [],
        taskLeases: [],
      },
    };

    rmSync(root, { recursive: true, force: true });
    initializeWorkspace(root, "Task Omission Test");
    const testService = new ContextService(root);
    testService.importWorkspace(corruptedExport);

    // Task comparison fails
    const task = testService.getTask("task-sample");
    expect(task).toBeNull();

    testService.close();
  });

  it("negative proof: removing audit history from the export makes audit comparison fail", () => {
    const root = createTempDir();
    initializeWorkspace(root, "Audit Omission Test");
    const service = new ContextService(root);

    service.create(
      {
        id: "rule-audit-proof",
        type: "rule",
        title: "Audit proof rule",
        content: "Generates audit entry",
        status: "approved",
      },
      humanActor,
    );

    const originalAudits = service.getAuditEvents();
    expect(originalAudits.length).toBeGreaterThan(0);

    const exportResult = service.exportWorkspace();
    service.close();

    // Corrupted export with audit events stripped
    const corruptedExport: WorkspaceExportData = {
      ...exportResult.data,
      operational: {
        ...exportResult.data.operational,
        auditEvents: [],
      },
    };

    rmSync(root, { recursive: true, force: true });
    initializeWorkspace(root, "Audit Omission Test");
    const testService = new ContextService(root);
    testService.importWorkspace(corruptedExport);

    // Audit comparison fails
    const restoredAudits = testService.getAuditEvents();
    expect(restoredAudits).toHaveLength(0);
    expect(restoredAudits.length).not.toBe(originalAudits.length);

    testService.close();
  });

  describe("ID collision rules", () => {
    it("default collision rule 'skip' preserves existing records and reports collisions", () => {
      const root = createTempDir();
      initializeWorkspace(root, "Collision Skip Workspace");
      const service = new ContextService(root);

      // Local existing item
      service.create(
        {
          id: "rule-collision-test",
          type: "rule",
          title: "Local canonical version",
          content: "This local text must be preserved.",
          status: "approved",
        },
        humanActor,
      );

      service.createTask(
        {
          id: "task-collision-test",
          title: "Local task title",
          description: "Local task description",
        },
        humanActor,
      );

      // Incoming data with same IDs but different contents
      const incomingExport: WorkspaceExportData = {
        formatVersion: 1,
        exportedAt: new Date().toISOString(),
        workspace: {
          id: "ws-1",
          name: "External",
          createdAt: new Date().toISOString(),
        },
        contextItems: [
          {
            id: "rule-collision-test",
            type: "rule",
            scope: "workspace",
            workspaceId: "ws-1",
            title: "Incoming conflicting title",
            content: "Incoming conflicting content that should be skipped.",
            source: "human",
            actor: "external-actor",
            status: "approved",
            importance: "normal",
            visibility: [],
            tags: [],
            supersedes: [],
            version: 99,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            expiresAt: null,
          },
        ],
        operational: {
          tasks: [
            {
              id: "task-collision-test",
              title: "Incoming conflicting task title",
              description: "Incoming description",
              status: "done",
              scope: [],
              version: 99,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
          ],
          taskLeases: [],
          agents: [],
          sessions: [],
          policies: [],
          auditEvents: [],
        },
      };

      const result = service.importWorkspace(incomingExport, {
        onCollision: "skip",
      });

      // Assert: Collisions reported
      expect(result.collisions).toHaveLength(2);
      expect(result.collisions[0]?.action).toBe("skipped");
      expect(result.collisions[1]?.action).toBe("skipped");

      // Assert: Existing local records are untouched
      const item = service.getItem("rule-collision-test");
      expect(item?.title).toBe("Local canonical version");
      expect(item?.content).toBe("This local text must be preserved.");

      const task = service.getTask("task-collision-test");
      expect(task?.title).toBe("Local task title");

      service.close();
    });

    it("collision rule 'replace' overwrites existing records with incoming records", () => {
      const root = createTempDir();
      initializeWorkspace(root, "Collision Replace Workspace");
      const service = new ContextService(root);

      service.create(
        {
          id: "rule-replace-test",
          type: "rule",
          title: "Old title",
          content: "Old content",
          status: "approved",
        },
        humanActor,
      );

      const incomingExport: WorkspaceExportData = {
        formatVersion: 1,
        exportedAt: new Date().toISOString(),
        workspace: {
          id: "ws-1",
          name: "External",
          createdAt: new Date().toISOString(),
        },
        contextItems: [
          {
            id: "rule-replace-test",
            type: "rule",
            scope: "workspace",
            workspaceId: "ws-1",
            title: "New replaced title",
            content: "New replaced content",
            source: "human",
            actor: "replacing-actor",
            status: "approved",
            importance: "normal",
            visibility: [],
            tags: ["replaced"],
            supersedes: [],
            version: 2,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            expiresAt: null,
          },
        ],
        operational: {
          tasks: [],
          taskLeases: [],
          agents: [],
          sessions: [],
          policies: [],
          auditEvents: [],
        },
      };

      const result = service.importWorkspace(incomingExport, {
        onCollision: "replace",
      });

      expect(result.collisions).toHaveLength(1);
      expect(result.collisions[0]?.action).toBe("replaced");

      const item = service.getItem("rule-replace-test");
      expect(item?.title).toBe("New replaced title");
      expect(item?.content).toBe("New replaced content");

      service.close();
    });

    it("collision rule 'error' aborts import immediately upon detecting ID collision", () => {
      const root = createTempDir();
      initializeWorkspace(root, "Collision Error Workspace");
      const service = new ContextService(root);

      service.create(
        {
          id: "rule-error-test",
          type: "rule",
          title: "Original rule",
          content: "Original content",
          status: "approved",
        },
        humanActor,
      );

      const incomingExport: WorkspaceExportData = {
        formatVersion: 1,
        exportedAt: new Date().toISOString(),
        workspace: {
          id: "ws-1",
          name: "External",
          createdAt: new Date().toISOString(),
        },
        contextItems: [
          {
            id: "rule-error-test",
            type: "rule",
            scope: "workspace",
            workspaceId: "ws-1",
            title: "Conflicting title",
            content: "Conflicting content",
            source: "human",
            actor: "actor-1",
            status: "approved",
            importance: "normal",
            visibility: [],
            tags: [],
            supersedes: [],
            version: 1,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            expiresAt: null,
          },
        ],
        operational: {
          tasks: [],
          taskLeases: [],
          agents: [],
          sessions: [],
          policies: [],
          auditEvents: [],
        },
      };

      expect(() =>
        service.importWorkspace(incomingExport, { onCollision: "error" }),
      ).toThrow(ImportCollisionError);

      // Local item untouched
      const item = service.getItem("rule-error-test");
      expect(item?.title).toBe("Original rule");

      service.close();
    });
  });
});
