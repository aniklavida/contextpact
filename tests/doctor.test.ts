import {
  existsSync,
  mkdirSync,
  mkdtempSync,
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
  reindexWorkspace,
  type ActorContext,
} from "../src/index.js";

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "contextpact-doctor-test-"));
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

describe("Workspace doctor diagnostics and repair recommendations", () => {
  const humanActor: ActorContext = {
    actor: "operator-1",
    source: "human",
    profile: "human",
  };

  it("doctor detects a deliberately damaged workspace of kind 'invalid workspace' and names the repair", () => {
    const root = createTempDir();
    // Case 1: uninitialized directory (missing .contextpact / manifest)
    const reportUninit = ContextService.doctor(root);
    expect(reportUninit.healthy).toBe(false);
    const uninitIssue = reportUninit.issues.find(
      (i) => i.kind === "invalid_workspace",
    );
    expect(uninitIssue).toBeDefined();
    expect(uninitIssue?.severity).toBe("error");
    expect(uninitIssue?.repair).toContain("contextpact init");

    // Case 2: corrupted manifest
    const corruptRoot = createTempDir();
    initializeWorkspace(corruptRoot, "Invalid Manifest Workspace");
    const manifestPath = join(corruptRoot, ".contextpact", "pact.yaml");
    writeFileSync(manifestPath, "invalid: : yaml [unbalanced", "utf8");

    const reportCorruptManifest = ContextService.doctor(corruptRoot);
    expect(reportCorruptManifest.healthy).toBe(false);
    const corruptManifestIssue = reportCorruptManifest.issues.find(
      (i) => i.kind === "invalid_workspace",
    );
    expect(corruptManifestIssue).toBeDefined();
    expect(corruptManifestIssue?.message).toContain("invalid or corrupt");
    expect(corruptManifestIssue?.repair).toContain("pact.yaml");

    // Case 3: missing database
    const missingDbRoot = createTempDir();
    initializeWorkspace(missingDbRoot, "Missing DB Workspace");
    const dbPath = join(missingDbRoot, ".contextpact", "contextpact.db");
    if (existsSync(dbPath)) {
      unlinkSync(dbPath);
    }
    const reportMissingDb = ContextService.doctor(missingDbRoot);
    expect(reportMissingDb.healthy).toBe(false);
    const missingDbIssue = reportMissingDb.issues.find(
      (i) => i.kind === "invalid_workspace",
    );
    expect(missingDbIssue).toBeDefined();
    expect(missingDbIssue?.repair).toContain("contextpact restore");
  });

  it("doctor detects a deliberately damaged workspace of kind 'wrong schema version' and names the repair", () => {
    const root = createTempDir();
    initializeWorkspace(root, "Wrong Schema Workspace");

    // Deliberately tamper with schema_migrations to set an outdated schema version (e.g. 1 instead of current 5)
    const dbPath = join(root, ".contextpact", "contextpact.db");
    const db = openDatabase(dbPath);
    db.prepare("DELETE FROM schema_migrations WHERE version > 1").run();
    db.close();

    const report = ContextService.doctor(root);
    expect(report.healthy).toBe(false);

    const issue = report.issues.find((i) => i.kind === "wrong_schema_version");
    expect(issue).toBeDefined();
    expect(issue?.severity).toBe("error");
    expect(issue?.message).toContain("schema version (1)");
    expect(issue?.repair).toContain("contextpact reindex");
    expect(issue?.details?.currentVersion).toBe(1);
    expect(issue?.details?.expectedVersion).toBe(5);
  });

  it("doctor detects a deliberately damaged workspace of kind 'stale index' and names the repair", () => {
    const root = createTempDir();
    initializeWorkspace(root, "Stale Index Workspace");
    const service = new ContextService(root);

    const item = service.create(
      {
        id: "rule-freshness",
        type: "rule",
        title: "Initial rule title",
        content: "Initial content synchronized with database index.",
        status: "approved",
      },
      humanActor,
    );
    service.close();

    // Deliberately modify file on disk directly without reindexing
    const filePath = join(
      root,
      ".contextpact",
      "knowledge",
      "rules",
      `${item.id}.md`,
    );
    expect(existsSync(filePath)).toBe(true);

    const tamperedContent = `---
id: ${item.id}
type: rule
scope: workspace
workspaceId: ws-1
title: Initial rule title
status: approved
importance: normal
visibility: []
tags: []
supersedes: []
version: 1
createdAt: 2026-09-16T00:00:00.000Z
updatedAt: 2026-09-16T00:00:00.000Z
expiresAt: null
---

External out-of-band modification on disk that makes SQLite index stale.
`;
    writeFileSync(filePath, tamperedContent, "utf8");

    const report = ContextService.doctor(root);
    expect(report.healthy).toBe(false);

    const issue = report.issues.find((i) => i.kind === "stale_index");
    expect(issue).toBeDefined();
    expect(issue?.severity).toBe("warning");
    expect(issue?.message).toContain("Search index is stale");
    expect(issue?.repair).toContain("contextpact reindex");
    expect(issue?.details?.staleFileCount).toBeGreaterThanOrEqual(1);
  });

  it("doctor detects a deliberately damaged workspace of kind 'orphaned file' and names the repair", () => {
    const root = createTempDir();
    initializeWorkspace(root, "Orphaned File Workspace");

    // Case A: Create an untracked, non-markdown stray file in knowledge directory
    const strayFile = join(
      root,
      ".contextpact",
      "knowledge",
      "rules",
      "unexpected-artifact.tmp",
    );
    writeFileSync(strayFile, "random stray content", "utf8");

    // Case B: Create an unparseable corrupt markdown file
    const corruptFile = join(
      root,
      ".contextpact",
      "knowledge",
      "rules",
      "corrupted-item.md",
    );
    writeFileSync(
      corruptFile,
      "---\ninvalid_frontmatter: [unclosed\n---\nBody",
      "utf8",
    );

    const report = ContextService.doctor(root);
    expect(report.healthy).toBe(false);

    const orphanIssues = report.issues.filter(
      (i) => i.kind === "orphaned_file",
    );
    expect(orphanIssues.length).toBeGreaterThanOrEqual(2);

    const strayIssue = orphanIssues.find((i) =>
      i.message.includes("unexpected-artifact.tmp"),
    );
    expect(strayIssue).toBeDefined();
    expect(strayIssue?.repair).toContain(
      "Remove the invalid or untracked file",
    );

    const corruptIssue = orphanIssues.find((i) =>
      i.message.includes("corrupted-item.md"),
    );
    expect(corruptIssue).toBeDefined();
    expect(corruptIssue?.repair).toContain(
      "Remove the invalid or untracked file",
    );
  });

  it("doctor detects a deliberately damaged workspace of kind 'expired lease' and names the repair", () => {
    const root = createTempDir();
    initializeWorkspace(root, "Expired Lease Workspace");
    const service = new ContextService(root);

    const task = service.createTask(
      {
        id: "task-lease-expire",
        title: "Task with expired lease",
        description: "Testing lease expiration detection",
      },
      humanActor,
    );
    service.ensureAgent("agent-worker-1", { clientKind: "cli" });

    // Claim lease
    service.claimTask({
      taskId: task.id,
      agentId: "agent-worker-1",
      ttlSeconds: 60,
    });

    // Deliberately manipulate lease in database to be in the past
    const db = service.getDatabase();
    const pastTimestamp = new Date(Date.now() - 3600 * 1000).toISOString();
    db.prepare("UPDATE task_leases SET expires_at = ? WHERE task_id = ?").run(
      pastTimestamp,
      task.id,
    );

    const report = service.diagnoseWorkspace();
    service.close();

    expect(report.healthy).toBe(false);
    const leaseIssue = report.issues.find((i) => i.kind === "expired_lease");
    expect(leaseIssue).toBeDefined();
    expect(leaseIssue?.severity).toBe("warning");
    expect(leaseIssue?.message).toContain("task-lease-expire");
    expect(leaseIssue?.message).toContain("expired at");
    expect(leaseIssue?.repair).toContain("contextpact task-release");
    expect(leaseIssue?.repair).toContain("stale takeover");
  });

  it("doctor detects a deliberately damaged workspace of kind 'missing provenance' and names the repair", () => {
    const root = createTempDir();
    initializeWorkspace(root, "Missing Provenance Workspace");
    const service = new ContextService(root);

    const item = service.create(
      {
        id: "rule-tampered-provenance",
        type: "rule",
        title: "Provenance testing item",
        content: "Content for provenance test",
        status: "approved",
      },
      humanActor,
    );

    // Deliberately wipe provenance (actor and source) in database
    const db = service.getDatabase();
    db.prepare(
      "UPDATE context_items SET actor = '', source = '' WHERE id = ?",
    ).run(item.id);

    const report = service.diagnoseWorkspace();
    service.close();

    expect(report.healthy).toBe(false);
    const provIssue = report.issues.find(
      (i) => i.kind === "missing_provenance",
    );
    expect(provIssue).toBeDefined();
    expect(provIssue?.severity).toBe("warning");
    expect(provIssue?.message).toContain("rule-tampered-provenance");
    expect(provIssue?.message).toContain(
      "missing required actor or source provenance",
    );
    expect(provIssue?.repair).toContain(
      "Update the record with valid actor/source provenance",
    );
  });

  it("doctor detects a database that was rebuilt rather than restored and asserts the wording does not claim recovered history", () => {
    const root = createTempDir();
    initializeWorkspace(root, "Rebuilt Database Workspace");
    const service = new ContextService(root);

    // Create knowledge item with audit history originally
    service.create(
      {
        id: "rule-rebuilt-test",
        type: "rule",
        title: "Knowledge surviving wipe",
        content: "This markdown knowledge file survives in the vault.",
        status: "approved",
      },
      humanActor,
    );
    service.close();

    // Now simulate database corruption/loss and a database REBUILD from Markdown alone
    // (e.g. contextpact.db was deleted and recreated via reindexWorkspace)
    const dbPath = join(root, ".contextpact", "contextpact.db");
    unlinkSync(dbPath);
    expect(existsSync(dbPath)).toBe(false);

    // Rebuild index from Markdown into fresh database
    const freshDb = openDatabase(dbPath);
    reindexWorkspace(root, freshDb);
    freshDb.close();

    // Verify context_items was rebuilt from Markdown
    const verifyDb = openDatabase(dbPath);
    const itemCount = (
      verifyDb.prepare("SELECT count(*) as c FROM context_items").get() as {
        c: number;
      }
    ).c;
    const auditCount = (
      verifyDb.prepare("SELECT count(*) as c FROM audit_events").get() as {
        c: number;
      }
    ).c;
    verifyDb.close();

    expect(itemCount).toBe(1);
    expect(auditCount).toBe(0); // Audit history was lost!

    // Run doctor
    const report = ContextService.doctor(root);
    expect(report.healthy).toBe(false);
    expect(report.rebuiltDatabase).toBe(true);

    const rebuiltIssue = report.issues.find(
      (i) => i.kind === "rebuilt_database",
    );
    expect(rebuiltIssue).toBeDefined();

    // Assert the diagnostic message explicitly states the database was rebuilt,
    // explicitly warns that leases and audit events cannot be rebuilt,
    // and does NOT claim recovered history.
    const message = rebuiltIssue?.message ?? "";
    const repair = rebuiltIssue?.repair ?? "";

    expect(message).toContain("rebuilt from Markdown rather than restored");
    expect(message).toContain(
      "cannot be rebuilt from Markdown and have been lost",
    );
    expect(message).toContain("Do not assume historical audit trail is intact");

    // Critical assertion: verify wording does NOT claim recovered history
    expect(message.toLowerCase()).not.toContain("recovered history");
    expect(message.toLowerCase()).not.toContain("history recovered");
    expect(message.toLowerCase()).not.toContain("restored audit");
    expect(message.toLowerCase()).not.toContain("audit trail restored");
    expect(message.toLowerCase()).not.toContain("leases restored");

    // Repair directs to dual-store backup restore
    expect(repair).toContain("contextpact restore");
  });

  it("doctor reports a healthy workspace with zero issues when undamaged and fully restored", () => {
    const root = createTempDir();
    initializeWorkspace(root, "Healthy Workspace");
    const service = new ContextService(root);

    service.create(
      {
        id: "rule-healthy",
        type: "rule",
        title: "Healthy Rule",
        content: "Complies with all health checks.",
        status: "approved",
      },
      humanActor,
    );

    const report = service.diagnoseWorkspace();
    service.close();

    expect(report.healthy).toBe(true);
    expect(report.rebuiltDatabase).toBe(false);
    expect(report.issues).toHaveLength(0);
    expect(report.summary.errors).toBe(0);
    expect(report.summary.warnings).toBe(0);
  });
});
