import { describe, expect, it } from "vitest";

import { contextItemSchema } from "../src/domain/context.js";

describe("context item contract", () => {
  it("keeps inferred durable knowledge proposed", () => {
    const now = new Date().toISOString();
    const item = contextItemSchema.parse({
      id: "ctx-1",
      type: "decision",
      scope: "workspace",
      workspaceId: "workspace-1",
      title: "Storage decision",
      content: "Use SQLite for operational state.",
      source: "agent",
      actor: "codex",
      status: "proposed",
      version: 1,
      createdAt: now,
      updatedAt: now,
    });

    expect(item.status).toBe("proposed");
    expect(item.importance).toBe("normal");
    expect(item.visibility).toEqual([]);
  });
});
