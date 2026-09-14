#!/usr/bin/env node

import { Command } from "commander";

import { ContextService } from "./core/context-service.js";
import type { ContextScope } from "./domain/context.js";
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
  .command("approve")
  .description("Approve a proposed context item through the approval gate.")
  .argument("<id>", "Context item ID to approve")
  .option("-d, --dir <directory>", "Workspace directory", process.cwd())
  .option("-a, --actor <actor>", "Approver actor identity", "human-user")
  .action((id: string, options: { dir: string; actor: string }) => {
    const service = new ContextService(options.dir);
    try {
      const item = service.approve(id, {
        actor: options.actor,
        source: "human",
        profile: "human",
      });
      process.stdout.write(`${JSON.stringify(item, null, 2)}\n`);
    } finally {
      service.close();
    }
  });

program
  .command("pack")
  .description("Build and inspect the default approved context pack.")
  .option("-d, --dir <directory>", "Workspace directory", process.cwd())
  .option(
    "-s, --scope <scope>",
    "Context scope (global, workspace, task, session)",
  )
  .action((options: { dir: string; scope?: string }) => {
    const service = new ContextService(options.dir);
    try {
      const scope = options.scope ? (options.scope as ContextScope) : undefined;
      const pack = service.buildDefaultPack(scope);
      process.stdout.write(`${JSON.stringify(pack, null, 2)}\n`);
    } finally {
      service.close();
    }
  });

program
  .command("reindex")
  .description(
    "Rebuild SQLite search index and reconcile Markdown knowledge items.",
  )
  .argument("[directory]", "Workspace directory", process.cwd())
  .action((directory: string) => {
    const service = new ContextService(directory);
    try {
      const result = service.reindex();
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } finally {
      service.close();
    }
  });

program
  .command("reconcile")
  .description("Reconcile Markdown knowledge items with SQLite index.")
  .argument("[directory]", "Workspace directory", process.cwd())
  .action((directory: string) => {
    const service = new ContextService(directory);
    try {
      const result = service.reconcile();
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } finally {
      service.close();
    }
  });

program
  .command("mcp")
  .description("Run the experimental ContextPact MCP server over stdio.")
  .action(async () => {
    await runStdioServer();
  });

await program.parseAsync();
