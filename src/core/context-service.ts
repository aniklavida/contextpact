import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

import type Database from "better-sqlite3";

import {
  createTaskSchema,
  registerAgentSchema,
  startSessionSchema,
  type AgentRecord,
  type CreateTaskInput,
  type RegisterAgentInput,
  type SessionRecord,
  type SessionStatus,
  type StartSessionInput,
  type TaskRecord,
  type TaskStatus,
} from "../domain/agent.js";
import {
  contextItemSchema,
  type ContextItem,
  type ContextScope,
  type ContextStatus,
  type ContextType,
  type Importance,
} from "../domain/context.js";
import {
  assertCanApprove,
  assertCanArchive,
  assertCanCreate,
  isActorElevated,
  isDurableContextType,
  isOperationalContextType,
  validateTransition,
  type ActorContext,
} from "../domain/lifecycle.js";
import {
  createPolicySchema,
  isScopeVisibleByPolicy,
  type CreatePolicyInput,
  type PolicyRecord,
  type PolicyRules,
} from "../domain/policy.js";
import {
  claimLeaseSchema,
  renewLeaseSchema,
  releaseLeaseSchema,
  takeoverLeaseSchema,
  LeaseConflictError,
  LeaseNotStaleError,
  LeaseOwnershipError,
  NoActiveLeaseError,
  TakeoverReasonRequiredError,
  type ClaimLeaseInput,
  type LeaseRecord,
  type ReleaseLeaseInput,
  type RenewLeaseInput,
  type ScopeConflict,
  type TakeoverLeaseInput,
} from "../domain/task.js";
import {
  createHandoffSchema,
  resumeHandoffSchema,
  MissingEvidenceError,
  HandoffNotFoundError,
  type CreateHandoffInput,
  type EvidenceItem,
  type Handoff,
  type HandoffOutcome,
  type HandoffRecord,
  type ResumeHandoffInput,
  type ResumeHandoffResult,
} from "../domain/handoff.js";
import { openDatabase } from "../storage/database.js";
import {
  formatHandoffNarrativeBody,
  parseHandoffNarrativeSections,
  readMarkdownKnowledgeItem,
  saveKnowledgeItem,
} from "../storage/markdown.js";
import {
  computeDocumentHash,
  reconcileWorkspace,
  recoverDatabase,
  reindexWorkspace,
  type ReconcileOptions,
  type ReconciliationResult,
  type RecoveryResult,
  type ReindexOptions,
  type ReindexResult,
} from "../storage/reconciliation.js";
import { readWorkspaceStatus, workspacePaths } from "../workspace/layout.js";
import {
  buildContextPack,
  renderContextPackMarkdown,
  sanitizeFtsQuery,
  type CandidateWithScore,
  type ContextPack,
  type ContextPackBudget,
  type ContextPackConflict,
  type ContextPackItem,
  type ContextPackOmission,
  type PackBuilderOptions,
} from "./pack-builder.js";
import {
  type BackupOptions,
  type BackupResult,
  type ExportOptions,
  type ExportResult,
  type ImportOptions,
  type ImportResult,
  type RestoreOptions,
  type RestoreResult,
  type WorkspaceExportData,
} from "../domain/maintenance.js";
import {
  backupWorkspace as coreBackupWorkspace,
  exportWorkspace as coreExportWorkspace,
  importWorkspace as coreImportWorkspace,
  restoreWorkspace as coreRestoreWorkspace,
} from "./maintenance.js";

export interface BaseContextInput {
  id?: string | undefined;
  type: ContextType;
  scope?: ContextScope | undefined;
  workspaceId?: string | undefined;
  title: string;
  content?: string | undefined;
  source?: string | undefined;
  actor?: string | undefined;
  importance?: Importance | undefined;
  visibility?: string[] | undefined;
  tags?: string[] | undefined;
  version?: number | undefined;
  createdAt?: string | undefined;
  updatedAt?: string | undefined;
  expiresAt?: string | null | undefined;
  supersedes?: string[] | undefined;
  [key: string]: unknown;
}

export interface CreateContextInput extends BaseContextInput {
  status?: ContextStatus | undefined;
}

export interface ProposeContextInput extends BaseContextInput {}

export interface QueryContextFilter {
  workspaceId?: string | undefined;
  status?: ContextStatus | undefined;
  type?: ContextType | undefined;
  scope?: ContextScope | undefined;
  includeSuperseded?: boolean | undefined;
  includeArchived?: boolean | undefined;
  includeProposed?: boolean | undefined;
  includeDraft?: boolean | undefined;
}

export interface SearchOptions {
  workspaceId?: string | undefined;
  scope?: ContextScope | undefined;
  allowGlobal?: boolean | undefined;
  policyId?: string | undefined;
  allowedScopes?: ContextScope[] | undefined;
  types?: ContextType[] | undefined;
  type?: ContextType | undefined;
  status?: ContextStatus | undefined;
  includeSuperseded?: boolean | undefined;
  includeArchived?: boolean | undefined;
  includeProposed?: boolean | undefined;
  includeDraft?: boolean | undefined;
  limit?: number | undefined;
}

export interface SearchResult {
  item: ContextItem;
  relevanceScore: number;
  matchRank: number;
}

export interface BuildPackOptions {
  workspaceId?: string | undefined;
  client?: ActorContext | string | undefined;
  clientId?: string | undefined;
  policyId?: string | undefined;
  allowGlobal?: boolean | undefined;
  taskId?: string | undefined;
  sessionId?: string | undefined;
  query?: string | undefined;
  scope?: ContextScope | undefined;
  type?: ContextType | undefined;
  types?: ContextType[] | undefined;
  tags?: string[] | undefined;
  maxTokens?: number | undefined;
  includeSuperseded?: boolean | undefined;
  includeArchived?: boolean | undefined;
  includeProposed?: boolean | undefined;
  includeDraft?: boolean | undefined;
  timestamp?: string | undefined;
}

export interface AuditEventRecord {
  id: number;
  event_type: string;
  actor: string;
  entity_type: string;
  entity_id: string;
  previous_version: number | null;
  payload: Record<string, unknown>;
  created_at: string;
}

export class ContextService {
  private readonly workspaceRoot: string;
  private readonly db: Database.Database;
  private readonly ownsDatabase: boolean;
  private readonly workspaceId: string;

  constructor(workspaceRoot: string, database?: Database.Database) {
    this.workspaceRoot = workspaceRoot;
    const paths = workspacePaths(workspaceRoot);
    if (database) {
      this.db = database;
      this.ownsDatabase = false;
    } else {
      this.db = openDatabase(paths.database);
      this.ownsDatabase = true;
    }

    const wsStatus = readWorkspaceStatus(workspaceRoot);
    if (wsStatus.manifest?.id) {
      this.workspaceId = wsStatus.manifest.id;
    } else {
      const row = this.db.prepare("SELECT id FROM workspace LIMIT 1").get() as
        { id: string } | undefined;
      this.workspaceId = row?.id ?? "workspace-default";
    }
  }

  close(): void {
    if (this.ownsDatabase) {
      this.db.close();
    }
  }

  getDatabase(): Database.Database {
    return this.db;
  }

  resolveActor(actor: ActorContext | string): ActorContext {
    if (typeof actor === "string") {
      const agent = this.getAgent(actor);
      if (agent) {
        this.touchAgent(agent.id);
        return {
          actor: agent.id,
          source: agent.clientKind === "human" ? "human" : "agent",
          profile: agent.profile,
        };
      }
      return {
        actor,
        source: "agent",
        profile: "default",
      };
    }

    const agent = this.getAgent(actor.actor);
    if (agent) {
      this.touchAgent(agent.id);
      return {
        actor: agent.id,
        source:
          actor.source ?? (agent.clientKind === "human" ? "human" : "agent"),
        profile: agent.profile,
      };
    }

    return {
      actor: actor.actor,
      source: actor.source,
      profile:
        actor.profile ?? (actor.source === "human" ? "human" : "default"),
    };
  }

  touchAgent(id: string, timestamp?: string): void {
    const now = timestamp ?? new Date().toISOString();
    this.db
      .prepare("UPDATE agents SET last_seen_at = ? WHERE id = ?")
      .run(now, id);
  }

  heartbeatAgent(id: string, timestamp?: string): AgentRecord {
    const now = timestamp ?? new Date().toISOString();
    const info = this.db
      .prepare("UPDATE agents SET last_seen_at = ? WHERE id = ?")
      .run(now, id);
    if (info.changes === 0) {
      throw new Error(`Agent '${id}' not found.`);
    }
    const agent = this.getAgent(id);
    return agent!;
  }

  registerAgent(input: RegisterAgentInput, actor?: ActorContext): AgentRecord {
    const validated = registerAgentSchema.parse(input);
    const id = validated.id?.trim() || `agent-${randomUUID()}`;
    const now = new Date().toISOString();

    const upsertSql = `
      INSERT INTO agents (id, display_name, client_kind, profile, last_seen_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        display_name = excluded.display_name,
        client_kind = excluded.client_kind,
        profile = excluded.profile,
        last_seen_at = excluded.last_seen_at;
    `;

    this.db
      .prepare(upsertSql)
      .run(
        id,
        validated.displayName,
        validated.clientKind,
        validated.profile,
        now,
        now,
      );

    const agent: AgentRecord = {
      id,
      displayName: validated.displayName,
      clientKind: validated.clientKind,
      profile: validated.profile,
      lastSeenAt: now,
      createdAt: now,
    };

    this.writeAuditEvent({
      event_type: "agent.registered",
      actor: actor?.actor ?? id,
      entity_type: "agent",
      entity_id: id,
      previous_version: null,
      payload: {
        display_name: agent.displayName,
        client_kind: agent.clientKind,
        profile: agent.profile,
      },
      created_at: now,
    });

    return agent;
  }

  ensureAgent(
    id: string,
    options?: { displayName?: string; clientKind?: string; profile?: string },
  ): AgentRecord {
    const existing = this.getAgent(id);
    if (existing) {
      return existing;
    }
    return this.registerAgent({
      id,
      displayName: options?.displayName ?? id,
      clientKind: options?.clientKind ?? "agent",
      profile: options?.profile ?? "default",
    });
  }

  getAgent(id: string): AgentRecord | null {
    const row = this.db
      .prepare(
        "SELECT id, display_name, client_kind, profile, last_seen_at, created_at FROM agents WHERE id = ?",
      )
      .get(id) as
      | {
          id: string;
          display_name: string;
          client_kind: string;
          profile: string;
          last_seen_at: string | null;
          created_at: string;
        }
      | undefined;

    if (!row) {
      return null;
    }

    return {
      id: row.id,
      displayName: row.display_name,
      clientKind: row.client_kind,
      profile: row.profile,
      lastSeenAt: row.last_seen_at,
      createdAt: row.created_at,
    };
  }

  listAgents(): AgentRecord[] {
    const rows = this.db
      .prepare(
        "SELECT id, display_name, client_kind, profile, last_seen_at, created_at FROM agents ORDER BY created_at ASC",
      )
      .all() as Array<{
      id: string;
      display_name: string;
      client_kind: string;
      profile: string;
      last_seen_at: string | null;
      created_at: string;
    }>;

    return rows.map((r) => ({
      id: r.id,
      displayName: r.display_name,
      clientKind: r.client_kind,
      profile: r.profile,
      lastSeenAt: r.last_seen_at,
      createdAt: r.created_at,
    }));
  }

  startSession(input: StartSessionInput, actor?: ActorContext): SessionRecord {
    const validated = startSessionSchema.parse(input);
    const agent = this.getAgent(validated.agentId);
    if (!agent) {
      throw new Error(
        `Cannot start session: Agent '${validated.agentId}' is not registered.`,
      );
    }

    if (validated.taskId) {
      const task = this.getTask(validated.taskId);
      if (!task) {
        throw new Error(
          `Cannot start session: Task '${validated.taskId}' not found.`,
        );
      }
    }

    const id = validated.id?.trim() || `session-${randomUUID()}`;
    const now = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO sessions (id, agent_id, task_id, status, started_at, ended_at)
         VALUES (?, ?, ?, 'active', ?, NULL)`,
      )
      .run(id, validated.agentId, validated.taskId ?? null, now);

    this.touchAgent(validated.agentId, now);

    const session: SessionRecord = {
      id,
      agentId: validated.agentId,
      taskId: validated.taskId ?? null,
      status: "active",
      startedAt: now,
      endedAt: null,
    };

    this.writeAuditEvent({
      event_type: "session.started",
      actor: actor?.actor ?? validated.agentId,
      entity_type: "session",
      entity_id: id,
      previous_version: null,
      payload: {
        agent_id: session.agentId,
        task_id: session.taskId,
        status: "active",
      },
      created_at: now,
    });

    return session;
  }

  endSession(id: string, actor?: ActorContext): SessionRecord {
    const existing = this.getSession(id);
    if (!existing) {
      throw new Error(`Session '${id}' not found.`);
    }

    if (existing.status !== "active") {
      throw new Error(
        `Cannot end session '${id}': session is not active (current status: '${existing.status}').`,
      );
    }

    const now = new Date().toISOString();

    this.db
      .prepare(
        "UPDATE sessions SET status = 'ended', ended_at = ? WHERE id = ?",
      )
      .run(now, id);

    this.touchAgent(existing.agentId, now);

    const updated: SessionRecord = {
      ...existing,
      status: "ended",
      endedAt: now,
    };

    this.writeAuditEvent({
      event_type: "session.ended",
      actor: actor?.actor ?? existing.agentId,
      entity_type: "session",
      entity_id: id,
      previous_version: null,
      payload: {
        agent_id: existing.agentId,
        task_id: existing.taskId,
        from_status: "active",
        to_status: "ended",
      },
      created_at: now,
    });

    return updated;
  }

  failSession(
    id: string,
    options?: { reason?: string | undefined },
    actor?: ActorContext,
  ): SessionRecord {
    const existing = this.getSession(id);
    if (!existing) {
      throw new Error(`Session '${id}' not found.`);
    }

    if (existing.status !== "active") {
      throw new Error(
        `Cannot fail session '${id}': session is not active (current status: '${existing.status}').`,
      );
    }

    const now = new Date().toISOString();

    this.db
      .prepare(
        "UPDATE sessions SET status = 'failed', ended_at = ? WHERE id = ?",
      )
      .run(now, id);

    this.touchAgent(existing.agentId, now);

    const updated: SessionRecord = {
      ...existing,
      status: "failed",
      endedAt: now,
    };

    this.writeAuditEvent({
      event_type: "session.failed",
      actor: actor?.actor ?? existing.agentId,
      entity_type: "session",
      entity_id: id,
      previous_version: null,
      payload: {
        agent_id: existing.agentId,
        task_id: existing.taskId,
        from_status: "active",
        to_status: "failed",
        reason: options?.reason,
      },
      created_at: now,
    });

    return updated;
  }

  getSession(id: string): SessionRecord | null {
    const row = this.db
      .prepare(
        "SELECT id, agent_id, task_id, status, started_at, ended_at FROM sessions WHERE id = ?",
      )
      .get(id) as
      | {
          id: string;
          agent_id: string;
          task_id: string | null;
          status: SessionStatus;
          started_at: string;
          ended_at: string | null;
        }
      | undefined;

    if (!row) {
      return null;
    }

    return {
      id: row.id,
      agentId: row.agent_id,
      taskId: row.task_id,
      status: row.status,
      startedAt: row.started_at,
      endedAt: row.ended_at,
    };
  }

  listSessions(filter?: {
    agentId?: string | undefined;
    taskId?: string | undefined;
    status?: SessionStatus | undefined;
  }): SessionRecord[] {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filter?.agentId) {
      conditions.push("agent_id = ?");
      params.push(filter.agentId);
    }
    if (filter?.taskId) {
      conditions.push("task_id = ?");
      params.push(filter.taskId);
    }
    if (filter?.status) {
      conditions.push("status = ?");
      params.push(filter.status);
    }

    const whereClause =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const rows = this.db
      .prepare(
        `SELECT id, agent_id, task_id, status, started_at, ended_at FROM sessions ${whereClause} ORDER BY started_at DESC`,
      )
      .all(...params) as Array<{
      id: string;
      agent_id: string;
      task_id: string | null;
      status: SessionStatus;
      started_at: string;
      ended_at: string | null;
    }>;

    return rows.map((r) => ({
      id: r.id,
      agentId: r.agent_id,
      taskId: r.task_id,
      status: r.status,
      startedAt: r.started_at,
      endedAt: r.ended_at,
    }));
  }

  createTask(input: CreateTaskInput, actor?: ActorContext): TaskRecord {
    const validated = createTaskSchema.parse(input);
    const id = validated.id?.trim() || `task-${randomUUID()}`;
    const now = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO tasks (id, title, description, status, scope_json, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
      )
      .run(
        id,
        validated.title,
        validated.description,
        validated.status,
        JSON.stringify(validated.scope),
        now,
        now,
      );

    if (actor) {
      this.touchAgent(actor.actor);
    }

    const task: TaskRecord = {
      id,
      title: validated.title,
      description: validated.description,
      status: validated.status,
      scope: validated.scope,
      version: 1,
      createdAt: now,
      updatedAt: now,
    };

    this.writeAuditEvent({
      event_type: "task.created",
      actor: actor?.actor ?? "system",
      entity_type: "task",
      entity_id: id,
      previous_version: null,
      payload: {
        title: task.title,
        status: task.status,
        scope: task.scope,
      },
      created_at: now,
    });

    return task;
  }

  getTask(id: string): TaskRecord | null {
    const row = this.db
      .prepare(
        "SELECT id, title, description, status, scope_json, version, created_at, updated_at FROM tasks WHERE id = ?",
      )
      .get(id) as
      | {
          id: string;
          title: string;
          description: string;
          status: TaskStatus;
          scope_json: string;
          version: number;
          created_at: string;
          updated_at: string;
        }
      | undefined;

    if (!row) {
      return null;
    }

    return {
      id: row.id,
      title: row.title,
      description: row.description,
      status: row.status,
      scope: JSON.parse(row.scope_json),
      version: row.version,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  listTasks(status?: TaskStatus): TaskRecord[] {
    const sql = status
      ? "SELECT id, title, description, status, scope_json, version, created_at, updated_at FROM tasks WHERE status = ? ORDER BY updated_at DESC"
      : "SELECT id, title, description, status, scope_json, version, created_at, updated_at FROM tasks ORDER BY updated_at DESC";
    const params = status ? [status] : [];
    const rows = this.db.prepare(sql).all(...params) as Array<{
      id: string;
      title: string;
      description: string;
      status: TaskStatus;
      scope_json: string;
      version: number;
      created_at: string;
      updated_at: string;
    }>;

    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      description: r.description,
      status: r.status,
      scope: JSON.parse(r.scope_json),
      version: r.version,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  createPolicy(input: CreatePolicyInput, actor?: ActorContext): PolicyRecord {
    const validated = createPolicySchema.parse(input);
    const id = validated.id?.trim() || `pol-${randomUUID()}`;
    const now = new Date().toISOString();
    const rules: PolicyRules =
      validated.rules ??
      (validated.policyJson ? JSON.parse(validated.policyJson) : {});
    const policyJson = validated.policyJson ?? JSON.stringify(rules);

    const upsertSql = `
      INSERT INTO policies (id, name, description, policy_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        description = excluded.description,
        policy_json = excluded.policy_json,
        updated_at = excluded.updated_at;
    `;

    this.db
      .prepare(upsertSql)
      .run(id, validated.name, validated.description, policyJson, now, now);

    const policy: PolicyRecord = {
      id,
      name: validated.name,
      description: validated.description,
      rules,
      policyJson,
      createdAt: now,
      updatedAt: now,
    };

    this.writeAuditEvent({
      event_type: "policy.created",
      actor: actor?.actor ?? "system",
      entity_type: "policy",
      entity_id: id,
      previous_version: null,
      payload: {
        name: policy.name,
        rules: policy.rules,
      },
      created_at: now,
    });

    return policy;
  }

  getPolicy(id: string): PolicyRecord | null {
    const row = this.db
      .prepare(
        "SELECT id, name, description, policy_json, created_at, updated_at FROM policies WHERE id = ?",
      )
      .get(id) as
      | {
          id: string;
          name: string;
          description: string;
          policy_json: string;
          created_at: string;
          updated_at: string;
        }
      | undefined;

    if (!row) {
      return null;
    }

    let rules: PolicyRules = {};
    try {
      rules = JSON.parse(row.policy_json);
    } catch {
      // fallback
    }

    return {
      id: row.id,
      name: row.name,
      description: row.description,
      rules,
      policyJson: row.policy_json,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  listPolicies(): PolicyRecord[] {
    const rows = this.db
      .prepare(
        "SELECT id, name, description, policy_json, created_at, updated_at FROM policies ORDER BY created_at ASC",
      )
      .all() as Array<{
      id: string;
      name: string;
      description: string;
      policy_json: string;
      created_at: string;
      updated_at: string;
    }>;

    return rows.map((r) => {
      let rules: PolicyRules = {};
      try {
        rules = JSON.parse(r.policy_json);
      } catch {
        // fallback
      }
      return {
        id: r.id,
        name: r.name,
        description: r.description,
        rules,
        policyJson: r.policy_json,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      };
    });
  }

  deletePolicy(id: string, actor?: ActorContext): boolean {
    const existing = this.getPolicy(id);
    if (!existing) {
      return false;
    }

    this.db.prepare("DELETE FROM policies WHERE id = ?").run(id);

    this.writeAuditEvent({
      event_type: "policy.deleted",
      actor: actor?.actor ?? "system",
      entity_type: "policy",
      entity_id: id,
      previous_version: null,
      payload: { name: existing.name },
      created_at: new Date().toISOString(),
    });

    return true;
  }

  isScopeVisible(scope: ContextScope, policyId?: string): boolean {
    let policy: PolicyRecord | null = null;
    if (policyId) {
      policy = this.getPolicy(policyId);
    } else {
      const policies = this.listPolicies();
      if (policies.length > 0) {
        policy = policies[0]!;
      }
    }
    return isScopeVisibleByPolicy(scope, policy?.rules);
  }

  create(input: CreateContextInput, actor: ActorContext): ContextItem {
    const resolvedActor = this.resolveActor(actor);
    const id = input.id?.trim() || `ctx-${randomUUID()}`;
    const type = input.type;
    const scope: ContextScope = input.scope ?? "workspace";
    const workspaceId = input.workspaceId ?? this.workspaceId;
    const now = new Date().toISOString();
    const createdAt = input.createdAt ?? now;
    const updatedAt = input.updatedAt ?? createdAt;
    const version = input.version ?? 1;

    let status: ContextStatus;
    if (isDurableContextType(type)) {
      if (resolvedActor.source === "agent") {
        if (input.status === "approved") {
          assertCanCreate(resolvedActor, { id, type, status: "approved" });
        }
        status = input.status === "draft" ? "draft" : "proposed";
      } else {
        status = input.status ?? "approved";
      }
    } else if (isOperationalContextType(type)) {
      status = input.status ?? "approved";
    } else {
      status = input.status ?? "proposed";
    }

    const rawItem: Record<string, unknown> = {
      ...input,
      id,
      type,
      scope,
      workspaceId,
      title: input.title,
      content: input.content ?? "",
      source: input.source ?? resolvedActor.source,
      actor: input.actor ?? resolvedActor.actor,
      status,
      importance: input.importance ?? "normal",
      visibility: input.visibility ?? [],
      tags: input.tags ?? [],
      version,
      createdAt,
      updatedAt,
      expiresAt: input.expiresAt ?? null,
      supersedes: input.supersedes ?? [],
    };

    const item = contextItemSchema.parse(rawItem);

    this.persistItem(item);

    this.writeAuditEvent({
      event_type: "context.created",
      actor: resolvedActor.actor,
      entity_type: "context_item",
      entity_id: item.id,
      previous_version: null,
      payload: {
        source: resolvedActor.source,
        profile:
          resolvedActor.profile ??
          (isActorElevated(resolvedActor) ? "elevated" : "default"),
        status: item.status,
        type: item.type,
        title: item.title,
        supersedes: item.supersedes,
      },
      created_at: item.createdAt,
    });

    if (item.status === "approved" && item.supersedes.length > 0) {
      for (const supersededId of item.supersedes) {
        this.executeSupersession(supersededId, item.id, resolvedActor);
      }
    }

    return item;
  }

  propose(input: ProposeContextInput, actor: ActorContext): ContextItem {
    const payload: CreateContextInput = {
      ...input,
      status: "proposed",
    };
    return this.create(payload, actor);
  }

  proposeDecision(
    input: Omit<BaseContextInput, "type">,
    actor: ActorContext,
  ): ContextItem {
    return this.propose(
      {
        ...input,
        type: "decision",
      } as ProposeContextInput,
      actor,
    );
  }

  approve(id: string, actor: ActorContext): ContextItem {
    const resolvedActor = this.resolveActor(actor);
    const existing = this.getItem(id);
    if (!existing) {
      throw new Error(`Context item '${id}' not found.`);
    }

    if (existing.status === "approved") {
      return existing;
    }

    validateTransition(existing.status, "approved", id);
    assertCanApprove(resolvedActor, existing);

    const prevVersion = existing.version;
    const nextVersion = existing.version + 1;
    const now = new Date().toISOString();

    const updated: ContextItem = {
      ...existing,
      status: "approved",
      version: nextVersion,
      updatedAt: now,
    };

    this.persistItem(updated);

    this.writeAuditEvent({
      event_type: "context.approved",
      actor: resolvedActor.actor,
      entity_type: "context_item",
      entity_id: id,
      previous_version: prevVersion,
      payload: {
        source: resolvedActor.source,
        profile:
          resolvedActor.profile ??
          (isActorElevated(resolvedActor) ? "elevated" : "default"),
        from_status: existing.status,
        to_status: "approved",
      },
      created_at: now,
    });

    if (updated.supersedes && updated.supersedes.length > 0) {
      for (const supersededId of updated.supersedes) {
        this.executeSupersession(supersededId, updated.id, resolvedActor);
      }
    }

    return updated;
  }

  supersede(
    params: { supersededId: string; replacingId: string },
    actor: ActorContext,
  ): { superseded: ContextItem; replacing: ContextItem } {
    const resolvedActor = this.resolveActor(actor);
    const { supersededId, replacingId } = params;

    const superseded = this.getItem(supersededId);
    if (!superseded) {
      throw new Error(`Superseded context item '${supersededId}' not found.`);
    }
    validateTransition(superseded.status, "superseded", supersededId);

    const replacing = this.getItem(replacingId);
    if (!replacing) {
      throw new Error(`Replacing context item '${replacingId}' not found.`);
    }
    if (replacing.status !== "approved") {
      throw new Error(
        `Replacing context item '${replacingId}' must be approved before it can supersede another item.`,
      );
    }

    const updatedSuperseded = this.executeSupersession(
      supersededId,
      replacingId,
      resolvedActor,
    );

    let updatedReplacing = replacing;
    if (!replacing.supersedes.includes(supersededId)) {
      updatedReplacing = {
        ...replacing,
        supersedes: [...replacing.supersedes, supersededId],
        updatedAt: new Date().toISOString(),
      };
      this.persistItem(updatedReplacing);
    }

    return { superseded: updatedSuperseded, replacing: updatedReplacing };
  }

  archive(id: string, actor: ActorContext): ContextItem {
    const resolvedActor = this.resolveActor(actor);
    const existing = this.getItem(id);
    if (!existing) {
      throw new Error(`Context item '${id}' not found.`);
    }

    if (existing.status === "archived") {
      return existing;
    }

    validateTransition(existing.status, "archived", id);
    assertCanArchive(resolvedActor, existing);

    const prevVersion = existing.version;
    const nextVersion = existing.version + 1;
    const now = new Date().toISOString();

    const updated: ContextItem = {
      ...existing,
      status: "archived",
      version: nextVersion,
      updatedAt: now,
    };

    this.persistItem(updated);

    this.writeAuditEvent({
      event_type: "context.archived",
      actor: resolvedActor.actor,
      entity_type: "context_item",
      entity_id: id,
      previous_version: prevVersion,
      payload: {
        source: resolvedActor.source,
        profile:
          resolvedActor.profile ??
          (isActorElevated(resolvedActor) ? "elevated" : "default"),
        from_status: existing.status,
        to_status: "archived",
      },
      created_at: now,
    });

    return updated;
  }

  transition(
    id: string,
    toStatus: ContextStatus,
    actor: ActorContext,
    options?: { reason?: string | undefined; replacingId?: string | undefined },
  ): ContextItem {
    const resolvedActor = this.resolveActor(actor);
    const existing = this.getItem(id);
    if (!existing) {
      throw new Error(`Context item '${id}' not found.`);
    }

    if (existing.status === toStatus) {
      return existing;
    }

    validateTransition(existing.status, toStatus, id);

    if (toStatus === "approved") {
      return this.approve(id, resolvedActor);
    }
    if (toStatus === "archived") {
      return this.archive(id, resolvedActor);
    }
    if (toStatus === "superseded") {
      if (!options?.replacingId) {
        throw new Error(
          `Superseding context item '${id}' requires a replacingId.`,
        );
      }
      return this.supersede(
        { supersededId: id, replacingId: options.replacingId },
        resolvedActor,
      ).superseded;
    }

    const prevVersion = existing.version;
    const nextVersion = existing.version + 1;
    const now = new Date().toISOString();

    const updated: ContextItem = {
      ...existing,
      status: toStatus,
      version: nextVersion,
      updatedAt: now,
    };

    this.persistItem(updated);

    this.writeAuditEvent({
      event_type: `context.${toStatus}`,
      actor: resolvedActor.actor,
      entity_type: "context_item",
      entity_id: id,
      previous_version: prevVersion,
      payload: {
        source: resolvedActor.source,
        profile:
          resolvedActor.profile ??
          (isActorElevated(resolvedActor) ? "elevated" : "default"),
        from_status: existing.status,
        to_status: toStatus,
        reason: options?.reason,
      },
      created_at: now,
    });

    return updated;
  }

  getItem(id: string): ContextItem | null {
    const fullRow = this.db
      .prepare(
        `SELECT id, type, scope, workspace_id, title, content, source, actor, status,
                importance, visibility_json, tags_json, document_path, document_hash, version,
                created_at, updated_at, expires_at
         FROM context_items WHERE id = ?`,
      )
      .get(id) as
      | {
          id: string;
          type: ContextType;
          scope: ContextScope;
          workspace_id: string;
          title: string;
          content: string;
          source: string;
          actor: string;
          status: ContextStatus;
          importance: Importance;
          visibility_json: string;
          tags_json: string;
          document_path: string | null;
          document_hash: string | null;
          version: number;
          created_at: string;
          updated_at: string;
          expires_at: string | null;
        }
      | undefined;

    if (fullRow) {
      if (fullRow.document_path && existsSync(fullRow.document_path)) {
        try {
          const diskItem = readMarkdownKnowledgeItem(fullRow.document_path);
          // If disk file is at least as fresh as DB, use it to preserve human frontmatter annotations
          if (diskItem.version >= fullRow.version) {
            return diskItem;
          }
        } catch {
          // If reading or parsing disk fails, fall back to SQLite row
        }
      }

      const supersedesRows = this.db
        .prepare(
          "SELECT superseded_id FROM context_supersedes WHERE context_id = ?",
        )
        .all(id) as Array<{ superseded_id: string }>;

      return contextItemSchema.parse({
        id: fullRow.id,
        type: fullRow.type,
        scope: fullRow.scope,
        workspaceId: fullRow.workspace_id || this.workspaceId,
        title: fullRow.title,
        content: fullRow.content,
        source: fullRow.source,
        actor: fullRow.actor,
        status: fullRow.status,
        importance: fullRow.importance,
        visibility: JSON.parse(fullRow.visibility_json),
        tags: JSON.parse(fullRow.tags_json),
        version: fullRow.version,
        createdAt: fullRow.created_at,
        updatedAt: fullRow.updated_at,
        expiresAt: fullRow.expires_at,
        supersedes: supersedesRows.map((r) => r.superseded_id),
      });
    }

    return null;
  }

  queryItems(filter?: QueryContextFilter): ContextItem[] {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filter?.workspaceId) {
      conditions.push("workspace_id = ?");
      params.push(filter.workspaceId);
    }

    if (filter?.status) {
      conditions.push("status = ?");
      params.push(filter.status);
    } else {
      if (!filter?.includeSuperseded) {
        conditions.push("status != 'superseded'");
      }
      if (!filter?.includeArchived) {
        conditions.push("status != 'archived'");
      }
      if (!filter?.includeProposed) {
        conditions.push("status != 'proposed'");
      }
      if (!filter?.includeDraft) {
        conditions.push("status != 'draft'");
      }
    }

    if (filter?.type) {
      conditions.push("type = ?");
      params.push(filter.type);
    }
    if (filter?.scope) {
      conditions.push("scope = ?");
      params.push(filter.scope);
    }

    const whereClause =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const sql = `SELECT id FROM context_items ${whereClause} ORDER BY updated_at DESC`;
    const rows = this.db.prepare(sql).all(...params) as Array<{ id: string }>;

    const items: ContextItem[] = [];
    for (const row of rows) {
      const item = this.getItem(row.id);
      if (item) {
        items.push(item);
      }
    }
    return items;
  }

  search(query: string, options?: SearchOptions): SearchResult[] {
    const ftsQuery = sanitizeFtsQuery(query);
    if (!ftsQuery) {
      return [];
    }

    let rows: Array<{ context_id: string; rank: number }> = [];
    try {
      const sql = `
        SELECT context_id, bm25(context_fts) as rank
        FROM context_fts
        WHERE context_fts MATCH ?
        ORDER BY rank ASC
      `;
      rows = this.db.prepare(sql).all(ftsQuery) as Array<{
        context_id: string;
        rank: number;
      }>;
    } catch {
      try {
        const tokens = query.match(/[\p{L}\p{N}_]+/gu) || [];
        if (tokens.length > 0) {
          const fallbackQuery = tokens.map((t) => `"${t}"`).join(" OR ");
          rows = this.db
            .prepare(
              `SELECT context_id, bm25(context_fts) as rank
               FROM context_fts
               WHERE context_fts MATCH ?
               ORDER BY rank ASC`,
            )
            .all(fallbackQuery) as Array<{ context_id: string; rank: number }>;
        }
      } catch {
        return [];
      }
    }

    const results: SearchResult[] = [];
    const targetWs = options?.workspaceId ?? this.workspaceId;

    for (const row of rows) {
      const item = this.getItem(row.context_id);
      if (!item) continue;

      if (item.workspaceId !== targetWs) {
        if (item.scope === "global" && options?.allowGlobal) {
          // allowed
        } else {
          continue;
        }
      } else if (item.scope === "global" && !options?.allowGlobal) {
        continue;
      }

      if (options?.scope && item.scope !== options.scope) {
        continue;
      }

      if (options?.type && item.type !== options.type) {
        continue;
      }
      if (options?.types && !options.types.includes(item.type)) {
        continue;
      }

      if (options?.status) {
        if (item.status !== options.status) continue;
      } else {
        if (item.status === "superseded" && !options?.includeSuperseded)
          continue;
        if (item.status === "archived" && !options?.includeArchived) continue;
        if (item.status === "proposed" && !options?.includeProposed) continue;
        if (item.status === "draft" && !options?.includeDraft) continue;
      }

      results.push({
        item,
        relevanceScore: -row.rank,
        matchRank: results.length + 1,
      });

      if (options?.limit && results.length >= options.limit) {
        break;
      }
    }

    return results;
  }

  buildPack(options?: BuildPackOptions): ContextPack {
    // 1. Resolve client identity and workspace
    const workspaceId = options?.workspaceId ?? this.workspaceId;
    let resolvedClientId = "anonymous-client";
    let clientKind = "unknown";
    let clientProfile = "default";

    if (options?.client) {
      if (typeof options.client === "string") {
        resolvedClientId = options.client;
      } else {
        resolvedClientId = options.client.actor;
        clientKind = options.client.source;
        clientProfile = options.client.profile ?? "default";
      }
    } else if (options?.clientId) {
      resolvedClientId = options.clientId;
    }

    const agentRow = this.db
      .prepare(
        "SELECT id, display_name, client_kind, profile FROM agents WHERE id = ?",
      )
      .get(resolvedClientId) as
      | {
          id: string;
          display_name: string;
          client_kind: string;
          profile: string;
        }
      | undefined;
    if (agentRow) {
      clientKind = agentRow.client_kind;
      clientProfile = agentRow.profile;
    }

    // 2. Enforce policy
    let allowGlobal = false;
    let policyMaxBudget: number | undefined;
    let activePolicyName: string | undefined;

    let policyRow:
      { id: string; name: string; policy_json: string } | undefined;
    if (options?.policyId) {
      policyRow = this.db
        .prepare("SELECT id, name, policy_json FROM policies WHERE id = ?")
        .get(options.policyId) as
        { id: string; name: string; policy_json: string } | undefined;
    } else {
      policyRow = this.db
        .prepare(
          "SELECT id, name, policy_json FROM policies ORDER BY id ASC LIMIT 1",
        )
        .get() as { id: string; name: string; policy_json: string } | undefined;
    }

    if (policyRow) {
      activePolicyName = policyRow.name;
      try {
        const parsed = JSON.parse(policyRow.policy_json);
        if (parsed.allowGlobal === true) {
          allowGlobal = true;
        }
        if (typeof parsed.maxBudget === "number") {
          policyMaxBudget = parsed.maxBudget;
        }
      } catch {
        // ignore JSON parse error
      }
    }

    // Global context is included ONLY when policy explicitly allows it
    if (options?.allowGlobal && allowGlobal) {
      allowGlobal = true;
    }

    // 3. Resolve active task and session
    let resolvedTaskId = options?.taskId;
    let resolvedSessionId = options?.sessionId;

    if (resolvedSessionId) {
      const sessionRow = this.db
        .prepare("SELECT id, task_id FROM sessions WHERE id = ?")
        .get(resolvedSessionId) as
        { id: string; task_id: string | null } | undefined;
      if (sessionRow && !resolvedTaskId && sessionRow.task_id) {
        resolvedTaskId = sessionRow.task_id;
      }
    } else if (resolvedClientId && resolvedClientId !== "anonymous-client") {
      const activeSessionRow = this.db
        .prepare(
          "SELECT id, task_id FROM sessions WHERE agent_id = ? AND status = 'active' ORDER BY started_at DESC LIMIT 1",
        )
        .get(resolvedClientId) as
        { id: string; task_id: string | null } | undefined;
      if (activeSessionRow) {
        resolvedSessionId = activeSessionRow.id;
        if (!resolvedTaskId && activeSessionRow.task_id) {
          resolvedTaskId = activeSessionRow.task_id;
        }
      }
    }

    if (
      !resolvedTaskId &&
      resolvedClientId &&
      resolvedClientId !== "anonymous-client"
    ) {
      const leaseRow = this.db
        .prepare(
          "SELECT task_id FROM task_leases WHERE agent_id = ? AND expires_at > datetime('now') ORDER BY expires_at DESC LIMIT 1",
        )
        .get(resolvedClientId) as { task_id: string } | undefined;
      if (leaseRow) {
        resolvedTaskId = leaseRow.task_id;
      }
    }

    // 4 & 5. Filter by status, query structured filters and FTS and supersedes links
    const supersedesRows = this.db
      .prepare("SELECT context_id, superseded_id FROM context_supersedes")
      .all() as Array<{ context_id: string; superseded_id: string }>;

    const replacementMap = new Map<string, string>();
    for (const row of supersedesRows) {
      replacementMap.set(row.superseded_id, row.context_id);
    }

    let ftsRelevanceMap = new Map<string, number>();
    let ftsMatchedIds: Set<string> | null = null;

    if (options?.query && options.query.trim()) {
      const ftsQuery = sanitizeFtsQuery(options.query);
      if (ftsQuery) {
        try {
          const ftsRows = this.db
            .prepare(
              `SELECT context_id, bm25(context_fts) as rank
               FROM context_fts
               WHERE context_fts MATCH ?
               ORDER BY rank ASC`,
            )
            .all(ftsQuery) as Array<{ context_id: string; rank: number }>;
          ftsMatchedIds = new Set<string>();
          for (const row of ftsRows) {
            ftsMatchedIds.add(row.context_id);
            ftsRelevanceMap.set(row.context_id, -row.rank);
          }
        } catch {
          ftsMatchedIds = new Set<string>();
        }
      } else {
        ftsMatchedIds = new Set<string>();
      }
    }

    // Candidate query from SQLite
    const allDbRows = this.db
      .prepare(
        "SELECT id FROM context_items WHERE workspace_id = ? OR scope = 'global' ORDER BY id ASC",
      )
      .all(workspaceId) as Array<{ id: string }>;

    const candidateItems: CandidateWithScore[] = [];

    for (const row of allDbRows) {
      if (ftsMatchedIds !== null && !ftsMatchedIds.has(row.id)) {
        continue;
      }

      const item = this.getItem(row.id);
      if (!item) continue;

      if (options?.type && item.type !== options.type) continue;
      if (options?.types && !options.types.includes(item.type)) continue;
      if (options?.tags && options.tags.length > 0) {
        const hasTag = options.tags.some((t) => item.tags?.includes(t));
        if (!hasTag) continue;
      }

      const relevance = ftsRelevanceMap.get(item.id) ?? 0;
      candidateItems.push({
        ...item,
        relevanceScore: relevance,
      });
    }

    // Deterministic timestamp from workspace state
    let packTimestamp = options?.timestamp;
    if (!packTimestamp) {
      const maxTimeRow = this.db
        .prepare(
          "SELECT MAX(updated_at) as latest FROM context_items WHERE workspace_id = ?",
        )
        .get(workspaceId) as { latest: string | null } | undefined;
      if (maxTimeRow?.latest) {
        packTimestamp = maxTimeRow.latest;
      } else {
        const wsRow = this.db
          .prepare("SELECT created_at FROM workspace WHERE id = ?")
          .get(workspaceId) as { created_at: string } | undefined;
        packTimestamp = wsRow?.created_at ?? new Date().toISOString();
      }
    }

    // 6, 7 & 8: Ranking, Token budgeting, Provenance, Conflicts, Omissions
    const budget = options?.maxTokens ?? policyMaxBudget;

    return buildContextPack(candidateItems, {
      workspaceId,
      generatedAt: packTimestamp,
      query: options?.query,
      scope: options?.scope,
      taskId: resolvedTaskId,
      sessionId: resolvedSessionId,
      clientId: resolvedClientId,
      allowGlobal,
      activePolicyName,
      maxTokens: budget,
      includeSuperseded: options?.includeSuperseded,
      includeArchived: options?.includeArchived,
      includeProposed: options?.includeProposed,
      includeDraft: options?.includeDraft,
      replacementMap,
    });
  }

  retrieve(options?: BuildPackOptions): ContextPack {
    return this.buildPack(options);
  }

  buildDefaultPack(scope?: ContextScope | undefined): ContextPack {
    return this.buildPack({
      scope: scope ?? undefined,
      includeSuperseded: false,
      includeArchived: false,
      includeProposed: false,
      includeDraft: false,
    });
  }

  getAuditEvents(
    entityId?: string,
    entityType = "context_item",
  ): AuditEventRecord[] {
    let sql = `SELECT id, event_type, actor, entity_type, entity_id, previous_version, payload_json, created_at
               FROM audit_events WHERE entity_type = ?`;
    const params: unknown[] = [entityType];

    if (entityId) {
      sql += " AND entity_id = ?";
      params.push(entityId);
    }

    sql += " ORDER BY id ASC";

    const rows = this.db.prepare(sql).all(...params) as Array<{
      id: number;
      event_type: string;
      actor: string;
      entity_type: string;
      entity_id: string;
      previous_version: number | null;
      payload_json: string;
      created_at: string;
    }>;

    return rows.map((r) => ({
      id: r.id,
      event_type: r.event_type,
      actor: r.actor,
      entity_type: r.entity_type,
      entity_id: r.entity_id,
      previous_version: r.previous_version,
      payload: JSON.parse(r.payload_json || "{}"),
      created_at: r.created_at,
    }));
  }

  getAllAuditEvents(): AuditEventRecord[] {
    const rows = this.db
      .prepare(
        "SELECT id, event_type, actor, entity_type, entity_id, previous_version, payload_json, created_at FROM audit_events ORDER BY id ASC",
      )
      .all() as Array<{
      id: number;
      event_type: string;
      actor: string;
      entity_type: string;
      entity_id: string;
      previous_version: number | null;
      payload_json: string;
      created_at: string;
    }>;

    return rows.map((r) => ({
      id: r.id,
      event_type: r.event_type,
      actor: r.actor,
      entity_type: r.entity_type,
      entity_id: r.entity_id,
      previous_version: r.previous_version,
      payload: JSON.parse(r.payload_json || "{}"),
      created_at: r.created_at,
    }));
  }

  getSupersededIds(contextId: string): string[] {
    const rows = this.db
      .prepare(
        "SELECT superseded_id FROM context_supersedes WHERE context_id = ?",
      )
      .all(contextId) as Array<{ superseded_id: string }>;
    return rows.map((r) => r.superseded_id);
  }

  getReplacementId(supersededId: string): string | null {
    const row = this.db
      .prepare(
        "SELECT context_id FROM context_supersedes WHERE superseded_id = ? LIMIT 1",
      )
      .get(supersededId) as { context_id: string } | undefined;
    return row?.context_id ?? null;
  }

  private persistItem(item: ContextItem): string {
    const documentPath = saveKnowledgeItem(this.workspaceRoot, item);
    const rawContent = readFileSync(documentPath, "utf8");
    const documentHash = computeDocumentHash(rawContent);

    const upsertSql = `
      INSERT INTO context_items (
        id, type, scope, workspace_id, title, content, source, actor, status,
        importance, visibility_json, tags_json, document_path, document_hash,
        version, created_at, updated_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        type = excluded.type,
        scope = excluded.scope,
        workspace_id = excluded.workspace_id,
        title = excluded.title,
        content = excluded.content,
        source = excluded.source,
        actor = excluded.actor,
        status = excluded.status,
        importance = excluded.importance,
        visibility_json = excluded.visibility_json,
        tags_json = excluded.tags_json,
        document_path = excluded.document_path,
        document_hash = excluded.document_hash,
        version = excluded.version,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        expires_at = excluded.expires_at;
    `;

    this.db
      .prepare(upsertSql)
      .run(
        item.id,
        item.type,
        item.scope,
        item.workspaceId,
        item.title,
        item.content,
        item.source,
        item.actor,
        item.status,
        item.importance,
        JSON.stringify(item.visibility ?? []),
        JSON.stringify(item.tags ?? []),
        documentPath,
        documentHash,
        item.version,
        item.createdAt,
        item.updatedAt,
        item.expiresAt ?? null,
      );

    try {
      this.db
        .prepare("DELETE FROM context_fts WHERE context_id = ?")
        .run(item.id);
      this.db
        .prepare(
          "INSERT INTO context_fts (context_id, title, content, tags) VALUES (?, ?, ?, ?)",
        )
        .run(item.id, item.title, item.content, (item.tags ?? []).join(" "));
    } catch {
      // Ignore FTS error if virtual table index is not available
    }

    return documentPath;
  }

  private executeSupersession(
    supersededId: string,
    replacingId: string,
    actor: ActorContext,
  ): ContextItem {
    const resolvedActor = this.resolveActor(actor);
    const superseded = this.getItem(supersededId);
    if (!superseded) {
      throw new Error(`Superseded context item '${supersededId}' not found.`);
    }

    if (superseded.status === "superseded") {
      this.db
        .prepare(
          "INSERT OR IGNORE INTO context_supersedes (context_id, superseded_id) VALUES (?, ?)",
        )
        .run(replacingId, supersededId);
      return superseded;
    }

    validateTransition(superseded.status, "superseded", supersededId);

    const prevVersion = superseded.version;
    const nextVersion = superseded.version + 1;
    const now = new Date().toISOString();

    const updatedSuperseded: ContextItem = {
      ...superseded,
      status: "superseded",
      version: nextVersion,
      updatedAt: now,
    };

    this.persistItem(updatedSuperseded);

    this.db
      .prepare(
        "INSERT OR IGNORE INTO context_supersedes (context_id, superseded_id) VALUES (?, ?)",
      )
      .run(replacingId, supersededId);

    this.writeAuditEvent({
      event_type: "context.superseded",
      actor: resolvedActor.actor,
      entity_type: "context_item",
      entity_id: supersededId,
      previous_version: prevVersion,
      payload: {
        source: resolvedActor.source,
        profile:
          resolvedActor.profile ??
          (isActorElevated(resolvedActor) ? "elevated" : "default"),
        from_status: superseded.status,
        to_status: "superseded",
        superseded_by: replacingId,
      },
      created_at: now,
    });

    return updatedSuperseded;
  }

  // ---------------------------------------------------------------------------
  // Task lease operations
  //
  // Leases are single-machine concurrency primitives. Two agents on the same
  // machine that share one SQLite file are kept from colliding on the same
  // task. This guarantee does not extend across devices or network boundaries.
  // ---------------------------------------------------------------------------

  private rowToLease(row: {
    task_id: string;
    agent_id: string;
    acquired_at: string;
    heartbeat_at: string;
    expires_at: string;
    version: number;
  }): LeaseRecord {
    return {
      taskId: row.task_id,
      agentId: row.agent_id,
      acquiredAt: row.acquired_at,
      heartbeatAt: row.heartbeat_at,
      expiresAt: row.expires_at,
      version: row.version,
    };
  }

  getLease(taskId: string): LeaseRecord | null {
    const row = this.db
      .prepare(
        "SELECT task_id, agent_id, acquired_at, heartbeat_at, expires_at, version FROM task_leases WHERE task_id = ?",
      )
      .get(taskId) as
      | {
          task_id: string;
          agent_id: string;
          acquired_at: string;
          heartbeat_at: string;
          expires_at: string;
          version: number;
        }
      | undefined;

    return row ? this.rowToLease(row) : null;
  }

  listLeases(): LeaseRecord[] {
    const rows = this.db
      .prepare(
        "SELECT task_id, agent_id, acquired_at, heartbeat_at, expires_at, version FROM task_leases ORDER BY acquired_at DESC",
      )
      .all() as Array<{
      task_id: string;
      agent_id: string;
      acquired_at: string;
      heartbeat_at: string;
      expires_at: string;
      version: number;
    }>;

    return rows.map((r) => this.rowToLease(r));
  }

  private computeScopeConflict(
    holderScopes: string[],
    claimantScopes: string[],
  ): ScopeConflict | null {
    if (holderScopes.length === 0 || claimantScopes.length === 0) {
      return null;
    }
    const holderSet = new Set(holderScopes);
    const overlapping = claimantScopes.filter((s) => holderSet.has(s));
    return {
      overlapping,
      holderScopes,
      claimantScopes,
    };
  }

  /**
   * Claim a lease on a task atomically inside a single SQLite transaction.
   *
   * The lease model is explicitly single-machine, backed by SQLite on a single
   * host filesystem. It does not provide distributed multi-machine consensus.
   *
   * A fresh conflicting claim fails immediately — it does not queue, retry or
   * steal. To take over a stale (expired) lease use takeoverLease() instead,
   * which requires an explicit reason and writes an audit trail.
   */
  claimLease(input: ClaimLeaseInput): LeaseRecord {
    const validated = claimLeaseSchema.parse(input);
    const { taskId, agentId, ttlSeconds, scope } = validated;

    const task = this.getTask(taskId);
    if (!task) {
      throw new Error(`Cannot claim lease: task '${taskId}' not found.`);
    }

    const agent = this.getAgent(agentId);
    if (!agent) {
      throw new Error(`Cannot claim lease: agent '${agentId}' not registered.`);
    }

    const now = new Date();
    const nowIso = now.toISOString();
    const expiresAt = new Date(now.getTime() + ttlSeconds * 1000).toISOString();

    // Run inside a single SQLite transaction with BEGIN IMMEDIATE.
    // SQLite's serialized writer lock ensures that concurrent processes
    // cannot both observe "no lease" and both insert. One acquires the lock first,
    // and the other will wait via busy_timeout and subsequently see the active lease.
    const lease = this.db
      .transaction((): LeaseRecord => {
        const existing = this.db
          .prepare(
            "SELECT task_id, agent_id, acquired_at, heartbeat_at, expires_at, version FROM task_leases WHERE task_id = ?",
          )
          .get(taskId) as
          | {
              task_id: string;
              agent_id: string;
              acquired_at: string;
              heartbeat_at: string;
              expires_at: string;
              version: number;
            }
          | undefined;

        if (existing) {
          // There is an existing lease. If it has not expired, refuse.
          if (existing.expires_at > nowIso) {
            const holderScopes = JSON.parse(
              (
                this.db
                  .prepare("SELECT scope_json FROM tasks WHERE id = ?")
                  .get(taskId) as { scope_json: string } | undefined
              )?.scope_json ?? "[]",
            ) as string[];
            const conflict = this.computeScopeConflict(holderScopes, scope);
            throw new LeaseConflictError(
              taskId,
              existing.agent_id,
              existing.expires_at,
              conflict,
            );
          }
          // Lease is stale — treat this as a takeover path without reason.
          // Reject: stale takeovers must go through takeoverLease().
          throw new LeaseConflictError(
            taskId,
            existing.agent_id,
            existing.expires_at,
            null,
          );
        }

        // Update task scope_json and set status to active.
        this.db
          .prepare(
            "UPDATE tasks SET scope_json = ?, status = 'active', updated_at = ? WHERE id = ?",
          )
          .run(JSON.stringify(scope), nowIso, taskId);

        this.db
          .prepare(
            `INSERT INTO task_leases (task_id, agent_id, acquired_at, heartbeat_at, expires_at, version)
           VALUES (?, ?, ?, ?, ?, 1)`,
          )
          .run(taskId, agentId, nowIso, nowIso, expiresAt);

        // Write audit inside the same transaction so the claim is one atomic transaction.
        const sql = `
        INSERT INTO audit_events (
          event_type, actor, entity_type, entity_id, previous_version, payload_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `;
        this.db.prepare(sql).run(
          "task.lease_acquired",
          agentId,
          "task",
          taskId,
          null,
          JSON.stringify({
            expires_at: expiresAt,
            ttl_seconds: ttlSeconds,
            scope,
          }),
          nowIso,
        );

        return {
          taskId,
          agentId,
          acquiredAt: nowIso,
          heartbeatAt: nowIso,
          expiresAt,
          version: 1,
        };
      })
      .immediate();

    return lease;
  }

  /**
   * Renew a lease the calling agent already holds. Extends the expiry by
   * ttlSeconds from now and updates heartbeat_at.
   */
  renewLease(input: RenewLeaseInput): LeaseRecord {
    const validated = renewLeaseSchema.parse(input);
    const { taskId, agentId, ttlSeconds } = validated;

    const now = new Date();
    const nowIso = now.toISOString();
    const expiresAt = new Date(now.getTime() + ttlSeconds * 1000).toISOString();

    const existing = this.getLease(taskId);
    if (!existing) {
      throw new NoActiveLeaseError(taskId, "renew");
    }
    if (existing.agentId !== agentId) {
      throw new LeaseOwnershipError(taskId, agentId, existing.agentId);
    }

    const nextVersion = existing.version + 1;

    this.db
      .transaction(() => {
        this.db
          .prepare(
            "UPDATE task_leases SET heartbeat_at = ?, expires_at = ?, version = ? WHERE task_id = ?",
          )
          .run(nowIso, expiresAt, nextVersion, taskId);

        const sql = `
        INSERT INTO audit_events (
          event_type, actor, entity_type, entity_id, previous_version, payload_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `;
        this.db
          .prepare(sql)
          .run(
            "task.lease_renewed",
            agentId,
            "task",
            taskId,
            existing.version,
            JSON.stringify({ expires_at: expiresAt, ttl_seconds: ttlSeconds }),
            nowIso,
          );
      })
      .immediate();

    return {
      taskId,
      agentId,
      acquiredAt: existing.acquiredAt,
      heartbeatAt: nowIso,
      expiresAt,
      version: nextVersion,
    };
  }

  /**
   * Release a lease the calling agent holds, transitioning the task to a
   * terminal-ish status (review, done, blocked or planned).
   */
  releaseLease(input: ReleaseLeaseInput): TaskRecord {
    const validated = releaseLeaseSchema.parse(input);
    const { taskId, agentId, finalStatus } = validated;

    const existing = this.getLease(taskId);
    if (!existing) {
      throw new NoActiveLeaseError(taskId, "release");
    }
    if (existing.agentId !== agentId) {
      throw new LeaseOwnershipError(taskId, agentId, existing.agentId);
    }

    const nowIso = new Date().toISOString();

    this.db
      .transaction(() => {
        this.db
          .prepare("DELETE FROM task_leases WHERE task_id = ?")
          .run(taskId);
        this.db
          .prepare("UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?")
          .run(finalStatus, nowIso, taskId);

        const sql = `
        INSERT INTO audit_events (
          event_type, actor, entity_type, entity_id, previous_version, payload_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `;
        this.db
          .prepare(sql)
          .run(
            "task.lease_released",
            agentId,
            "task",
            taskId,
            existing.version,
            JSON.stringify({ final_status: finalStatus }),
            nowIso,
          );
      })
      .immediate();

    return this.getTask(taskId)!;
  }

  /**
   * Take over an expired lease from a different agent. A non-empty reason is
   * mandatory. The audit row names both the displaced agent and the incoming
   * agent so the event is always traceable.
   *
   * Refuses if the lease has not yet expired — use claimLease() for fresh
   * tasks or wait until the current lease expires.
   */
  takeoverLease(input: TakeoverLeaseInput): LeaseRecord {
    if (
      !input ||
      typeof input.reason !== "string" ||
      input.reason.trim().length === 0
    ) {
      throw new TakeoverReasonRequiredError(input?.taskId ?? "unknown");
    }

    const validated = takeoverLeaseSchema.parse(input);
    const { taskId, agentId, reason, ttlSeconds, scope } = validated;

    const task = this.getTask(taskId);
    if (!task) {
      throw new Error(`Cannot take over lease: task '${taskId}' not found.`);
    }

    const agent = this.getAgent(agentId);
    if (!agent) {
      throw new Error(
        `Cannot take over lease: agent '${agentId}' not registered.`,
      );
    }

    const now = new Date();
    const nowIso = now.toISOString();
    const expiresAt = new Date(now.getTime() + ttlSeconds * 1000).toISOString();

    const newLease = this.db
      .transaction((): LeaseRecord => {
        const existing = this.db
          .prepare(
            "SELECT task_id, agent_id, acquired_at, heartbeat_at, expires_at, version FROM task_leases WHERE task_id = ?",
          )
          .get(taskId) as
          | {
              task_id: string;
              agent_id: string;
              acquired_at: string;
              heartbeat_at: string;
              expires_at: string;
              version: number;
            }
          | undefined;

        if (!existing) {
          throw new NoActiveLeaseError(taskId, "take over");
        }

        if (existing.expires_at > nowIso) {
          throw new LeaseNotStaleError(taskId, existing.expires_at);
        }

        const prevAgent = existing.agent_id;

        this.db
          .prepare("DELETE FROM task_leases WHERE task_id = ?")
          .run(taskId);

        this.db
          .prepare(
            "UPDATE tasks SET scope_json = ?, status = 'active', updated_at = ? WHERE id = ?",
          )
          .run(JSON.stringify(scope), nowIso, taskId);

        this.db
          .prepare(
            `INSERT INTO task_leases (task_id, agent_id, acquired_at, heartbeat_at, expires_at, version)
           VALUES (?, ?, ?, ?, ?, 1)`,
          )
          .run(taskId, agentId, nowIso, nowIso, expiresAt);

        // Write audit inside the transaction so it is always present.
        const sql = `
        INSERT INTO audit_events (
          event_type, actor, entity_type, entity_id, previous_version, payload_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `;
        this.db.prepare(sql).run(
          "task.lease_takeover",
          agentId,
          "task",
          taskId,
          existing.version,
          JSON.stringify({
            displaced_agent: prevAgent,
            incoming_agent: agentId,
            reason: reason.trim(),
            expires_at: expiresAt,
            ttl_seconds: ttlSeconds,
            scope,
          }),
          nowIso,
        );

        return {
          taskId,
          agentId,
          acquiredAt: nowIso,
          heartbeatAt: nowIso,
          expiresAt,
          version: 1,
        };
      })
      .immediate();

    return newLease;
  }

  claimTask(input: {
    taskId: string;
    agentId: string;
    ttlSeconds?: number | undefined;
    scope?: string[] | undefined;
    takeoverReason?: string | undefined;
  }): LeaseRecord {
    this.ensureAgent(input.agentId);
    if (input.takeoverReason && input.takeoverReason.trim().length > 0) {
      return this.takeoverLease({
        taskId: input.taskId,
        agentId: input.agentId,
        reason: input.takeoverReason,
        ttlSeconds: input.ttlSeconds ?? 300,
        scope: input.scope ?? [],
      });
    }

    const existing = this.getLease(input.taskId);
    const nowIso = new Date().toISOString();
    if (
      existing &&
      existing.agentId === input.agentId &&
      existing.expiresAt > nowIso
    ) {
      return this.renewLease({
        taskId: input.taskId,
        agentId: input.agentId,
        ttlSeconds: input.ttlSeconds ?? 300,
      });
    }

    return this.claimLease({
      taskId: input.taskId,
      agentId: input.agentId,
      ttlSeconds: input.ttlSeconds ?? 300,
      scope: input.scope ?? [],
    });
  }

  releaseTask(input: {
    taskId: string;
    agentId: string;
    finalStatus?: "review" | "done" | "blocked" | "planned" | undefined;
  }): TaskRecord {
    this.ensureAgent(input.agentId);
    return this.releaseLease({
      taskId: input.taskId,
      agentId: input.agentId,
      finalStatus: input.finalStatus ?? "review",
    });
  }

  getTaskWithLease(
    taskId: string,
  ): { task: TaskRecord; lease: LeaseRecord | null } | null {
    const task = this.getTask(taskId);
    if (!task) {
      return null;
    }
    const lease = this.getLease(taskId);
    return { task, lease };
  }

  private writeAuditEvent(event: {
    event_type: string;
    actor: string;
    entity_type: string;
    entity_id: string;
    previous_version: number | null;
    payload: Record<string, unknown>;
    created_at: string;
  }): void {
    const sql = `
      INSERT INTO audit_events (
        event_type, actor, entity_type, entity_id, previous_version, payload_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `;
    this.db
      .prepare(sql)
      .run(
        event.event_type,
        event.actor,
        event.entity_type,
        event.entity_id,
        event.previous_version,
        JSON.stringify(event.payload),
        event.created_at,
      );

    if (event.actor) {
      this.touchAgent(event.actor, event.created_at);
    }
  }

  /**
   * Create an evidence-bearing structured handoff across a context boundary.
   *
   * Markdown owns the human-readable narrative. SQLite owns the operational
   * record and atomic coordination link. Both share the same stable ID.
   *
   * Refuses immediately at the service layer if claiming success without evidence.
   */
  createHandoff(input: CreateHandoffInput, actor?: ActorContext): Handoff {
    const validated = createHandoffSchema.parse(input);
    const {
      taskId,
      agentId,
      outcome,
      summary,
      blockers,
      nextAction,
      evidence,
      releaseLease,
      tags,
    } = validated;

    // EVIDENCE IS REQUIRED: Refuse success claim without evidence at the service layer
    if (outcome === "success" && (!evidence || evidence.length === 0)) {
      throw new MissingEvidenceError(
        "Handoff asserting success refused: evidence is required. Completion without verification is not accepted as proven.",
      );
    }

    const task = this.getTask(taskId);
    if (!task) {
      throw new Error(`Cannot create handoff: task '${taskId}' not found.`);
    }

    const agent = this.getAgent(agentId);
    if (!agent) {
      throw new Error(
        `Cannot create handoff: agent '${agentId}' not registered.`,
      );
    }

    // Verify lease ownership if an active lease exists
    const activeLease = this.getLease(taskId);
    if (activeLease && activeLease.agentId !== agentId) {
      throw new LeaseOwnershipError(taskId, agentId, activeLease.agentId);
    }

    const leaseVersion = activeLease ? activeLease.version : null;
    const id = validated.id?.trim() || `handoff-${randomUUID()}`;
    const nowIso = new Date().toISOString();
    const title = validated.title?.trim() || `Handoff for ${task.title}`;

    // Format human-readable narrative body for Markdown file
    const narrativeBody = formatHandoffNarrativeBody({
      summary,
      blockers,
      nextAction,
    });

    // Run SQLite operations inside a single atomic transaction
    this.db
      .transaction(() => {
        // 1. Insert operational record into handoffs table
        this.db
          .prepare(
            `INSERT INTO handoffs (id, task_id, agent_id, lease_version, outcome, evidence_json, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            id,
            taskId,
            agentId,
            leaseVersion,
            outcome,
            JSON.stringify(evidence),
            nowIso,
            nowIso,
          );

        // 2. If releaseLease is true and an active lease was held, release it
        if (releaseLease && activeLease) {
          this.db
            .prepare("DELETE FROM task_leases WHERE task_id = ?")
            .run(taskId);
          const finalTaskStatus = outcome === "blocked" ? "blocked" : "review";
          this.db
            .prepare("UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?")
            .run(finalTaskStatus, nowIso, taskId);

          const sql = `
            INSERT INTO audit_events (
              event_type, actor, entity_type, entity_id, previous_version, payload_json, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
          `;
          this.db.prepare(sql).run(
            "task.lease_released",
            agentId,
            "task",
            taskId,
            activeLease.version,
            JSON.stringify({
              final_status: finalTaskStatus,
              reason: "handoff",
            }),
            nowIso,
          );
        }

        // 3. Write handoff.created audit event
        const auditSql = `
          INSERT INTO audit_events (
            event_type, actor, entity_type, entity_id, previous_version, payload_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `;
        this.db.prepare(auditSql).run(
          "handoff.created",
          agentId,
          "handoff",
          id,
          null,
          JSON.stringify({
            task_id: taskId,
            outcome,
            next_action: nextAction,
            evidence_count: evidence.length,
          }),
          nowIso,
        );
      })
      .immediate();

    // 4. Save Markdown narrative file and index in context_items & FTS
    const contextItem: ContextItem = contextItemSchema.parse({
      id,
      type: "handoff",
      scope: "task",
      workspaceId: this.workspaceId,
      title,
      content: narrativeBody,
      source: "agent",
      actor: agentId,
      status: "approved",
      importance: "normal",
      visibility: [],
      tags,
      version: 1,
      createdAt: nowIso,
      updatedAt: nowIso,
      expiresAt: null,
      supersedes: [],
      taskId,
      outcome,
      nextAction,
      blockers,
    });

    const documentPath = this.persistItem(contextItem);

    if (actor) {
      this.touchAgent(actor.actor);
    } else {
      this.touchAgent(agentId);
    }

    return {
      id,
      taskId,
      agentId,
      leaseVersion,
      outcome,
      summary,
      blockers,
      nextAction,
      evidence,
      title,
      tags,
      documentPath,
      createdAt: nowIso,
      updatedAt: nowIso,
    };
  }

  /**
   * Retrieve a handoff by ID. Merges the SQLite operational record with
   * the Markdown narrative file.
   */
  getHandoff(id: string): Handoff | null {
    const row = this.db
      .prepare(
        `SELECT id, task_id, agent_id, lease_version, outcome, evidence_json, created_at, updated_at
         FROM handoffs WHERE id = ?`,
      )
      .get(id) as
      | {
          id: string;
          task_id: string;
          agent_id: string;
          lease_version: number | null;
          outcome: HandoffOutcome;
          evidence_json: string;
          created_at: string;
          updated_at: string;
        }
      | undefined;

    if (!row) {
      return null;
    }

    let evidence: EvidenceItem[] = [];
    try {
      evidence = JSON.parse(row.evidence_json);
    } catch {
      evidence = [];
    }

    // Markdown narrative owns what happened, blockers and next action
    const item = this.getItem(id);
    let summary = "";
    let blockers: string[] = [];
    let nextAction = "";
    let title = `Handoff for ${row.task_id}`;
    let tags: string[] = [];
    let documentPath: string | undefined;

    if (item) {
      title = item.title;
      tags = item.tags ?? [];
      const parsedNarrative = parseHandoffNarrativeSections(item.content);
      summary = parsedNarrative.summary;
      blockers = parsedNarrative.blockers;
      nextAction = parsedNarrative.nextAction;

      const rawRecord = item as unknown as Record<string, unknown>;
      if (!nextAction && typeof rawRecord.nextAction === "string") {
        nextAction = rawRecord.nextAction;
      }
      if (blockers.length === 0 && Array.isArray(rawRecord.blockers)) {
        blockers = rawRecord.blockers as string[];
      }
      const itemRow = this.db
        .prepare("SELECT document_path FROM context_items WHERE id = ?")
        .get(id) as { document_path: string | null } | undefined;
      documentPath = itemRow?.document_path ?? undefined;
    }

    return {
      id: row.id,
      taskId: row.task_id,
      agentId: row.agent_id,
      leaseVersion: row.lease_version,
      outcome: row.outcome,
      summary,
      blockers,
      nextAction,
      evidence,
      title,
      tags,
      documentPath,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /**
   * List handoffs with optional filters.
   */
  listHandoffs(filter?: {
    taskId?: string;
    agentId?: string;
    outcome?: HandoffOutcome;
  }): Handoff[] {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filter?.taskId) {
      conditions.push("task_id = ?");
      params.push(filter.taskId);
    }
    if (filter?.agentId) {
      conditions.push("agent_id = ?");
      params.push(filter.agentId);
    }
    if (filter?.outcome) {
      conditions.push("outcome = ?");
      params.push(filter.outcome);
    }

    const whereClause =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const rows = this.db
      .prepare(
        `SELECT id FROM handoffs ${whereClause} ORDER BY created_at DESC`,
      )
      .all(...params) as Array<{ id: string }>;

    const list: Handoff[] = [];
    for (const r of rows) {
      const h = this.getHandoff(r.id);
      if (h) list.push(h);
    }
    return list;
  }

  /**
   * Resume work from a handoff: reads the handoff, claims the task,
   * records the resumption in the audit trail, and returns the context.
   */
  resumeHandoff(
    input: ResumeHandoffInput,
    actor?: ActorContext,
  ): ResumeHandoffResult {
    const validated = resumeHandoffSchema.parse(input);
    const { handoffId, agentId, ttlSeconds, scope } = validated;

    const handoff = this.getHandoff(handoffId);
    if (!handoff) {
      throw new HandoffNotFoundError(handoffId);
    }

    const task = this.getTask(handoff.taskId);
    if (!task) {
      throw new Error(
        `Cannot resume handoff '${handoffId}': task '${handoff.taskId}' not found.`,
      );
    }

    const agent = this.getAgent(agentId);
    if (!agent) {
      throw new Error(
        `Cannot resume handoff: agent '${agentId}' not registered.`,
      );
    }

    // Claim the lease on the handoff's task for the resuming agent
    const lease = this.claimLease({
      taskId: handoff.taskId,
      agentId,
      ttlSeconds,
      scope: scope.length > 0 ? scope : task.scope,
    });

    const nowIso = new Date().toISOString();
    const auditSql = `
      INSERT INTO audit_events (
        event_type, actor, entity_type, entity_id, previous_version, payload_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `;
    this.db.prepare(auditSql).run(
      "handoff.resumed",
      agentId,
      "handoff",
      handoffId,
      null,
      JSON.stringify({
        task_id: handoff.taskId,
        resuming_agent: agentId,
        handed_off_by: handoff.agentId,
        next_action: handoff.nextAction,
      }),
      nowIso,
    );

    if (actor) {
      this.touchAgent(actor.actor);
    } else {
      this.touchAgent(agentId);
    }

    const updatedTask = this.getTask(handoff.taskId)!;

    return {
      handoff,
      task: updatedTask,
      lease,
      nextAction: handoff.nextAction,
    };
  }

  reconcile(options?: ReconcileOptions): ReconciliationResult {
    return reconcileWorkspace(this.workspaceRoot, this.db, options);
  }

  reindex(options?: ReindexOptions): ReindexResult {
    return reindexWorkspace(this.workspaceRoot, this.db, options);
  }

  exportWorkspace(options?: ExportOptions): ExportResult {
    return coreExportWorkspace(this.workspaceRoot, this.db, options);
  }

  importWorkspace(
    source: string | WorkspaceExportData,
    options?: ImportOptions,
  ): ImportResult {
    return coreImportWorkspace(this.workspaceRoot, this.db, source, options);
  }

  backupWorkspace(options?: BackupOptions): BackupResult {
    return coreBackupWorkspace(this.workspaceRoot, this.db, options);
  }

  restoreWorkspace(
    backupSource: string,
    options?: RestoreOptions,
  ): RestoreResult {
    return coreRestoreWorkspace(this.workspaceRoot, backupSource, options);
  }

  static export(workspaceRoot: string, options?: ExportOptions): ExportResult {
    const service = new ContextService(workspaceRoot);
    try {
      return service.exportWorkspace(options);
    } finally {
      service.close();
    }
  }

  static import(
    workspaceRoot: string,
    source: string | WorkspaceExportData,
    options?: ImportOptions,
  ): ImportResult {
    const service = new ContextService(workspaceRoot);
    try {
      return service.importWorkspace(source, options);
    } finally {
      service.close();
    }
  }

  static backup(workspaceRoot: string, options?: BackupOptions): BackupResult {
    return coreBackupWorkspace(workspaceRoot, undefined, options);
  }

  static restore(
    workspaceRoot: string,
    backupSource: string,
    options?: RestoreOptions,
  ): RestoreResult {
    return coreRestoreWorkspace(workspaceRoot, backupSource, options);
  }

  static recover(workspaceRoot: string): RecoveryResult {
    return recoverDatabase(workspaceRoot);
  }
}
