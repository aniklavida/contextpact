#!/usr/bin/env node

import { fileURLToPath } from "node:url";
import { Command } from "commander";

import { ContextService } from "./core/context-service.js";
import { renderContextPackMarkdown } from "./core/pack-builder.js";
import type {
  ContextScope,
  ContextType,
  Importance,
} from "./domain/context.js";
import type { TaskStatus } from "./domain/agent.js";
import type { EvidenceItem, HandoffOutcome } from "./domain/handoff.js";
import { isOperationalContextType } from "./domain/lifecycle.js";
import {
  connectClient,
  formatGenericMcpBlock,
  isSupportedClient,
  runConnectionCheck,
} from "./mcp/connect/index.js";
import { runStdioServer } from "./mcp/server.js";
import {
  initializeWorkspace,
  readWorkspaceStatus,
} from "./workspace/layout.js";

export function createProgram(): Command {
  const program = new Command();

  program
    .name("contextpact")
    .description("Local-first context and coordination across AI tools.")
    .version("0.0.0");

  // 1. Bootstrap: init
  program
    .command("init")
    .description(
      "Create an experimental local ContextPact workspace foundation.",
    )
    .argument("[directory]", "Workspace directory", process.cwd())
    .option("--name <name>", "Workspace display name")
    .action((directory: string, options: { name?: string }) => {
      const status = initializeWorkspace(directory, options.name);
      process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
    });

  // 1. Bootstrap: status
  program
    .command("status")
    .description("Inspect the current local workspace foundation.")
    .argument("[directory]", "Workspace directory", process.cwd())
    .action((directory: string) => {
      process.stdout.write(
        `${JSON.stringify(readWorkspaceStatus(directory), null, 2)}\n`,
      );
    });

  // 2. Context: propose
  program
    .command("propose")
    .description("Propose a durable context item or record operational state.")
    .option("-d, --dir <directory>", "Workspace directory", process.cwd())
    .option("--id <id>", "Context item ID")
    .requiredOption(
      "-t, --type <type>",
      "Context type (rule, preference, fact, goal, source, decision, task_note, handoff)",
    )
    .requiredOption("--title <title>", "Context item title")
    .option("--content <content>", "Context item content", "")
    .option(
      "-s, --scope <scope>",
      "Context scope (global, workspace, task, session)",
    )
    .option(
      "-i, --importance <importance>",
      "Importance level (low, normal, high, critical)",
    )
    .option("--tags <tags...>", "Context tags")
    .option("--supersedes <ids...>", "Superseded context item IDs")
    .option("-a, --actor <actor>", "Proposer actor identity", "cli-user")
    .action(
      (options: {
        dir: string;
        id?: string;
        type: string;
        title: string;
        content: string;
        scope?: string;
        importance?: string;
        tags?: string[];
        supersedes?: string[];
        actor: string;
      }) => {
        const service = new ContextService(options.dir);
        try {
          const actorContext = {
            actor: options.actor,
            source: "human" as const,
            profile: "human",
          };
          const contextType = options.type as ContextType;
          const item = isOperationalContextType(contextType)
            ? service.create(
                {
                  id: options.id,
                  type: contextType,
                  title: options.title,
                  content: options.content,
                  scope: options.scope as ContextScope | undefined,
                  importance: options.importance as Importance | undefined,
                  tags: options.tags,
                  supersedes: options.supersedes,
                  status: "approved",
                },
                actorContext,
              )
            : service.propose(
                {
                  id: options.id,
                  type: contextType,
                  title: options.title,
                  content: options.content,
                  scope: options.scope as ContextScope | undefined,
                  importance: options.importance as Importance | undefined,
                  tags: options.tags,
                  supersedes: options.supersedes,
                },
                actorContext,
              );
          process.stdout.write(`${JSON.stringify(item, null, 2)}\n`);
        } finally {
          service.close();
        }
      },
    );

  // 2. Context: get
  program
    .command("get")
    .description(
      "Retrieve a context item by its ID across all lifecycle states.",
    )
    .argument("<id>", "Context item ID to retrieve")
    .option("-d, --dir <directory>", "Workspace directory", process.cwd())
    .action((id: string, options: { dir: string }) => {
      const service = new ContextService(options.dir);
      try {
        const item = service.getItem(id);
        if (!item) {
          process.stderr.write(`Context item '${id}' not found.\n`);
          process.exitCode = 1;
          return;
        }
        process.stdout.write(`${JSON.stringify(item, null, 2)}\n`);
      } finally {
        service.close();
      }
    });

  // 2. Context: approve
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

  // 2. Context: archive
  program
    .command("archive")
    .description("Archive an approved context item when no longer relevant.")
    .argument("<id>", "Context item ID to archive")
    .option("-d, --dir <directory>", "Workspace directory", process.cwd())
    .option("-a, --actor <actor>", "Archiver actor identity", "human-user")
    .action((id: string, options: { dir: string; actor: string }) => {
      const service = new ContextService(options.dir);
      try {
        const item = service.archive(id, {
          actor: options.actor,
          source: "human",
          profile: "human",
        });
        process.stdout.write(`${JSON.stringify(item, null, 2)}\n`);
      } finally {
        service.close();
      }
    });

  // 2. Context: search
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

  // 2. Context: pack
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

  // 3. Decisions: decision
  const decisionCmd = program
    .command("decision")
    .description("Propose and inspect architectural or product decisions.");

  decisionCmd
    .command("propose", { isDefault: true })
    .description("Propose an architectural or product decision.")
    .option("-d, --dir <directory>", "Workspace directory", process.cwd())
    .option("--id <id>", "Decision ID")
    .requiredOption("--title <title>", "Decision title")
    .option("--content <content>", "Decision rationale and implications", "")
    .option(
      "-s, --scope <scope>",
      "Decision scope (global, workspace, task, session)",
    )
    .option(
      "-i, --importance <importance>",
      "Importance level (low, normal, high, critical)",
    )
    .option("--tags <tags...>", "Decision tags")
    .option("--supersedes <ids...>", "Superseded decision IDs")
    .option("-a, --actor <actor>", "Proposer actor identity", "cli-user")
    .action(
      (options: {
        dir: string;
        id?: string;
        title: string;
        content: string;
        scope?: string;
        importance?: string;
        tags?: string[];
        supersedes?: string[];
        actor: string;
      }) => {
        const service = new ContextService(options.dir);
        try {
          const item = service.proposeDecision(
            {
              id: options.id,
              title: options.title,
              content: options.content,
              scope: options.scope as ContextScope | undefined,
              importance: options.importance as Importance | undefined,
              tags: options.tags,
              supersedes: options.supersedes,
            },
            {
              actor: options.actor,
              source: "human",
              profile: "human",
            },
          );
          process.stdout.write(`${JSON.stringify(item, null, 2)}\n`);
        } finally {
          service.close();
        }
      },
    );

  // 4. Tasks: task
  const taskCmd = program
    .command("task")
    .description("Manage coordination tasks and single-machine leases.");

  taskCmd
    .command("create")
    .description("Create a coordination task.")
    .option("-d, --dir <directory>", "Workspace directory", process.cwd())
    .option("--id <id>", "Task ID")
    .requiredOption("--title <title>", "Task title")
    .option("--desc, --description <description>", "Task description", "")
    .option(
      "-s, --status <status>",
      "Task status (planned, active, review, done, blocked)",
      "planned",
    )
    .option("--scope <scopes...>", "Task scope paths")
    .option("-a, --actor <actor>", "Creator actor identity", "cli-user")
    .action(
      (options: {
        dir: string;
        id?: string;
        title: string;
        description: string;
        status: string;
        scope?: string[];
        actor: string;
      }) => {
        const service = new ContextService(options.dir);
        try {
          const task = service.createTask(
            {
              id: options.id,
              title: options.title,
              description: options.description,
              status: options.status as TaskStatus,
              scope: options.scope ?? [],
            },
            {
              actor: options.actor,
              source: "human",
              profile: "human",
            },
          );
          process.stdout.write(`${JSON.stringify(task, null, 2)}\n`);
        } finally {
          service.close();
        }
      },
    );

  taskCmd
    .command("claim")
    .description("Claim, renew, or takeover a task lease.")
    .argument("<taskId>", "Task ID to claim")
    .option("-d, --dir <directory>", "Workspace directory", process.cwd())
    .option("-a, --agent <agentId>", "Claiming agent identity", "cli-agent")
    .option("--ttl <seconds>", "Lease duration in seconds", "300")
    .option("--scope <scopes...>", "Advisory scope paths")
    .option(
      "--takeover-reason <reason>",
      "Reason for takeover if lease is stale",
    )
    .action(
      (
        taskId: string,
        options: {
          dir: string;
          agent: string;
          ttl: string;
          scope?: string[];
          takeoverReason?: string;
        },
      ) => {
        const service = new ContextService(options.dir);
        try {
          const ttlSeconds = parseInt(options.ttl, 10);
          const lease = service.claimTask({
            taskId,
            agentId: options.agent,
            ttlSeconds,
            scope: options.scope,
            takeoverReason: options.takeoverReason,
          });
          process.stdout.write(`${JSON.stringify(lease, null, 2)}\n`);
        } finally {
          service.close();
        }
      },
    );

  taskCmd
    .command("release")
    .description("Release an active task lease and transition task status.")
    .argument("<taskId>", "Task ID to release")
    .option("-d, --dir <directory>", "Workspace directory", process.cwd())
    .option("-a, --agent <agentId>", "Releasing agent identity", "cli-agent")
    .option(
      "-s, --status <status>",
      "Final task status (review, done, blocked, planned)",
      "review",
    )
    .action(
      (
        taskId: string,
        options: {
          dir: string;
          agent: string;
          status: string;
        },
      ) => {
        const service = new ContextService(options.dir);
        try {
          const task = service.releaseTask({
            taskId,
            agentId: options.agent,
            finalStatus: options.status as
              "review" | "done" | "blocked" | "planned",
          });
          process.stdout.write(`${JSON.stringify(task, null, 2)}\n`);
        } finally {
          service.close();
        }
      },
    );

  taskCmd
    .command("get")
    .description("Retrieve a task by ID along with its active lease state.")
    .argument("<taskId>", "Task ID to inspect")
    .option("-d, --dir <directory>", "Workspace directory", process.cwd())
    .action((taskId: string, options: { dir: string }) => {
      const service = new ContextService(options.dir);
      try {
        const result = service.getTaskWithLease(taskId);
        if (!result) {
          process.stderr.write(`Task '${taskId}' not found.\n`);
          process.exitCode = 1;
          return;
        }
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      } finally {
        service.close();
      }
    });

  taskCmd
    .command("list")
    .description("List tasks in the workspace.")
    .option("-d, --dir <directory>", "Workspace directory", process.cwd())
    .option(
      "-s, --status <status>",
      "Filter by status (planned, active, review, done, blocked)",
    )
    .action((options: { dir: string; status?: string }) => {
      const service = new ContextService(options.dir);
      try {
        const tasks = service.listTasks(
          options.status as TaskStatus | undefined,
        );
        process.stdout.write(`${JSON.stringify(tasks, null, 2)}\n`);
      } finally {
        service.close();
      }
    });

  // 5. Handoffs: handoff
  const handoffCmd = program
    .command("handoff")
    .description(
      "Create, inspect, or manage evidence-bearing structured handoffs.",
    );

  handoffCmd
    .command("create")
    .description("Record a new evidence-bearing structured handoff.")
    .option("-d, --dir <directory>", "Workspace directory", process.cwd())
    .option("--id <id>", "Handoff ID")
    .requiredOption("-t, --task <taskId>", "Task ID")
    .option("-a, --agent <agentId>", "Agent identity", "cli-agent")
    .option("--title <title>", "Handoff title")
    .requiredOption(
      "-o, --outcome <outcome>",
      "Handoff outcome (success, blocked, in_progress)",
    )
    .requiredOption("-m, --summary <summary>", "Handoff summary narrative")
    .requiredOption("-n, --next-action <action>", "Strictly one next action")
    .option("--blockers <blockers...>", "Blockers encountered")
    .option(
      "--evidence <items...>",
      "Evidence items (description or JSON objects)",
    )
    .option("--tags <tags...>", "Handoff tags")
    .option("--keep-lease", "Do not release task lease on handoff", false)
    .action(
      (options: {
        dir: string;
        id?: string;
        task: string;
        agent: string;
        title?: string;
        outcome: string;
        summary: string;
        nextAction: string;
        blockers?: string[];
        evidence?: string[];
        tags?: string[];
        keepLease?: boolean;
      }) => {
        const service = new ContextService(options.dir);
        try {
          const parsedEvidence: EvidenceItem[] = (options.evidence ?? []).map(
            (item) => {
              try {
                return JSON.parse(item);
              } catch {
                return {
                  kind: "manual",
                  description: item,
                  verified: true,
                };
              }
            },
          );

          const actorContext = {
            actor: options.agent,
            source: "human" as const,
            profile: "human",
          };

          service.ensureAgent(options.agent, { clientKind: "cli" });

          const handoff = service.createHandoff(
            {
              id: options.id,
              taskId: options.task,
              agentId: options.agent,
              title: options.title,
              outcome: options.outcome as HandoffOutcome,
              summary: options.summary,
              blockers: options.blockers ?? [],
              nextAction: options.nextAction,
              evidence: parsedEvidence,
              releaseLease: !options.keepLease,
              tags: options.tags ?? [],
            },
            actorContext,
          );
          process.stdout.write(`${JSON.stringify(handoff, null, 2)}\n`);
        } finally {
          service.close();
        }
      },
    );

  handoffCmd
    .command("get")
    .description("Retrieve a structured handoff by ID.")
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

  handoffCmd
    .command("inspect [id]", { isDefault: true, hidden: true })
    .description("Inspect a structured handoff by ID directly.")
    .option("-d, --dir <directory>", "Workspace directory", process.cwd())
    .action((id: string | undefined, options: { dir: string }) => {
      if (!id) {
        process.stderr.write("Handoff ID required.\n");
        process.exitCode = 1;
        return;
      }
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

  // 5. Handoffs: resume
  program
    .command("resume")
    .description(
      "Resume work from a structured handoff: claim the task and inspect context.",
    )
    .argument("<handoffId>", "Handoff ID to resume from")
    .option("-d, --dir <directory>", "Workspace directory", process.cwd())
    .option(
      "-a, --agent <agentId>",
      "Resuming agent identity",
      "agent-resuming",
    )
    .option("--ttl <seconds>", "Lease duration in seconds", "300")
    .action(
      (
        handoffId: string,
        options: { dir: string; agent: string; ttl: string },
      ) => {
        const service = new ContextService(options.dir);
        try {
          service.ensureAgent(options.agent, { clientKind: "cli" });
          const result = service.resumeHandoff({
            handoffId,
            agentId: options.agent,
            ttlSeconds: parseInt(options.ttl, 10),
          });
          process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        } finally {
          service.close();
        }
      },
    );

  // Maintenance & Runner (Documented CLI exceptions)
  program
    .command("reindex")
    .description(
      "Rebuild SQLite search index and reconcile Markdown knowledge items.",
    )
    .argument("[directory]", "Workspace directory", process.cwd())
    .option(
      "--clean-deleted",
      "Remove database rows for files deleted from disk",
      true,
    )
    .option(
      "--no-clean-deleted",
      "Preserve database rows for files deleted from disk",
    )
    .action((directory: string, options: { cleanDeleted?: boolean }) => {
      const service = new ContextService(directory);
      try {
        const result = service.reindex({
          cleanDeleted: options.cleanDeleted !== false,
        });
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      } finally {
        service.close();
      }
    });

  program
    .command("backup")
    .description(
      "Create a point-in-time dual-store snapshot bundle covering Markdown vault and SQLite database.",
    )
    .argument("[outputPath]", "Backup destination path")
    .option("-d, --dir <directory>", "Workspace directory", process.cwd())
    .action((outputPath: string | undefined, options: { dir: string }) => {
      const service = new ContextService(options.dir);
      try {
        const result = service.backupWorkspace({ outputPath });
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      } catch (err) {
        process.stderr.write(
          `Backup failed: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        process.exitCode = 1;
      } finally {
        service.close();
      }
    });

  program
    .command("restore")
    .description(
      "Restore both Markdown vault and SQLite database from a dual-store backup snapshot.",
    )
    .argument("<sourcePath>", "Path to backup snapshot directory to restore")
    .option(
      "-d, --dir <directory>",
      "Target workspace directory",
      process.cwd(),
    )
    .option(
      "--clean",
      "Remove existing workspace files before restoring",
      false,
    )
    .action((sourcePath: string, options: { dir: string; clean?: boolean }) => {
      try {
        const result = ContextService.restore(options.dir, sourcePath, {
          cleanExisting: options.clean,
        });
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      } catch (err) {
        process.stderr.write(
          `Restore failed: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        process.exitCode = 1;
      }
    });

  program
    .command("doctor")
    .description(
      "Diagnose workspace health, schema versions, index freshness, orphaned files, expired leases, missing provenance, and rebuilt database state.",
    )
    .argument("[directory]", "Workspace directory", process.cwd())
    .action((directory: string) => {
      const report = ContextService.doctor(directory);
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      if (!report.healthy) {
        process.exitCode = 1;
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
    .command("export")
    .description(
      "Export workspace including Markdown vault and SQLite operational state.",
    )
    .argument("[outputPath]", "Export destination file path")
    .option("-d, --dir <directory>", "Workspace directory", process.cwd())
    .option("--stdout", "Print raw export JSON to stdout", false)
    .action(
      (
        outputPath: string | undefined,
        options: { dir: string; stdout?: boolean },
      ) => {
        const service = new ContextService(options.dir);
        try {
          const result = service.exportWorkspace({ outputPath });
          if (options.stdout) {
            process.stdout.write(`${JSON.stringify(result.data, null, 2)}\n`);
          } else {
            process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
          }
        } finally {
          service.close();
        }
      },
    );

  program
    .command("import")
    .description(
      "Import workspace data with deterministic ID collision policies.",
    )
    .argument("<sourceFile>", "Path to export JSON file to import")
    .option("-d, --dir <directory>", "Workspace directory", process.cwd())
    .option(
      "--on-collision <policy>",
      "ID collision policy (skip, replace, error)",
      "skip",
    )
    .action(
      (sourceFile: string, options: { dir: string; onCollision: string }) => {
        const service = new ContextService(options.dir);
        try {
          const result = service.importWorkspace(sourceFile, {
            onCollision: options.onCollision as "skip" | "replace" | "error",
          });
          process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        } catch (err) {
          process.stderr.write(
            `Import failed: ${err instanceof Error ? err.message : String(err)}\n`,
          );
          process.exitCode = 1;
        } finally {
          service.close();
        }
      },
    );

  program
    .command("connect")
    .description(
      "Connect ContextPact MCP server to host AI clients (claude, codex, cursor) or print generic MCP config.",
    )
    .argument(
      "[client]",
      "Client identifier (claude, codex, cursor, or generic/other)",
    )
    .option(
      "--check",
      "Spawn MCP server over stdio, invoke a real tool, and report connection status",
    )
    .option(
      "--base-dir <directory>",
      "Base directory for locating client configuration file (default: user home)",
    )
    .option("--command <command>", "Custom MCP server command executable")
    .option("--args <args...>", "Custom MCP server arguments")
    .action(
      async (
        client: string | undefined,
        options: {
          check?: boolean;
          baseDir?: string;
          command?: string;
          args?: string[];
        },
      ) => {
        if (options.check) {
          const checkResult = await runConnectionCheck({
            command: options.command,
            args: options.args,
          });
          if (!checkResult.ok) {
            process.stderr.write(
              `MCP connection check failed: ${checkResult.error}\n`,
            );
            process.exitCode = 1;
            return;
          }
          process.stdout.write(`${JSON.stringify(checkResult, null, 2)}\n`);
          return;
        }

        if (!client || !isSupportedClient(client)) {
          const block = formatGenericMcpBlock({
            command: options.command,
            args: options.args,
          });
          process.stdout.write(block);
          return;
        }

        try {
          const result = connectClient(client, {
            baseDir: options.baseDir,
            command: options.command,
            args: options.args,
          });
          process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        } catch (error) {
          process.stderr.write(
            `Failed to connect client '${client}': ${error instanceof Error ? error.message : String(error)}\n`,
          );
          process.exitCode = 1;
        }
      },
    );

  program
    .command("mcp")
    .description("Run the experimental ContextPact MCP server over stdio.")
    .action(async () => {
      await runStdioServer();
    });

  return program;
}

export function assertSupportedNodeVersion(
  currentVersion = process.versions.node,
): void {
  const parts = currentVersion.split(".").map(Number);
  const major = parts[0] ?? 0;
  const minor = parts[1] ?? 0;
  if (major < 22 || (major === 22 && minor < 12)) {
    throw new Error(
      `ContextPact requires Node.js >=22.12.0 (detected v${currentVersion}). Please upgrade Node.js.`,
    );
  }
}

export const program = createProgram();

const normalizedArgv1 = process.argv[1]?.replace(/\\/g, "/");
const isEntry =
  normalizedArgv1 &&
  (process.argv[1] === fileURLToPath(import.meta.url) ||
    normalizedArgv1.endsWith("/cli.ts") ||
    normalizedArgv1.endsWith("/cli.js") ||
    normalizedArgv1.endsWith("/contextpact") ||
    normalizedArgv1.endsWith("/contextpact.cmd"));

if (isEntry) {
  try {
    assertSupportedNodeVersion();
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    process.exit(1);
  }
  void program.parseAsync();
}
