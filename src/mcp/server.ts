import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { readWorkspaceStatus } from "../workspace/layout.js";

export function createServer(): McpServer {
  const server = new McpServer({ name: "contextpact", version: "0.0.0" });

  server.registerTool(
    "context_status",
    {
      description:
        "Inspect whether a local ContextPact workspace is initialized.",
      inputSchema: { workspace: z.string().optional() },
    },
    async ({ workspace }) => {
      const status = readWorkspaceStatus(workspace);
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
      const status = readWorkspaceStatus(workspace);
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

  return server;
}

export async function runStdioServer(): Promise<void> {
  const server = createServer();
  await server.connect(new StdioServerTransport());
}
