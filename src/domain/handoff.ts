import { z } from "zod";

import { type TaskRecord } from "./agent.js";
import { type LeaseRecord } from "./task.js";

// ---------------------------------------------------------------------------
// Outcome
// ---------------------------------------------------------------------------

export const handoffOutcomeSchema = z.enum([
  "success",
  "blocked",
  "in_progress",
]);
export type HandoffOutcome = z.infer<typeof handoffOutcomeSchema>;

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

export const evidenceKindSchema = z.enum([
  "test",
  "command",
  "file",
  "diff",
  "log",
  "metric",
  "manual",
]);
export type EvidenceKind = z.infer<typeof evidenceKindSchema>;

export const evidenceItemSchema = z.preprocess(
  (raw) => {
    if (typeof raw === "string") {
      return { description: raw, kind: "manual", verified: true };
    }
    return raw;
  },
  z.object({
    kind: z.string().default("test"),
    description: z.string().min(1, "Evidence description is required"),
    command: z.string().optional(),
    output: z.string().optional(),
    exitCode: z.number().int().optional(),
    path: z.string().optional(),
    hash: z.string().optional(),
    timestamp: z.string().optional(),
    verified: z.boolean().default(true),
    metadata: z.record(z.string(), z.unknown()).optional(),
  }),
);

export type EvidenceItem = z.infer<typeof evidenceItemSchema>;

// ---------------------------------------------------------------------------
// Next Action (strictly one action, not a list)
// ---------------------------------------------------------------------------

export const nextActionSchema = z
  .string()
  .min(1, "Exactly one next action is required.");
export type NextAction = z.infer<typeof nextActionSchema>;

// ---------------------------------------------------------------------------
// Handoff Schemas
// ---------------------------------------------------------------------------

export const createHandoffSchema = z.preprocess(
  (raw) => {
    if (raw && typeof raw === "object") {
      const val = { ...(raw as Record<string, unknown>) };
      if (Array.isArray(val.nextAction) || Array.isArray(val.nextActions)) {
        throw new Error("Exactly one next action is required, not a list.");
      }
      if (val.next_action !== undefined && val.nextAction === undefined) {
        if (Array.isArray(val.next_action)) {
          throw new Error("Exactly one next action is required, not a list.");
        }
        val.nextAction = val.next_action;
        delete val.next_action;
      }
      if (val.task_id && !val.taskId) {
        val.taskId = val.task_id;
      }
      if (val.agent_id && !val.agentId) {
        val.agentId = val.agent_id;
      }
      if (typeof val.blockers === "string") {
        val.blockers = val.blockers.trim() ? [val.blockers.trim()] : [];
      }
      return val;
    }
    return raw;
  },
  z.object({
    id: z.string().min(1).optional(),
    taskId: z.string().min(1, "Task ID is required"),
    agentId: z.string().min(1, "Agent ID is required"),
    title: z.string().min(1).optional(),
    outcome: handoffOutcomeSchema,
    summary: z.string().min(1, "Narrative outcome summary is required"),
    blockers: z.array(z.string()).default([]),
    nextAction: nextActionSchema,
    evidence: z.array(evidenceItemSchema).default([]),
    releaseLease: z.boolean().default(true),
    scope: z.array(z.string().min(1)).default([]),
    tags: z.array(z.string().min(1)).default([]),
  }),
);

export type CreateHandoffInput = z.input<typeof createHandoffSchema>;

export const resumeHandoffSchema = z.preprocess(
  (raw) => {
    if (raw && typeof raw === "object") {
      const val = { ...(raw as Record<string, unknown>) };
      if (val.handoff_id && !val.handoffId) {
        val.handoffId = val.handoff_id;
      }
      if (val.agent_id && !val.agentId) {
        val.agentId = val.agent_id;
      }
      return val;
    }
    return raw;
  },
  z.object({
    handoffId: z.string().min(1, "Handoff ID is required"),
    agentId: z.string().min(1, "Agent ID is required"),
    ttlSeconds: z.number().int().positive().default(300),
    scope: z.array(z.string().min(1)).default([]),
  }),
);

export type ResumeHandoffInput = z.input<typeof resumeHandoffSchema>;

// ---------------------------------------------------------------------------
// Storage split models: Markdown Narrative vs SQLite Record
// ---------------------------------------------------------------------------

/** Operational state stored in SQLite. */
export interface HandoffRecord {
  id: string;
  taskId: string;
  agentId: string;
  leaseVersion: number | null;
  outcome: HandoffOutcome;
  evidence: EvidenceItem[];
  createdAt: string;
  updatedAt: string;
}

/** Human-readable narrative stored in Markdown. */
export interface HandoffNarrative {
  id: string;
  title: string;
  summary: string;
  blockers: string[];
  nextAction: string;
  tags: string[];
  documentPath?: string | undefined;
  documentHash?: string | undefined;
}

/** Complete resolved handoff combining operational record and narrative. */
export interface Handoff {
  id: string;
  taskId: string;
  agentId: string;
  leaseVersion: number | null;
  outcome: HandoffOutcome;
  summary: string;
  blockers: string[];
  nextAction: string;
  evidence: EvidenceItem[];
  title: string;
  tags: string[];
  documentPath?: string | undefined;
  createdAt: string;
  updatedAt: string;
}

export interface ResumeHandoffResult {
  handoff: Handoff;
  task: TaskRecord;
  lease: LeaseRecord;
  nextAction: string;
}

// ---------------------------------------------------------------------------
// Error classes
// ---------------------------------------------------------------------------

export class MissingEvidenceError extends Error {
  readonly outcome: string;
  readonly missing: string;

  constructor(message?: string) {
    super(
      message ??
        "Handoff asserting success refused: evidence is required. Completion without verification is not accepted as proven.",
    );
    this.name = "MissingEvidenceError";
    this.outcome = "success";
    this.missing = "evidence";
  }
}

export class HandoffNotFoundError extends Error {
  readonly handoffId: string;

  constructor(handoffId: string) {
    super(`Handoff '${handoffId}' not found.`);
    this.name = "HandoffNotFoundError";
    this.handoffId = handoffId;
  }
}
