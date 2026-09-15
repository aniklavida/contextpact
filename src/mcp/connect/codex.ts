import { homedir } from "node:os";
import { join } from "node:path";
import { parse, stringify } from "smol-toml";

import type { ClientAdapter, ServerConfigOptions } from "./types.js";

export class CodexAdapter implements ClientAdapter {
  readonly clientName = "codex";
  readonly displayName = "Codex";
  readonly defaultPathDescription = "~/.codex/config.toml";

  resolveConfigPath(baseDir?: string): string {
    const root = baseDir ?? homedir();
    return join(root, ".codex", "config.toml");
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
        mcp_servers: {
          contextpact: serverEntry,
        },
      };
      return stringify(rootConfig);
    }

    let parsed: unknown;
    try {
      parsed = parse(existingContent);
    } catch (error) {
      throw new Error(
        `Malformed Codex configuration: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      throw new Error(
        "Malformed Codex configuration: root must be a TOML table",
      );
    }

    const configObj = parsed as Record<string, unknown>;
    let mcpServers = configObj.mcp_servers;
    if (mcpServers === undefined) {
      mcpServers = {};
      configObj.mcp_servers = mcpServers;
    } else if (
      typeof mcpServers !== "object" ||
      mcpServers === null ||
      Array.isArray(mcpServers)
    ) {
      throw new Error(
        "Malformed Codex configuration: 'mcp_servers' must be a TOML table",
      );
    }

    (mcpServers as Record<string, unknown>).contextpact = serverEntry;

    return stringify(configObj);
  }
}
