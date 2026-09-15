import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createProgram } from "../src/cli.js";
import {
  connectClient,
  formatGenericMcpBlock,
  getAdapter,
  getGenericMcpConfig,
  listSupportedClients,
  mcpServersConfigSchema,
  runConnectionCheck,
} from "../src/index.js";

describe("Guided connection: Claude Code, Codex, Cursor and generic MCP", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "contextpact-connect-test-"));
  });

  afterEach(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  async function runCli(
    args: string[],
  ): Promise<{ stdout: string; stderr: string; exitCode: number | undefined }> {
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];

    const originalStdoutWrite = process.stdout.write;
    const originalStderrWrite = process.stderr.write;
    const originalExitCode = process.exitCode;

    process.exitCode = undefined;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdoutChunks.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    }) as typeof process.stdout.write;

    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderrChunks.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    }) as typeof process.stderr.write;

    try {
      const program = createProgram();
      program.exitOverride();
      await program.parseAsync(["node", "contextpact", ...args]);
    } catch (err: unknown) {
      const error = err as { exitCode?: number; code?: string };
      if (typeof error.exitCode === "number") {
        process.exitCode = error.exitCode;
      }
    } finally {
      process.stdout.write = originalStdoutWrite;
      process.stderr.write = originalStderrWrite;
    }

    const result = {
      stdout: stdoutChunks.join(""),
      stderr: stderrChunks.join(""),
      exitCode: process.exitCode,
    };
    process.exitCode = originalExitCode;
    return result;
  }

  it("lists supported clients (claude, codex, cursor)", () => {
    const clients = listSupportedClients();
    expect(clients).toContain("claude");
    expect(clients).toContain("codex");
    expect(clients).toContain("cursor");
  });

  it("connect claude writes a correct entry into a fixture config file in a temporary directory", () => {
    const result = connectClient("claude", { baseDir: tempDir });
    expect(result.client).toBe("claude");
    expect(result.created).toBe(true);

    const targetPath = join(tempDir, ".claude.json");
    expect(existsSync(targetPath)).toBe(true);

    const content = JSON.parse(readFileSync(targetPath, "utf8"));
    expect(content.mcpServers).toBeDefined();
    expect(content.mcpServers.contextpact).toEqual({
      command: "contextpact",
      args: ["mcp"],
    });
  });

  it("connect codex writes a correct entry into a fixture config file in a temporary directory", () => {
    const result = connectClient("codex", { baseDir: tempDir });
    expect(result.client).toBe("codex");
    expect(result.created).toBe(true);

    const targetPath = join(tempDir, ".codex", "config.toml");
    expect(existsSync(targetPath)).toBe(true);

    const raw = readFileSync(targetPath, "utf8");
    const content = parseToml(raw) as Record<string, unknown>;
    expect(content.mcp_servers).toBeDefined();
    const mcpServers = content.mcp_servers as Record<string, unknown>;
    expect(mcpServers.contextpact).toEqual({
      command: "contextpact",
      args: ["mcp"],
    });
  });

  it("connect cursor writes a correct entry into a fixture config file in a temporary directory", () => {
    const result = connectClient("cursor", { baseDir: tempDir });
    expect(result.client).toBe("cursor");
    expect(result.created).toBe(true);

    const targetPath = join(tempDir, ".cursor", "mcp.json");
    expect(existsSync(targetPath)).toBe(true);

    const content = JSON.parse(readFileSync(targetPath, "utf8"));
    expect(content.mcpServers).toBeDefined();
    expect(content.mcpServers.contextpact).toEqual({
      command: "contextpact",
      args: ["mcp"],
    });
  });

  it("running connect claude twice leaves the file byte-identical", () => {
    connectClient("claude", { baseDir: tempDir });
    const targetPath = join(tempDir, ".claude.json");
    const contentOnce = readFileSync(targetPath, "utf8");

    connectClient("claude", { baseDir: tempDir });
    const contentTwice = readFileSync(targetPath, "utf8");

    expect(contentTwice).toBe(contentOnce);
  });

  it("running connect codex twice leaves the file byte-identical", () => {
    connectClient("codex", { baseDir: tempDir });
    const targetPath = join(tempDir, ".codex", "config.toml");
    const contentOnce = readFileSync(targetPath, "utf8");

    connectClient("codex", { baseDir: tempDir });
    const contentTwice = readFileSync(targetPath, "utf8");

    expect(contentTwice).toBe(contentOnce);
  });

  it("running connect cursor twice leaves the file byte-identical", () => {
    connectClient("cursor", { baseDir: tempDir });
    const targetPath = join(tempDir, ".cursor", "mcp.json");
    const contentOnce = readFileSync(targetPath, "utf8");

    connectClient("cursor", { baseDir: tempDir });
    const contentTwice = readFileSync(targetPath, "utf8");

    expect(contentTwice).toBe(contentOnce);
  });

  it("an existing unrelated entry in the claude config survives untouched", () => {
    const targetPath = join(tempDir, ".claude.json");
    const initialConfig = {
      theme: "dark",
      telemetry: false,
      mcpServers: {
        otherServer: {
          command: "node",
          args: ["/path/to/other.js"],
        },
      },
    };
    writeFileSync(
      targetPath,
      JSON.stringify(initialConfig, null, 2) + "\n",
      "utf8",
    );

    connectClient("claude", { baseDir: tempDir });

    const merged = JSON.parse(readFileSync(targetPath, "utf8"));
    expect(merged.theme).toBe("dark");
    expect(merged.telemetry).toBe(false);
    expect(merged.mcpServers.otherServer).toEqual({
      command: "node",
      args: ["/path/to/other.js"],
    });
    expect(merged.mcpServers.contextpact).toEqual({
      command: "contextpact",
      args: ["mcp"],
    });
  });

  it("an existing unrelated entry in the codex config survives untouched", () => {
    const codexDir = join(tempDir, ".codex");
    mkdirSync(codexDir, { recursive: true });
    const targetPath = join(codexDir, "config.toml");
    const initialToml = [
      'model = "o3"',
      "",
      "[other_section]",
      'setting = "enabled"',
      "",
      "[mcp_servers.existing_tool]",
      'command = "npx"',
      'args = ["existing"]',
      "",
    ].join("\n");
    writeFileSync(targetPath, initialToml, "utf8");

    connectClient("codex", { baseDir: tempDir });

    const raw = readFileSync(targetPath, "utf8");
    const parsed = parseToml(raw) as Record<string, unknown>;
    expect(parsed.model).toBe("o3");
    expect((parsed.other_section as Record<string, unknown>).setting).toBe(
      "enabled",
    );
    const mcpServers = parsed.mcp_servers as Record<string, unknown>;
    expect(mcpServers.existing_tool).toEqual({
      command: "npx",
      args: ["existing"],
    });
    expect(mcpServers.contextpact).toEqual({
      command: "contextpact",
      args: ["mcp"],
    });
  });

  it("an existing unrelated entry in the cursor config survives untouched", () => {
    const cursorDir = join(tempDir, ".cursor");
    mkdirSync(cursorDir, { recursive: true });
    const targetPath = join(cursorDir, "mcp.json");
    const initialConfig = {
      mcpServers: {
        gitTool: {
          command: "node",
          args: ["/tools/git.js"],
          env: { TOKEN: "secret" },
        },
      },
    };
    writeFileSync(
      targetPath,
      JSON.stringify(initialConfig, null, 2) + "\n",
      "utf8",
    );

    connectClient("cursor", { baseDir: tempDir });

    const merged = JSON.parse(readFileSync(targetPath, "utf8"));
    expect(merged.mcpServers.gitTool).toEqual({
      command: "node",
      args: ["/tools/git.js"],
      env: { TOKEN: "secret" },
    });
    expect(merged.mcpServers.contextpact).toEqual({
      command: "contextpact",
      args: ["mcp"],
    });
  });

  it("a malformed existing claude config causes a clear failure and no write", () => {
    const targetPath = join(tempDir, ".claude.json");
    const malformed = "{ broken json: 123";
    writeFileSync(targetPath, malformed, "utf8");

    expect(() => connectClient("claude", { baseDir: tempDir })).toThrow(
      /Malformed Claude configuration/,
    );

    // Assert that the file on disk was NOT modified
    const current = readFileSync(targetPath, "utf8");
    expect(current).toBe(malformed);
  });

  it("a malformed existing codex config causes a clear failure and no write", () => {
    const codexDir = join(tempDir, ".codex");
    mkdirSync(codexDir, { recursive: true });
    const targetPath = join(codexDir, "config.toml");
    const malformed = "model = = = invalid toml";
    writeFileSync(targetPath, malformed, "utf8");

    expect(() => connectClient("codex", { baseDir: tempDir })).toThrow(
      /Malformed Codex configuration/,
    );

    // Assert that the file on disk was NOT modified
    const current = readFileSync(targetPath, "utf8");
    expect(current).toBe(malformed);
  });

  it("a malformed existing cursor config causes a clear failure and no write", () => {
    const cursorDir = join(tempDir, ".cursor");
    mkdirSync(cursorDir, { recursive: true });
    const targetPath = join(cursorDir, "mcp.json");
    const malformed = "[not an object]";
    writeFileSync(targetPath, malformed, "utf8");

    expect(() => connectClient("cursor", { baseDir: tempDir })).toThrow(
      /Malformed Cursor configuration/,
    );

    // Assert that the file on disk was NOT modified
    const current = readFileSync(targetPath, "utf8");
    expect(current).toBe(malformed);
  });

  it("the generic block is produced and validated against the protocol contract", () => {
    const genericConfig = getGenericMcpConfig();

    // Validates against the Zod protocol contract schema
    const parsed = mcpServersConfigSchema.parse(genericConfig);
    expect(parsed.mcpServers.contextpact).toBeDefined();
    expect(parsed.mcpServers.contextpact?.command).toBe("contextpact");
    expect(parsed.mcpServers.contextpact?.args).toEqual(["mcp"]);

    const formatted = formatGenericMcpBlock();
    expect(formatted).toContain('"contextpact": {');
    expect(formatted).toContain('"command": "contextpact"');
  });

  it("the connection check starts the MCP server and successfully calls one real tool", async () => {
    const checkResult = await runConnectionCheck({
      toolName: "context_status",
      workspaceRoot: tempDir,
    });

    expect(checkResult.ok).toBe(true);
    expect(checkResult.error).toBeUndefined();
    expect(checkResult.testedTool).toBe("context_status");
    expect(checkResult.toolsAvailable).toContain("context_status");
    expect(checkResult.toolsAvailable).toContain("context_propose");
    expect(checkResult.toolResult).toBeDefined();

    const resultObj = checkResult.toolResult as {
      structuredContent?: { initialized: boolean };
    };
    expect(resultObj.structuredContent).toBeDefined();
  });

  it("CLI contextpact connect connects claude, codex and cursor in a temporary directory", async () => {
    // 1. Claude
    const claudeResult = await runCli([
      "connect",
      "claude",
      "--base-dir",
      tempDir,
    ]);
    expect(claudeResult.exitCode).toBeUndefined();
    const claudeParsed = JSON.parse(claudeResult.stdout);
    expect(claudeParsed.client).toBe("claude");
    expect(existsSync(join(tempDir, ".claude.json"))).toBe(true);

    // 2. Codex
    const codexResult = await runCli([
      "connect",
      "codex",
      "--base-dir",
      tempDir,
    ]);
    expect(codexResult.exitCode).toBeUndefined();
    const codexParsed = JSON.parse(codexResult.stdout);
    expect(codexParsed.client).toBe("codex");
    expect(existsSync(join(tempDir, ".codex", "config.toml"))).toBe(true);

    // 3. Cursor
    const cursorResult = await runCli([
      "connect",
      "cursor",
      "--base-dir",
      tempDir,
    ]);
    expect(cursorResult.exitCode).toBeUndefined();
    const cursorParsed = JSON.parse(cursorResult.stdout);
    expect(cursorParsed.client).toBe("cursor");
    expect(existsSync(join(tempDir, ".cursor", "mcp.json"))).toBe(true);
  });

  it("CLI contextpact connect outputs generic MCP block for generic or unspecified client", async () => {
    const genericResult = await runCli(["connect", "generic"]);
    expect(genericResult.exitCode).toBeUndefined();
    const parsedGeneric = JSON.parse(genericResult.stdout);
    expect(parsedGeneric.mcpServers.contextpact).toBeDefined();

    const unspecifiedResult = await runCli(["connect"]);
    expect(unspecifiedResult.exitCode).toBeUndefined();
    const parsedUnspecified = JSON.parse(unspecifiedResult.stdout);
    expect(parsedUnspecified.mcpServers.contextpact).toBeDefined();
  });

  it("CLI contextpact connect --check executes live server check and tool invocation", async () => {
    const checkResult = await runCli(["connect", "--check"]);
    expect(checkResult.exitCode).toBeUndefined();
    const parsed = JSON.parse(checkResult.stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.testedTool).toBe("context_status");
    expect(parsed.toolsAvailable).toContain("context_status");
  });
});
