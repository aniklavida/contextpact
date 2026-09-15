import { z } from "zod";

export const contextTypeSchema = z.enum([
  "rule",
  "preference",
  "fact",
  "goal",
  "source",
  "decision",
  "task_note",
  "handoff",
]);

export type ContextType = z.infer<typeof contextTypeSchema>;

export const contextScopeSchema = z.enum([
  "global",
  "workspace",
  "task",
  "session",
]);
export type ContextScope = z.infer<typeof contextScopeSchema>;

export const contextStatusSchema = z.enum([
  "draft",
  "proposed",
  "approved",
  "superseded",
  "archived",
]);
export type ContextStatus = z.infer<typeof contextStatusSchema>;

export const importanceSchema = z.enum(["low", "normal", "high", "critical"]);
export type Importance = z.infer<typeof importanceSchema>;

const isoDatetimeSchema = z.union([
  z.iso.datetime({ offset: true }),
  z.date().transform((date) => date.toISOString()),
]);

const baseContextItemSchema = z
  .object({
    id: z.string().min(1),
    type: contextTypeSchema,
    scope: contextScopeSchema,
    workspaceId: z.string().min(1),
    title: z.string().min(1),
    content: z.string().default(""),
    source: z.string().min(1),
    actor: z.string().min(1),
    status: contextStatusSchema,
    importance: importanceSchema.default("normal"),
    visibility: z.array(z.string().min(1)).default([]),
    tags: z.array(z.string().min(1)).default([]),
    version: z.number().int().positive().default(1),
    createdAt: isoDatetimeSchema,
    updatedAt: isoDatetimeSchema,
    expiresAt: isoDatetimeSchema.nullable().default(null),
    supersedes: z.array(z.string().min(1)).default([]),
  })
  .passthrough();

export const contextItemSchema = z.preprocess((raw) => {
  if (raw && typeof raw === "object") {
    const val = { ...(raw as Record<string, unknown>) };
    if (
      !val.workspaceId &&
      val.workspace &&
      typeof val.workspace === "string"
    ) {
      val.workspaceId = val.workspace;
      delete val.workspace;
    }
    if (!val.createdAt && val.created) {
      val.createdAt = val.created;
      delete val.created;
    }
    if (!val.updatedAt && val.updated) {
      val.updatedAt = val.updated;
      delete val.updated;
    }
    if (!val.expiresAt && val.expires) {
      val.expiresAt = val.expires;
      delete val.expires;
    }
    if (typeof val.tags === "string") {
      val.tags = [val.tags];
    } else if (val.tags === null) {
      delete val.tags;
    }
    if (typeof val.visibility === "string") {
      val.visibility = [val.visibility];
    } else if (val.visibility === null) {
      delete val.visibility;
    }
    if (typeof val.supersedes === "string") {
      val.supersedes = [val.supersedes];
    } else if (val.supersedes === null) {
      delete val.supersedes;
    }
    return val;
  }
  return raw;
}, baseContextItemSchema);

export type ContextItem = z.infer<typeof baseContextItemSchema>;
