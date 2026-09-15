import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export interface ConnectionCheckOptions {
  command?: string | undefined;
  args?: string[] | undefined;
  toolName?: string | undefined;
  toolArguments?: Record<string, unknown> | undefined;
  workspaceRoot?: string | undefined;
  env?: Record<string, string> | undefined;
}

export interface ConnectionCheckResult {
  ok: boolean;
  serverCommand: string;
  serverArgs: string[];
  toolsAvailable: string[];
  testedTool: string;
  toolResult: unknown;
  error?: string;
}

export function resolveDefaultServerCommand(): {
  command: string;
  args: string[];
} {
  const currentFile = fileURLToPath(import.meta.url);
  const projectRoot = join(
    fileURLToPath(new URL(".", import.meta.url)),
    "../../../",
  );
  const distCli = join(projectRoot, "dist", "cli.js");
  const srcCli = join(projectRoot, "src", "cli.ts");
  const tsxBin = join(projectRoot, "node_modules", ".bin", "tsx");

  if (currentFile.endsWith(".ts") && existsSync(tsxBin) && existsSync(srcCli)) {
    return {
      command: tsxBin,
      args: [srcCli, "mcp"],
    };
  }

  if (existsSync(distCli)) {
    return {
      command: process.execPath,
      args: [distCli, "mcp"],
    };
  }

  return {
    command: "contextpact",
    args: ["mcp"],
  };
}

export async function runConnectionCheck(
  options?: ConnectionCheckOptions,
): Promise<ConnectionCheckResult> {
  const defaultCmd = resolveDefaultServerCommand();
  const command = options?.command ?? defaultCmd.command;
  const args = options?.args ?? defaultCmd.args;
  const toolName = options?.toolName ?? "context_status";
  const toolArguments =
    options?.toolArguments ??
    (options?.workspaceRoot ? { workspace: options.workspaceRoot } : {});

  const transportEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      transportEnv[key] = value;
    }
  }
  if (options?.env) {
    Object.assign(transportEnv, options.env);
  }

  const transport = new StdioClientTransport({
    command,
    args,
    env: transportEnv,
  });

  const client = new Client(
    { name: "contextpact-connection-checker", version: "0.0.0" },
    { capabilities: {} },
  );

  try {
    await client.connect(transport);
    const toolsList = await client.listTools();
    const toolNames = toolsList.tools.map((t) => t.name);

    if (!toolNames.includes(toolName)) {
      throw new Error(
        `MCP server started over stdio but did not expose the expected tool '${toolName}'. Available tools: ${toolNames.join(", ")}`,
      );
    }

    const toolResult = await client.callTool({
      name: toolName,
      arguments: toolArguments,
    });

    return {
      ok: true,
      serverCommand: command,
      serverArgs: args,
      toolsAvailable: toolNames,
      testedTool: toolName,
      toolResult,
    };
  } catch (error) {
    return {
      ok: false,
      serverCommand: command,
      serverArgs: args,
      toolsAvailable: [],
      testedTool: toolName,
      toolResult: null,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    try {
      await client.close();
    } catch {
      // Ignore close errors during cleanup
    }
  }
}
