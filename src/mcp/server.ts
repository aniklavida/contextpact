import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { ContextService } from "../core/context-service.js";
import {
  contextScopeSchema,
  contextTypeSchema,
  importanceSchema,
} from "../domain/context.js";
import {
  DEFAULT_MCP_ACTOR,
  isOperationalContextType,
  type ActorContext,
} from "../domain/lifecycle.js";
import { readWorkspaceStatus } from "../workspace/layout.js";

export interface McpServerOptions {
  workspaceRoot?: string;
  actor?: ActorContext;
}

export function createServer(options?: McpServerOptions): McpServer {
  const server = new McpServer({ name: "contextpact", version: "0.0.0" });
  const serverActor: ActorContext = options?.actor ?? DEFAULT_MCP_ACTOR;

  function getService(workspace?: string): ContextService {
    const root = workspace ?? options?.workspaceRoot ?? process.cwd();
    return new ContextService(root);
  }

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
    "context_bootstrap",
    {
      description:
        "Return the current foundation-level workspace identity and storage status.",
      inputSchema: { workspace: z.string().optional() },
    },
    async ({ workspace }) => {
      const status = readWorkspaceStatus(workspace ?? options?.workspaceRoot);
      const message = status.initialized
        ? `ContextPact workspace '${status.manifest?.name}' is initialized.`
        : "No ContextPact workspace is initialized at this location.";
      const structuredContent: Record<string, unknown> = {
        ...status,
        message,
      };
      return {
        content: [{ type: "text", text: message }],
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

  server.registerTool(
    "context_approve",
    {
      description:
        "Approve a proposed context item through the approval gate. Blocked for default agent profiles.",
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
      try {
        const results = service.search(query, {
          scope,
          allowGlobal,
          limit,
        });
        return {
          content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
          structuredContent: { results },
        };
      } finally {
        service.close();
      }
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
      try {
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
      } finally {
        service.close();
      }
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

  return server;
}

export async function runStdioServer(
  options?: McpServerOptions,
): Promise<void> {
  const server = createServer(options);
  await server.connect(new StdioServerTransport());
}
