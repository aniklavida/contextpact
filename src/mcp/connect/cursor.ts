import { homedir } from "node:os";
import { join } from "node:path";

import type { ClientAdapter, ServerConfigOptions } from "./types.js";

export class CursorAdapter implements ClientAdapter {
  readonly clientName = "cursor";
  readonly displayName = "Cursor";
  readonly defaultPathDescription = "~/.cursor/mcp.json";

  resolveConfigPath(baseDir?: string): string {
    const root = baseDir ?? homedir();
    return join(root, ".cursor", "mcp.json");
  }

  mergeConfig(
    existingContent: string | null,
    options?: ServerConfigOptions,
  ): string {
    const serverEntry: {
      command: string;
      args: string[];
      env?: Record<string, string>;
    } = {
      command: options?.command ?? "contextpact",
      args: options?.args ?? ["mcp"],
    };
    if (options?.env && Object.keys(options.env).length > 0) {
      serverEntry.env = options.env;
    }

    if (existingContent === null || existingContent.trim() === "") {
      const rootConfig = {
        mcpServers: {
          contextpact: serverEntry,
        },
      };
      return JSON.stringify(rootConfig, null, 2) + "\n";
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(existingContent);
    } catch (error) {
      throw new Error(
        `Malformed Cursor configuration: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      throw new Error(
        "Malformed Cursor configuration: root must be a JSON object",
      );
    }

    const configObj = parsed as Record<string, unknown>;
    let mcpServers = configObj.mcpServers;
    if (mcpServers === undefined) {
      mcpServers = {};
      configObj.mcpServers = mcpServers;
    } else if (
      typeof mcpServers !== "object" ||
      mcpServers === null ||
      Array.isArray(mcpServers)
    ) {
      throw new Error(
        "Malformed Cursor configuration: 'mcpServers' must be a JSON object",
      );
    }

    (mcpServers as Record<string, unknown>).contextpact = serverEntry;

    return JSON.stringify(configObj, null, 2) + "\n";
  }
}
