import { spawn } from "node:child_process";
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
  MissingEvidenceError,
  initializeWorkspace,
  readMarkdownKnowledgeItem,
  workspacePaths,
  type Handoff,
  type HandoffOutcome,
  type LeaseRecord,
  type TaskRecord,
} from "../src/index.js";

describe("Structured handoffs with evidence and multi-process resumption", () => {
  let tempDir: string;
  let service: ContextService;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "contextpact-handoff-test-"));
    initializeWorkspace(tempDir, "Handoff Test Workspace");
    service = new ContextService(tempDir);

    service.registerAgent({
      id: "agent-alpha",
      displayName: "Agent Alpha",
      clientKind: "mcp",
      profile: "default",
    });
    service.registerAgent({
      id: "agent-beta",
      displayName: "Agent Beta",
      clientKind: "mcp",
      profile: "default",
    });
  });

  afterEach(() => {
    service.close();
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // Evidence requirement
  // -------------------------------------------------------------------------
  describe("Evidence enforcement at service layer", () => {
    it("refuses a handoff asserting success with no evidence, and the refusal names what was missing", () => {
      service.createTask({
        id: "task-no-ev",
        title: "Task without evidence",
        status: "planned",
        scope: ["src/"],
      });
      service.claimLease({
        taskId: "task-no-ev",
        agentId: "agent-alpha",
        ttlSeconds: 300,
      });

      let caught: MissingEvidenceError | null = null;
      try {
        service.createHandoff({
          taskId: "task-no-ev",
          agentId: "agent-alpha",
          outcome: "success",
          summary: "Finished all the work successfully.",
          blockers: [],
          nextAction: "Deploy the service",
          evidence: [],
        });
      } catch (err) {
        if (err instanceof MissingEvidenceError) caught = err;
      }

      expect(caught).not.toBeNull();
      expect(caught!.name).toBe("MissingEvidenceError");
      expect(caught!.missing).toBe("evidence");
      expect(caught!.message.toLowerCase()).toContain("evidence");
      expect(caught!.message).toContain(
        "Completion without verification is not accepted as proven",
      );
    });

    it("refuses a handoff asserting success when evidence array is omitted", () => {
      service.createTask({
        id: "task-omitted-ev",
        title: "Task with omitted evidence",
        status: "planned",
        scope: ["src/"],
      });

      expect(() => {
        service.createHandoff({
          taskId: "task-omitted-ev",
          agentId: "agent-alpha",
          outcome: "success",
          summary: "Finished work.",
          nextAction: "Proceed to review",
        } as any);
      }).toThrow(MissingEvidenceError);
    });

    it("accepts a handoff asserting success when valid evidence is provided", () => {
      service.createTask({
        id: "task-with-ev",
        title: "Task with evidence",
        status: "planned",
        scope: ["src/"],
      });
      service.claimLease({
        taskId: "task-with-ev",
        agentId: "agent-alpha",
        ttlSeconds: 300,
      });

      const handoff = service.createHandoff({
        taskId: "task-with-ev",
        agentId: "agent-alpha",
        outcome: "success",
        summary: "Implemented parser and verified with test suite.",
        blockers: [],
        nextAction: "Review test coverage report",
        evidence: [
          {
            kind: "test",
            description: "111 tests passed with 0 failures",
            command: "npm test",
            exitCode: 0,
          },
        ],
      });

      expect(handoff.outcome).toBe("success");
      expect(handoff.evidence).toHaveLength(1);
      expect(handoff.evidence[0]!.description).toBe(
        "111 tests passed with 0 failures",
      );
    });

    it("allows blocked or in_progress handoff without evidence", () => {
      service.createTask({
        id: "task-blocked",
        title: "Blocked task",
        status: "planned",
        scope: ["src/"],
      });

      const handoff = service.createHandoff({
        taskId: "task-blocked",
        agentId: "agent-alpha",
        outcome: "blocked",
        summary: "Blocked on upstream API key approval.",
        blockers: ["Waiting for third-party credentials."],
        nextAction: "Request API credentials from administrator",
        evidence: [],
      });

      expect(handoff.outcome).toBe("blocked");
      expect(handoff.blockers).toEqual([
        "Waiting for third-party credentials.",
      ]);
    });
  });

  // -------------------------------------------------------------------------
  // Next action discipline: exactly one next action
  // -------------------------------------------------------------------------
  describe("Exactly one next action discipline", () => {
    it("refuses a handoff when nextAction is an array of actions", () => {
      service.createTask({
        id: "task-multi-action",
        title: "Task with multiple next actions",
        status: "planned",
        scope: ["src/"],
      });

      expect(() => {
        service.createHandoff({
          taskId: "task-multi-action",
          agentId: "agent-alpha",
          outcome: "in_progress",
          summary: "Partial progress.",
          nextAction: ["Do step one", "Do step two"] as any,
        });
      }).toThrow(/Exactly one next action is required, not a list/);
    });

    it("refuses a handoff when nextActions plural is provided", () => {
      service.createTask({
        id: "task-plural-action",
        title: "Task with nextActions plural",
        status: "planned",
        scope: ["src/"],
      });

      expect(() => {
        service.createHandoff({
          taskId: "task-plural-action",
          agentId: "agent-alpha",
          outcome: "in_progress",
          summary: "Partial progress.",
          nextActions: ["First action", "Second action"],
        } as any);
      }).toThrow(/Exactly one next action is required, not a list/);
    });

    it("refuses a handoff when nextAction is empty string", () => {
      service.createTask({
        id: "task-empty-action",
        title: "Task with empty next action",
        status: "planned",
        scope: ["src/"],
      });

      expect(() => {
        service.createHandoff({
          taskId: "task-empty-action",
          agentId: "agent-alpha",
          outcome: "in_progress",
          summary: "Partial progress.",
          nextAction: "",
        });
      }).toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // Storage split: Markdown narrative vs SQLite record
  // -------------------------------------------------------------------------
  describe("Storage ownership: Markdown narrative vs SQLite record", () => {
    it("writes human-readable Markdown to handoffs/ and operational record to SQLite with stable shared ID", () => {
      service.createTask({
        id: "task-split",
        title: "Storage split task",
        status: "planned",
        scope: ["src/"],
      });
      service.claimLease({
        taskId: "task-split",
        agentId: "agent-alpha",
        ttlSeconds: 300,
      });

      const handoff = service.createHandoff({
        id: "ho-stable-001",
        taskId: "task-split",
        agentId: "agent-alpha",
        outcome: "success",
        summary: "Implemented data schema and atomic writes.",
        blockers: [],
        nextAction: "Execute integration tests on test suite",
        evidence: [
          {
            kind: "test",
            description: "All unit tests pass",
            command: "npm test",
            exitCode: 0,
          },
        ],
      });

      expect(handoff.id).toBe("ho-stable-001");

      // Verify SQLite operational record
      const db = service.getDatabase();
      const row = db
        .prepare("SELECT * FROM handoffs WHERE id = ?")
        .get("ho-stable-001") as any;
      expect(row).toBeDefined();
      expect(row.id).toBe("ho-stable-001");
      expect(row.task_id).toBe("task-split");
      expect(row.agent_id).toBe("agent-alpha");
      expect(row.outcome).toBe("success");
      expect(JSON.parse(row.evidence_json)).toHaveLength(1);

      // Verify Markdown file on disk under handoffs/
      const paths = workspacePaths(tempDir);
      const markdownPath = join(paths.handoffs, "ho-stable-001.md");
      expect(existsSync(markdownPath)).toBe(true);

      const rawMarkdown = readFileSync(markdownPath, "utf8");
      // Markdown is human readable without ContextPact running
      expect(rawMarkdown).toContain("## Outcome");
      expect(rawMarkdown).toContain(
        "Implemented data schema and atomic writes.",
      );
      expect(rawMarkdown).toContain("## Blockers");
      expect(rawMarkdown).toContain("None.");
      expect(rawMarkdown).toContain("## Next Action");
      expect(rawMarkdown).toContain("Execute integration tests on test suite");

      // Verify it is also a valid Markdown knowledge item
      const parsedItem = readMarkdownKnowledgeItem(markdownPath);
      expect(parsedItem.id).toBe("ho-stable-001");
      expect(parsedItem.type).toBe("handoff");
      expect(parsedItem.status).toBe("approved");

      // Verify getHandoff returns combined view
      const retrieved = service.getHandoff("ho-stable-001");
      expect(retrieved).not.toBeNull();
      expect(retrieved!.id).toBe("ho-stable-001");
      expect(retrieved!.taskId).toBe("task-split");
      expect(retrieved!.summary).toBe(
        "Implemented data schema and atomic writes.",
      );
      expect(retrieved!.nextAction).toBe(
        "Execute integration tests on test suite",
      );
      expect(retrieved!.evidence[0]!.command).toBe("npm test");
    });

    it("surfaces external edits made to Markdown narrative without breaking operational link", () => {
      service.createTask({
        id: "task-ext-edit",
        title: "External edit task",
        status: "planned",
        scope: ["src/"],
      });

      service.createHandoff({
        id: "ho-ext-001",
        taskId: "task-ext-edit",
        agentId: "agent-alpha",
        outcome: "in_progress",
        summary: "Original summary.",
        blockers: [],
        nextAction: "Original action",
      });

      // Human or external editor updates the Markdown narrative file directly
      const paths = workspacePaths(tempDir);
      const markdownPath = join(paths.handoffs, "ho-ext-001.md");
      const currentContent = readFileSync(markdownPath, "utf8");
      const updatedContent = currentContent
        .replaceAll("Original summary.", "Human edited summary in Obsidian.")
        .replaceAll("Original action", "Deploy after code review");
      writeFileSync(markdownPath, updatedContent, "utf8");

      // Reconcile and read
      service.reconcile();
      const updatedHandoff = service.getHandoff("ho-ext-001")!;
      expect(updatedHandoff.summary).toBe("Human edited summary in Obsidian.");
      expect(updatedHandoff.nextAction).toBe("Deploy after code review");
      expect(updatedHandoff.taskId).toBe("task-ext-edit");
    });
  });

  // -------------------------------------------------------------------------
  // Search and Pack integration (retrieval path)
  // -------------------------------------------------------------------------
  describe("Search and pack retrieval", () => {
    it("indexes handoffs in FTS5 search and makes them searchable like any other item", () => {
      service.createTask({
        id: "task-fts",
        title: "FTS Task",
        status: "planned",
        scope: ["src/"],
      });

      service.createHandoff({
        id: "ho-search-1",
        taskId: "task-fts",
        agentId: "agent-alpha",
        outcome: "success",
        summary: "Implemented cryptographic token verification.",
        nextAction: "Audit security boundaries",
        evidence: [
          {
            kind: "test",
            description: "Crypto tests pass",
            command: "npm test",
          },
        ],
      });

      const searchResults = service.search("cryptographic");
      expect(searchResults.some((r) => r.item.id === "ho-search-1")).toBe(true);

      const actionSearchResults = service.search("boundaries");
      expect(actionSearchResults.some((r) => r.item.id === "ho-search-1")).toBe(
        true,
      );
    });

    it("includes approved handoffs in deterministic context pack", () => {
      service.createTask({
        id: "task-pack",
        title: "Pack Task",
        status: "planned",
        scope: ["src/"],
      });

      service.createHandoff({
        id: "ho-pack-1",
        taskId: "task-pack",
        agentId: "agent-alpha",
        outcome: "success",
        summary: "Deterministic pack test outcome.",
        nextAction: "Check budget allocation",
        evidence: [
          {
            kind: "test",
            description: "Unit tests pass",
          },
        ],
      });

      const pack = service.buildPack({
        taskId: "task-pack",
        type: "handoff",
      });

      expect(pack.items.some((i) => i.id === "ho-pack-1")).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Reconciliation conflict detection
  // -------------------------------------------------------------------------
  describe("Reconciliation conflict detection for handoffs", () => {
    it("surfaces conflict when a handoff Markdown file has no corresponding SQLite record", () => {
      const paths = workspacePaths(tempDir);
      // Manually drop a rogue Markdown handoff file into handoffs/ without SQLite record
      const roguePath = join(paths.handoffs, "ho-rogue.md");
      const rogueContent = `---
id: ho-rogue
type: handoff
scope: task
workspaceId: ws-default
title: Rogue Handoff
source: agent
actor: agent-alpha
status: approved
importance: normal
tags: []
version: 1
createdAt: "${new Date().toISOString()}"
updatedAt: "${new Date().toISOString()}"
taskId: ghost-task
outcome: success
nextAction: Do nothing
---

## Outcome
Rogue outcome.

## Blockers
None.

## Next Action
Do nothing
`;
      writeFileSync(roguePath, rogueContent, "utf8");

      const result = service.reconcile();
      const conflict = result.conflicts.find((c) => c.id === "ho-rogue");
      expect(conflict).toBeDefined();
      expect(conflict!.type).toBe("handoff_record_conflict");
      expect(conflict!.message).toContain(
        "no corresponding operational record",
      );
    });

    it("surfaces conflict when a SQLite handoff record exists but its Markdown file is missing", () => {
      service.createTask({
        id: "task-del-md",
        title: "Task with deleted markdown",
        status: "planned",
        scope: [],
      });

      const handoff = service.createHandoff({
        id: "ho-missing-file",
        taskId: "task-del-md",
        agentId: "agent-alpha",
        outcome: "in_progress",
        summary: "Summary before file deletion.",
        nextAction: "Recover file",
      });

      // Delete the markdown narrative file from disk
      const paths = workspacePaths(tempDir);
      unlinkSync(join(paths.handoffs, `${handoff.id}.md`));

      const result = service.reconcile({ cleanDeleted: false });
      const conflict = result.conflicts.find((c) => c.id === "ho-missing-file");
      expect(conflict).toBeDefined();
      expect(conflict!.type).toBe("handoff_record_conflict");
      expect(conflict!.message).toContain(
        "narrative Markdown file is missing from disk",
      );
    });

    it("surfaces conflict when narrative file taskId contradicts SQLite record task_id", () => {
      service.createTask({
        id: "task-real",
        title: "Real Task",
        status: "planned",
        scope: [],
      });
      service.createTask({
        id: "task-fake",
        title: "Fake Task",
        status: "planned",
        scope: [],
      });

      service.createHandoff({
        id: "ho-clash",
        taskId: "task-real",
        agentId: "agent-alpha",
        outcome: "in_progress",
        summary: "Clash test.",
        nextAction: "Fix mismatch",
      });

      // Manually edit the frontmatter taskId to conflict
      const paths = workspacePaths(tempDir);
      const filePath = join(paths.handoffs, "ho-clash.md");
      const content = readFileSync(filePath, "utf8");
      const hackedContent = content.replace("task-real", "task-fake");
      writeFileSync(filePath, hackedContent, "utf8");

      const result = service.reconcile();
      const conflict = result.conflicts.find((c) => c.id === "ho-clash");
      expect(conflict).toBeDefined();
      expect(conflict!.type).toBe("handoff_record_conflict");
      expect(conflict!.message).toContain(
        "references task 'task-fake', but SQLite record is linked to task 'task-real'",
      );
    });
  });

  // -------------------------------------------------------------------------
  // Multi-process resumption via child_process (isolated OS processes)
  // -------------------------------------------------------------------------
  describe("Multi-process resumption via child_process worker", () => {
    interface WorkerOutput {
      ok: boolean;
      lease?: LeaseRecord;
      task?: TaskRecord;
      handoff?: Handoff;
      nextAction?: string;
      error?: string;
      name?: string;
    }

    function runWorkerProcess(
      workspaceDir: string,
      command: string,
      args: Record<string, unknown> = {},
    ): Promise<WorkerOutput> {
      return new Promise((resolve, reject) => {
        const cp = spawn(
          process.execPath,
          [
            "--import",
            "tsx/esm",
            join(import.meta.dirname, "helpers", "lease-worker.mjs"),
            workspaceDir,
            command,
            JSON.stringify(args),
          ],
          { stdio: ["ignore", "pipe", "pipe"] },
        );
        let stdout = "";
        let stderr = "";
        cp.stdout.on("data", (chunk: Buffer) => {
          stdout += chunk.toString();
        });
        cp.stderr.on("data", (chunk: Buffer) => {
          stderr += chunk.toString();
        });
        cp.on("error", reject);
        cp.on("close", () => {
          try {
            resolve(JSON.parse(stdout.trim()) as WorkerOutput);
          } catch {
            reject(
              new Error(
                `Worker failed with invalid JSON: ${stdout} (stderr: ${stderr})`,
              ),
            );
          }
        });
      });
    }

    it("Agent A works, hands off and exits; Agent B resumes from the handoff ALONE and finishes the task without sharing process state", async () => {
      // 1. Create a task in the workspace
      const task = service.createTask({
        id: "task-handoff-flow",
        title: "Multi-process coordination flow",
        description: "Task to be completed across two independent OS processes",
        status: "planned",
        scope: ["src/worker"],
      });
      expect(task.status).toBe("planned");

      // 2. Spawn Process A: Agent Alpha claims the task, works, records handoff, and exits
      const claimResultA = await runWorkerProcess(tempDir, "claim", {
        taskId: "task-handoff-flow",
        agentId: "agent-alpha",
        ttlSeconds: 300,
        scope: ["src/worker"],
      });
      expect(claimResultA.ok).toBe(true);
      expect(claimResultA.lease?.agentId).toBe("agent-alpha");

      // Agent Alpha creates a structured handoff with evidence and one next action
      const handoffResultA = await runWorkerProcess(tempDir, "handoff", {
        id: "ho-flow-001",
        taskId: "task-handoff-flow",
        agentId: "agent-alpha",
        outcome: "success",
        summary: "Completed phase 1: architecture and interface definition.",
        blockers: [],
        nextAction: "Implement phase 2 and run verification suite",
        evidence: [
          {
            kind: "test",
            description: "Phase 1 unit tests passing",
            command: "npm test -- tests/phase1.test.ts",
            exitCode: 0,
          },
        ],
        releaseLease: true,
      });
      expect(handoffResultA.ok).toBe(true);
      expect(handoffResultA.handoff?.id).toBe("ho-flow-001");
      expect(handoffResultA.handoff?.outcome).toBe("success");

      // Process A has now fully exited. Its memory and process state are gone.

      // 3. Spawn Process B: Agent Beta resumes from handoff ALONE.
      // Agent Beta only knows the handoffId ("ho-flow-001").
      const resumeResultB = await runWorkerProcess(tempDir, "resume-handoff", {
        handoffId: "ho-flow-001",
        agentId: "agent-beta",
        ttlSeconds: 300,
      });

      expect(resumeResultB.ok).toBe(true);
      expect(resumeResultB.lease).toBeDefined();
      expect(resumeResultB.lease?.agentId).toBe("agent-beta");
      expect(resumeResultB.task?.id).toBe("task-handoff-flow");
      expect(resumeResultB.nextAction).toBe(
        "Implement phase 2 and run verification suite",
      );

      // Agent Beta continues from the next action, completes work, and releases lease
      const releaseResultB = await runWorkerProcess(tempDir, "release", {
        taskId: "task-handoff-flow",
        agentId: "agent-beta",
        finalStatus: "done",
      });
      expect(releaseResultB.ok).toBe(true);
      expect(releaseResultB.task?.status).toBe("done");

      // Process B has now fully exited.

      // 4. Verify in the main process
      const finalTask = service.getTask("task-handoff-flow")!;
      expect(finalTask.status).toBe("done");

      // Verify handoff narrative file exists in .contextpact/handoffs/
      const paths = workspacePaths(tempDir);
      const handoffFile = join(paths.handoffs, "ho-flow-001.md");
      expect(existsSync(handoffFile)).toBe(true);

      const fileContent = readFileSync(handoffFile, "utf8");
      expect(fileContent).toContain(
        "Completed phase 1: architecture and interface definition.",
      );
      expect(fileContent).toContain(
        "Implement phase 2 and run verification suite",
      );

      // Verify audit events trace both agents
      const db = service.getDatabase();
      const auditEvents = db
        .prepare(
          "SELECT event_type, actor FROM audit_events WHERE entity_id IN ('task-handoff-flow', 'ho-flow-001') ORDER BY id ASC",
        )
        .all() as Array<{ event_type: string; actor: string }>;

      const eventTypes = auditEvents.map((e) => e.event_type);
      expect(eventTypes).toContain("task.lease_acquired");
      expect(eventTypes).toContain("handoff.created");
      expect(eventTypes).toContain("handoff.resumed");
      expect(eventTypes).toContain("task.lease_released");

      // Agent Alpha created handoff, Agent Beta resumed it
      const handoffCreatedEvent = auditEvents.find(
        (e) => e.event_type === "handoff.created",
      );
      expect(handoffCreatedEvent?.actor).toBe("agent-alpha");

      const handoffResumedEvent = auditEvents.find(
        (e) => e.event_type === "handoff.resumed",
      );
      expect(handoffResumedEvent?.actor).toBe("agent-beta");
    });
  });
});
