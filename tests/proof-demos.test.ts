import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("End-to-end proof workflows from clean workspaces", () => {
  const rootDir = join(import.meta.dirname, "..");
  const codingDemoPath = join(rootDir, "demos", "coding-demo.mjs");
  const researchDemoPath = join(rootDir, "demos", "research-demo.mjs");

  it("coding demo executes unattended from a clean workspace and completes all coordination milestones", () => {
    const result = spawnSync(process.execPath, [codingDemoPath], {
      cwd: rootDir,
      encoding: "utf8",
      timeout: 30_000,
      env: { ...process.env, NODE_ENV: "test" },
    });

    if (result.status !== 0) {
      console.error("Coding demo stdout:", result.stdout);
      console.error("Coding demo stderr:", result.stderr);
    }

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "ContextPact End-to-End Proof Demo: Coding Workflow",
    );
    expect(result.stdout).toContain("Payment Service Engine");
    expect(result.stdout).toContain("Stdio MCP server active");
    expect(result.stdout).toContain("rule-idempotency-keys");
    expect(result.stdout).toContain("task-stripe-gw");
    expect(result.stdout).toContain("task-receipt-svc");
    expect(result.stdout).toContain("Expected conflict rejection verified");
    expect(result.stdout).toContain(
      "Both agents successfully retrieved 'rule-idempotency-keys'",
    );
    expect(result.stdout).toContain("dec-stripe-webhook-tolerance");
    expect(result.stdout).toContain("Decision approved by human-lead");
    expect(result.stdout).toContain("ho-stripe-to-qa");
    expect(result.stdout).toContain(
      "Resumed successfully: lease held by 'agent-qa'",
    );
    expect(result.stdout).toContain(
      "Doctor check passed: workspace healthy, 0 issues detected",
    );
    expect(result.stdout).toContain(
      "Coding Workflow Demo Completed Successfully!",
    );
  }, 35_000);

  it("research demo executes unattended from a clean workspace and completes all coordination and supersession milestones", () => {
    const result = spawnSync(process.execPath, [researchDemoPath], {
      cwd: rootDir,
      encoding: "utf8",
      timeout: 30_000,
      env: { ...process.env, NODE_ENV: "test" },
    });

    if (result.status !== 0) {
      console.error("Research demo stdout:", result.stdout);
      console.error("Research demo stderr:", result.stderr);
    }

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "ContextPact End-to-End Proof Demo: Research Workflow",
    );
    expect(result.stdout).toContain("Roman Concrete Durability Study");
    expect(result.stdout).toContain("src-pliny-naturalis");
    expect(result.stdout).toContain("src-jackson-2017-nature");
    expect(result.stdout).toContain("fact-tobermorite-growth");
    expect(result.stdout).toContain("concl-slaking-defect");
    expect(result.stdout).toContain("Expected lease conflict verified");
    expect(result.stdout).toContain("ho-petrography-to-spectroscopy");
    expect(result.stdout).toContain("Resumed by 'dr-okafor-spectroscopy'");
    expect(result.stdout).toContain("src-seymour-2023-advances");
    expect(result.stdout).toContain("fact-lime-clast-healing");
    expect(result.stdout).toContain("concl-autogenous-healing");
    expect(result.stdout).toContain("status='superseded'");
    expect(result.stdout).toContain(
      "Revised conclusion 'concl-autogenous-healing' is PRESENT",
    );
    expect(result.stdout).toContain(
      "Flawed conclusion 'concl-slaking-defect' is EXCLUDED",
    );
    expect(result.stdout).toContain("reason='superseded'");
    expect(result.stdout).toContain("replacedBy='concl-autogenous-healing'");
    expect(result.stdout).toContain(
      "100% of context pack items carry explicit author/source/version provenance",
    );
    expect(result.stdout).toContain(
      "Doctor check passed: workspace healthy, 0 issues detected",
    );
    expect(result.stdout).toContain(
      "Research Workflow Demo Completed Successfully!",
    );
  }, 35_000);

  it("research workflow contains zero coding-specific concepts in its domain data and schemas", () => {
    const researchDemoSource = readFileSync(researchDemoPath, "utf8");

    // Extract all string content passed to CLI commands in the research demo
    // (arguments to --title, --content, --desc, --scope, -m, -n, etc.)
    const codingSpecificTerms = [
      /\bcompiler\b/i,
      /\bsyntax\b/i,
      /\bfunction\b/i,
      /\bgit\b/i,
      /\bcommit\b/i,
      /\bpull request\b/i,
      /\bbug\b/i,
      /\brefactor\b/i,
      /\bendpoint\b/i,
      /\bmiddleware\b/i,
      /\bnpm\b/i,
      /\bunit test\b/i,
      /\bbackend\b/i,
      /\bfrontend\b/i,
      /\bclass\b/i,
      /\bvariable\b/i,
    ];

    // Find all CLI arguments inside runCli([...]) invocations
    const runCliMatches = Array.from(
      researchDemoSource.matchAll(/runCli\(\s*\[([\s\S]*?)\]/g),
    );
    expect(runCliMatches.length).toBeGreaterThan(5);

    for (const match of runCliMatches) {
      const cliArgsBlock = match[1] ?? "";
      for (const term of codingSpecificTerms) {
        const found = term.test(cliArgsBlock);
        if (found) {
          throw new Error(
            `Research demo CLI arguments contain coding-specific term matching ${term}: "${cliArgsBlock}"`,
          );
        }
        expect(found).toBe(false);
      }
    }
  });
});
