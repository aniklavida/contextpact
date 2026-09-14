import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ApprovalGateError,
  ContextService,
  initializeWorkspace,
  LifecycleTransitionError,
  readMarkdownKnowledgeItem,
  type ActorContext,
  type ContextItem,
} from "../src/index.js";

describe("Lifecycle, supersession and approval gate", () => {
  let tempDir: string;
  let service: ContextService;

  const humanActor: ActorContext = {
    actor: "anik",
    source: "human",
    profile: "human",
  };

  const defaultAgentActor: ActorContext = {
    actor: "agent-builder",
    source: "agent",
    profile: "default",
  };

  const elevatedAgentActor: ActorContext = {
    actor: "agent-reviewer",
    source: "agent",
    profile: "elevated",
  };

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "contextpact-lifecycle-test-"));
    initializeWorkspace(tempDir, "Lifecycle Workspace");
    service = new ContextService(tempDir);
  });

  afterEach(() => {
    service.close();
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe("Actor permissions and knowledge creation", () => {
    it("creates agent-authored durable knowledge as proposed by default", () => {
      const item = service.create(
        {
          id: "dec-storage-arch",
          type: "decision",
          title: "Storage architecture",
          content: "Use SQLite for metadata and Markdown for content.",
        },
        defaultAgentActor,
      );

      expect(item.status).toBe("proposed");
      expect(item.actor).toBe("agent-builder");
      expect(item.source).toBe("agent");

      // Verify audit event exists
      const audit = service.getAuditEvents("dec-storage-arch");
      expect(audit).toHaveLength(1);
      expect(audit[0]?.actor).toBe("agent-builder");
      expect(audit[0]?.event_type).toBe("context.created");
      expect(audit[0]?.payload["status"]).toBe("proposed");
    });

    it("refuses agent attempting to create durable knowledge directly as approved", () => {
      expect(() => {
        service.create(
          {
            id: "dec-cheat",
            type: "decision",
            title: "Bypass attempt",
            content: "Try to self-approve on creation.",
            status: "approved",
          },
          defaultAgentActor,
        );
      }).toThrow(ApprovalGateError);

      expect(() => {
        service.create(
          {
            id: "rule-cheat",
            type: "rule",
            title: "Rule bypass attempt",
            content: "Try to self-approve rule on creation.",
            status: "approved",
          },
          defaultAgentActor,
        );
      }).toThrow(ApprovalGateError);
    });

    it("allows human or elevated profile to create durable knowledge directly as approved", () => {
      const item = service.create(
        {
          id: "dec-human-approved",
          type: "decision",
          title: "Human approved decision",
          content: "Decided directly by the user.",
          status: "approved",
        },
        humanActor,
      );

      expect(item.status).toBe("approved");
      expect(item.actor).toBe("anik");
    });

    it("allows agent to write operational task state and handoff state immediately", () => {
      const taskNote = service.create(
        {
          id: "op-note-1",
          type: "task_note",
          title: "Work log for parser update",
          content: "Finished AST generator.",
          status: "approved",
        },
        defaultAgentActor,
      );

      const handoff = service.create(
        {
          id: "handoff-1",
          type: "handoff",
          title: "Handoff to review agent",
          content: "Ready for integration testing.",
          status: "approved",
        },
        defaultAgentActor,
      );

      expect(taskNote.status).toBe("approved");
      expect(handoff.status).toBe("approved");

      const taskAudits = service.getAuditEvents("op-note-1");
      expect(taskAudits).toHaveLength(1);
      expect(taskAudits[0]?.actor).toBe("agent-builder");
      expect(taskAudits[0]?.payload["source"]).toBe("agent");
    });
  });

  describe("Approval gate", () => {
    it("refuses approval when attempted by default agent profile", () => {
      const proposal = service.propose(
        {
          id: "dec-cache-strategy",
          type: "decision",
          title: "Cache policy",
          content: "Use LRU in-memory cache.",
        },
        defaultAgentActor,
      );

      expect(proposal.status).toBe("proposed");

      // Attempt to approve via default agent profile
      expect(() => {
        service.approve(proposal.id, defaultAgentActor);
      }).toThrow(ApprovalGateError);

      const reloaded = service.getItem(proposal.id);
      expect(reloaded?.status).toBe("proposed");
    });

    it("refuses self-approval when proposing agent attempts to approve its own proposal", () => {
      const proposal = service.create(
        {
          id: "dec-self-approve",
          type: "decision",
          title: "Self approval test",
          content: "Should not be approvable by author agent.",
        },
        elevatedAgentActor, // agent-reviewer
      );

      expect(proposal.status).toBe("proposed");

      // Same agent attempting to approve its own proposal
      expect(() => {
        service.approve(proposal.id, elevatedAgentActor);
      }).toThrow(ApprovalGateError);

      const reloaded = service.getItem(proposal.id);
      expect(reloaded?.status).toBe("proposed");
    });

    it("allows approval by a human actor", () => {
      const proposal = service.propose(
        {
          id: "dec-human-gate",
          type: "decision",
          title: "Security gate test",
          content: "Requires human review.",
        },
        defaultAgentActor,
      );

      const approved = service.approve(proposal.id, humanActor);
      expect(approved.status).toBe("approved");
      expect(approved.version).toBe(2);

      const audits = service.getAuditEvents(proposal.id);
      expect(audits).toHaveLength(2); // created + approved
      expect(audits[1]?.event_type).toBe("context.approved");
      expect(audits[1]?.actor).toBe("anik");
      expect(audits[1]?.previous_version).toBe(1);
      expect(audits[1]?.payload["from_status"]).toBe("proposed");
      expect(audits[1]?.payload["to_status"]).toBe("approved");
    });

    it("allows approval by a separate elevated agent reviewer", () => {
      const proposal = service.propose(
        {
          id: "dec-separate-reviewer",
          type: "decision",
          title: "Reviewer approval",
          content: "Author is agent-builder, reviewer is agent-reviewer.",
        },
        defaultAgentActor, // author: agent-builder
      );

      const approved = service.approve(proposal.id, elevatedAgentActor);
      expect(approved.status).toBe("approved");
      expect(approved.version).toBe(2);

      const audits = service.getAuditEvents(proposal.id);
      expect(audits).toHaveLength(2);
      expect(audits[1]?.actor).toBe("agent-reviewer");
      expect(audits[1]?.previous_version).toBe(1);
    });
  });

  describe("State machine transitions and rejections", () => {
    it("handles legal transitions: draft -> proposed -> approved -> archived", () => {
      // draft creation
      const draft = service.create(
        {
          id: "dec-journey-1",
          type: "decision",
          title: "Draft journey",
          content: "Initial draft.",
          status: "draft",
        },
        defaultAgentActor,
      );
      expect(draft.status).toBe("draft");

      // draft -> proposed
      const proposed = service.transition(
        draft.id,
        "proposed",
        defaultAgentActor,
      );
      expect(proposed.status).toBe("proposed");
      expect(proposed.version).toBe(2);

      // proposed -> approved
      const approved = service.transition(proposed.id, "approved", humanActor);
      expect(approved.status).toBe("approved");
      expect(approved.version).toBe(3);

      // approved -> archived
      const archived = service.transition(approved.id, "archived", humanActor);
      expect(archived.status).toBe("archived");
      expect(archived.version).toBe(4);

      // Verify audit events for each step
      const audits = service.getAuditEvents(draft.id);
      expect(audits).toHaveLength(4);
      expect(audits[0]?.event_type).toBe("context.created");
      expect(audits[1]?.event_type).toBe("context.proposed");
      expect(audits[2]?.event_type).toBe("context.approved");
      expect(audits[3]?.event_type).toBe("context.archived");
    });

    it("handles legal transition: proposed -> draft (rework request)", () => {
      const item = service.propose(
        {
          id: "dec-rework",
          type: "decision",
          title: "Needs rework",
          content: "Not ready yet.",
        },
        defaultAgentActor,
      );

      const drafted = service.transition(item.id, "draft", humanActor);
      expect(drafted.status).toBe("draft");
      expect(drafted.version).toBe(2);
    });

    it("handles legal transition: proposed -> archived (proposal rejection)", () => {
      const item = service.propose(
        {
          id: "dec-reject",
          type: "decision",
          title: "Bad idea",
          content: "Will not implement.",
        },
        defaultAgentActor,
      );

      const archived = service.archive(item.id, humanActor);
      expect(archived.status).toBe("archived");
      expect(archived.version).toBe(2);
    });

    it("rejects illegal transitions", () => {
      // 1. approved -> draft
      const approvedItem = service.create(
        {
          id: "dec-approved-locked",
          type: "decision",
          title: "Locked decision",
          content: "Already approved.",
          status: "approved",
        },
        humanActor,
      );

      expect(() => {
        service.transition(approvedItem.id, "draft", humanActor);
      }).toThrow(LifecycleTransitionError);

      // 2. approved -> proposed
      expect(() => {
        service.transition(approvedItem.id, "proposed", humanActor);
      }).toThrow(LifecycleTransitionError);

      // 3. draft -> superseded
      const draftItem = service.create(
        {
          id: "dec-draft-item",
          type: "decision",
          title: "Draft item",
          content: "Draft.",
          status: "draft",
        },
        defaultAgentActor,
      );

      expect(() => {
        service.transition(draftItem.id, "superseded", humanActor, {
          replacingId: approvedItem.id,
        });
      }).toThrow(LifecycleTransitionError);

      // 4. proposed -> superseded
      const proposedItem = service.propose(
        {
          id: "dec-proposed-item",
          type: "decision",
          title: "Proposed item",
          content: "Proposed.",
        },
        defaultAgentActor,
      );

      expect(() => {
        service.transition(proposedItem.id, "superseded", humanActor, {
          replacingId: approvedItem.id,
        });
      }).toThrow(LifecycleTransitionError);

      // 5. superseded item cannot transition to approved, proposed, or draft
      const supersedingItem = service.create(
        {
          id: "dec-replacing-item",
          type: "decision",
          title: "Replacement",
          content: "Replaces approved item.",
          status: "approved",
          supersedes: [approvedItem.id],
        },
        humanActor,
      );

      const supersededItem = service.getItem(approvedItem.id);
      expect(supersededItem?.status).toBe("superseded");

      expect(() => {
        service.transition(approvedItem.id, "approved", humanActor);
      }).toThrow(LifecycleTransitionError);

      expect(() => {
        service.transition(approvedItem.id, "proposed", humanActor);
      }).toThrow(LifecycleTransitionError);

      expect(() => {
        service.transition(approvedItem.id, "draft", humanActor);
      }).toThrow(LifecycleTransitionError);

      // 6. archived -> approved
      const archivedItem = service.archive(supersedingItem.id, humanActor);
      expect(archivedItem.status).toBe("archived");

      expect(() => {
        service.transition(archivedItem.id, "approved", humanActor);
      }).toThrow(LifecycleTransitionError);

      // 7. archived -> superseded
      expect(() => {
        service.transition(archivedItem.id, "superseded", humanActor, {
          replacingId: "some-id",
        });
      }).toThrow(LifecycleTransitionError);
    });

    it("refuses non-elevated agent attempting to archive approved knowledge", () => {
      const approvedItem = service.create(
        {
          id: "dec-human-rule",
          type: "decision",
          title: "Protected decision",
          content: "Only human can archive.",
          status: "approved",
        },
        humanActor,
      );

      expect(() => {
        service.archive(approvedItem.id, defaultAgentActor);
      }).toThrow(ApprovalGateError);
    });
  });

  describe("Supersession, disk readability and context pack exclusion", () => {
    it("superseded decision stays readable on disk, findable by explicit query, and absent from default pack", () => {
      // Step 1: Initial approved decision
      const v1 = service.create(
        {
          id: "dec-storage-v1",
          type: "decision",
          title: "Storage engine v1",
          content: "Use JSON files on disk.",
          status: "approved",
        },
        humanActor,
      );
      expect(v1.status).toBe("approved");

      // Check default pack contains v1
      const packBefore = service.buildDefaultPack();
      expect(
        packBefore.items.some((item) => item.id === "dec-storage-v1"),
      ).toBe(true);

      // Step 2: Agent proposes v2 that supersedes v1
      const v2Proposal = service.propose(
        {
          id: "dec-storage-v2",
          type: "decision",
          title: "Storage engine v2",
          content: "Use SQLite with Markdown vault.",
          supersedes: ["dec-storage-v1"],
        },
        defaultAgentActor,
      );

      // While v2 is proposed, v1 MUST remain approved and in default pack!
      const v1DuringProposal = service.getItem("dec-storage-v1");
      expect(v1DuringProposal?.status).toBe("approved");

      const packDuring = service.buildDefaultPack();
      expect(
        packDuring.items.some((item) => item.id === "dec-storage-v1"),
      ).toBe(true);
      expect(
        packDuring.items.some((item) => item.id === "dec-storage-v2"),
      ).toBe(false);

      // Step 3: Human approves v2 through approval gate
      const v2Approved = service.approve(v2Proposal.id, humanActor);
      expect(v2Approved.status).toBe("approved");

      // Step 4: Verify supersession effects

      // a) SQLite context_supersedes table has relationship
      const db = service.getDatabase();
      const supersedesRow = db
        .prepare(
          "SELECT context_id, superseded_id FROM context_supersedes WHERE context_id = ? AND superseded_id = ?",
        )
        .get("dec-storage-v2", "dec-storage-v1") as
        { context_id: string; superseded_id: string } | undefined;
      expect(supersedesRow).toBeDefined();
      expect(supersedesRow?.context_id).toBe("dec-storage-v2");
      expect(supersedesRow?.superseded_id).toBe("dec-storage-v1");

      // b) v1 stays readable on disk
      const v1OnDisk = readMarkdownKnowledgeItem(
        join(
          tempDir,
          ".contextpact",
          "knowledge",
          "decisions",
          "dec-storage-v1.md",
        ),
      );
      expect(v1OnDisk.id).toBe("dec-storage-v1");
      expect(v1OnDisk.status).toBe("superseded");
      expect(v1OnDisk.version).toBe(2);

      // c) v1 is still findable by explicit query
      const explicitQueryItem = service.getItem("dec-storage-v1");
      expect(explicitQueryItem).not.toBeNull();
      expect(explicitQueryItem?.id).toBe("dec-storage-v1");
      expect(explicitQueryItem?.status).toBe("superseded");

      // d) v1 is ABSENT from default context pack, and v2 is PRESENT
      const defaultPack = service.buildDefaultPack();
      expect(
        defaultPack.items.some((item) => item.id === "dec-storage-v1"),
      ).toBe(false);
      expect(
        defaultPack.items.some((item) => item.id === "dec-storage-v2"),
      ).toBe(true);

      // e) v1 has audit row for supersession
      const v1Audits = service.getAuditEvents("dec-storage-v1");
      const supersedeAudit = v1Audits.find(
        (a) => a.event_type === "context.superseded",
      );
      expect(supersedeAudit).toBeDefined();
      expect(supersedeAudit?.actor).toBe("anik");
      expect(supersedeAudit?.previous_version).toBe(1);
      expect(supersedeAudit?.payload["from_status"]).toBe("approved");
      expect(supersedeAudit?.payload["to_status"]).toBe("superseded");
      expect(supersedeAudit?.payload["superseded_by"]).toBe("dec-storage-v2");
    });

    it("distinguishes archived vs superseded: both leave default pack, only supersession has replacement link", () => {
      // Approved item 1 (to be superseded)
      service.create(
        {
          id: "dec-to-supersede",
          type: "decision",
          title: "Decision to supersede",
          content: "Old decision.",
          status: "approved",
        },
        humanActor,
      );

      // Approved item 2 (to be archived)
      service.create(
        {
          id: "dec-to-archive",
          type: "decision",
          title: "Decision to archive",
          content: "Deprecated decision, no replacement.",
          status: "approved",
        },
        humanActor,
      );

      // Supersede item 1 with replacement
      service.create(
        {
          id: "dec-replacement",
          type: "decision",
          title: "Replacement decision",
          content: "Replaces item 1.",
          status: "approved",
          supersedes: ["dec-to-supersede"],
        },
        humanActor,
      );

      // Archive item 2
      service.archive("dec-to-archive", humanActor);

      // Both must leave default pack
      const defaultPack = service.buildDefaultPack();
      expect(
        defaultPack.items.some((item) => item.id === "dec-to-supersede"),
      ).toBe(false);
      expect(
        defaultPack.items.some((item) => item.id === "dec-to-archive"),
      ).toBe(false);
      expect(
        defaultPack.items.some((item) => item.id === "dec-replacement"),
      ).toBe(true);

      // Both remain readable on disk
      const supersededDisk = readMarkdownKnowledgeItem(
        join(
          tempDir,
          ".contextpact",
          "knowledge",
          "decisions",
          "dec-to-supersede.md",
        ),
      );
      const archivedDisk = readMarkdownKnowledgeItem(
        join(
          tempDir,
          ".contextpact",
          "knowledge",
          "decisions",
          "dec-to-archive.md",
        ),
      );
      expect(supersededDisk.status).toBe("superseded");
      expect(archivedDisk.status).toBe("archived");

      // ONLY superseded item carries relationship in context_supersedes table
      const db = service.getDatabase();
      const supersededLink = db
        .prepare("SELECT * FROM context_supersedes WHERE superseded_id = ?")
        .get("dec-to-supersede");
      expect(supersededLink).toBeDefined();

      const archivedLink = db
        .prepare("SELECT * FROM context_supersedes WHERE superseded_id = ?")
        .get("dec-to-archive");
      expect(archivedLink).toBeUndefined();
    });
  });

  describe("Audit trail completeness", () => {
    it("every state change has a matching audit row naming the actor and previous version", () => {
      // 1. Propose
      const item = service.propose(
        {
          id: "dec-audit-trace",
          type: "decision",
          title: "Audit trace test",
          content: "Verifying audit event row generation.",
        },
        defaultAgentActor,
      );

      // 2. Approve
      service.approve(item.id, humanActor);

      // 3. Supersede with new item
      service.create(
        {
          id: "dec-audit-trace-v2",
          type: "decision",
          title: "Audit trace test v2",
          content: "Replacement item.",
          status: "approved",
          supersedes: [item.id],
        },
        humanActor,
      );

      const audits = service.getAuditEvents("dec-audit-trace");
      expect(audits).toHaveLength(3);

      // Event 1: created/proposed
      expect(audits[0]?.event_type).toBe("context.created");
      expect(audits[0]?.actor).toBe("agent-builder");
      expect(audits[0]?.previous_version).toBeNull();
      expect(audits[0]?.payload["source"]).toBe("agent");
      expect(audits[0]?.payload["status"]).toBe("proposed");
      expect(typeof audits[0]?.created_at).toBe("string");

      // Event 2: approved
      expect(audits[1]?.event_type).toBe("context.approved");
      expect(audits[1]?.actor).toBe("anik");
      expect(audits[1]?.previous_version).toBe(1);
      expect(audits[1]?.payload["source"]).toBe("human");
      expect(audits[1]?.payload["from_status"]).toBe("proposed");
      expect(audits[1]?.payload["to_status"]).toBe("approved");

      // Event 3: superseded
      expect(audits[2]?.event_type).toBe("context.superseded");
      expect(audits[2]?.actor).toBe("anik");
      expect(audits[2]?.previous_version).toBe(2);
      expect(audits[2]?.payload["source"]).toBe("human");
      expect(audits[2]?.payload["from_status"]).toBe("approved");
      expect(audits[2]?.payload["to_status"]).toBe("superseded");
      expect(audits[2]?.payload["superseded_by"]).toBe("dec-audit-trace-v2");
    });
  });
});
