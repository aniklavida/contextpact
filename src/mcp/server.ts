import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { ContextService } from "../core/context-service.js";
import { taskStatusSchema } from "../domain/agent.js";
import {
  contextScopeSchema,
  contextTypeSchema,
  importanceSchema,
} from "../domain/context.js";
import {
  DEFAULT_MCP_ACTOR,
  isActorElevated,
  isOperationalContextType,
  type ActorContext,
} from "../domain/lifecycle.js";
import {
  evidenceItemSchema,
  handoffOutcomeSchema,
  nextActionSchema,
} from "../domain/handoff.js";
import { readWorkspaceStatus } from "../workspace/layout.js";

export interface McpServerOptions {
  workspaceRoot?: string;
  actor?: ActorContext;
}

export function createServer(options?: McpServerOptions): McpServer {
  const server = new McpServer({ name: "contextpact", version: "0.0.0" });
  const serverActor: ActorContext = options?.actor ?? DEFAULT_MCP_ACTOR;

  const serviceCache = new Map<string, ContextService>();

  function getService(workspace?: string): ContextService {
    const root = workspace ?? options?.workspaceRoot ?? process.cwd();
    let service = serviceCache.get(root);
    if (!service) {
      service = new ContextService(root);
      serviceCache.set(root, service);
    }
    return service;
  }

  const originalClose = server.close.bind(server);
  server.close = async () => {
    for (const service of serviceCache.values()) {
      service.close();
    }
    serviceCache.clear();
    await originalClose();
  };

  server.registerTool(
    "context_status",
    {
      description:
        "Inspect whether a local ContextPact workspace is initialized.",
      inputSchema: { workspace: z.string().optional() },
    },
    async ({ workspace }) => {
      const status = readWorkspaceStatus(workspace ?? options?.workspaceRoot);
      const structuredContent: Record<string, unknown> = { ...status };
      return {
        content: [{ type: "text", text: JSON.stringify(status, null, 2) }],
        structuredContent,
      };
    },
  );

  server.registerTool(
    "context_propose",
    {
      description:
        "Propose a durable context item or operational state for the local workspace.",
      inputSchema: {
        workspace: z.string().optional(),
        id: z.string().optional(),
        type: contextTypeSchema,
        title: z.string().min(1),
        content: z.string().default(""),
        scope: contextScopeSchema.optional(),
        importance: importanceSchema.optional(),
        tags: z.array(z.string()).optional(),
        supersedes: z.array(z.string()).optional(),
      },
    },
    async ({
      workspace,
      id,
      type,
      title,
      content,
      scope,
      importance,
      tags,
      supersedes,
    }) => {
      try {
        const service = getService(workspace);
        const item = isOperationalContextType(type)
          ? service.create(
              {
                id,
                type,
                title,
                content,
                scope,
                importance,
                tags,
                supersedes,
                status: "approved",
              },
              serverActor,
            )
          : service.propose(
              {
                id,
                type,
                title,
                content,
                scope,
                importance,
                tags,
                supersedes,
              },
              serverActor,
            );
        return {
          content: [
            {
              type: "text",
              text: `Context item '${item.id}' recorded with status '${item.status}'.`,
            },
          ],
          structuredContent: { ...item },
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: error instanceof Error ? error.message : String(error),
            },
          ],
        };
      }
    },
  );

  if (isActorElevated(serverActor)) {
    server.registerTool(
      "context_approve",
      {
        description:
          "Approve a proposed context item through the approval gate. Available only to elevated or human profiles.",
        inputSchema: {
          workspace: z.string().optional(),
          id: z.string().min(1),
        },
      },
      async ({ workspace, id }) => {
        try {
          const service = getService(workspace);
          const item = service.approve(id, serverActor);
          return {
            content: [
              {
                type: "text",
                text: `Context item '${item.id}' approved successfully.`,
              },
            ],
            structuredContent: { ...item },
          };
        } catch (error) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: error instanceof Error ? error.message : String(error),
              },
            ],
          };
        }
      },
    );
  }

  server.registerTool(
    "context_get",
    {
      description:
        "Retrieve a context item by its ID, including superseded or archived items.",
      inputSchema: {
        workspace: z.string().optional(),
        id: z.string().min(1),
      },
    },
    async ({ workspace, id }) => {
      const service = getService(workspace);
      const item = service.getItem(id);
      if (!item) {
        return {
          isError: true,
          content: [{ type: "text", text: `Context item '${id}' not found.` }],
        };
      }
      return {
        content: [{ type: "text", text: JSON.stringify(item, null, 2) }],
        structuredContent: { ...item },
      };
    },
  );

  server.registerTool(
    "context_search",
    {
      description:
        "Search workspace knowledge using SQLite FTS5 full-text search.",
      inputSchema: {
        workspace: z.string().optional(),
        query: z.string().min(1),
        scope: contextScopeSchema.optional(),
        allowGlobal: z.boolean().optional(),
        limit: z.number().int().positive().optional(),
      },
    },
    async ({ workspace, query, scope, allowGlobal, limit }) => {
      const service = getService(workspace);
      const results = service.search(query, {
        scope,
        allowGlobal,
        limit,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
        structuredContent: { results },
      };
    },
  );

  server.registerTool(
    "context_pack",
    {
      description:
        "Retrieve the deterministic token-budgeted context pack of approved knowledge.",
      inputSchema: {
        workspace: z.string().optional(),
        query: z.string().optional(),
        scope: contextScopeSchema.optional(),
        taskId: z.string().optional(),
        sessionId: z.string().optional(),
        maxTokens: z.number().int().positive().optional(),
        allowGlobal: z.boolean().optional(),
      },
    },
    async ({
      workspace,
      query,
      scope,
      taskId,
      sessionId,
      maxTokens,
      allowGlobal,
    }) => {
      const service = getService(workspace);
      const pack = service.buildPack({
        query,
        scope,
        taskId,
        sessionId,
        maxTokens,
        allowGlobal,
        client: serverActor,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(pack, null, 2) }],
        structuredContent: { ...pack },
      };
    },
  );

  server.registerTool(
    "context_archive",
    {
      description: "Archive a context item when no longer relevant.",
      inputSchema: {
        workspace: z.string().optional(),
        id: z.string().min(1),
      },
    },
    async ({ workspace, id }) => {
      try {
        const service = getService(workspace);
        const item = service.archive(id, serverActor);
        return {
          content: [
            {
              type: "text",
              text: `Context item '${item.id}' archived successfully.`,
            },
          ],
          structuredContent: { ...item },
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: error instanceof Error ? error.message : String(error),
            },
          ],
        };
      }
    },
  );

  server.registerTool(
    "decision_propose",
    {
      description:
        "Propose an architectural or product decision for durable knowledge in the workspace.",
      inputSchema: {
        workspace: z.string().optional(),
        id: z.string().optional(),
        title: z.string().min(1),
        content: z.string().default(""),
        scope: contextScopeSchema.optional(),
        importance: importanceSchema.optional(),
        tags: z.array(z.string()).optional(),
        supersedes: z.array(z.string()).optional(),
      },
    },
    async ({
      workspace,
      id,
      title,
      content,
      scope,
      importance,
      tags,
      supersedes,
    }) => {
      try {
        const service = getService(workspace);
        const item = service.proposeDecision(
          {
            id,
            title,
            content,
            scope,
            importance,
            tags,
            supersedes,
          },
          serverActor,
        );
        return {
          content: [
            {
              type: "text",
              text: `Decision '${item.id}' proposed successfully with status '${item.status}'.`,
            },
          ],
          structuredContent: { ...item },
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: error instanceof Error ? error.message : String(error),
            },
          ],
        };
      }
    },
  );

  server.registerTool(
    "task_create",
    {
      description: "Create a coordination task in the workspace.",
      inputSchema: {
        workspace: z.string().optional(),
        id: z.string().optional(),
        title: z.string().min(1),
        description: z.string().optional(),
        status: taskStatusSchema.optional(),
        scope: z.array(z.string()).optional(),
      },
    },
    async ({ workspace, id, title, description, status, scope }) => {
      try {
        const service = getService(workspace);
        const task = service.createTask(
          {
            id,
            title,
            description: description ?? "",
            status: status ?? "planned",
            scope: scope ?? [],
          },
          serverActor,
        );
        return {
          content: [
            {
              type: "text",
              text: `Task '${task.id}' created with status '${task.status}'.`,
            },
          ],
          structuredContent: { ...task },
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: error instanceof Error ? error.message : String(error),
            },
          ],
        };
      }
    },
  );

  server.registerTool(
    "task_claim",
    {
      description:
        "Claim, renew, or takeover a task lease for an agent process.",
      inputSchema: {
        workspace: z.string().optional(),
        taskId: z.string().min(1),
        agentId: z.string().optional(),
        ttlSeconds: z.number().int().positive().optional(),
        scope: z.array(z.string()).optional(),
        takeoverReason: z.string().optional(),
      },
    },
    async ({
      workspace,
      taskId,
      agentId,
      ttlSeconds,
      scope,
      takeoverReason,
    }) => {
      try {
        const service = getService(workspace);
        const effectiveAgentId = agentId ?? serverActor.actor;
        const lease = service.claimTask({
          taskId,
          agentId: effectiveAgentId,
          ttlSeconds,
          scope,
          takeoverReason,
        });
        return {
          content: [
            {
              type: "text",
              text: `Task '${taskId}' lease claimed by '${lease.agentId}' until ${lease.expiresAt}.`,
            },
          ],
          structuredContent: { ...lease },
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: error instanceof Error ? error.message : String(error),
            },
          ],
        };
      }
    },
  );

  server.registerTool(
    "task_release",
    {
      description: "Release an active task lease and transition task status.",
      inputSchema: {
        workspace: z.string().optional(),
        taskId: z.string().min(1),
        agentId: z.string().optional(),
        status: z.enum(["review", "done", "blocked", "planned"]).optional(),
      },
    },
    async ({ workspace, taskId, agentId, status }) => {
      try {
        const service = getService(workspace);
        const effectiveAgentId = agentId ?? serverActor.actor;
        const task = service.releaseTask({
          taskId,
          agentId: effectiveAgentId,
          finalStatus: status ?? "review",
        });
        return {
          content: [
            {
              type: "text",
              text: `Task '${task.id}' lease released with status '${task.status}'.`,
            },
          ],
          structuredContent: { ...task },
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: error instanceof Error ? error.message : String(error),
            },
          ],
        };
      }
    },
  );

  server.registerTool(
    "task_get",
    {
      description:
        "Retrieve a task by ID, including its current status, scope, and active lease.",
      inputSchema: {
        workspace: z.string().optional(),
        id: z.string().min(1),
      },
    },
    async ({ workspace, id }) => {
      const service = getService(workspace);
      const record = service.getTaskWithLease(id);
      if (!record) {
        return {
          isError: true,
          content: [{ type: "text", text: `Task '${id}' not found.` }],
        };
      }
      return {
        content: [{ type: "text", text: JSON.stringify(record, null, 2) }],
        structuredContent: { ...record },
      };
    },
  );

  server.registerTool(
    "handoff_create",
    {
      description:
        "Record an evidence-bearing structured handoff across a context boundary.",
      inputSchema: {
        workspace: z.string().optional(),
        id: z.string().optional(),
        taskId: z.string().min(1),
        agentId: z.string().optional(),
        title: z.string().optional(),
        outcome: handoffOutcomeSchema,
        summary: z.string().min(1),
        blockers: z.array(z.string()).optional(),
        nextAction: nextActionSchema,
        evidence: z.array(evidenceItemSchema).optional(),
        releaseLease: z.boolean().optional(),
        tags: z.array(z.string()).optional(),
      },
    },
    async ({
      workspace,
      id,
      taskId,
      agentId,
      title,
      outcome,
      summary,
      blockers,
      nextAction,
      evidence,
      releaseLease,
      tags,
    }) => {
      try {
        const service = getService(workspace);
        const effectiveAgentId = agentId ?? serverActor.actor;
        if (!service.getAgent(effectiveAgentId)) {
          service.registerAgent({
            id: effectiveAgentId,
            displayName: effectiveAgentId,
            clientKind: serverActor.source === "human" ? "human" : "mcp",
            profile: serverActor.profile ?? "default",
          });
        }
        const handoff = service.createHandoff(
          {
            id,
            taskId,
            agentId: effectiveAgentId,
            title,
            outcome,
            summary,
            blockers: blockers ?? [],
            nextAction,
            evidence: evidence ?? [],
            releaseLease: releaseLease ?? true,
            tags: tags ?? [],
          },
          serverActor,
        );
        return {
          content: [
            {
              type: "text",
              text: `Handoff '${handoff.id}' recorded with outcome '${handoff.outcome}'. Next action: ${handoff.nextAction}`,
            },
          ],
          structuredContent: { ...handoff },
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: error instanceof Error ? error.message : String(error),
            },
          ],
        };
      }
    },
  );

  server.registerTool(
    "handoff_get",
    {
      description: "Retrieve an operational and narrative handoff by ID.",
      inputSchema: {
        workspace: z.string().optional(),
        id: z.string().min(1),
      },
    },
    async ({ workspace, id }) => {
      const service = getService(workspace);
      const handoff = service.getHandoff(id);
      if (!handoff) {
        return {
          isError: true,
          content: [{ type: "text", text: `Handoff '${id}' not found.` }],
        };
      }
      return {
        content: [{ type: "text", text: JSON.stringify(handoff, null, 2) }],
        structuredContent: { ...handoff },
      };
    },
  );

  server.registerTool(
    "handoff_resume",
    {
      description:
        "Resume work from a handoff: claims the task lease and acquires task and handoff context.",
      inputSchema: {
        workspace: z.string().optional(),
        handoffId: z.string().min(1),
        agentId: z.string().optional(),
        ttlSeconds: z.number().int().positive().optional(),
      },
    },
    async ({ workspace, handoffId, agentId, ttlSeconds }) => {
      try {
        const service = getService(workspace);
        const effectiveAgentId = agentId ?? serverActor.actor;
        if (!service.getAgent(effectiveAgentId)) {
          service.registerAgent({
            id: effectiveAgentId,
            displayName: effectiveAgentId,
            clientKind: serverActor.source === "human" ? "human" : "mcp",
            profile: serverActor.profile ?? "default",
          });
        }
        const result = service.resumeHandoff(
          {
            handoffId,
            agentId: effectiveAgentId,
            ttlSeconds,
          },
          serverActor,
        );
        return {
          content: [
            {
              type: "text",
              text: `Resumed from handoff '${handoffId}'. Claimed lease for task '${result.task.id}'. Next action: ${result.nextAction}`,
            },
          ],
          structuredContent: { ...result },
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: error instanceof Error ? error.message : String(error),
            },
          ],
        };
      }
    },
  );

  return server;
}

export async function runStdioServer(
  options?: McpServerOptions,
): Promise<void> {
  const server = createServer(options);
  await server.connect(new StdioServerTransport());
}
