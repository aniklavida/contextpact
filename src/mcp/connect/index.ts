import { existsSync, readFileSync } from "node:fs";
import { writeAtomicFile } from "../../storage/atomic.js";
import { ClaudeAdapter } from "./claude.js";
import { CodexAdapter } from "./codex.js";
import { CursorAdapter } from "./cursor.js";
import { formatGenericMcpBlock, getGenericMcpConfig } from "./generic.js";
import type {
  ClientAdapter,
  ConnectResult,
  ServerConfigOptions,
} from "./types.js";

export * from "./types.js";
export * from "./claude.js";
export * from "./cursor.js";
export * from "./codex.js";
export * from "./generic.js";
export * from "./check.js";

export interface ConnectOptions extends ServerConfigOptions {
  baseDir?: string | undefined;
}

const adapters = new Map<string, ClientAdapter>([
  ["claude", new ClaudeAdapter()],
  ["codex", new CodexAdapter()],
  ["cursor", new CursorAdapter()],
]);

export function registerAdapter(adapter: ClientAdapter): void {
  adapters.set(adapter.clientName.toLowerCase(), adapter);
}

export function getAdapter(clientName: string): ClientAdapter | undefined {
  return adapters.get(clientName.toLowerCase());
}

export function listSupportedClients(): string[] {
  return Array.from(adapters.keys());
}

export function isSupportedClient(clientName: string): boolean {
  return adapters.has(clientName.toLowerCase());
}

export function connectClient(
  clientName: string,
  options?: ConnectOptions,
): ConnectResult {
  const adapter = getAdapter(clientName);
  if (!adapter) {
    throw new Error(
      `Unsupported client '${clientName}'. Supported clients: ${listSupportedClients().join(", ")}. Use generic MCP configuration for other clients.`,
    );
  }

  const configPath = adapter.resolveConfigPath(options?.baseDir);
  const fileExisted = existsSync(configPath);
  const existingContent = fileExisted
    ? readFileSync(configPath, { encoding: "utf8" })
    : null;

  const merged = adapter.mergeConfig(existingContent, options);

  writeAtomicFile(configPath, merged, { overwrite: true });

  return {
    client: adapter.clientName,
    displayName: adapter.displayName,
    configPath,
    created: !fileExisted,
    updated: fileExisted,
  };
}
