import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  contextItemSchema,
  type ContextItem,
  type ContextType,
} from "../src/domain/context.js";
import { writeAtomicFile } from "../src/storage/atomic.js";
import {
  CONTEXT_TYPE_FOLDERS,
  formatMarkdownKnowledgeItem,
  getKnowledgeFolderPath,
  getKnowledgeItemPath,
  parseMarkdownKnowledgeItem,
  readMarkdownKnowledgeItem,
  saveKnowledgeItem,
  writeMarkdownKnowledgeItem,
} from "../src/storage/markdown.js";
import { initializeWorkspace } from "../src/workspace/layout.js";

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "contextpact-markdown-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("Markdown knowledge items", () => {
  it("supports all eight context types declared in the domain", () => {
    const types: ContextType[] = [
      "rule",
      "preference",
      "fact",
      "goal",
      "source",
      "decision",
      "task_note",
      "handoff",
    ];

    const root = createTempDir();
    initializeWorkspace(root);

    for (const type of types) {
      expect(CONTEXT_TYPE_FOLDERS[type]).toBeDefined();

      const item: ContextItem = contextItemSchema.parse({
        id: `item-${type}-01`,
        type,
        scope: "workspace",
        workspaceId: "ws-test",
        title: `Test ${type}`,
        content: `Content for ${type}`,
        source: "agent",
        actor: "antigravity",
        status: "approved",
        version: 1,
        createdAt: "2026-09-15T00:00:00.000Z",
        updatedAt: "2026-09-15T00:00:00.000Z",
      });

      const savedPath = saveKnowledgeItem(root, item);
      expect(existsSync(savedPath)).toBe(true);
      expect(savedPath).toContain(
        type === "handoff"
          ? join(".contextpact", "handoffs")
          : join(".contextpact", "knowledge", CONTEXT_TYPE_FOLDERS[type]),
      );

      const loaded = readMarkdownKnowledgeItem(savedPath);
      expect(loaded.id).toBe(item.id);
      expect(loaded.type).toBe(type);
      expect(loaded.content).toBe(item.content);
    }
  });

  it("round trip: parse, mutate, write, re-parse yields an identical structure", () => {
    const root = createTempDir();
    const filePath = join(root, "roundtrip.md");

    const initialItem: ContextItem = contextItemSchema.parse({
      id: "dec-storage-01",
      type: "decision",
      scope: "workspace",
      workspaceId: "ws-roundtrip",
      title: "Initial Storage Decision",
      content:
        "We use Markdown files for durable knowledge and SQLite for state.",
      source: "human",
      actor: "anik",
      status: "proposed",
      importance: "high",
      visibility: ["team", "public"],
      tags: ["architecture", "storage"],
      version: 1,
      createdAt: "2026-09-15T00:00:00.000Z",
      updatedAt: "2026-09-15T00:00:00.000Z",
      expiresAt: null,
      supersedes: [],
      reviewer: "lead-architect",
      customFlag: true,
      score: 95,
    });

    writeMarkdownKnowledgeItem(filePath, initialItem);
    const parsed = readMarkdownKnowledgeItem(filePath);

    // Mutate multiple fields including custom frontmatter and content
    const mutated: ContextItem = {
      ...parsed,
      title: "Approved Storage Architecture",
      status: "approved",
      importance: "critical",
      version: 2,
      updatedAt: "2026-09-15T01:00:00.000Z",
      tags: ["architecture", "storage", "v1-approved"],
      content:
        "Updated: SQLite for operational coordination and Markdown for human reading.",
      reviewer: "lead-architect-confirmed",
      customFlag: false,
      score: 100,
    };

    writeMarkdownKnowledgeItem(filePath, mutated);
    const reParsed = readMarkdownKnowledgeItem(filePath);

    expect(reParsed).toEqual(mutated);
  });

  it("preserves unknown frontmatter keys written by a human across read-modify-write", () => {
    const root = createTempDir();
    const filePath = join(root, "human-annotated.md");

    const rawHumanMarkdown = `---
id: rule-lint-01
type: rule
scope: workspace
workspaceId: ws-test
title: Lint on commit
source: human
actor: anik
status: approved
importance: high
version: 1
createdAt: "2026-09-15T00:00:00.000Z"
updatedAt: "2026-09-15T00:00:00.000Z"
customNotes: "Added during team retro"
auditTrail:
  signedBy: "anik"
  verifiedAt: "2026-09-15T00:10:00Z"
legacyId: 4209
---

All commits must pass format:check and typecheck.
`;

    writeFileSync(filePath, rawHumanMarkdown, "utf8");

    const loaded = readMarkdownKnowledgeItem(filePath);
    expect(loaded.customNotes).toBe("Added during team retro");
    expect(loaded.auditTrail).toEqual({
      signedBy: "anik",
      verifiedAt: "2026-09-15T00:10:00Z",
    });
    expect(loaded.legacyId).toBe(4209);

    // Mutate and save
    const updated: ContextItem = {
      ...loaded,
      version: 2,
      updatedAt: "2026-09-15T01:00:00.000Z",
    };
    writeMarkdownKnowledgeItem(filePath, updated);

    const reloaded = readMarkdownKnowledgeItem(filePath);
    expect(reloaded.customNotes).toBe("Added during team retro");
    expect(reloaded.auditTrail).toEqual({
      signedBy: "anik",
      verifiedAt: "2026-09-15T00:10:00Z",
    });
    expect(reloaded.legacyId).toBe(4209);
    expect(reloaded.version).toBe(2);
  });

  it("an item written by the library and an equivalent item hand-typed by a person parse to the same structure", () => {
    const root = createTempDir();
    const libraryPath = join(root, "library.md");
    const humanPath = join(root, "human.md");

    // Item written through the library API
    const item: ContextItem = contextItemSchema.parse({
      id: "fact-engine-01",
      type: "fact",
      scope: "workspace",
      workspaceId: "ws-fact",
      title: "Supported Node version",
      content: "ContextPact requires Node.js >= 22.12.0.",
      source: "spec",
      actor: "anik",
      status: "approved",
      version: 1,
      createdAt: "2026-09-15T00:00:00.000Z",
      updatedAt: "2026-09-15T00:00:00.000Z",
    });
    writeMarkdownKnowledgeItem(libraryPath, item);

    // Hand-typed by a person: uses workspace alias, omits defaults, uses unquoted ISO dates
    const handTyped = `---
id: fact-engine-01
type: fact
scope: workspace
workspace: ws-fact
title: Supported Node version
source: spec
actor: anik
status: approved
createdAt: 2026-09-15T00:00:00.000Z
updatedAt: 2026-09-15T00:00:00.000Z
---

ContextPact requires Node.js >= 22.12.0.
`;
    writeFileSync(humanPath, handTyped, "utf8");

    const parsedFromLibrary = readMarkdownKnowledgeItem(libraryPath);
    const parsedFromHuman = readMarkdownKnowledgeItem(humanPath);

    expect(parsedFromLibrary).toEqual(parsedFromHuman);
  });

  it("keeps the filename stable when title changes: the ID is the identity", () => {
    const root = createTempDir();
    initializeWorkspace(root);

    const initialItem: ContextItem = contextItemSchema.parse({
      id: "decision-concurrency",
      type: "decision",
      scope: "workspace",
      workspaceId: "ws-test",
      title: "Initial Title: Optimistic Locking",
      content: "Use version increments.",
      source: "architect",
      actor: "anik",
      status: "proposed",
      version: 1,
      createdAt: "2026-09-15T00:00:00.000Z",
      updatedAt: "2026-09-15T00:00:00.000Z",
    });

    const initialPath = saveKnowledgeItem(root, initialItem);
    expect(initialPath.endsWith("decision-concurrency.md")).toBe(true);

    // Mutate title
    const renamedItem: ContextItem = {
      ...initialItem,
      title: "Revised Title: Strict Lease Based Locking",
      version: 2,
      updatedAt: "2026-09-15T01:00:00.000Z",
    };

    const updatedPath = saveKnowledgeItem(root, renamedItem);
    expect(updatedPath).toBe(initialPath);
    expect(updatedPath.endsWith("decision-concurrency.md")).toBe(true);

    const reloaded = readMarkdownKnowledgeItem(updatedPath);
    expect(reloaded.id).toBe("decision-concurrency");
    expect(reloaded.title).toBe("Revised Title: Strict Lease Based Locking");
  });

  it("an interrupted write leaves either the old file or the new file on disk, never a truncated one", () => {
    const root = createTempDir();
    const targetFile = join(root, "atomic-test.md");

    const originalContent = "OLD_DURABLE_CONTENT_THAT_MUST_SURVIVE";
    writeFileSync(targetFile, originalContent, "utf8");

    expect(() => {
      writeAtomicFile(targetFile, "NEW_PARTIAL_CONTENT", {
        beforeRename: () => {
          throw new Error(
            "Simulated interruption (e.g. power failure / process kill)",
          );
        },
      });
    }).toThrow("Simulated interruption");

    // The file on disk must still contain the full old content, never truncated
    const contentAfterInterruption = readFileSync(targetFile, "utf8");
    expect(contentAfterInterruption).toBe(originalContent);

    // No stray temporary files left behind in the directory
    expect(readdirSync(root)).toEqual(["atomic-test.md"]);

    // Now complete the write normally
    writeAtomicFile(targetFile, "NEW_FINAL_CONTENT");
    const contentAfterSuccess = readFileSync(targetFile, "utf8");
    expect(contentAfterSuccess).toBe("NEW_FINAL_CONTENT");
    expect(readdirSync(root)).toEqual(["atomic-test.md"]);
  });

  it("leaves no truncated file when an interrupted write targets a new file", () => {
    const root = createTempDir();
    const targetFile = join(root, "new-file.md");

    expect(() => {
      writeAtomicFile(targetFile, "SHOULD_NOT_EXIST_AS_PARTIAL", {
        beforeRename: () => {
          throw new Error("Simulated disk error during initial write");
        },
      });
    }).toThrow("Simulated disk error");

    expect(existsSync(targetFile)).toBe(false);
    expect(readdirSync(root)).toEqual([]);
  });

  it("throws clear errors on malformed markdown knowledge items", () => {
    expect(() => parseMarkdownKnowledgeItem("no frontmatter here")).toThrow(
      "Missing YAML frontmatter in Markdown knowledge item",
    );

    expect(() =>
      parseMarkdownKnowledgeItem("---\nid: test\ntitle: unclosed\n"),
    ).toThrow("Unclosed YAML frontmatter in Markdown knowledge item");

    expect(() =>
      parseMarkdownKnowledgeItem("---\n- item1\n- item2\n---\nbody"),
    ).toThrow("Frontmatter must be a YAML mapping");
  });
});
