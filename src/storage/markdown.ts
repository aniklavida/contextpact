import { readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

import YAML from "yaml";

import {
  contextItemSchema,
  type ContextItem,
  type ContextType,
} from "../domain/context.js";
import { writeAtomicFile, type AtomicWriteOptions } from "./atomic.js";

export const CONTEXT_TYPE_FOLDERS: Record<ContextType, string> = {
  rule: "rules",
  preference: "preferences",
  fact: "facts",
  goal: "goals",
  source: "sources",
  decision: "decisions",
  task_note: "task_notes",
  handoff: "handoffs",
};

const STANDARD_FRONTMATTER_KEYS: readonly string[] = [
  "id",
  "type",
  "scope",
  "workspaceId",
  "title",
  "source",
  "actor",
  "status",
  "importance",
  "visibility",
  "tags",
  "version",
  "createdAt",
  "updatedAt",
  "expiresAt",
  "supersedes",
];

export function getKnowledgeFolderPath(
  workspaceRoot: string,
  type: ContextType,
): string {
  const folder = CONTEXT_TYPE_FOLDERS[type];
  if (!folder) {
    throw new Error(`Unsupported context type: ${type}`);
  }
  const root = resolve(workspaceRoot);
  const knowledgeDir =
    basename(root) === ".contextpact"
      ? join(root, "knowledge")
      : join(root, ".contextpact", "knowledge");
  return join(knowledgeDir, folder);
}

export function getKnowledgeItemPath(
  workspaceRoot: string,
  itemOrType: Pick<ContextItem, "type" | "id"> | ContextType,
  maybeId?: string,
): string {
  let type: ContextType;
  let id: string;
  if (typeof itemOrType === "string") {
    type = itemOrType;
    if (!maybeId) {
      throw new Error("Item ID is required when passing ContextType as string");
    }
    id = maybeId;
  } else {
    type = itemOrType.type;
    id = itemOrType.id;
  }
  const folderPath = getKnowledgeFolderPath(workspaceRoot, type);
  return join(folderPath, `${id}.md`);
}

export function parseMarkdownKnowledgeItem(raw: string): ContextItem {
  const source = raw.replace(/^\uFEFF/, "");

  if (!source.startsWith("---")) {
    throw new Error("Missing YAML frontmatter in Markdown knowledge item");
  }

  const firstNewlineIndex = source.indexOf("\n");
  if (firstNewlineIndex === -1) {
    throw new Error("Invalid frontmatter delimiter");
  }

  const firstLine = source.slice(0, firstNewlineIndex).trim();
  if (firstLine !== "---") {
    throw new Error("Missing YAML frontmatter in Markdown knowledge item");
  }

  const remainder = source.slice(firstNewlineIndex + 1);
  const match = remainder.match(/^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/m);
  if (!match || match.index === undefined) {
    throw new Error("Unclosed YAML frontmatter in Markdown knowledge item");
  }

  const frontmatterString = remainder.slice(0, match.index);
  const rawBody = remainder.slice(match.index + match[0].length);

  const parsedYaml = YAML.parse(frontmatterString) ?? {};
  if (
    typeof parsedYaml !== "object" ||
    parsedYaml === null ||
    Array.isArray(parsedYaml)
  ) {
    throw new Error("Frontmatter must be a YAML mapping");
  }

  return contextItemSchema.parse({
    ...parsedYaml,
    content: rawBody.trim(),
  });
}

export function formatMarkdownKnowledgeItem(item: ContextItem): string {
  const { content, ...frontmatter } = item;

  const orderedFrontmatter: Record<string, unknown> = {};
  for (const key of STANDARD_FRONTMATTER_KEYS) {
    if (key in frontmatter) {
      orderedFrontmatter[key] = frontmatter[key];
    }
  }
  for (const [key, value] of Object.entries(frontmatter)) {
    if (!STANDARD_FRONTMATTER_KEYS.includes(key)) {
      orderedFrontmatter[key] = value;
    }
  }

  const yamlContent = YAML.stringify(orderedFrontmatter).trimEnd();
  const trimmedBody = (content ?? "").trim();
  if (trimmedBody.length === 0) {
    return `---\n${yamlContent}\n---\n`;
  }
  return `---\n${yamlContent}\n---\n\n${trimmedBody}\n`;
}

export function readMarkdownKnowledgeItem(filePath: string): ContextItem {
  const fileContent = readFileSync(filePath, "utf8");
  return parseMarkdownKnowledgeItem(fileContent);
}

export function writeMarkdownKnowledgeItem(
  filePath: string,
  item: ContextItem,
  options?: AtomicWriteOptions,
): void {
  const markdown = formatMarkdownKnowledgeItem(item);
  writeAtomicFile(filePath, markdown, { encoding: "utf8", ...options });
}

export function readKnowledgeItem(
  workspaceRoot: string,
  type: ContextType,
  id: string,
): ContextItem {
  const filePath = getKnowledgeItemPath(workspaceRoot, type, id);
  return readMarkdownKnowledgeItem(filePath);
}

export function saveKnowledgeItem(
  workspaceRoot: string,
  item: ContextItem,
  options?: AtomicWriteOptions,
): string {
  const filePath = getKnowledgeItemPath(workspaceRoot, item);
  writeMarkdownKnowledgeItem(filePath, item, options);
  return filePath;
}
