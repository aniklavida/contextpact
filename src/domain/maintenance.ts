import { z } from "zod";

import type { AgentRecord, SessionRecord, TaskRecord } from "./agent.js";
import { contextItemSchema, type ContextItem } from "./context.js";
import type { PolicyRecord } from "./policy.js";
import type { LeaseRecord } from "./task.js";

export type CollisionPolicy = "skip" | "replace" | "error";

export interface StoredAuditEvent {
  id: number;
  event_type: string;
  actor: string;
  entity_type: string;
  entity_id: string;
  previous_version: number | null;
  payload: Record<string, unknown>;
  created_at: string;
}

export interface WorkspaceExportData {
  formatVersion: 1;
  exportedAt: string;
  workspace: {
    id: string;
    name: string;
    createdAt: string;
  };
  contextItems: ContextItem[];
  operational: {
    tasks: TaskRecord[];
    taskLeases: LeaseRecord[];
    agents: AgentRecord[];
    sessions: SessionRecord[];
    policies: PolicyRecord[];
    auditEvents: StoredAuditEvent[];
  };
}

export const workspaceExportSchema = z.object({
  formatVersion: z.literal(1),
  exportedAt: z.string(),
  workspace: z.object({
    id: z.string(),
    name: z.string(),
    createdAt: z.string(),
  }),
  contextItems: z.array(contextItemSchema),
  operational: z.object({
    tasks: z.array(
      z.object({
        id: z.string(),
        title: z.string(),
        description: z.string(),
        status: z.enum(["planned", "active", "review", "done", "blocked"]),
        scope: z.array(z.string()),
        version: z.number(),
        createdAt: z.string(),
        updatedAt: z.string(),
      }),
    ),
    taskLeases: z.array(
      z.object({
        taskId: z.string(),
        agentId: z.string(),
        acquiredAt: z.string(),
        heartbeatAt: z.string(),
        expiresAt: z.string(),
        version: z.number(),
      }),
    ),
    agents: z.array(
      z.object({
        id: z.string(),
        displayName: z.string(),
        clientKind: z.string(),
        profile: z.string(),
        lastSeenAt: z.string().nullable(),
        createdAt: z.string(),
      }),
    ),
    sessions: z.array(
      z.object({
        id: z.string(),
        agentId: z.string(),
        taskId: z.string().nullable(),
        status: z.enum(["active", "ended", "failed"]),
        startedAt: z.string(),
        endedAt: z.string().nullable(),
      }),
    ),
    policies: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        description: z.string(),
        rules: z.record(z.string(), z.unknown()),
        policyJson: z.string().default("{}"),
        createdAt: z.string(),
        updatedAt: z.string(),
      }),
    ),
    auditEvents: z.array(
      z.object({
        id: z.number(),
        event_type: z.string(),
        actor: z.string(),
        entity_type: z.string(),
        entity_id: z.string(),
        previous_version: z.number().nullable(),
        payload: z.record(z.string(), z.unknown()),
        created_at: z.string(),
      }),
    ),
  }),
});

export interface ExportOptions {
  outputPath?: string | undefined;
  includeAuditHistory?: boolean | undefined;
}

export interface ExportResult {
  exportPath: string;
  exportedAt: string;
  contextItemCount: number;
  taskCount: number;
  auditEventCount: number;
  data: WorkspaceExportData;
}

export interface ImportCollision {
  entityType: "context_item" | "task" | "agent" | "policy";
  id: string;
  action: "skipped" | "replaced";
  message: string;
}

export class ImportCollisionError extends Error {
  readonly collisions: ImportCollision[];

  constructor(collisions: ImportCollision[]) {
    const list = collisions.map((c) => `${c.entityType}:${c.id}`).join(", ");
    super(`Import aborted due to ID collisions: ${list}`);
    this.name = "ImportCollisionError";
    this.collisions = collisions;
  }
}

export interface ImportOptions {
  onCollision?: CollisionPolicy | undefined;
}

export interface ImportResult {
  importedAt: string;
  collisionPolicy: CollisionPolicy;
  imported: {
    contextItems: number;
    tasks: number;
    taskLeases: number;
    agents: number;
    sessions: number;
    policies: number;
    auditEvents: number;
  };
  collisions: ImportCollision[];
}
