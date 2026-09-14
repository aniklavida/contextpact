import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ContextService,
  createServer,
  initializeWorkspace,
  type ActorContext,
  type ContextItem,
} from "../src/index.js";

describe("MCP Server approval gate and lifecycle tools", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "contextpact-mcp-test-"));
    initializeWorkspace(tempDir, "MCP Test Workspace");
  });

  afterEach(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  function getTool(server: ReturnType<typeof createServer>, name: string) {
    const tools = (
      server as unknown as {
        _registeredTools: Record<
          string,
          { handler: (args: unknown, extra: unknown) => Promise<unknown> }
        >;
      }
    )._registeredTools;
    const tool = tools[name];
    if (!tool) {
      throw new Error(`Tool '${name}' not found on MCP server`);
    }
    return tool.handler;
  }

  it("a proposal made through the default MCP profile cannot be approved through that same profile", async () => {
    // Server running with default MCP profile
    const defaultServer = createServer({ workspaceRoot: tempDir });

    const proposeTool = getTool(defaultServer, "context_propose");
    const approveTool = getTool(defaultServer, "context_approve");
    const getToolFn = getTool(defaultServer, "context_get");

    // Propose durable knowledge
    const proposeResult = (await proposeTool(
      {
        workspace: tempDir,
        id: "dec-auth-boundary",
        type: "decision",
        title: "Auth boundary policy",
        content: "Enforce strict approval boundary.",
      },
      {},
    )) as {
      content: Array<{ text: string }>;
      structuredContent?: ContextItem;
      isError?: boolean;
    };

    expect(proposeResult.isError).toBeFalsy();
    expect(proposeResult.structuredContent?.status).toBe("proposed");
    expect(proposeResult.structuredContent?.actor).toBe("mcp-agent");

    // Attempt to approve via the same default MCP profile
    const approveResult = (await approveTool(
      {
        workspace: tempDir,
        id: "dec-auth-boundary",
      },
      {},
    )) as { isError?: boolean; content: Array<{ text: string }> };

    // Assert the refusal rather than the happy path
    expect(approveResult.isError).toBe(true);
    expect(approveResult.content[0]?.text).toContain("Approval gate refusal");
    expect(approveResult.content[0]?.text).toContain(
      "Default profile cannot approve durable knowledge",
    );

    // Verify the proposal remains strictly in 'proposed' status
    const getResult = (await getToolFn(
      {
        workspace: tempDir,
        id: "dec-auth-boundary",
      },
      {},
    )) as { structuredContent?: ContextItem };
    expect(getResult.structuredContent?.status).toBe("proposed");
  });

  it("an elevated MCP profile can approve proposals through the approval gate", async () => {
    // 1. Propose through default server
    const defaultServer = createServer({ workspaceRoot: tempDir });
    const proposeTool = getTool(defaultServer, "context_propose");

    await proposeTool(
      {
        workspace: tempDir,
        id: "dec-queue-storage",
        type: "decision",
        title: "Queue engine",
        content: "Queue rides on SQLite.",
      },
      {},
    );

    // 2. Approve through elevated profile server
    const elevatedActor: ActorContext = {
      actor: "human-reviewer",
      source: "human",
      profile: "elevated",
    };
    const elevatedServer = createServer({
      workspaceRoot: tempDir,
      actor: elevatedActor,
    });

    const elevatedApproveTool = getTool(elevatedServer, "context_approve");
    const approveResult = (await elevatedApproveTool(
      {
        workspace: tempDir,
        id: "dec-queue-storage",
      },
      {},
    )) as {
      isError?: boolean;
      content: Array<{ text: string }>;
      structuredContent?: ContextItem;
    };

    expect(approveResult.isError).toBeFalsy();
    expect(approveResult.structuredContent?.status).toBe("approved");

    // Verify audit event reflects human-reviewer actor
    const service = new ContextService(tempDir);
    const audits = service.getAuditEvents("dec-queue-storage");
    expect(audits).toHaveLength(2);
    expect(audits[1]?.actor).toBe("human-reviewer");
    expect(audits[1]?.event_type).toBe("context.approved");
    service.close();
  });

  it("allows default MCP profile to write operational task notes immediately", async () => {
    const defaultServer = createServer({ workspaceRoot: tempDir });
    const proposeTool = getTool(defaultServer, "context_propose");

    const result = (await proposeTool(
      {
        workspace: tempDir,
        id: "op-note-mcp-1",
        type: "task_note",
        title: "Current progress",
        content: "Running test suites.",
      },
      {},
    )) as { isError?: boolean; structuredContent?: ContextItem };

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent?.status).toBe("approved");
    expect(result.structuredContent?.type).toBe("task_note");
  });

  it("retrieves default packs and excludes proposed or superseded items via context_pack", async () => {
    const humanActor: ActorContext = {
      actor: "anik",
      source: "human",
      profile: "human",
    };
    const service = new ContextService(tempDir);

    // Create approved item
    service.create(
      {
        id: "dec-arch-1",
        type: "decision",
        title: "Core Architecture",
        content: "Approved core decision.",
        status: "approved",
      },
      humanActor,
    );

    // Create proposed item
    service.propose(
      {
        id: "dec-arch-2-prop",
        type: "decision",
        title: "Proposed Architecture",
        content: "Not yet approved.",
      },
      { actor: "agent-1", source: "agent", profile: "default" },
    );
    service.close();

    const server = createServer({ workspaceRoot: tempDir });
    const packTool = getTool(server, "context_pack");

    const packResult = (await packTool({ workspace: tempDir }, {})) as {
      structuredContent?: { items: Array<{ id: string }> };
    };

    const items = packResult.structuredContent?.items ?? [];
    expect(items.some((i) => i.id === "dec-arch-1")).toBe(true);
    expect(items.some((i) => i.id === "dec-arch-2-prop")).toBe(false);
  });
});
