import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ApprovalGateError,
  ContextService,
  initializeWorkspace,
  type AgentRecord,
  type ActorContext,
  type SessionRecord,
} from "../src/index.js";

describe("Agents, sessions and the policy model", () => {
  let tempDir: string;
  let service: ContextService;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "contextpact-agent-test-"));
    initializeWorkspace(tempDir, "Agent Test Workspace");
    service = new ContextService(tempDir);
  });

  afterEach(() => {
    service.close();
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // Agent registration
  // -------------------------------------------------------------------------
  describe("Agent registration", () => {
    it("registers an agent with client_kind and profile populated", () => {
      const agent = service.registerAgent({
        id: "agent-mcp-001",
        displayName: "MCP Builder",
        clientKind: "mcp",
        profile: "default",
      });

      expect(agent.id).toBe("agent-mcp-001");
      expect(agent.displayName).toBe("MCP Builder");
      expect(agent.clientKind).toBe("mcp");
      expect(agent.profile).toBe("default");
      expect(agent.lastSeenAt).not.toBeNull();
      expect(agent.createdAt).not.toBeNull();
    });

    it("retrieves a registered agent by id", () => {
      service.registerAgent({
        id: "agent-fetch-me",
        displayName: "Fetch Test Agent",
        clientKind: "cli",
        profile: "default",
      });

      const fetched = service.getAgent("agent-fetch-me");
      expect(fetched).not.toBeNull();
      expect(fetched!.displayName).toBe("Fetch Test Agent");
      expect(fetched!.clientKind).toBe("cli");
    });

    it("lists all registered agents", () => {
      service.registerAgent({
        id: "agent-list-a",
        displayName: "Agent A",
        clientKind: "mcp",
        profile: "default",
      });
      service.registerAgent({
        id: "agent-list-b",
        displayName: "Agent B",
        clientKind: "cli",
        profile: "elevated",
      });

      const agents = service.listAgents();
      const ids = agents.map((a) => a.id);
      expect(ids).toContain("agent-list-a");
      expect(ids).toContain("agent-list-b");
    });

    it("assigns a generated id when none is supplied", () => {
      const agent = service.registerAgent({
        displayName: "Auto ID Agent",
        clientKind: "mcp",
        profile: "default",
      });

      expect(agent.id).toMatch(/^agent-/);
    });

    it("writes an audit event for each registration", () => {
      service.registerAgent({
        id: "agent-audit-check",
        displayName: "Audit Check Agent",
        clientKind: "mcp",
        profile: "default",
      });

      const db = service.getDatabase();
      const row = db
        .prepare(
          "SELECT actor, entity_id, payload_json FROM audit_events WHERE event_type = 'agent.registered' AND entity_id = ?",
        )
        .get("agent-audit-check") as
        { actor: string; entity_id: string; payload_json: string } | undefined;

      expect(row).toBeDefined();
      expect(row!.entity_id).toBe("agent-audit-check");
      const payload = JSON.parse(row!.payload_json);
      expect(payload.client_kind).toBe("mcp");
      expect(payload.profile).toBe("default");
    });

    it("updates client_kind and profile on re-registration (upsert)", () => {
      service.registerAgent({
        id: "agent-upsert",
        displayName: "Original Name",
        clientKind: "mcp",
        profile: "default",
      });

      const updated = service.registerAgent({
        id: "agent-upsert",
        displayName: "Updated Name",
        clientKind: "cli",
        profile: "elevated",
      });

      expect(updated.clientKind).toBe("cli");
      expect(updated.profile).toBe("elevated");

      const fetched = service.getAgent("agent-upsert");
      expect(fetched!.clientKind).toBe("cli");
      expect(fetched!.profile).toBe("elevated");
    });
  });

  // -------------------------------------------------------------------------
  // Session lifecycle
  // -------------------------------------------------------------------------
  describe("Session lifecycle", () => {
    let registeredAgent: AgentRecord;

    beforeEach(() => {
      registeredAgent = service.registerAgent({
        id: "agent-session-host",
        displayName: "Session Host",
        clientKind: "mcp",
        profile: "default",
      });
    });

    it("starts a session for a registered agent", () => {
      const session = service.startSession({ agentId: registeredAgent.id });

      expect(session.id).toMatch(/^session-/);
      expect(session.agentId).toBe(registeredAgent.id);
      expect(session.status).toBe("active");
      expect(session.startedAt).not.toBeNull();
      expect(session.endedAt).toBeNull();
    });

    it("starts a session linked to a task", () => {
      const task = service.createTask({
        id: "task-sess-link",
        title: "Linked Task",
        description: "",
        status: "planned",
        scope: [],
      });

      const session = service.startSession({
        agentId: registeredAgent.id,
        taskId: task.id,
      });

      expect(session.taskId).toBe(task.id);
    });

    it("ends an active session", () => {
      const session = service.startSession({ agentId: registeredAgent.id });
      const ended = service.endSession(session.id);

      expect(ended.status).toBe("ended");
      expect(ended.endedAt).not.toBeNull();

      const fetched = service.getSession(session.id);
      expect(fetched!.status).toBe("ended");
    });

    it("fails an active session with a reason", () => {
      const session = service.startSession({ agentId: registeredAgent.id });
      const failed = service.failSession(session.id, {
        reason: "Process crashed unexpectedly.",
      });

      expect(failed.status).toBe("failed");
      expect(failed.endedAt).not.toBeNull();

      const db = service.getDatabase();
      const auditRow = db
        .prepare(
          "SELECT payload_json FROM audit_events WHERE event_type = 'session.failed' AND entity_id = ?",
        )
        .get(session.id) as { payload_json: string } | undefined;

      expect(auditRow).toBeDefined();
      const payload = JSON.parse(auditRow!.payload_json);
      expect(payload.reason).toBe("Process crashed unexpectedly.");
    });

    it("refuses to end a session that is already ended", () => {
      const session = service.startSession({ agentId: registeredAgent.id });
      service.endSession(session.id);

      expect(() => {
        service.endSession(session.id);
      }).toThrow(/not active/);
    });

    it("refuses to fail a session that is already failed", () => {
      const session = service.startSession({ agentId: registeredAgent.id });
      service.failSession(session.id);

      expect(() => {
        service.failSession(session.id);
      }).toThrow(/not active/);
    });

    it("refuses to start a session for an unregistered agent", () => {
      expect(() => {
        service.startSession({ agentId: "agent-does-not-exist" });
      }).toThrow(/not registered/);
    });

    it("refuses to start a session linked to a non-existent task", () => {
      expect(() => {
        service.startSession({
          agentId: registeredAgent.id,
          taskId: "task-ghost",
        });
      }).toThrow(/not found/);
    });

    it("lists sessions filtered by agentId and status", () => {
      const s1 = service.startSession({ agentId: registeredAgent.id });
      const s2 = service.startSession({ agentId: registeredAgent.id });
      service.endSession(s1.id);

      const activeSessions = service.listSessions({
        agentId: registeredAgent.id,
        status: "active",
      });
      expect(activeSessions.map((s) => s.id)).toContain(s2.id);
      expect(activeSessions.map((s) => s.id)).not.toContain(s1.id);
    });

    it("writes audit events for session.started, session.ended, and session.failed", () => {
      const s1 = service.startSession({ agentId: registeredAgent.id });
      service.endSession(s1.id);

      const s2 = service.startSession({ agentId: registeredAgent.id });
      service.failSession(s2.id);

      const db = service.getDatabase();

      const startedRow = db
        .prepare(
          "SELECT actor FROM audit_events WHERE event_type = 'session.started' AND entity_id = ?",
        )
        .get(s1.id) as { actor: string } | undefined;
      expect(startedRow).toBeDefined();
      expect(startedRow!.actor).toBe(registeredAgent.id);

      const endedRow = db
        .prepare(
          "SELECT actor FROM audit_events WHERE event_type = 'session.ended' AND entity_id = ?",
        )
        .get(s1.id) as { actor: string } | undefined;
      expect(endedRow).toBeDefined();

      const failedRow = db
        .prepare(
          "SELECT actor FROM audit_events WHERE event_type = 'session.failed' AND entity_id = ?",
        )
        .get(s2.id) as { actor: string } | undefined;
      expect(failedRow).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // Two concurrent agents are distinguishable in every audit row they cause
  // -------------------------------------------------------------------------
  describe("Concurrent agent distinguishability", () => {
    it("two simultaneously registered agents produce distinct audit rows for every action each takes", () => {
      // Register two agents representing separate local processes
      const agentAlpha = service.registerAgent({
        id: "proc-alpha",
        displayName: "Alpha Process",
        clientKind: "mcp",
        profile: "default",
      });

      const agentBeta = service.registerAgent({
        id: "proc-beta",
        displayName: "Beta Process",
        clientKind: "cli",
        profile: "default",
      });

      // Both are retrievable and distinct
      expect(agentAlpha.id).not.toBe(agentBeta.id);
      expect(agentAlpha.clientKind).toBe("mcp");
      expect(agentBeta.clientKind).toBe("cli");

      const actorAlpha: ActorContext = {
        actor: agentAlpha.id,
        source: "agent",
        profile: "default",
      };

      const actorBeta: ActorContext = {
        actor: agentBeta.id,
        source: "agent",
        profile: "default",
      };

      // Each proposes durable knowledge under its own identity
      const propAlpha = service.propose(
        {
          id: "ctx-alpha-proposal",
          type: "fact",
          title: "Alpha discovered fact",
          content: "Alpha process observation.",
        },
        actorAlpha,
      );

      const propBeta = service.propose(
        {
          id: "ctx-beta-proposal",
          type: "fact",
          title: "Beta discovered fact",
          content: "Beta process observation.",
        },
        actorBeta,
      );

      // Each proposal has the correct author on the item itself
      expect(propAlpha.actor).toBe(agentAlpha.id);
      expect(propBeta.actor).toBe(agentBeta.id);

      // Audit rows carry each agent's own id — no row is attributed to the other
      const auditAlpha = service.getAuditEvents("ctx-alpha-proposal");
      const auditBeta = service.getAuditEvents("ctx-beta-proposal");

      expect(auditAlpha).toHaveLength(1);
      expect(auditAlpha[0]!.actor).toBe(agentAlpha.id);

      expect(auditBeta).toHaveLength(1);
      expect(auditBeta[0]!.actor).toBe(agentBeta.id);

      // The two actors never appear in each other's audit rows
      expect(auditAlpha[0]!.actor).not.toBe(agentBeta.id);
      expect(auditBeta[0]!.actor).not.toBe(agentAlpha.id);
    });

    it("session audit rows carry the acting agent's id, not the other agent's id", () => {
      service.registerAgent({
        id: "proc-c",
        displayName: "Process C",
        clientKind: "mcp",
        profile: "default",
      });
      service.registerAgent({
        id: "proc-d",
        displayName: "Process D",
        clientKind: "mcp",
        profile: "default",
      });

      const sessionC = service.startSession({ agentId: "proc-c" });
      const sessionD = service.startSession({ agentId: "proc-d" });

      service.endSession(sessionC.id);
      service.failSession(sessionD.id);

      const db = service.getDatabase();

      const cRows = db
        .prepare(
          "SELECT actor FROM audit_events WHERE entity_type = 'session' AND entity_id = ? ORDER BY id ASC",
        )
        .all(sessionC.id) as Array<{ actor: string }>;

      const dRows = db
        .prepare(
          "SELECT actor FROM audit_events WHERE entity_type = 'session' AND entity_id = ? ORDER BY id ASC",
        )
        .all(sessionD.id) as Array<{ actor: string }>;

      // Every audit row for session C names proc-c
      for (const row of cRows) {
        expect(row.actor).toBe("proc-c");
      }
      // Every audit row for session D names proc-d
      for (const row of dRows) {
        expect(row.actor).toBe("proc-d");
      }

      // Sanity: the two sets are disjoint
      expect(cRows.map((r) => r.actor)).not.toContain("proc-d");
      expect(dRows.map((r) => r.actor)).not.toContain("proc-c");
    });
  });

  // -------------------------------------------------------------------------
  // Profile as a capability set — approval gate enforced at the SERVICE LAYER
  //
  // This test proves the refusal happens inside ContextService.approve(),
  // which is the domain service below any adapter (MCP, CLI, etc.).
  // -------------------------------------------------------------------------
  describe("Profile capability enforcement at the service layer", () => {
    it("default profile is refused approve_durable at ContextService.approve(), independent of any adapter", () => {
      // Register an agent holding the default (MCP) profile
      service.registerAgent({
        id: "proc-default",
        displayName: "Default Process",
        clientKind: "mcp",
        profile: "default",
      });

      const humanActor: ActorContext = {
        actor: "human-op",
        source: "human",
        profile: "human",
      };

      // Human creates a durable proposal
      const proposal = service.propose(
        {
          id: "fact-for-gate",
          type: "fact",
          title: "Gate test",
          content: "Needs human approval.",
        },
        humanActor,
      );
      expect(proposal.status).toBe("proposed");

      // Build an ActorContext as the default-profile agent
      const defaultActor: ActorContext = {
        actor: "proc-default",
        source: "agent",
        profile: "default",
      };

      // Call ContextService.approve() directly — no MCP adapter involved
      expect(() => {
        service.approve(proposal.id, defaultActor);
      }).toThrow(ApprovalGateError);

      // The item is still proposed — the refusal was effective
      const reloaded = service.getItem(proposal.id);
      expect(reloaded!.status).toBe("proposed");
    });

    it("elevated profile can approve durable knowledge at the service layer", () => {
      service.registerAgent({
        id: "proc-elevated",
        displayName: "Elevated Reviewer",
        clientKind: "mcp",
        profile: "elevated",
      });

      const defaultActor: ActorContext = {
        actor: "proc-default-author",
        source: "agent",
        profile: "default",
      };
      const elevatedActor: ActorContext = {
        actor: "proc-elevated",
        source: "agent",
        profile: "elevated",
      };

      const proposal = service.propose(
        {
          id: "fact-elevated-gate",
          type: "fact",
          title: "Elevated approval test",
          content: "Ready for elevated review.",
        },
        defaultActor,
      );

      const approved = service.approve(proposal.id, elevatedActor);
      expect(approved.status).toBe("approved");
    });

    it("default-profile agent cannot approve its own proposal at the service layer", () => {
      service.registerAgent({
        id: "proc-self-approver",
        displayName: "Self-Approver Attempt",
        clientKind: "mcp",
        profile: "elevated",
      });

      const elevatedActor: ActorContext = {
        actor: "proc-self-approver",
        source: "agent",
        profile: "elevated",
      };

      const proposal = service.propose(
        {
          id: "fact-self-gate",
          type: "fact",
          title: "Self approval test",
          content: "Author trying to self-approve.",
        },
        elevatedActor,
      );

      // Same agent attempts to approve its own proposal
      expect(() => {
        service.approve(proposal.id, elevatedActor);
      }).toThrow(ApprovalGateError);

      const reloaded = service.getItem(proposal.id);
      expect(reloaded!.status).toBe("proposed");
    });
  });

  // -------------------------------------------------------------------------
  // last_seen_at maintenance
  // -------------------------------------------------------------------------
  describe("last_seen_at maintenance", () => {
    it("last_seen_at is set at registration time", () => {
      const before = new Date().toISOString();
      const agent = service.registerAgent({
        id: "agent-lsa-reg",
        displayName: "LSA Registration",
        clientKind: "mcp",
        profile: "default",
      });
      const after = new Date().toISOString();

      expect(agent.lastSeenAt).not.toBeNull();
      expect(agent.lastSeenAt! >= before).toBe(true);
      expect(agent.lastSeenAt! <= after).toBe(true);
    });

    it("last_seen_at advances when a session is started or ended", async () => {
      const agent = service.registerAgent({
        id: "agent-lsa-session",
        displayName: "LSA Session",
        clientKind: "mcp",
        profile: "default",
      });

      const atReg = agent.lastSeenAt!;

      // Small delay so the timestamps differ
      await new Promise((r) => setTimeout(r, 5));

      const session = service.startSession({ agentId: agent.id });

      const afterStart = service.getAgent(agent.id)!.lastSeenAt!;
      expect(afterStart > atReg).toBe(true);

      await new Promise((r) => setTimeout(r, 5));

      service.endSession(session.id);

      const afterEnd = service.getAgent(agent.id)!.lastSeenAt!;
      expect(afterEnd > afterStart).toBe(true);
    });

    it("heartbeatAgent advances last_seen_at and returns the updated record", async () => {
      service.registerAgent({
        id: "agent-hb",
        displayName: "Heartbeat Agent",
        clientKind: "mcp",
        profile: "default",
      });

      const before = service.getAgent("agent-hb")!.lastSeenAt!;

      await new Promise((r) => setTimeout(r, 5));

      const updated = service.heartbeatAgent("agent-hb");

      expect(updated.lastSeenAt).not.toBeNull();
      expect(updated.lastSeenAt! > before).toBe(true);
    });

    it("heartbeatAgent throws for an unregistered agent id", () => {
      expect(() => {
        service.heartbeatAgent("agent-phantom");
      }).toThrow(/not found/);
    });

    it("resolveActor touching an agent by id advances last_seen_at", async () => {
      service.registerAgent({
        id: "agent-resolve-touch",
        displayName: "Resolve Touch",
        clientKind: "mcp",
        profile: "default",
      });

      const before = service.getAgent("agent-resolve-touch")!.lastSeenAt!;

      await new Promise((r) => setTimeout(r, 5));

      service.resolveActor("agent-resolve-touch");

      const after = service.getAgent("agent-resolve-touch")!.lastSeenAt!;
      expect(after > before).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Policy rows controlling scope visibility
  // -------------------------------------------------------------------------
  describe("Policy-driven scope visibility", () => {
    it("creates a policy with allowGlobal:false so global scope is excluded from packs", () => {
      const humanActor: ActorContext = {
        actor: "human-policy",
        source: "human",
        profile: "human",
      };

      // Create policy that blocks global
      const policy = service.createPolicy({
        id: "pol-no-global",
        name: "no-global",
        description: "Blocks global context",
        rules: { allowGlobal: false },
      });

      // Create a global-scope item
      service.create(
        {
          id: "ctx-global-item",
          type: "fact",
          scope: "global",
          title: "Global fact",
          content: "Should be policy-restricted.",
          status: "approved",
        },
        humanActor,
      );

      // Pack with this policy: global item must be omitted
      const pack = service.buildPack({ policyId: policy.id });

      expect(pack.items.some((i) => i.id === "ctx-global-item")).toBe(false);
      expect(
        pack.omissions.some(
          (o) => o.id === "ctx-global-item" && o.reason === "policy_restricted",
        ),
      ).toBe(true);
    });

    it("creates a policy with allowGlobal:true so global scope IS included in packs", () => {
      const humanActor: ActorContext = {
        actor: "human-policy",
        source: "human",
        profile: "human",
      };

      const policy = service.createPolicy({
        id: "pol-allow-global",
        name: "allow-global",
        description: "Permits global context",
        rules: { allowGlobal: true },
      });

      service.create(
        {
          id: "ctx-global-allowed",
          type: "fact",
          scope: "global",
          title: "Global fact allowed",
          content: "Should be included when policy allows.",
          status: "approved",
        },
        humanActor,
      );

      const pack = service.buildPack({ policyId: policy.id });
      expect(pack.items.some((i) => i.id === "ctx-global-allowed")).toBe(true);
    });

    it("retrieves and deletes a policy", () => {
      service.createPolicy({
        id: "pol-to-delete",
        name: "delete-me",
        description: "",
        rules: {},
      });

      expect(service.getPolicy("pol-to-delete")).not.toBeNull();

      const deleted = service.deletePolicy("pol-to-delete");
      expect(deleted).toBe(true);

      expect(service.getPolicy("pol-to-delete")).toBeNull();
    });

    it("isScopeVisible reflects policy rules for global scope", () => {
      service.createPolicy({
        id: "pol-vis-test",
        name: "vis-test",
        description: "",
        rules: { allowGlobal: false },
      });

      expect(service.isScopeVisible("global", "pol-vis-test")).toBe(false);
      expect(service.isScopeVisible("workspace", "pol-vis-test")).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // resolveActor correctly maps agent id to its registered profile
  // -------------------------------------------------------------------------
  describe("resolveActor profile inheritance", () => {
    it("resolveActor returns the profile stored in the agents table", () => {
      service.registerAgent({
        id: "agent-profile-check",
        displayName: "Profile Check Agent",
        clientKind: "mcp",
        profile: "elevated",
      });

      const resolved = service.resolveActor("agent-profile-check");
      expect(resolved.profile).toBe("elevated");
      expect(resolved.source).toBe("agent");
    });

    it("resolveActor falls back to default profile for unknown actor strings", () => {
      const resolved = service.resolveActor("agent-unknown-xyz");
      expect(resolved.profile).toBe("default");
      expect(resolved.source).toBe("agent");
    });

    it("resolveActor derives source:human when clientKind is human", () => {
      service.registerAgent({
        id: "agent-human-kind",
        displayName: "Human Client",
        clientKind: "human",
        profile: "human",
      });

      const resolved = service.resolveActor("agent-human-kind");
      expect(resolved.source).toBe("human");
    });
  });
});
