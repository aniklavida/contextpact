import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ContextService,
  initializeWorkspace,
  openDatabase,
  type ActorContext,
} from "../src/index.js";

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "contextpact-backup-restore-test-"));
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

describe("Dual-store workspace backup and point-in-time restore", () => {
  const humanActor: ActorContext = {
    actor: "operator-1",
    source: "human",
    profile: "human",
  };

  it("creates a dual-store backup capturing both Markdown vault and SQLite database", () => {
    const root = createTempDir();
    initializeWorkspace(root, "Dual Store Backup Workspace");
    const service = new ContextService(root);

    // Populate Markdown knowledge items
    const rule1 = service.create(
      {
        id: "rule-dual-backup",
        type: "rule",
        title: "Dual-store backup guarantee",
        content: "Backup must cover both stores or it is not a backup.",
        status: "approved",
      },
      humanActor,
    );

    // Populate SQLite operational state
    const task1 = service.createTask(
      {
        id: "task-dual-backup",
        title: "Execute dual-store backup verification",
        description: "Verify atomic snapshot capturing markdown and sqlite",
        status: "active",
      },
      humanActor,
    );

    service.ensureAgent("agent-backup-worker", { clientKind: "cli" });
    service.claimTask({
      taskId: task1.id,
      agentId: "agent-backup-worker",
      ttlSeconds: 900,
    });

    const backupResult = service.backupWorkspace();
    service.close();

    // Verify backup result metadata
    expect(existsSync(backupResult.backupPath)).toBe(true);
    expect(backupResult.stores).toEqual(["markdown", "sqlite"]);
    expect(backupResult.itemCount).toBeGreaterThanOrEqual(1);
    expect(backupResult.taskCount).toBeGreaterThanOrEqual(1);
    expect(backupResult.auditEventCount).toBeGreaterThanOrEqual(2);

    // Verify bundle contents on disk
    const backupDb = join(backupResult.backupPath, "contextpact.db");
    const backupManifest = join(backupResult.backupPath, "pact.yaml");
    const backupKnowledge = join(backupResult.backupPath, "knowledge");
    const backupJson = join(backupResult.backupPath, "backup.json");

    expect(existsSync(backupDb)).toBe(true);
    expect(existsSync(backupManifest)).toBe(true);
    expect(existsSync(backupKnowledge)).toBe(true);
    expect(existsSync(backupJson)).toBe(true);

    const ruleFile = join(backupKnowledge, "rules", `${rule1.id}.md`);
    expect(existsSync(ruleFile)).toBe(true);
  });

  it("restores both Markdown vault and SQLite database into a clean workspace", () => {
    const sourceRoot = createTempDir();
    initializeWorkspace(sourceRoot, "Source Workspace");
    const sourceService = new ContextService(sourceRoot);

    const fact1 = sourceService.create(
      {
        id: "fact-restore-proof",
        type: "fact",
        title: "Restore verification fact",
        content: "Verified recovery across both storage engines.",
        status: "approved",
      },
      humanActor,
    );

    const task1 = sourceService.createTask(
      {
        id: "task-restore-proof",
        title: "Restore proof task",
        description: "Testing restoration of task state and lease",
      },
      humanActor,
    );

    sourceService.ensureAgent("agent-restorer", { clientKind: "cli" });
    sourceService.claimTask({
      taskId: task1.id,
      agentId: "agent-restorer",
      ttlSeconds: 600,
    });

    const originalAudits = sourceService.getAllAuditEvents();
    const backupResult = sourceService.backupWorkspace();
    sourceService.close();

    // Target clean workspace
    const targetRoot = createTempDir();
    const restoreResult = ContextService.restore(
      targetRoot,
      backupResult.backupPath,
    );

    expect(restoreResult.stores).toEqual(["markdown", "sqlite"]);
    expect(restoreResult.itemCount).toBeGreaterThanOrEqual(1);
    expect(restoreResult.taskCount).toBeGreaterThanOrEqual(1);
    expect(restoreResult.auditEventCount).toBe(originalAudits.length);

    // Open target workspace with ContextService and verify all records
    const targetService = new ContextService(targetRoot);

    // 1. Markdown vault restored
    const restoredFact = targetService.getItem(fact1.id);
    expect(restoredFact).not.toBeNull();
    expect(restoredFact?.title).toBe(fact1.title);
    expect(restoredFact?.content).toBe(fact1.content);

    // 2. SQLite operational task and lease restored
    const restoredTaskWithLease = targetService.getTaskWithLease(task1.id);
    expect(restoredTaskWithLease).not.toBeNull();
    expect(restoredTaskWithLease?.task.title).toBe(task1.title);
    expect(restoredTaskWithLease?.lease).not.toBeNull();
    expect(restoredTaskWithLease?.lease?.agentId).toBe("agent-restorer");

    // 3. SQLite audit history restored
    const restoredAudits = targetService.getAllAuditEvents();
    expect(restoredAudits).toHaveLength(originalAudits.length);

    targetService.close();

    // Verify workspace status on target
    const targetStatus = initializeWorkspace(targetRoot);
    expect(targetStatus.initialized).toBe(true);
    expect(targetStatus.databaseExists).toBe(true);
  });

  it("rejects incomplete backup missing SQLite database", () => {
    const root = createTempDir();
    initializeWorkspace(root, "Incomplete Backup Source");
    const service = new ContextService(root);
    const backupResult = service.backupWorkspace();
    service.close();

    // Deliberately remove contextpact.db from backup snapshot
    const backupDb = join(backupResult.backupPath, "contextpact.db");
    unlinkSync(backupDb);

    const targetRoot = createTempDir();
    expect(() =>
      ContextService.restore(targetRoot, backupResult.backupPath),
    ).toThrowError(/missing SQLite database 'contextpact\.db'/);
  });

  it("rejects incomplete backup missing Markdown vault", () => {
    const root = createTempDir();
    initializeWorkspace(root, "Incomplete Vault Source");
    const service = new ContextService(root);
    const backupResult = service.backupWorkspace();
    service.close();

    // Deliberately remove knowledge directory from backup snapshot
    const backupKnowledge = join(backupResult.backupPath, "knowledge");
    rmSync(backupKnowledge, { recursive: true, force: true });

    const targetRoot = createTempDir();
    expect(() =>
      ContextService.restore(targetRoot, backupResult.backupPath),
    ).toThrowError(/missing Markdown vault 'knowledge'/);
  });

  it("rejects incomplete backup missing workspace manifest", () => {
    const root = createTempDir();
    initializeWorkspace(root, "Incomplete Manifest Source");
    const service = new ContextService(root);
    const backupResult = service.backupWorkspace();
    service.close();

    // Deliberately remove pact.yaml from backup snapshot
    const backupManifest = join(backupResult.backupPath, "pact.yaml");
    unlinkSync(backupManifest);

    const targetRoot = createTempDir();
    expect(() =>
      ContextService.restore(targetRoot, backupResult.backupPath),
    ).toThrowError(/missing workspace manifest 'pact\.yaml'/);
  });
});
