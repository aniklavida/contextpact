import { z } from "zod";
import type { ServerConfigOptions } from "./types.js";

export const mcpStdioServerConfigSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).optional(),
});

export type McpStdioServerConfig = z.infer<typeof mcpStdioServerConfigSchema>;

export const mcpServersConfigSchema = z.object({
  mcpServers: z.record(z.string(), mcpStdioServerConfigSchema),
});

export type McpServersConfig = z.infer<typeof mcpServersConfigSchema>;

export function getGenericMcpConfig(
  options?: ServerConfigOptions,
): McpServersConfig {
  const serverEntry: McpStdioServerConfig = {
    command: options?.command ?? "contextpact",
    args: options?.args ?? ["mcp"],
    ...(options?.env && Object.keys(options.env).length > 0
      ? { env: options.env }
      : {}),
  };

  const rawConfig = {
    mcpServers: {
      contextpact: serverEntry,
    },
  };

  return mcpServersConfigSchema.parse(rawConfig);
}

export function formatGenericMcpBlock(options?: ServerConfigOptions): string {
  const config = getGenericMcpConfig(options);
  return JSON.stringify(config, null, 2) + "\n";
}
