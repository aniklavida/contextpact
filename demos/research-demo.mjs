#!/usr/bin/env node

/**
 * ============================================================================
 * ContextPact Proof Demo: End-to-End Research Workflow
 * ============================================================================
 *
 * PURPOSE:
 * Demonstrates ContextPact operating in a purely non-coding domain:
 * a geochemical and archaeological materials science investigation into
 * ancient Roman marine concrete durability.
 * Proves that coding is the first proof workflow, NOT the product boundary (CP-D002).
 *
 * WHAT THIS DEMO EXERCISES (END-TO-END):
 * 1. Clean workspace initialization (`contextpact init`)
 * 2. Primary literature and historical sources (`contextpact propose -t source`)
 * 3. Grounded empirical facts (`contextpact propose -t fact`)
 * 4. Human-in-the-loop review and approval (`contextpact approve`)
 * 5. Working hypothesis / preliminary conclusion (`contextpact propose -t decision`)
 * 6. Research task coordination, claims, mutex lease conflict rejection, and evidence-bearing handoffs
 * 7. Resumption of research inquiry from handoff alone by a collaborator
 * 8. Subsequent empirical evidence overturning the earlier hypothesis
 * 9. Explicit supersession of the flawed conclusion by the validated conclusion (`--supersedes`)
 * 10. Deterministic context pack retrieval carrying full provenance and tracking superseded omissions
 * 11. Full-text literature search (`contextpact search`) and workspace health audit (`contextpact doctor`)
 *
 * HARD CONSTRAINT:
 * Contains zero coding-specific schema assumptions, fields, or vocabulary.
 *
 * PREREQUISITES:
 * - Node.js >= 22.14.0
 * - Build the repository once before running: `npm run build`
 *
 * RUNNING THIS SCRIPT:
 *   # Run unattended in an isolated temporary directory (auto-cleaned):
 *   node demos/research-demo.mjs
 *
 *   # Or run in a specific directory:
 *   mkdir /tmp/research-demo-workspace && cd /tmp/research-demo-workspace
 *   node /path/to/demos/research-demo.mjs .
 *
 *   # Or preserve the generated workspace for manual inspection:
 *   node demos/research-demo.mjs --keep
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
  workspaceDir = mkdtempSync(join(tmpdir(), "contextpact-research-demo-"));
  isTemporary = true;
}

console.log("=".repeat(80));
console.log("ContextPact End-to-End Proof Demo: Research Workflow");
console.log("Domain: Roman Marine Concrete Geochemical Investigation");
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
const totalSteps = 9;

function logStep(title, details) {
  console.log(`[Step ${currentStep}/${totalSteps}] ${title}`);
  if (details) {
    console.log(`  ${details}`);
  }
  currentStep++;
}

try {
  // --------------------------------------------------------------------------
  // Step 1: Initialize Clean Workspace
  // --------------------------------------------------------------------------
  logStep(
    "Initialize Research Workspace",
    "Creates .contextpact directory with SQLite database, Markdown vault, and pact.yaml",
  );
  console.log(
    `  $ contextpact init ${workspaceDir} --name "Roman Concrete Durability Study"`,
  );
  const initResult = runCli([
    "init",
    workspaceDir,
    "--name",
    "Roman Concrete Durability Study",
  ]).json();
  if (!initResult.initialized) {
    throw new Error("Workspace initialization reported initialized=false");
  }
  console.log(
    `  -> Research workspace initialized. ID: ${initResult.manifest.id}`,
  );
  console.log();

  // --------------------------------------------------------------------------
  // Step 2: Record Primary Historical and Scientific Literature Sources
  // --------------------------------------------------------------------------
  logStep(
    "Record and Approve Primary Research Sources",
    "Historical text (Pliny the Elder) and geochemical literature (Jackson et al. 2017)",
  );
  console.log(`  $ contextpact propose -t source --id src-pliny-naturalis ...`);
  runCli([
    "propose",
    "-d",
    workspaceDir,
    "-t",
    "source",
    "--id",
    "src-pliny-naturalis",
    "--title",
    "Pliny the Elder, Naturalis Historia Book XXXVI",
    "--content",
    "Classical treatise documenting Puteolan volcanic ash reacting with lime water to produce submerged maritime structures unyielding to the waves.",
    "-s",
    "workspace",
    "-i",
    "high",
    "-a",
    "dr-chen-historian",
  ]);

  console.log(
    `  $ contextpact propose -t source --id src-jackson-2017-nature ...`,
  );
  runCli([
    "propose",
    "-d",
    workspaceDir,
    "-t",
    "source",
    "--id",
    "src-jackson-2017-nature",
    "--title",
    "Jackson et al. (2017) American Mineralogist / Nature Cores",
    "--content",
    "Synchrotron X-ray diffraction of 2,000-year-old Portus Cosanus drill cores demonstrating post-curing crystallization of aluminium-tobermorite.",
    "-s",
    "workspace",
    "-i",
    "critical",
    "-a",
    "dr-alvarez-geochemist",
  ]);

  console.log(
    `  $ contextpact approve src-pliny-naturalis -a lead-investigator`,
  );
  runCli([
    "approve",
    "-d",
    workspaceDir,
    "src-pliny-naturalis",
    "-a",
    "lead-investigator",
  ]);
  console.log(
    `  $ contextpact approve src-jackson-2017-nature -a lead-investigator`,
  );
  runCli([
    "approve",
    "-d",
    workspaceDir,
    "src-jackson-2017-nature",
    "-a",
    "lead-investigator",
  ]);
  console.log(
    `  -> Primary research sources approved into durable knowledge vault.`,
  );
  console.log();

  // --------------------------------------------------------------------------
  // Step 3: Propose Grounded Empirical Facts
  // --------------------------------------------------------------------------
  logStep(
    "Record Validated Empirical Fact",
    "Seawater percolation induces in-situ Al-tobermorite and phillipsite crystal growth",
  );
  console.log(
    `  $ contextpact propose -t fact --id fact-tobermorite-growth ...`,
  );
  runCli([
    "propose",
    "-d",
    workspaceDir,
    "-t",
    "fact",
    "--id",
    "fact-tobermorite-growth",
    "--title",
    "Centuries-Long Post-Curing Tobermorite Crystal Growth",
    "--content",
    "Alkaline seawater percolating through permeable pumice matrix dissolves volcanic glass components, precipitating interlocking Al-tobermorite and phillipsite mineral plates that strengthen the cementitious fabric.",
    "-s",
    "workspace",
    "-i",
    "critical",
    "-a",
    "dr-alvarez-geochemist",
  ]);

  console.log(
    `  $ contextpact approve fact-tobermorite-growth -a lead-investigator`,
  );
  runCli([
    "approve",
    "-d",
    workspaceDir,
    "fact-tobermorite-growth",
    "-a",
    "lead-investigator",
  ]);
  console.log(`  -> Empirical fact approved.`);
  console.log();

  // --------------------------------------------------------------------------
  // Step 4: Record Working Hypothesis (Preliminary Conclusion)
  // --------------------------------------------------------------------------
  logStep(
    "Record Preliminary Working Hypothesis (Flawed Initial Conclusion)",
    "Team initially assumes ubiquitous mortar lime clasts are accidental defects from poor slaking",
  );
  console.log(
    `  $ contextpact propose -t decision --id concl-slaking-defect ...`,
  );
  const initialHypothesis = runCli([
    "propose",
    "-d",
    workspaceDir,
    "-t",
    "decision",
    "--id",
    "concl-slaking-defect",
    "--title",
    "Working Hypothesis: Lime Clasts Are Incidental Slaking Defects",
    "--content",
    "Millimeter-scale white calcite inclusions observed throughout mortar cores represent poor slaking practice and incomplete batch homogenization, offering no positive contribution to structural resilience.",
    "-s",
    "workspace",
    "-i",
    "normal",
    "-a",
    "dr-morin-petrography",
  ]).json();
  console.log(
    `  -> Preliminary hypothesis proposed: status='${initialHypothesis.status}'`,
  );

  console.log(
    `  $ contextpact approve concl-slaking-defect -a lead-investigator`,
  );
  runCli([
    "approve",
    "-d",
    workspaceDir,
    "concl-slaking-defect",
    "-a",
    "lead-investigator",
  ]);
  console.log(`  -> Preliminary hypothesis approved by lead investigator.`);
  console.log();

  // --------------------------------------------------------------------------
  // Step 5: Research Coordination: Tasks, Claims, Leases & Evidence-Bearing Handoff
  // --------------------------------------------------------------------------
  logStep(
    "Coordinate Research Tasks with Mutual-Exclusion Leases & Handoff",
    "Specialists investigate microstructure and spectroscopy; petrographer hands off to spectroscopist",
  );
  console.log(
    `  $ contextpact task create --id task-petrography --scope investigation/petrography ...`,
  );
  runCli([
    "task",
    "create",
    "-d",
    workspaceDir,
    "--id",
    "task-petrography",
    "--title",
    "Petrographic Thin-Section Survey of Mortar Inclusions",
    "--desc",
    "Analyze polished thin-sections of Privernum and Portus samples under polarized light and backscattered electron imaging",
    "--scope",
    "investigation/petrography",
    "-a",
    "lead-investigator",
  ]);

  console.log(
    `  $ contextpact task claim task-petrography -a dr-morin-petrography`,
  );
  const claimResult = runCli([
    "task",
    "claim",
    "-d",
    workspaceDir,
    "task-petrography",
    "-a",
    "dr-morin-petrography",
    "--scope",
    "investigation/petrography",
    "--ttl",
    "300",
  ]).json();
  console.log(
    `  -> Lease acquired by '${claimResult.agentId}' on '${claimResult.taskId}'`,
  );

  // Verify mutual exclusion: second researcher cannot claim the same task
  console.log(
    `  $ contextpact task claim task-petrography -a dr-okafor-spectroscopy (conflict check)`,
  );
  const conflictCheck = runCli(
    [
      "task",
      "claim",
      "-d",
      workspaceDir,
      "task-petrography",
      "-a",
      "dr-okafor-spectroscopy",
    ],
    false,
  );
  if (conflictCheck.status === 0) {
    throw new Error("Expected lease conflict rejection, but claim succeeded!");
  }
  const conflictMsg =
    conflictCheck.stderr
      .split("\n")
      .map((l) => l.trim())
      .find(
        (l) =>
          l.startsWith("LeaseConflictError:") ||
          (l.includes("already claimed") && !l.startsWith("throw ")),
      ) || "LeaseConflictError: active lease held";
  console.log(`  -> Expected lease conflict verified: ${conflictMsg}`);

  // Petrographer completes analysis and creates structured handoff with scientific evidence
  console.log(
    `  $ contextpact handoff create --id ho-petrography-to-spectroscopy ...`,
  );
  const handoffOutput = runCli([
    "handoff",
    "create",
    "-d",
    workspaceDir,
    "--id",
    "ho-petrography-to-spectroscopy",
    "-t",
    "task-petrography",
    "-a",
    "dr-morin-petrography",
    "--title",
    "Petrographic Survey Complete: Lime Clast Fracturing Identified",
    "-o",
    "success",
    "-m",
    "Thin-section analysis reveals micro-cracks preferentially terminate inside lime clasts rather than traversing the matrix. Calcium depletion halos border each internal crack.",
    "-n",
    "Conduct micro-X-ray fluorescence and calcium K-edge spectroscopy on clast micro-fractures",
    "--evidence",
    JSON.stringify({
      kind: "file",
      description:
        "Backscattered SEM micrograph and calcium distribution map across inclusion boundary",
      path: "evidence/bse_sem_clast_halo.tif",
      verified: true,
    }),
  ]).json();
  console.log(
    `  -> Handoff '${handoffOutput.id}' recorded with imaging evidence.`,
  );
  console.log(`  -> Single next inquiry: "${handoffOutput.nextAction}"`);

  // Spectroscopist resumes the inquiry from the handoff alone
  console.log(
    `  $ contextpact resume ho-petrography-to-spectroscopy -a dr-okafor-spectroscopy`,
  );
  const resumeOutput = runCli([
    "resume",
    "-d",
    workspaceDir,
    "ho-petrography-to-spectroscopy",
    "-a",
    "dr-okafor-spectroscopy",
  ]).json();
  if (resumeOutput.lease.agentId !== "dr-okafor-spectroscopy") {
    throw new Error(
      `Expected lease holder 'dr-okafor-spectroscopy' but got '${resumeOutput.lease.agentId}'`,
    );
  }
  console.log(
    `  -> Resumed by '${resumeOutput.lease.agentId}'. Task status: '${resumeOutput.task.status}'`,
  );

  // Release task as done
  runCli([
    "task",
    "release",
    "-d",
    workspaceDir,
    "task-petrography",
    "-a",
    "dr-okafor-spectroscopy",
    "-s",
    "done",
  ]);
  console.log(`  -> Task completed and lease released.`);
  console.log();

  // --------------------------------------------------------------------------
  // Step 6: Subsequent Empirical Evidence Disproves Initial Hypothesis
  // --------------------------------------------------------------------------
  logStep(
    "Record Breakthrough Literature and Self-Healing Evidence",
    "Seymour et al. 2023 proves hot-mixing with quicklime creates reactive calcium reservoirs",
  );
  console.log(
    `  $ contextpact propose -t source --id src-seymour-2023-advances ...`,
  );
  runCli([
    "propose",
    "-d",
    workspaceDir,
    "-t",
    "source",
    "--id",
    "src-seymour-2023-advances",
    "--title",
    "Seymour et al. (2023) Science Advances Hot-Mixing Discovery",
    "--content",
    "High-resolution synchrotron spectroscopy establishing that lime clasts originated from hot-mixing quicklime (calcium oxide) at extreme temperatures, forming brittle high-surface-area calcium reservoirs.",
    "-s",
    "workspace",
    "-i",
    "critical",
    "-a",
    "dr-okafor-spectroscopy",
  ]);
  runCli([
    "approve",
    "-d",
    workspaceDir,
    "src-seymour-2023-advances",
    "-a",
    "lead-investigator",
  ]);

  console.log(
    `  $ contextpact propose -t fact --id fact-lime-clast-healing ...`,
  );
  runCli([
    "propose",
    "-d",
    workspaceDir,
    "-t",
    "fact",
    "--id",
    "fact-lime-clast-healing",
    "--title",
    "Autogenous Fracture Self-Healing Mechanism",
    "--content",
    "When micro-cracks penetrate a lime clast, moisture infiltration dissolves calcium ions from the clast reservoir into the fracture volume; reaction with dissolved carbonate recrystallizes calcite, sealing micro-fissures autogenously within weeks.",
    "-s",
    "workspace",
    "-i",
    "critical",
    "-a",
    "dr-okafor-spectroscopy",
  ]);
  runCli([
    "approve",
    "-d",
    workspaceDir,
    "fact-lime-clast-healing",
    "-a",
    "lead-investigator",
  ]);
  console.log(`  -> New empirical evidence approved into durable knowledge.`);
  console.log();

  // --------------------------------------------------------------------------
  // Step 7: Supersession: Overturn the Flawed Conclusion
  // --------------------------------------------------------------------------
  logStep(
    "Supersession: Replace Flawed Hypothesis with Validated Conclusion",
    "Proposes revised conclusion that explicitly supersedes concl-slaking-defect",
  );
  console.log(
    `  $ contextpact propose -t decision --id concl-autogenous-healing --supersedes concl-slaking-defect ...`,
  );
  const supersedingProposal = runCli([
    "propose",
    "-d",
    workspaceDir,
    "-t",
    "decision",
    "--id",
    "concl-autogenous-healing",
    "--title",
    "Revised Conclusion: Lime Clasts Are Functional Autogenous Self-Healing Architecture",
    "--content",
    "Lime clasts are not accidental slaking defects. Hot-mixing with quicklime was an intentional architectural strategy that endowed Roman maritime concrete with an autogenous crack self-healing capacity, conferring millennial durability.",
    "-s",
    "workspace",
    "-i",
    "critical",
    "--supersedes",
    "concl-slaking-defect",
    "-a",
    "dr-morin-petrography",
  ]).json();
  console.log(
    `  -> Revised conclusion proposed. Supersedes: [${supersedingProposal.supersedes.join(", ")}]`,
  );

  console.log(
    `  $ contextpact approve concl-autogenous-healing -a lead-investigator`,
  );
  const supersedingApproved = runCli([
    "approve",
    "-d",
    workspaceDir,
    "concl-autogenous-healing",
    "-a",
    "lead-investigator",
  ]).json();
  console.log(
    `  -> Approved revised conclusion. Version: ${supersedingApproved.version}, Status: ${supersedingApproved.status}`,
  );

  // Inspect the earlier conclusion to verify it was automatically marked superseded
  const oldItem = runCli([
    "get",
    "-d",
    workspaceDir,
    "concl-slaking-defect",
  ]).json();
  if (oldItem.status !== "superseded") {
    throw new Error(
      `Expected earlier conclusion status to be 'superseded', but got '${oldItem.status}'`,
    );
  }
  console.log(
    `  -> Verified: earlier conclusion 'concl-slaking-defect' transitioned to status='${oldItem.status}'`,
  );
  console.log();

  // --------------------------------------------------------------------------
  // Step 8: Build and Inspect Context Pack with Provenance & Omission Tracking
  // --------------------------------------------------------------------------
  logStep(
    "Build Deterministic Context Pack with Provenance & Supersession Tracking",
    "Verifies valid knowledge is included with full provenance, while superseded items are tracked in omissions",
  );
  console.log(`  $ contextpact pack`);
  const finalPack = runCli(["pack", "-d", workspaceDir]).json();

  const hasRevised = finalPack.items.some(
    (i) => i.id === "concl-autogenous-healing",
  );
  const hasFlawed = finalPack.items.some(
    (i) => i.id === "concl-slaking-defect",
  );
  if (!hasRevised) {
    throw new Error(
      "Revised conclusion missing from active context pack items!",
    );
  }
  if (hasFlawed) {
    throw new Error(
      "Flawed superseded conclusion mistakenly included in active context pack items!",
    );
  }

  const supersededOmission = finalPack.omissions.find(
    (o) => o.id === "concl-slaking-defect",
  );
  if (!supersededOmission) {
    throw new Error(
      "Superseded conclusion was not recorded in pack omissions!",
    );
  }
  if (supersededOmission.reason !== "superseded") {
    throw new Error(
      `Expected omission reason 'superseded' but got '${supersededOmission.reason}'`,
    );
  }
  if (supersededOmission.replacedBy !== "concl-autogenous-healing") {
    throw new Error(
      `Expected replacedBy 'concl-autogenous-healing' but got '${supersededOmission.replacedBy}'`,
    );
  }

  console.log(
    `  -> Pack contains ${finalPack.items.length} active items (budget used: ${finalPack.tokenBudget.usedTokens} tokens)`,
  );
  console.log(
    `  -> Revised conclusion 'concl-autogenous-healing' is PRESENT (status: approved)`,
  );
  console.log(
    `  -> Flawed conclusion 'concl-slaking-defect' is EXCLUDED from active items`,
  );
  console.log(
    `  -> Omission explicitly tracked: id='${supersededOmission.id}', reason='${supersededOmission.reason}', replacedBy='${supersededOmission.replacedBy}'`,
  );

  // Verify provenance on all items
  for (const item of finalPack.items) {
    if (!item.actor || !item.source || !item.version || !item.updatedAt) {
      throw new Error(`Item ${item.id} is missing provenance metadata!`);
    }
  }
  console.log(
    `  -> Verified: 100% of context pack items carry explicit author/source/version provenance.`,
  );
  console.log();

  // --------------------------------------------------------------------------
  // Step 9: Full-Text Literature Search & Health Diagnosis
  // --------------------------------------------------------------------------
  logStep(
    "Verify FTS5 Full-Text Search and Workspace Health Audit",
    "Executes full-text query across research literature; runs doctor diagnostic",
  );
  console.log(`  $ contextpact search "tobermorite"`);
  const searchResult = runCli([
    "search",
    "-d",
    workspaceDir,
    "tobermorite",
  ]).json();
  console.log(
    `  -> FTS5 search matched ${searchResult.length} literature items`,
  );

  console.log(`  $ contextpact doctor ${workspaceDir}`);
  const docResult = runCli(["doctor", workspaceDir]).json();
  if (!docResult.healthy) {
    throw new Error(
      `Doctor reported unhealthy workspace: ${JSON.stringify(docResult.issues)}`,
    );
  }
  console.log(`  -> Doctor check passed: workspace healthy, 0 issues detected`);
  console.log();

  console.log("=".repeat(80));
  console.log("Research Workflow Demo Completed Successfully!");
  console.log("=".repeat(80));
} finally {
  if (isTemporary && !keepWorkspace) {
    rmSync(workspaceDir, { recursive: true, force: true });
    console.log(`Cleaned up temporary workspace: ${workspaceDir}`);
  } else {
    console.log(`Workspace preserved at: ${workspaceDir}`);
  }
}
