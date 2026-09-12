#!/usr/bin/env node

import { Command } from "commander";

import { runStdioServer } from "./mcp/server.js";
import {
  initializeWorkspace,
  readWorkspaceStatus,
} from "./workspace/layout.js";

const program = new Command();

program
  .name("contextpact")
  .description("Local-first context and coordination across AI tools.")
  .version("0.0.0");

program
  .command("init")
  .description("Create an experimental local ContextPact workspace foundation.")
  .argument("[directory]", "Workspace directory", process.cwd())
  .option("--name <name>", "Workspace display name")
  .action((directory: string, options: { name?: string }) => {
    const status = initializeWorkspace(directory, options.name);
    process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
  });

program
  .command("status")
  .description("Inspect the current local workspace foundation.")
  .argument("[directory]", "Workspace directory", process.cwd())
  .action((directory: string) => {
    process.stdout.write(
      `${JSON.stringify(readWorkspaceStatus(directory), null, 2)}\n`,
    );
  });

program
  .command("mcp")
  .description("Run the experimental ContextPact MCP server over stdio.")
  .action(async () => {
    await runStdioServer();
  });

await program.parseAsync();
