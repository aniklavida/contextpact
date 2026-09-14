import { z } from "zod";

export const sessionStatusSchema = z.enum(["active", "ended", "failed"]);
export type SessionStatus = z.infer<typeof sessionStatusSchema>;

export const registerAgentSchema = z.preprocess(
  (raw) => {
    if (raw && typeof raw === "object") {
      const val = { ...(raw as Record<string, unknown>) };
      if (!val.displayName && typeof val.display_name === "string") {
        val.displayName = val.display_name;
      }
      if (!val.clientKind && typeof val.client_kind === "string") {
        val.clientKind = val.client_kind;
      }
      return val;
    }
    return raw;
  },
  z.object({
    id: z.string().min(1).optional(),
    displayName: z.string().min(1),
    clientKind: z.string().min(1),
    profile: z.string().min(1).default("default"),
  }),
);

export type RegisterAgentInput = z.infer<typeof registerAgentSchema>;

export interface AgentRecord {
  id: string;
  displayName: string;
  clientKind: string;
  profile: string;
  lastSeenAt: string | null;
  createdAt: string;
}

export const startSessionSchema = z.preprocess(
  (raw) => {
    if (raw && typeof raw === "object") {
      const val = { ...(raw as Record<string, unknown>) };
      if (!val.agentId && typeof val.agent_id === "string") {
        val.agentId = val.agent_id;
      }
      if (val.taskId === undefined && val.task_id !== undefined) {
        val.taskId = val.task_id;
      }
      return val;
    }
    return raw;
  },
  z.object({
    id: z.string().min(1).optional(),
    agentId: z.string().min(1),
    taskId: z.string().min(1).nullable().optional(),
  }),
);

export type StartSessionInput = z.infer<typeof startSessionSchema>;

export interface SessionRecord {
  id: string;
  agentId: string;
  taskId: string | null;
  status: SessionStatus;
  startedAt: string;
  endedAt: string | null;
}

export const taskStatusSchema = z.enum([
  "planned",
  "active",
  "review",
  "done",
  "blocked",
]);
export type TaskStatus = z.infer<typeof taskStatusSchema>;

export const createTaskSchema = z.object({
  id: z.string().min(1).optional(),
  title: z.string().min(1),
  description: z.string().default(""),
  status: taskStatusSchema.default("planned"),
  scope: z.array(z.string().min(1)).default([]),
});

export type CreateTaskInput = z.input<typeof createTaskSchema>;

export interface TaskRecord {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  scope: string[];
  version: number;
  createdAt: string;
  updatedAt: string;
}
