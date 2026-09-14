import { describe, expect, it } from "vitest";

import { createProgram } from "../src/cli.js";
import {
  createServer,
  DOCUMENTED_EXCEPTIONS,
  SURFACE_FEATURES,
  verifySurfaceParity,
  type ActorContext,
} from "../src/index.js";

describe("CLI and MCP surface parity and profile-based exposure", () => {
  it("enforces that MCP tool count sits inside the 10-15 band across profiles", () => {
    // Default profile MCP server
    const defaultServer = createServer();
    const defaultTools = Object.keys(
      (
        defaultServer as unknown as {
          _registeredTools: Record<string, unknown>;
        }
      )._registeredTools,
    );

    // Elevated profile MCP server
    const elevatedActor: ActorContext = {
      actor: "reviewer-1",
      source: "human",
      profile: "elevated",
    };
    const elevatedServer = createServer({ actor: elevatedActor });
    const elevatedTools = Object.keys(
      (
        elevatedServer as unknown as {
          _registeredTools: Record<string, unknown>;
        }
      )._registeredTools,
    );

    // Assert tool count sits within 10-15 band
    expect(defaultTools.length).toBeGreaterThanOrEqual(10);
    expect(defaultTools.length).toBeLessThanOrEqual(15);
    expect(defaultTools).toHaveLength(14);

    expect(elevatedTools.length).toBeGreaterThanOrEqual(10);
    expect(elevatedTools.length).toBeLessThanOrEqual(15);
    expect(elevatedTools).toHaveLength(15);
  });

  it("profile-based tool exposure: default profile never sees approval tools", () => {
    const defaultServer = createServer();
    const defaultTools = Object.keys(
      (
        defaultServer as unknown as {
          _registeredTools: Record<string, unknown>;
        }
      )._registeredTools,
    );

    expect(defaultTools).not.toContain("context_approve");

    const elevatedActor: ActorContext = {
      actor: "reviewer-1",
      source: "human",
      profile: "elevated",
    };
    const elevatedServer = createServer({ actor: elevatedActor });
    const elevatedTools = Object.keys(
      (
        elevatedServer as unknown as {
          _registeredTools: Record<string, unknown>;
        }
      )._registeredTools,
    );

    expect(elevatedTools).toContain("context_approve");
  });

  it("fails on any undocumented gap between CLI commands and MCP tools", () => {
    const program = createProgram();
    const cliCommands = program.commands.map((cmd) => cmd.name());

    const elevatedActor: ActorContext = {
      actor: "reviewer-1",
      source: "human",
      profile: "elevated",
    };
    const elevatedServer = createServer({ actor: elevatedActor });
    const mcpTools = Object.keys(
      (
        elevatedServer as unknown as {
          _registeredTools: Record<string, unknown>;
        }
      )._registeredTools,
    );

    const report = verifySurfaceParity(cliCommands, mcpTools, {
      elevated: true,
    });

    expect(report.undocumentedCliCommands).toEqual([]);
    expect(report.undocumentedMcpTools).toEqual([]);
    expect(report.missingCliImplementations).toEqual([]);
    expect(report.missingMcpImplementations).toEqual([]);
    expect(report.passed).toBe(true);
  });

  it("validates that all documented exceptions have non-empty rationale and are present", () => {
    const program = createProgram();
    const cliCommands = new Set(program.commands.map((cmd) => cmd.name()));

    expect(DOCUMENTED_EXCEPTIONS.length).toBeGreaterThan(0);

    for (const exception of DOCUMENTED_EXCEPTIONS) {
      expect(exception.name.trim().length).toBeGreaterThan(0);
      expect(exception.reason.trim().length).toBeGreaterThan(15);

      if (exception.interface === "cli") {
        expect(cliCommands.has(exception.name)).toBe(true);
      }
    }
  });

  it("verifies all 5 coordination categories are represented in the surface contract", () => {
    const categories = new Set(SURFACE_FEATURES.map((f) => f.category));
    expect(categories).toContain("bootstrap");
    expect(categories).toContain("context");
    expect(categories).toContain("decisions");
    expect(categories).toContain("tasks");
    expect(categories).toContain("handoffs");
  });
});
