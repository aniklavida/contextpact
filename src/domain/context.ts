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

export const contextScopeSchema = z.enum([
  "global",
  "workspace",
  "task",
  "session",
]);
export const contextStatusSchema = z.enum([
  "draft",
  "proposed",
  "approved",
  "superseded",
  "archived",
]);
export const importanceSchema = z.enum(["low", "normal", "high", "critical"]);

export const contextItemSchema = z.object({
  id: z.string().min(1),
  type: contextTypeSchema,
  scope: contextScopeSchema,
  workspaceId: z.string().min(1),
  title: z.string().min(1),
  content: z.string(),
  source: z.string().min(1),
  actor: z.string().min(1),
  status: contextStatusSchema,
  importance: importanceSchema.default("normal"),
  visibility: z.array(z.string().min(1)).default([]),
  tags: z.array(z.string().min(1)).default([]),
  version: z.number().int().positive(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime().nullable().default(null),
  supersedes: z.array(z.string().min(1)).default([]),
});

export type ContextItem = z.infer<typeof contextItemSchema>;
