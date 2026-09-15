import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createProgram } from "../src/cli.js";
import { initializeWorkspace } from "../src/index.js";

describe("CLI surface commands over one core", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "contextpact-cli-test-"));
    initializeWorkspace(tempDir, "CLI Test Workspace");
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
      // Commander throws CommanderError on exitOverride()
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

  it("inspects workspace status via status command", async () => {
    const result = await runCli(["status", tempDir]);
    expect(result.exitCode).toBeUndefined();
    const parsed = JSON.parse(result.stdout);
    expect(parsed.initialized).toBe(true);
    expect(parsed.manifest.name).toBe("CLI Test Workspace");
  });

  it("proposes, retrieves, approves, and archives context items via CLI", async () => {
    // 1. Propose context item
    const proposeResult = await runCli([
      "propose",
      "--dir",
      tempDir,
      "--id",
      "rule-cli-parity",
      "--type",
      "rule",
      "--title",
      "Command Surface Parity",
      "--content",
      "Every command surface mirrors MCP.",
      "--tags",
      "cli",
      "mcp",
    ]);

    expect(proposeResult.exitCode).toBeUndefined();
    const proposed = JSON.parse(proposeResult.stdout);
    expect(proposed.id).toBe("rule-cli-parity");
    expect(proposed.status).toBe("proposed");

    // 2. Get context item
    const getResult = await runCli([
      "get",
      "rule-cli-parity",
      "--dir",
      tempDir,
    ]);
    expect(getResult.exitCode).toBeUndefined();
    const fetched = JSON.parse(getResult.stdout);
    expect(fetched.id).toBe("rule-cli-parity");
    expect(fetched.title).toBe("Command Surface Parity");

    // 3. Approve context item
    const approveResult = await runCli([
      "approve",
      "rule-cli-parity",
      "--dir",
      tempDir,
      "--actor",
      "lead-architect",
    ]);
    expect(approveResult.exitCode).toBeUndefined();
    const approved = JSON.parse(approveResult.stdout);
    expect(approved.id).toBe("rule-cli-parity");
    expect(approved.status).toBe("approved");

    // 4. Archive context item
    const archiveResult = await runCli([
      "archive",
      "rule-cli-parity",
      "--dir",
      tempDir,
      "--actor",
      "lead-architect",
    ]);
    expect(archiveResult.exitCode).toBeUndefined();
    const archived = JSON.parse(archiveResult.stdout);
    expect(archived.id).toBe("rule-cli-parity");
    expect(archived.status).toBe("archived");
  });

  it("proposes decisions via decision command", async () => {
    const result = await runCli([
      "decision",
      "propose",
      "--dir",
      tempDir,
      "--id",
      "dec-cli-transport",
      "--title",
      "Transport Independence",
      "--content",
      "Core is independent of transports.",
      "--tags",
      "architecture",
    ]);

    expect(result.exitCode).toBeUndefined();
    const parsed = JSON.parse(result.stdout);
    expect(parsed.id).toBe("dec-cli-transport");
    expect(parsed.type).toBe("decision");
    expect(parsed.status).toBe("proposed");
  });

  it("manages task lifecycle through task create, claim, get, list, and release", async () => {
    // 1. Create task
    const createResult = await runCli([
      "task",
      "create",
      "--dir",
      tempDir,
      "--id",
      "task-cli-e2e",
      "--title",
      "End to end task execution",
      "--desc",
      "Validate CLI task management",
      "--scope",
      "src/cli.ts",
    ]);

    expect(createResult.exitCode).toBeUndefined();
    const created = JSON.parse(createResult.stdout);
    expect(created.id).toBe("task-cli-e2e");
    expect(created.status).toBe("planned");

    // 2. Claim task lease
    const claimResult = await runCli([
      "task",
      "claim",
      "task-cli-e2e",
      "--dir",
      tempDir,
      "--agent",
      "builder-agent",
      "--ttl",
      "300",
    ]);

    expect(claimResult.exitCode).toBeUndefined();
    const lease = JSON.parse(claimResult.stdout);
    expect(lease.taskId).toBe("task-cli-e2e");
    expect(lease.agentId).toBe("builder-agent");

    // 3. Get task with lease
    const getResult = await runCli([
      "task",
      "get",
      "task-cli-e2e",
      "--dir",
      tempDir,
    ]);
    expect(getResult.exitCode).toBeUndefined();
    const withLease = JSON.parse(getResult.stdout);
    expect(withLease.task.id).toBe("task-cli-e2e");
    expect(withLease.lease.agentId).toBe("builder-agent");

    // 4. List tasks
    const listResult = await runCli(["task", "list", "--dir", tempDir]);
    expect(listResult.exitCode).toBeUndefined();
    const list = JSON.parse(listResult.stdout);
    expect(list.some((t: { id: string }) => t.id === "task-cli-e2e")).toBe(
      true,
    );

    // 5. Release task lease
    const releaseResult = await runCli([
      "task",
      "release",
      "task-cli-e2e",
      "--dir",
      tempDir,
      "--agent",
      "builder-agent",
      "--status",
      "done",
    ]);

    expect(releaseResult.exitCode).toBeUndefined();
    const released = JSON.parse(releaseResult.stdout);
    expect(released.id).toBe("task-cli-e2e");
    expect(released.status).toBe("done");
  });

  it("creates, retrieves, and resumes handoffs via CLI", async () => {
    // Setup a task first
    await runCli([
      "task",
      "create",
      "--dir",
      tempDir,
      "--id",
      "task-ho-cli",
      "--title",
      "CLI Handoff Task",
    ]);
    await runCli([
      "task",
      "claim",
      "task-ho-cli",
      "--dir",
      tempDir,
      "--agent",
      "agent-initial",
    ]);

    // 1. Create handoff
    const hoCreateResult = await runCli([
      "handoff",
      "create",
      "--dir",
      tempDir,
      "--id",
      "ho-cli-1",
      "--task",
      "task-ho-cli",
      "--agent",
      "agent-initial",
      "--outcome",
      "success",
      "--summary",
      "CLI handoff phase 1 completed.",
      "--next-action",
      "Execute phase 2 verification",
      "--evidence",
      JSON.stringify({
        kind: "test",
        description: "CLI tests pass",
        verified: true,
      }),
    ]);

    expect(hoCreateResult.exitCode).toBeUndefined();
    const handoff = JSON.parse(hoCreateResult.stdout);
    expect(handoff.id).toBe("ho-cli-1");
    expect(handoff.outcome).toBe("success");
    expect(handoff.nextAction).toBe("Execute phase 2 verification");

    // 2. Get handoff via handoff get and handoff <id>
    const hoGetResult = await runCli([
      "handoff",
      "get",
      "ho-cli-1",
      "--dir",
      tempDir,
    ]);
    expect(hoGetResult.exitCode).toBeUndefined();
    const fetchedHo = JSON.parse(hoGetResult.stdout);
    expect(fetchedHo.id).toBe("ho-cli-1");

    // 3. Resume handoff
    const resumeResult = await runCli([
      "resume",
      "ho-cli-1",
      "--dir",
      tempDir,
      "--agent",
      "agent-incoming",
    ]);

    expect(resumeResult.exitCode).toBeUndefined();
    const resumed = JSON.parse(resumeResult.stdout);
    expect(resumed.task.id).toBe("task-ho-cli");
    expect(resumed.lease.agentId).toBe("agent-incoming");
    expect(resumed.nextAction).toBe("Execute phase 2 verification");
  });

  it("exports and imports workspace via CLI commands", async () => {
    // Propose an approved item
    await runCli([
      "propose",
      "--dir",
      tempDir,
      "--type",
      "rule",
      "--title",
      "CLI Export Rule",
      "--content",
      "Exportable via CLI",
    ]);

    const exportFilePath = join(tempDir, "cli-export.json");
    const exportResult = await runCli([
      "export",
      exportFilePath,
      "--dir",
      tempDir,
    ]);
    expect(exportResult.exitCode).toBeUndefined();
    expect(existsSync(exportFilePath)).toBe(true);

    const exportOutput = JSON.parse(exportResult.stdout);
    expect(exportOutput.contextItemCount).toBeGreaterThanOrEqual(1);

    // Import into a target workspace
    const targetDir = mkdtempSync(
      join(tmpdir(), "contextpact-cli-import-target-"),
    );
    try {
      initializeWorkspace(targetDir, "Import Target");
      const importResult = await runCli([
        "import",
        exportFilePath,
        "--dir",
        targetDir,
        "--on-collision",
        "replace",
      ]);
      expect(importResult.exitCode).toBeUndefined();
      const importOutput = JSON.parse(importResult.stdout);
      expect(importOutput.imported.contextItems).toBeGreaterThanOrEqual(1);
    } finally {
      rmSync(targetDir, { recursive: true, force: true });
    }
  });

  it("backs up and restores workspace via CLI commands", async () => {
    await runCli([
      "propose",
      "--dir",
      tempDir,
      "--type",
      "fact",
      "--title",
      "CLI Backup Fact",
      "--content",
      "Dual-store backup verified via CLI",
    ]);

    const backupDirPath = join(tempDir, "custom-backup");
    const backupResult = await runCli([
      "backup",
      backupDirPath,
      "--dir",
      tempDir,
    ]);
    expect(backupResult.exitCode).toBeUndefined();
    expect(existsSync(backupDirPath)).toBe(true);

    const backupOutput = JSON.parse(backupResult.stdout);
    expect(backupOutput.stores).toEqual(["markdown", "sqlite"]);
    expect(backupOutput.itemCount).toBeGreaterThanOrEqual(1);

    const targetDir = mkdtempSync(
      join(tmpdir(), "contextpact-cli-restore-target-"),
    );
    try {
      const restoreResult = await runCli([
        "restore",
        backupDirPath,
        "--dir",
        targetDir,
      ]);
      expect(restoreResult.exitCode).toBeUndefined();
      const restoreOutput = JSON.parse(restoreResult.stdout);
      expect(restoreOutput.stores).toEqual(["markdown", "sqlite"]);
      expect(restoreOutput.itemCount).toBeGreaterThanOrEqual(1);

      // Verify doctor passes on restored target
      const doctorResult = await runCli(["doctor", targetDir]);
      expect(doctorResult.exitCode).toBeUndefined();
      const doctorOutput = JSON.parse(doctorResult.stdout);
      expect(doctorOutput.healthy).toBe(true);
      expect(doctorOutput.issues).toHaveLength(0);
    } finally {
      rmSync(targetDir, { recursive: true, force: true });
    }
  });

  it("runs reindex and doctor commands via CLI", async () => {
    // Propose an item
    await runCli([
      "propose",
      "--dir",
      tempDir,
      "--type",
      "rule",
      "--title",
      "CLI Reindex Rule",
      "--content",
      "Reindexed via CLI command",
    ]);

    // Reindex
    const reindexResult = await runCli(["reindex", tempDir]);
    expect(reindexResult.exitCode).toBeUndefined();
    const reindexOutput = JSON.parse(reindexResult.stdout);
    expect(
      reindexOutput.unchanged.length + reindexOutput.indexed.length,
    ).toBeGreaterThanOrEqual(1);

    // Doctor
    const doctorResult = await runCli(["doctor", tempDir]);
    expect(doctorResult.exitCode).toBeUndefined();
    const doctorOutput = JSON.parse(doctorResult.stdout);
    expect(doctorOutput.healthy).toBe(true);
    expect(doctorOutput.rebuiltDatabase).toBe(false);
  });
});
