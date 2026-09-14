#!/usr/bin/env node

import { Command } from "commander";

import { ContextService } from "./core/context-service.js";
import { renderContextPackMarkdown } from "./core/pack-builder.js";
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
  .command("search")
  .description(
    "Search workspace context items using SQLite FTS5 full-text search.",
  )
  .argument("<query>", "Search query string")
  .option("-d, --dir <directory>", "Workspace directory", process.cwd())
  .option(
    "-s, --scope <scope>",
    "Context scope (global, workspace, task, session)",
  )
  .option("--allow-global", "Allow searching global context")
  .option("-l, --limit <number>", "Maximum number of results", "10")
  .action(
    (
      query: string,
      options: {
        dir: string;
        scope?: string;
        allowGlobal?: boolean;
        limit?: string;
      },
    ) => {
      const service = new ContextService(options.dir);
      try {
        const results = service.search(query, {
          scope: options.scope ? (options.scope as ContextScope) : undefined,
          allowGlobal: options.allowGlobal,
          limit: options.limit ? parseInt(options.limit, 10) : undefined,
        });
        process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
      } finally {
        service.close();
      }
    },
  );

program
  .command("pack")
  .description(
    "Build and inspect the deterministic token-budgeted context pack.",
  )
  .option("-d, --dir <directory>", "Workspace directory", process.cwd())
  .option("-q, --query <query>", "Search query filter")
  .option(
    "-s, --scope <scope>",
    "Context scope (global, workspace, task, session)",
  )
  .option("-t, --task <taskId>", "Active task ID")
  .option("-S, --session <sessionId>", "Active session ID")
  .option("-c, --client <clientId>", "Client identity")
  .option("-b, --budget <tokens>", "Maximum token budget")
  .option("--allow-global", "Allow global context if permitted by policy")
  .option("-f, --format <format>", "Output format (json, markdown)", "json")
  .action(
    (options: {
      dir: string;
      query?: string;
      scope?: string;
      task?: string;
      session?: string;
      client?: string;
      budget?: string;
      allowGlobal?: boolean;
      format?: string;
    }) => {
      const service = new ContextService(options.dir);
      try {
        const scope = options.scope
          ? (options.scope as ContextScope)
          : undefined;
        const maxTokens = options.budget
          ? parseInt(options.budget, 10)
          : undefined;
        const pack = service.buildPack({
          query: options.query,
          scope,
          taskId: options.task,
          sessionId: options.session,
          clientId: options.client,
          maxTokens,
          allowGlobal: options.allowGlobal,
        });
        if (options.format === "markdown") {
          process.stdout.write(`${renderContextPackMarkdown(pack)}\n`);
        } else {
          process.stdout.write(`${JSON.stringify(pack, null, 2)}\n`);
        }
      } finally {
        service.close();
      }
    },
  );

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
  .command("handoff")
  .description("Inspect an evidence-bearing structured handoff by ID.")
  .argument("<id>", "Handoff ID")
  .option("-d, --dir <directory>", "Workspace directory", process.cwd())
  .action((id: string, options: { dir: string }) => {
    const service = new ContextService(options.dir);
    try {
      const handoff = service.getHandoff(id);
      if (!handoff) {
        process.stderr.write(`Handoff '${id}' not found.\n`);
        process.exitCode = 1;
        return;
      }
      process.stdout.write(`${JSON.stringify(handoff, null, 2)}\n`);
    } finally {
      service.close();
    }
  });

program
  .command("resume")
  .description(
    "Resume work from a structured handoff: claim the task and inspect context.",
  )
  .argument("<handoffId>", "Handoff ID to resume from")
  .option("-d, --dir <directory>", "Workspace directory", process.cwd())
  .option("-a, --agent <agentId>", "Resuming agent identity", "agent-resuming")
  .action((handoffId: string, options: { dir: string; agent: string }) => {
    const service = new ContextService(options.dir);
    try {
      const result = service.resumeHandoff({
        handoffId,
        agentId: options.agent,
      });
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
