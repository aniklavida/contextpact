import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ContextService,
  LeaseConflictError,
  LeaseNotStaleError,
  LeaseOwnershipError,
  NoActiveLeaseError,
  TakeoverReasonRequiredError,
  initializeWorkspace,
} from "../src/index.js";

describe("Task lease: create, claim, renew, release and stale takeover", () => {
  let tempDir: string;
  let service: ContextService;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "contextpact-lease-test-"));
    initializeWorkspace(tempDir, "Lease Test Workspace");
    service = new ContextService(tempDir);

    service.registerAgent({
      id: "agent-alpha",
      displayName: "Alpha",
      clientKind: "mcp",
      profile: "default",
    });
    service.registerAgent({
      id: "agent-beta",
      displayName: "Beta",
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
  // Task CRUD
  // -------------------------------------------------------------------------
  describe("Task create and list", () => {
    it("creates a task with planned status and retrieves it", () => {
      const task = service.createTask({
        id: "task-001",
        title: "First task",
        description: "A test task",
        status: "planned",
        scope: ["src/"],
      });

      expect(task.id).toBe("task-001");
      expect(task.title).toBe("First task");
      expect(task.status).toBe("planned");
      expect(task.scope).toEqual(["src/"]);
      expect(task.version).toBe(1);
    });

    it("lists tasks filtered by status", () => {
      service.createTask({
        id: "t-planned",
        title: "Planned",
        status: "planned",
        scope: [],
      });
      service.createTask({
        id: "t-done",
        title: "Done",
        status: "done",
        scope: [],
      });

      const planned = service.listTasks("planned");
      expect(planned.map((t) => t.id)).toContain("t-planned");
      expect(planned.map((t) => t.id)).not.toContain("t-done");
    });
  });

  // -------------------------------------------------------------------------
  // Claim
  // -------------------------------------------------------------------------
  describe("claimLease", () => {
    it("succeeds when no lease exists and sets task status to active", () => {
      service.createTask({
        id: "task-fresh",
        title: "Fresh Task",
        status: "planned",
        scope: [],
      });

      const lease = service.claimLease({
        taskId: "task-fresh",
        agentId: "agent-alpha",
        ttlSeconds: 300,
        scope: ["src/"],
      });

      expect(lease.taskId).toBe("task-fresh");
      expect(lease.agentId).toBe("agent-alpha");
      expect(lease.version).toBe(1);
      expect(lease.expiresAt > lease.acquiredAt).toBe(true);

      const task = service.getTask("task-fresh")!;
      expect(task.status).toBe("active");
      expect(task.scope).toEqual(["src/"]);
    });

    it("writes a task.lease_acquired audit event", () => {
      service.createTask({
        id: "task-audit",
        title: "Audit Task",
        status: "planned",
        scope: [],
      });
      service.claimLease({
        taskId: "task-audit",
        agentId: "agent-alpha",
        ttlSeconds: 60,
        scope: [],
      });

      const db = service.getDatabase();
      const row = db
        .prepare(
          "SELECT actor, payload_json FROM audit_events WHERE event_type = 'task.lease_acquired' AND entity_id = ?",
        )
        .get("task-audit") as
        { actor: string; payload_json: string } | undefined;

      expect(row).toBeDefined();
      expect(row!.actor).toBe("agent-alpha");
      const payload = JSON.parse(row!.payload_json);
      expect(payload.ttl_seconds).toBe(60);
    });

    it("throws LeaseConflictError when an active lease already exists", () => {
      service.createTask({
        id: "task-conflict",
        title: "Conflict",
        status: "planned",
        scope: [],
      });
      service.claimLease({
        taskId: "task-conflict",
        agentId: "agent-alpha",
        ttlSeconds: 300,
        scope: ["a/"],
      });

      expect(() => {
        service.claimLease({
          taskId: "task-conflict",
          agentId: "agent-beta",
          ttlSeconds: 300,
          scope: ["b/"],
        });
      }).toThrow(LeaseConflictError);
    });

    it("LeaseConflictError includes the holder agent id and expiry", () => {
      service.createTask({
        id: "task-err-info",
        title: "Error Info",
        status: "planned",
        scope: [],
      });
      service.claimLease({
        taskId: "task-err-info",
        agentId: "agent-alpha",
        ttlSeconds: 300,
        scope: [],
      });

      let caught: LeaseConflictError | null = null;
      try {
        service.claimLease({
          taskId: "task-err-info",
          agentId: "agent-beta",
          ttlSeconds: 300,
          scope: [],
        });
      } catch (err) {
        if (err instanceof LeaseConflictError) caught = err;
      }

      expect(caught).not.toBeNull();
      expect(caught!.holderAgentId).toBe("agent-alpha");
      expect(typeof caught!.expiresAt).toBe("string");
    });

    it("surfaces overlapping scopes when two claims collide on the same scopes", () => {
      service.createTask({
        id: "task-scope-clash",
        title: "Scope Clash",
        status: "planned",
        scope: [],
      });
      service.claimLease({
        taskId: "task-scope-clash",
        agentId: "agent-alpha",
        ttlSeconds: 300,
        scope: ["src/", "docs/"],
      });

      let caught: LeaseConflictError | null = null;
      try {
        service.claimLease({
          taskId: "task-scope-clash",
          agentId: "agent-beta",
          ttlSeconds: 300,
          scope: ["src/", "tests/"],
        });
      } catch (err) {
        if (err instanceof LeaseConflictError) caught = err;
      }

      expect(caught).not.toBeNull();
      expect(caught!.scopeConflict).not.toBeNull();
      expect(caught!.scopeConflict!.overlapping).toContain("src/");
      expect(caught!.scopeConflict!.overlapping).not.toContain("docs/");
    });

    it("rejects a claim against an expired lease (must use takeoverLease instead)", () => {
      service.createTask({
        id: "task-stale-claim",
        title: "Stale",
        status: "planned",
        scope: [],
      });
      // Claim with 0-second TTL creates a lease that is already expired at the next millisecond.
      // We manipulate the expiry directly via SQL to simulate expiry.
      service.claimLease({
        taskId: "task-stale-claim",
        agentId: "agent-alpha",
        ttlSeconds: 300,
        scope: [],
      });
      const pastExpiry = new Date(Date.now() - 1000).toISOString();
      service
        .getDatabase()
        .prepare("UPDATE task_leases SET expires_at = ? WHERE task_id = ?")
        .run(pastExpiry, "task-stale-claim");

      // claimLease must refuse even for an expired lease; caller must use takeoverLease
      expect(() => {
        service.claimLease({
          taskId: "task-stale-claim",
          agentId: "agent-beta",
          ttlSeconds: 300,
          scope: [],
        });
      }).toThrow(LeaseConflictError);
    });

    it("refuses to claim for an unknown task", () => {
      expect(() => {
        service.claimLease({
          taskId: "ghost-task",
          agentId: "agent-alpha",
          ttlSeconds: 300,
          scope: [],
        });
      }).toThrow(/not found/);
    });

    it("refuses to claim for an unregistered agent", () => {
      service.createTask({
        id: "task-unreg",
        title: "Unreg",
        status: "planned",
        scope: [],
      });
      expect(() => {
        service.claimLease({
          taskId: "task-unreg",
          agentId: "agent-ghost",
          ttlSeconds: 300,
          scope: [],
        });
      }).toThrow(/not registered/);
    });
  });

  // -------------------------------------------------------------------------
  // Renew
  // -------------------------------------------------------------------------
  describe("renewLease", () => {
    it("extends the expiry and increments version", async () => {
      service.createTask({
        id: "task-renew",
        title: "Renew",
        status: "planned",
        scope: [],
      });
      const original = service.claimLease({
        taskId: "task-renew",
        agentId: "agent-alpha",
        ttlSeconds: 10,
        scope: [],
      });

      await new Promise((r) => setTimeout(r, 5));

      const renewed = service.renewLease({
        taskId: "task-renew",
        agentId: "agent-alpha",
        ttlSeconds: 300,
      });

      expect(renewed.version).toBe(original.version + 1);
      expect(renewed.expiresAt > original.expiresAt).toBe(true);
      expect(renewed.heartbeatAt >= original.heartbeatAt).toBe(true);
    });

    it("throws NoActiveLeaseError when no lease exists", () => {
      service.createTask({
        id: "task-no-lease",
        title: "NoLease",
        status: "planned",
        scope: [],
      });
      expect(() => {
        service.renewLease({
          taskId: "task-no-lease",
          agentId: "agent-alpha",
          ttlSeconds: 300,
        });
      }).toThrow(NoActiveLeaseError);
    });

    it("throws LeaseOwnershipError when a different agent tries to renew", () => {
      service.createTask({
        id: "task-owner-renew",
        title: "Owner renew",
        status: "planned",
        scope: [],
      });
      service.claimLease({
        taskId: "task-owner-renew",
        agentId: "agent-alpha",
        ttlSeconds: 300,
        scope: [],
      });

      expect(() => {
        service.renewLease({
          taskId: "task-owner-renew",
          agentId: "agent-beta",
          ttlSeconds: 300,
        });
      }).toThrow(LeaseOwnershipError);
    });
  });

  // -------------------------------------------------------------------------
  // Release
  // -------------------------------------------------------------------------
  describe("releaseLease", () => {
    it("removes the lease and sets the task to the given final status", () => {
      service.createTask({
        id: "task-release",
        title: "Release",
        status: "planned",
        scope: [],
      });
      service.claimLease({
        taskId: "task-release",
        agentId: "agent-alpha",
        ttlSeconds: 300,
        scope: [],
      });

      const updated = service.releaseLease({
        taskId: "task-release",
        agentId: "agent-alpha",
        finalStatus: "done",
      });

      expect(updated.status).toBe("done");
      expect(service.getLease("task-release")).toBeNull();
    });

    it("accepts all valid final statuses: review, done, blocked, planned", () => {
      const statuses = ["review", "done", "blocked", "planned"] as const;
      for (const finalStatus of statuses) {
        const taskId = `task-rel-${finalStatus}`;
        service.createTask({
          id: taskId,
          title: finalStatus,
          status: "planned",
          scope: [],
        });
        service.claimLease({
          taskId,
          agentId: "agent-alpha",
          ttlSeconds: 300,
          scope: [],
        });
        const result = service.releaseLease({
          taskId,
          agentId: "agent-alpha",
          finalStatus,
        });
        expect(result.status).toBe(finalStatus);
      }
    });

    it("throws NoActiveLeaseError when releasing a task with no lease", () => {
      service.createTask({
        id: "task-rel-norel",
        title: "No release",
        status: "planned",
        scope: [],
      });
      expect(() => {
        service.releaseLease({
          taskId: "task-rel-norel",
          agentId: "agent-alpha",
          finalStatus: "done",
        });
      }).toThrow(NoActiveLeaseError);
    });

    it("throws LeaseOwnershipError when a non-owner tries to release", () => {
      service.createTask({
        id: "task-rel-owner",
        title: "Owner release",
        status: "planned",
        scope: [],
      });
      service.claimLease({
        taskId: "task-rel-owner",
        agentId: "agent-alpha",
        ttlSeconds: 300,
        scope: [],
      });

      expect(() => {
        service.releaseLease({
          taskId: "task-rel-owner",
          agentId: "agent-beta",
          finalStatus: "done",
        });
      }).toThrow(LeaseOwnershipError);
    });

    it("writes a task.lease_released audit event", () => {
      service.createTask({
        id: "task-rel-audit",
        title: "Rel audit",
        status: "planned",
        scope: [],
      });
      service.claimLease({
        taskId: "task-rel-audit",
        agentId: "agent-alpha",
        ttlSeconds: 300,
        scope: [],
      });
      service.releaseLease({
        taskId: "task-rel-audit",
        agentId: "agent-alpha",
        finalStatus: "review",
      });

      const db = service.getDatabase();
      const row = db
        .prepare(
          "SELECT actor, payload_json FROM audit_events WHERE event_type = 'task.lease_released' AND entity_id = ?",
        )
        .get("task-rel-audit") as
        { actor: string; payload_json: string } | undefined;

      expect(row).toBeDefined();
      expect(row!.actor).toBe("agent-alpha");
      expect(JSON.parse(row!.payload_json).final_status).toBe("review");
    });
  });

  // -------------------------------------------------------------------------
  // Stale takeover
  // -------------------------------------------------------------------------
  describe("takeoverLease", () => {
    function createExpiredLease(taskId: string, holderAgent: string): void {
      service.createTask({
        id: taskId,
        title: taskId,
        status: "planned",
        scope: [],
      });
      service.claimLease({
        taskId,
        agentId: holderAgent,
        ttlSeconds: 300,
        scope: [],
      });
      const pastExpiry = new Date(Date.now() - 1000).toISOString();
      service
        .getDatabase()
        .prepare("UPDATE task_leases SET expires_at = ? WHERE task_id = ?")
        .run(pastExpiry, taskId);
    }

    it("succeeds on an expired lease and sets a new lease for the incoming agent", () => {
      createExpiredLease("task-takeover", "agent-alpha");

      const newLease = service.takeoverLease({
        taskId: "task-takeover",
        agentId: "agent-beta",
        reason: "Alpha process disappeared after the host machine suspended.",
        ttlSeconds: 300,
        scope: [],
      });

      expect(newLease.agentId).toBe("agent-beta");
      expect(newLease.taskId).toBe("task-takeover");
      expect(newLease.version).toBe(1);
    });

    it("writes a task.lease_takeover audit event naming both agents and the reason", () => {
      createExpiredLease("task-takeover-audit", "agent-alpha");

      service.takeoverLease({
        taskId: "task-takeover-audit",
        agentId: "agent-beta",
        reason: "Stale after crash.",
        ttlSeconds: 300,
        scope: [],
      });

      const db = service.getDatabase();
      const row = db
        .prepare(
          "SELECT actor, payload_json FROM audit_events WHERE event_type = 'task.lease_takeover' AND entity_id = ?",
        )
        .get("task-takeover-audit") as
        { actor: string; payload_json: string } | undefined;

      expect(row).toBeDefined();
      expect(row!.actor).toBe("agent-beta");
      const payload = JSON.parse(row!.payload_json);
      expect(payload.displaced_agent).toBe("agent-alpha");
      expect(payload.incoming_agent).toBe("agent-beta");
      expect(payload.reason).toBe("Stale after crash.");
    });

    it("refuses takeover when the lease has not yet expired", () => {
      service.createTask({
        id: "task-live-lease",
        title: "Live",
        status: "planned",
        scope: [],
      });
      service.claimLease({
        taskId: "task-live-lease",
        agentId: "agent-alpha",
        ttlSeconds: 300,
        scope: [],
      });

      expect(() => {
        service.takeoverLease({
          taskId: "task-live-lease",
          agentId: "agent-beta",
          reason: "I want it.",
          ttlSeconds: 300,
          scope: [],
        });
      }).toThrow(LeaseNotStaleError);
    });

    it("refuses takeover with an empty or whitespace reason", () => {
      createExpiredLease("task-no-reason", "agent-alpha");

      expect(() => {
        service.takeoverLease({
          taskId: "task-no-reason",
          agentId: "agent-beta",
          reason: "   ",
          ttlSeconds: 300,
          scope: [],
        });
      }).toThrow(TakeoverReasonRequiredError);

      expect(() => {
        service.takeoverLease({
          taskId: "task-no-reason",
          agentId: "agent-beta",
          reason: "",
          ttlSeconds: 300,
          scope: [],
        });
      }).toThrow(TakeoverReasonRequiredError);
    });

    it("refuses takeover when no lease exists at all", () => {
      service.createTask({
        id: "task-none",
        title: "NoLease",
        status: "planned",
        scope: [],
      });

      expect(() => {
        service.takeoverLease({
          taskId: "task-none",
          agentId: "agent-beta",
          reason: "Taking over.",
          ttlSeconds: 300,
          scope: [],
        });
      }).toThrow(NoActiveLeaseError);
    });
  });

  // -------------------------------------------------------------------------
  // getLease and listLeases
  // -------------------------------------------------------------------------
  describe("getLease and listLeases", () => {
    it("getLease returns null when no lease exists", () => {
      service.createTask({
        id: "task-get-null",
        title: "GetNull",
        status: "planned",
        scope: [],
      });
      expect(service.getLease("task-get-null")).toBeNull();
    });

    it("getLease returns the current lease", () => {
      service.createTask({
        id: "task-get",
        title: "Get",
        status: "planned",
        scope: [],
      });
      service.claimLease({
        taskId: "task-get",
        agentId: "agent-alpha",
        ttlSeconds: 300,
        scope: [],
      });

      const lease = service.getLease("task-get");
      expect(lease).not.toBeNull();
      expect(lease!.agentId).toBe("agent-alpha");
    });

    it("listLeases returns all active leases", () => {
      service.createTask({
        id: "task-list-a",
        title: "A",
        status: "planned",
        scope: [],
      });
      service.createTask({
        id: "task-list-b",
        title: "B",
        status: "planned",
        scope: [],
      });
      service.claimLease({
        taskId: "task-list-a",
        agentId: "agent-alpha",
        ttlSeconds: 300,
        scope: [],
      });
      service.claimLease({
        taskId: "task-list-b",
        agentId: "agent-beta",
        ttlSeconds: 300,
        scope: [],
      });

      const leases = service.listLeases();
      expect(leases.map((l) => l.taskId)).toContain("task-list-a");
      expect(leases.map((l) => l.taskId)).toContain("task-list-b");
    });
  });

  // -------------------------------------------------------------------------
  // Multi-process concurrency via child_process
  // -------------------------------------------------------------------------
  describe("Single-machine multi-process concurrency via child_process", () => {
    interface WorkerResult {
      ok: boolean;
      lease?: {
        taskId: string;
        agentId: string;
        acquiredAt: string;
        heartbeatAt: string;
        expiresAt: string;
        version: number;
      };
      task?: {
        id: string;
        title: string;
        description: string;
        status: string;
        scope: string[];
        version: number;
      };
      error?: string;
      name?: string;
    }

    function runWorker(
      workspaceDir: string,
      command: string,
      args: Record<string, unknown> = {},
    ): Promise<WorkerResult> {
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
            resolve(JSON.parse(stdout.trim()) as WorkerResult);
          } catch {
            reject(
              new Error(
                `Worker failed to return valid JSON: ${stdout} (stderr: ${stderr})`,
              ),
            );
          }
        });
      });
    }

    it("two OS processes claim two DIFFERENT tasks concurrently and both succeed", async () => {
      service.createTask({
        id: "task-diff-alpha",
        title: "Alpha Task",
        status: "planned",
        scope: ["src/alpha"],
      });
      service.createTask({
        id: "task-diff-beta",
        title: "Beta Task",
        status: "planned",
        scope: ["src/beta"],
      });

      const [res1, res2] = await Promise.all([
        runWorker(tempDir, "claim", {
          taskId: "task-diff-alpha",
          agentId: "agent-alpha",
          scope: ["src/alpha"],
        }),
        runWorker(tempDir, "claim", {
          taskId: "task-diff-beta",
          agentId: "agent-beta",
          scope: ["src/beta"],
        }),
      ]);

      expect(res1.ok).toBe(true);
      expect(res1.lease).toBeDefined();
      expect(res1.lease?.taskId).toBe("task-diff-alpha");
      expect(res1.lease?.agentId).toBe("agent-alpha");

      expect(res2.ok).toBe(true);
      expect(res2.lease).toBeDefined();
      expect(res2.lease?.taskId).toBe("task-diff-beta");
      expect(res2.lease?.agentId).toBe("agent-beta");

      const lease1 = service.getLease("task-diff-alpha");
      const lease2 = service.getLease("task-diff-beta");
      expect(lease1?.agentId).toBe("agent-alpha");
      expect(lease2?.agentId).toBe("agent-beta");
    });

    it("two OS processes claim the SAME task and exactly one succeeds; the loser gets a clear refusal", async () => {
      service.createTask({
        id: "task-same-conflict",
        title: "Same Task",
        status: "planned",
        scope: ["src/common"],
      });

      const [res1, res2] = await Promise.all([
        runWorker(tempDir, "claim", {
          taskId: "task-same-conflict",
          agentId: "agent-alpha",
          scope: ["src/common"],
        }),
        runWorker(tempDir, "claim", {
          taskId: "task-same-conflict",
          agentId: "agent-beta",
          scope: ["src/common"],
        }),
      ]);

      const successCount = (res1.ok ? 1 : 0) + (res2.ok ? 1 : 0);
      const failCount = (!res1.ok ? 1 : 0) + (!res2.ok ? 1 : 0);

      expect(successCount).toBe(1);
      expect(failCount).toBe(1);

      const winner = res1.ok ? res1 : res2;
      const loser = !res1.ok ? res1 : res2;

      expect(winner.lease).toBeDefined();
      expect(winner.lease?.taskId).toBe("task-same-conflict");
      expect(["agent-alpha", "agent-beta"]).toContain(winner.lease?.agentId);

      expect(loser.name).toBe("LeaseConflictError");
      expect(loser.error).toMatch(/already claimed by agent/);
      expect(loser.error).toMatch(/Overlapping scopes: \[src\/common\]/);
    });

    it("a stale takeover without a reason is refused, and one with a reason produces an audit row naming both agents and the reason", async () => {
      service.createTask({
        id: "task-takeover-proc",
        title: "Takeover Proc Task",
        status: "planned",
        scope: ["src/worker"],
      });
      service.claimLease({
        taskId: "task-takeover-proc",
        agentId: "agent-alpha",
        ttlSeconds: 300,
        scope: ["src/worker"],
      });

      // Backdate the lease so it is expired
      const pastExpiry = new Date(Date.now() - 5000).toISOString();
      service
        .getDatabase()
        .prepare("UPDATE task_leases SET expires_at = ? WHERE task_id = ?")
        .run(pastExpiry, "task-takeover-proc");

      // Refused when reason is missing/empty
      const noReasonRes = await runWorker(tempDir, "takeover", {
        taskId: "task-takeover-proc",
        agentId: "agent-beta",
        reason: "",
      });

      expect(noReasonRes.ok).toBe(false);
      expect(noReasonRes.name).toBe("TakeoverReasonRequiredError");

      // Accepted with non-empty reason
      const withReasonRes = await runWorker(tempDir, "takeover", {
        taskId: "task-takeover-proc",
        agentId: "agent-beta",
        reason: "Agent alpha process terminated unexpectedly.",
        scope: ["src/worker"],
      });

      expect(withReasonRes.ok).toBe(true);
      expect(withReasonRes.lease?.agentId).toBe("agent-beta");
      expect(withReasonRes.lease?.taskId).toBe("task-takeover-proc");

      const db = service.getDatabase();
      const auditRow = db
        .prepare(
          "SELECT actor, payload_json FROM audit_events WHERE event_type = 'task.lease_takeover' AND entity_id = ?",
        )
        .get("task-takeover-proc") as
        { actor: string; payload_json: string } | undefined;

      expect(auditRow).toBeDefined();
      expect(auditRow?.actor).toBe("agent-beta");
      const payload = JSON.parse(auditRow!.payload_json);
      expect(payload.displaced_agent).toBe("agent-alpha");
      expect(payload.incoming_agent).toBe("agent-beta");
      expect(payload.reason).toBe(
        "Agent alpha process terminated unexpectedly.",
      );
    });
  });
});
