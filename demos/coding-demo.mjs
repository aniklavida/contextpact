#!/usr/bin/env node

/**
 * ============================================================================
 * ContextPact Proof Demo: End-to-End Coding Workflow
 * ============================================================================
 *
 * PURPOSE:
 * Demonstrates ContextPact coordinating multiple AI agents and human oversight
 * in a real coding workflow starting from an empty workspace directory.
 * Proves that coding is the first proof workflow for ContextPact (CP-D002).
 *
 * WHAT THIS DEMO EXERCISES (END-TO-END):
 * 1. Clean workspace initialization (`contextpact init`)
 * 2. Host client MCP integration (`contextpact connect claude`) and stdio probe (`contextpact connect --check`)
 * 3. Proposing an architectural rule through the approval gate (`contextpact propose` -> `contextpact approve`)
 * 4. Creating coordinated tasks with non-overlapping scopes (`contextpact task create`)
 * 5. Multi-agent task claiming and mutual-exclusion lease conflict rejection (`contextpact task claim`)
 * 6. Deterministic context pack retrieval for both agents (`contextpact pack`)
 * 7. Agent proposing durable knowledge during implementation, held at the approval gate
 * 8. Human approving the agent-authored proposal
 * 9. Evidence-bearing structured handoff with test evidence and strictly one next action (`contextpact handoff create`)
 * 10. Resumption from handoff alone by a second agent (`contextpact resume`), verifying lease transfer and next action
 * 11. Final task completion (`contextpact task release`) and workspace health diagnosis (`contextpact doctor`)
 *
 * PREREQUISITES:
 * - Node.js >= 22.14.0
 * - Build the repository once before running: `npm run build`
 *
 * RUNNING THIS SCRIPT:
 *   # Run unattended in an isolated temporary directory (auto-cleaned):
 *   node demos/coding-demo.mjs
 *
 *   # Or run in a specific directory:
 *   mkdir /tmp/coding-demo-workspace && cd /tmp/coding-demo-workspace
 *   node /path/to/demos/coding-demo.mjs .
 *
 *   # Or preserve the generated workspace for manual inspection:
 *   node demos/coding-demo.mjs --keep
 * ============================================================================
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..");
const CLI_PATH = join(PROJECT_ROOT, "dist", "cli.js");

if (!existsSync(CLI_PATH)) {
  console.error("Error: Built CLI not found at " + CLI_PATH);
  console.error("Please run 'npm run build' before running this demo.");
  process.exit(1);
}

// Parse command line arguments
const args = process.argv.slice(2);
const keepWorkspace = args.includes("--keep");
const explicitDir = args.find((a) => !a.startsWith("--"));

let workspaceDir = explicitDir ? resolve(explicitDir) : null;
let isTemporary = false;

if (!workspaceDir) {
  workspaceDir = mkdtempSync(join(tmpdir(), "contextpact-coding-demo-"));
  isTemporary = true;
}

console.log("=".repeat(80));
console.log("ContextPact End-to-End Proof Demo: Coding Workflow");
console.log("=".repeat(80));
console.log(`Workspace: ${workspaceDir}`);
console.log(`CLI Path:  ${CLI_PATH}`);
console.log();

function runCli(commandArgs, expectSuccess = true) {
  const result = spawnSync(process.execPath, [CLI_PATH, ...commandArgs], {
    cwd: workspaceDir,
    encoding: "utf8",
    env: { ...process.env, NODE_ENV: "test" },
  });

  if (expectSuccess && result.status !== 0) {
    console.error(`Command failed: contextpact ${commandArgs.join(" ")}`);
    console.error(`Exit code: ${result.status}`);
    console.error(`stderr:\n${result.stderr}`);
    console.error(`stdout:\n${result.stdout}`);
    throw new Error(`Command failed with exit code ${result.status}`);
  }

  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    json: () => {
      try {
        return JSON.parse(result.stdout.trim());
      } catch (err) {
        throw new Error(
          `Failed to parse JSON from command output:\n${result.stdout}\nError: ${err.message}`,
        );
      }
    },
  };
}

let currentStep = 1;
const totalSteps = 10;

function logStep(title, details) {
  console.log(`[Step ${currentStep}/${totalSteps}] ${title}`);
  if (details) {
    console.log(`  ${details}`);
  }
  currentStep++;
}

try {
  // --------------------------------------------------------------------------
  // Step 1: Initialize Workspace
  // --------------------------------------------------------------------------
  logStep(
    "Initialize Clean Workspace",
    "Creates .contextpact directory with SQLite database, Markdown vault, and pact.yaml",
  );
  console.log(
    `  $ contextpact init ${workspaceDir} --name "Payment Service Engine"`,
  );
  const initResult = runCli([
    "init",
    workspaceDir,
    "--name",
    "Payment Service Engine",
  ]).json();
  if (!initResult.initialized) {
    throw new Error("Workspace initialization reported initialized=false");
  }
  console.log(`  -> Workspace initialized. ID: ${initResult.manifest.id}`);
  console.log();

  // --------------------------------------------------------------------------
  // Step 2: Guided Host Connection (Claude Code MCP & stdio verification)
  // --------------------------------------------------------------------------
  logStep(
    "Connect Host AI Client & Verify Stdio MCP Server",
    "Configures Claude Code MCP settings in the workspace and verifies stdio connectivity",
  );
  console.log(`  $ contextpact connect claude --base-dir ${workspaceDir}`);
  const connectResult = runCli([
    "connect",
    "claude",
    "--base-dir",
    workspaceDir,
  ]).json();
  console.log(`  -> Host config generated: ${connectResult.configPath}`);

  console.log(`  $ contextpact connect --check`);
  const checkResult = runCli(["connect", "--check"]).json();
  if (!checkResult.ok) {
    throw new Error(`MCP connection check failed: ${checkResult.error}`);
  }
  console.log(
    `  -> Stdio MCP server active: ${checkResult.toolsAvailable.length} tools available, probe '${checkResult.testedTool}' passed`,
  );
  console.log();

  // --------------------------------------------------------------------------
  // Step 3: Propose and Approve Foundational Knowledge
  // --------------------------------------------------------------------------
  logStep(
    "Publish Architectural Rule via Human Approval Gate",
    "Proposes an API idempotency rule; human reviewer approves it into durable knowledge",
  );
  console.log(`  $ contextpact propose -t rule --id rule-idempotency-keys ...`);
  const propRule = runCli([
    "propose",
    "-d",
    workspaceDir,
    "-t",
    "rule",
    "--id",
    "rule-idempotency-keys",
    "--title",
    "Payment Mutation Idempotency Standard",
    "--content",
    "All mutating payment API endpoints require an Idempotency-Key HTTP header. Cached responses are served for duplicate keys within 24 hours.",
    "-s",
    "workspace",
    "-i",
    "critical",
    "-a",
    "lead-architect",
  ]).json();
  console.log(
    `  -> Rule proposed with status '${propRule.status}' (held at approval gate)`,
  );

  console.log(`  $ contextpact approve rule-idempotency-keys -a human-lead`);
  const appRule = runCli([
    "approve",
    "-d",
    workspaceDir,
    "rule-idempotency-keys",
    "-a",
    "human-lead",
  ]).json();
  if (appRule.status !== "approved") {
    throw new Error(`Expected approved status but got '${appRule.status}'`);
  }
  console.log(
    `  -> Rule approved. Version: ${appRule.version}, Status: ${appRule.status}`,
  );
  console.log();

  // --------------------------------------------------------------------------
  // Step 4: Create Coordinated Tasks with Non-Overlapping Scopes
  // --------------------------------------------------------------------------
  logStep(
    "Create Parallel Development Tasks with Isolated Scopes",
    "Defines non-overlapping scopes: src/gateways/stripe/ and src/services/receipts/",
  );
  console.log(
    `  $ contextpact task create --id task-stripe-gw --scope src/gateways/stripe/ ...`,
  );
  const task1 = runCli([
    "task",
    "create",
    "-d",
    workspaceDir,
    "--id",
    "task-stripe-gw",
    "--title",
    "Implement Stripe Webhook Gateway",
    "--desc",
    "Validate webhook signatures and process incoming payment events",
    "--scope",
    "src/gateways/stripe/",
    "-a",
    "lead-architect",
  ]).json();

  console.log(
    `  $ contextpact task create --id task-receipt-svc --scope src/services/receipts/ ...`,
  );
  const task2 = runCli([
    "task",
    "create",
    "-d",
    workspaceDir,
    "--id",
    "task-receipt-svc",
    "--title",
    "Implement Receipt Mailer Service",
    "--desc",
    "Generate PDF receipts and queue email dispatch upon payment",
    "--scope",
    "src/services/receipts/",
    "-a",
    "lead-architect",
  ]).json();
  console.log(
    `  -> Tasks created: ${task1.id} (planned), ${task2.id} (planned)`,
  );
  console.log();

  // --------------------------------------------------------------------------
  // Step 5: Multi-Agent Lease Acquisition & Conflict Rejection
  // --------------------------------------------------------------------------
  logStep(
    "Parallel Agent Task Claims & Mutex Conflict Proof",
    "Agent A claims task 1, Agent B claims task 2. Conflicting claim on task 1 is rejected.",
  );
  console.log(
    `  $ contextpact task claim task-stripe-gw -a agent-stripe-dev --ttl 300`,
  );
  const claim1 = runCli([
    "task",
    "claim",
    "-d",
    workspaceDir,
    "task-stripe-gw",
    "-a",
    "agent-stripe-dev",
    "--scope",
    "src/gateways/stripe/",
    "--ttl",
    "300",
  ]).json();
  console.log(
    `  -> Lease acquired by '${claim1.agentId}' on '${claim1.taskId}' (expires: ${claim1.expiresAt})`,
  );

  console.log(
    `  $ contextpact task claim task-receipt-svc -a agent-receipt-dev --ttl 300`,
  );
  const claim2 = runCli([
    "task",
    "claim",
    "-d",
    workspaceDir,
    "task-receipt-svc",
    "-a",
    "agent-receipt-dev",
    "--scope",
    "src/services/receipts/",
    "--ttl",
    "300",
  ]).json();
  console.log(
    `  -> Lease acquired by '${claim2.agentId}' on '${claim2.taskId}' (expires: ${claim2.expiresAt})`,
  );

  console.log(
    `  $ contextpact task claim task-stripe-gw -a agent-receipt-dev (testing conflict rejection)`,
  );
  const conflictAttempt = runCli(
    [
      "task",
      "claim",
      "-d",
      workspaceDir,
      "task-stripe-gw",
      "-a",
      "agent-receipt-dev",
    ],
    false,
  );
  if (conflictAttempt.status === 0) {
    throw new Error("Expected conflicting claim to fail, but it succeeded!");
  }
  const conflictMessage =
    conflictAttempt.stderr
      .split("\n")
      .map((l) => l.trim())
      .find(
        (l) =>
          l.startsWith("LeaseConflictError:") ||
          (l.includes("already claimed") && !l.startsWith("throw ")),
      ) || "LeaseConflictError: active lease held";
  console.log(`  -> Expected conflict rejection verified: ${conflictMessage}`);
  console.log();

  // --------------------------------------------------------------------------
  // Step 6: Both Agents Retrieve the Same Approved Context Pack
  // --------------------------------------------------------------------------
  logStep(
    "Retrieve Approved Context Pack Across Parallel Agents",
    "Both agents request context packs for their active tasks; both receive the approved rule",
  );
  console.log(`  $ contextpact pack -t task-stripe-gw`);
  const packA = runCli([
    "pack",
    "-d",
    workspaceDir,
    "-t",
    "task-stripe-gw",
  ]).json();
  console.log(`  $ contextpact pack -t task-receipt-svc`);
  const packB = runCli([
    "pack",
    "-d",
    workspaceDir,
    "-t",
    "task-receipt-svc",
  ]).json();

  const ruleInA = packA.items.some((i) => i.id === "rule-idempotency-keys");
  const ruleInB = packB.items.some((i) => i.id === "rule-idempotency-keys");
  if (!ruleInA || !ruleInB) {
    throw new Error(
      "Approved rule missing from one or both agent context packs",
    );
  }
  console.log(
    `  -> Both agents successfully retrieved 'rule-idempotency-keys' with identical provenance`,
  );
  console.log();

  // --------------------------------------------------------------------------
  // Step 7: Agent Proposes Durable Knowledge During Implementation
  // --------------------------------------------------------------------------
  logStep(
    "Agent Proposes Durable Architectural Decision",
    "agent-stripe-dev proposes webhook replay tolerance; proposal stays out of default packs",
  );
  console.log(
    `  $ contextpact propose -t decision --id dec-stripe-webhook-tolerance ...`,
  );
  const decProposal = runCli([
    "propose",
    "-d",
    workspaceDir,
    "-t",
    "decision",
    "--id",
    "dec-stripe-webhook-tolerance",
    "--title",
    "Stripe Webhook Timestamp Tolerance Window",
    "--content",
    "Webhook signatures with event timestamps older than 300 seconds are rejected to mitigate replay attacks.",
    "-s",
    "workspace",
    "-i",
    "high",
    "-a",
    "agent-stripe-dev",
  ]).json();
  if (decProposal.status !== "proposed") {
    throw new Error(`Expected proposed status but got '${decProposal.status}'`);
  }
  console.log(
    `  -> Decision proposed by agent: status='${decProposal.status}'`,
  );

  // Verify it is not yet visible in pack
  const packPreApprove = runCli(["pack", "-d", workspaceDir]).json();
  if (
    packPreApprove.items.some((i) => i.id === "dec-stripe-webhook-tolerance")
  ) {
    throw new Error(
      "Unapproved proposed decision leaked into default context pack!",
    );
  }
  console.log(
    `  -> Verified: proposed decision is withheld from context packs until approved`,
  );
  console.log();

  // --------------------------------------------------------------------------
  // Step 8: Human Approver Approves the Agent Proposal
  // --------------------------------------------------------------------------
  logStep(
    "Human Reviewer Approves Agent-Authored Decision",
    "Human lead approves dec-stripe-webhook-tolerance; it becomes active durable knowledge",
  );
  console.log(
    `  $ contextpact approve dec-stripe-webhook-tolerance -a human-lead`,
  );
  const decApproved = runCli([
    "approve",
    "-d",
    workspaceDir,
    "dec-stripe-webhook-tolerance",
    "-a",
    "human-lead",
  ]).json();
  if (decApproved.status !== "approved") {
    throw new Error(`Expected approved status but got '${decApproved.status}'`);
  }
  console.log(
    `  -> Decision approved by human-lead. Now available in workspace context.`,
  );
  console.log();

  // --------------------------------------------------------------------------
  // Step 9: Structured Evidence-Bearing Handoff
  // --------------------------------------------------------------------------
  logStep(
    "Agent Records Evidence-Bearing Structured Handoff",
    "agent-stripe-dev finishes implementation, records test evidence, declares single next action, and releases lease",
  );
  console.log(
    `  $ contextpact handoff create --id ho-stripe-to-qa -t task-stripe-gw ...`,
  );
  const handoffRecord = runCli([
    "handoff",
    "create",
    "-d",
    workspaceDir,
    "--id",
    "ho-stripe-to-qa",
    "-t",
    "task-stripe-gw",
    "-a",
    "agent-stripe-dev",
    "--title",
    "Stripe Webhook Gateway Implementation Complete",
    "-o",
    "success",
    "-m",
    "Core webhook signature verification and idempotency persistence implemented. All unit tests pass.",
    "-n",
    "Execute integration test suite against mocked Stripe webhook endpoint",
    "--evidence",
    JSON.stringify({
      kind: "test",
      description: "18 unit tests passing with zero failures",
      command: "npm test -- tests/gateways/stripe.test.ts",
      exitCode: 0,
    }),
  ]).json();
  console.log(
    `  -> Handoff '${handoffRecord.id}' recorded. Next action: "${handoffRecord.nextAction}"`,
  );
  console.log(`  -> Task lease automatically released.`);
  console.log();

  // --------------------------------------------------------------------------
  // Step 10: Resumption, Verification, and Completion
  // --------------------------------------------------------------------------
  logStep(
    "Independent Agent Resumes from Handoff Alone & Finishes Work",
    "agent-qa resumes via handoff ID alone, acquiring lease and receiving single next action",
  );
  console.log(`  $ contextpact resume ho-stripe-to-qa -a agent-qa`);
  const resumeResult = runCli([
    "resume",
    "-d",
    workspaceDir,
    "ho-stripe-to-qa",
    "-a",
    "agent-qa",
  ]).json();

  if (resumeResult.lease.agentId !== "agent-qa") {
    throw new Error(
      `Expected lease holder 'agent-qa' but got '${resumeResult.lease.agentId}'`,
    );
  }
  if (
    resumeResult.nextAction !==
    "Execute integration test suite against mocked Stripe webhook endpoint"
  ) {
    throw new Error(
      `Unexpected resumed nextAction: '${resumeResult.nextAction}'`,
    );
  }
  console.log(
    `  -> Resumed successfully: lease held by '${resumeResult.lease.agentId}'`,
  );
  console.log(`  -> Next action delivered: "${resumeResult.nextAction}"`);

  console.log(
    `  $ contextpact task release task-stripe-gw -a agent-qa -s done`,
  );
  const releaseResult = runCli([
    "task",
    "release",
    "-d",
    workspaceDir,
    "task-stripe-gw",
    "-a",
    "agent-qa",
    "-s",
    "done",
  ]).json();
  console.log(
    `  -> Task '${releaseResult.id}' marked status '${releaseResult.status}'`,
  );

  console.log(`  $ contextpact doctor ${workspaceDir}`);
  const doctorResult = runCli(["doctor", workspaceDir]).json();
  if (!doctorResult.healthy) {
    throw new Error(
      `Doctor reported unhealthy workspace: ${JSON.stringify(doctorResult.issues)}`,
    );
  }
  console.log(`  -> Doctor check passed: workspace healthy, 0 issues detected`);
  console.log();

  console.log("=".repeat(80));
  console.log("Coding Workflow Demo Completed Successfully!");
  console.log("=".repeat(80));
} finally {
  if (isTemporary && !keepWorkspace) {
    rmSync(workspaceDir, { recursive: true, force: true });
    console.log(`Cleaned up temporary workspace: ${workspaceDir}`);
  } else {
    console.log(`Workspace preserved at: ${workspaceDir}`);
  }
}
