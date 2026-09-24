import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Command } from "commander";
import { describe, expect, it } from "vitest";

import { createProgram } from "../src/cli.js";
import { createServer, type ActorContext } from "../src/index.js";

const CLI_DOC_PATH = resolve(__dirname, "../docs/CLI_REFERENCE.md");
const MCP_DOC_PATH = resolve(__dirname, "../docs/MCP_REFERENCE.md");

/**
 * Recursively walks a Commander Command tree and collects all command names
 * (both command groups and leaf subcommands) prefixed by parent names.
 */
function collectCliCommands(
  cmd: Command,
  prefix = "",
): Array<{ name: string; command: Command }> {
  const name = prefix ? `${prefix} ${cmd.name()}` : cmd.name();
  const results: Array<{ name: string; command: Command }> = [
    { name, command: cmd },
  ];
  for (const sub of cmd.commands) {
    results.push(...collectCliCommands(sub, name));
  }
  return results;
}

/**
 * Extracts documented CLI command names from docs/CLI_REFERENCE.md headings.
 * Matches headings such as:
 * ### contextpact init
 * ### contextpact task create
 */
function extractDocumentedCliCommands(markdown: string): string[] {
  const matches = [
    ...markdown.matchAll(/^###+ (?:contextpact )?([a-z0-9 _-]+)$/gim),
  ];
  return matches.map((m) => m[1]!.trim());
}

/**
 * Extracts documented MCP tool names from docs/MCP_REFERENCE.md headings.
 * Matches headings such as:
 * ### context_status
 * ### context_propose
 */
function extractDocumentedMcpTools(markdown: string): string[] {
  const matches = [...markdown.matchAll(/^###+ ([a-z_]+)$/gim)];
  return matches.map((m) => m[1]!.trim());
}

describe("CLI and MCP reference documentation drift", () => {
  it("fails if any real CLI command is missing from docs/CLI_REFERENCE.md or vice versa", () => {
    const cliDocContent = readFileSync(CLI_DOC_PATH, "utf8");
    const documentedCommands = extractDocumentedCliCommands(cliDocContent);

    const program = createProgram();
    const allCliEntries = program.commands.flatMap((c) =>
      collectCliCommands(c),
    );
    const realCommandNames = allCliEntries.map((e) => e.name);

    const missingFromDoc = realCommandNames.filter(
      (cmd) => !documentedCommands.includes(cmd),
    );
    const extraInDoc = documentedCommands.filter(
      (cmd) => !realCommandNames.includes(cmd),
    );

    expect(
      missingFromDoc,
      `CLI commands present in code but missing from docs/CLI_REFERENCE.md: ${missingFromDoc.join(", ")}`,
    ).toEqual([]);

    expect(
      extraInDoc,
      `CLI commands documented in docs/CLI_REFERENCE.md but not present in code: ${extraInDoc.join(", ")}`,
    ).toEqual([]);
  });

  it("verifies that all CLI options and flags are documented for each command", () => {
    const cliDocContent = readFileSync(CLI_DOC_PATH, "utf8");
    const program = createProgram();
    const allCliEntries = program.commands.flatMap((c) =>
      collectCliCommands(c),
    );

    const missingFlagsReport: string[] = [];

    for (const { name, command } of allCliEntries) {
      const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const sectionRegex = new RegExp(
        `###+ (?:contextpact )?${escapedName}\\b([\\s\\S]*?)(?=###+ (?:contextpact )|$)`,
        "i",
      );
      const match = cliDocContent.match(sectionRegex);
      if (!match) {
        missingFlagsReport.push(`Section not found for command '${name}'`);
        continue;
      }

      const sectionText = match[1]!;
      for (const opt of command.options) {
        const longFlag = opt.long;
        if (longFlag && !sectionText.includes(longFlag)) {
          missingFlagsReport.push(
            `Command '${name}' is missing documentation for option flag '${longFlag}'`,
          );
        }
      }
    }

    expect(
      missingFlagsReport,
      `Undocumented CLI options detected:\n${missingFlagsReport.join("\n")}`,
    ).toEqual([]);
  });

  it("fails if any real MCP tool is missing from docs/MCP_REFERENCE.md or vice versa", () => {
    const mcpDocContent = readFileSync(MCP_DOC_PATH, "utf8");
    const documentedTools = extractDocumentedMcpTools(mcpDocContent);

    const elevatedActor: ActorContext = {
      actor: "test-elevated",
      source: "human",
      profile: "elevated",
    };
    const server = createServer({ actor: elevatedActor });
    const realToolRegistry = (
      server as unknown as {
        _registeredTools: Record<string, { description?: string }>;
      }
    )._registeredTools;

    const realToolNames = Object.keys(realToolRegistry);

    const missingFromDoc = realToolNames.filter(
      (tool) => !documentedTools.includes(tool),
    );
    const extraInDoc = documentedTools.filter(
      (tool) => !realToolNames.includes(tool),
    );

    expect(
      missingFromDoc,
      `MCP tools registered in code but missing from docs/MCP_REFERENCE.md: ${missingFromDoc.join(", ")}`,
    ).toEqual([]);

    expect(
      extraInDoc,
      `MCP tools documented in docs/MCP_REFERENCE.md but not registered in code: ${extraInDoc.join(", ")}`,
    ).toEqual([]);
  });

  it("verifies that all MCP tool input parameters are documented for each tool", () => {
    const mcpDocContent = readFileSync(MCP_DOC_PATH, "utf8");
    const elevatedActor: ActorContext = {
      actor: "test-elevated",
      source: "human",
      profile: "elevated",
    };
    const server = createServer({ actor: elevatedActor });
    const realToolRegistry = (
      server as unknown as {
        _registeredTools: Record<
          string,
          { inputSchema?: { shape?: Record<string, unknown> } }
        >;
      }
    )._registeredTools;

    const missingParamsReport: string[] = [];

    for (const [toolName, tool] of Object.entries(realToolRegistry)) {
      const sectionRegex = new RegExp(
        `###+ ${toolName}\\b([\\s\\S]*?)(?=###+ |$)`,
        "i",
      );
      const match = mcpDocContent.match(sectionRegex);
      if (!match) {
        missingParamsReport.push(`Section not found for tool '${toolName}'`);
        continue;
      }

      const sectionText = match[1]!;
      const shape = tool.inputSchema?.shape ?? {};
      for (const paramName of Object.keys(shape)) {
        if (
          !sectionText.includes(`\`${paramName}\``) &&
          !sectionText.includes(paramName)
        ) {
          missingParamsReport.push(
            `Tool '${toolName}' is missing documentation for parameter '${paramName}'`,
          );
        }
      }
    }

    expect(
      missingParamsReport,
      `Undocumented MCP parameters detected:\n${missingParamsReport.join("\n")}`,
    ).toEqual([]);
  });
});
