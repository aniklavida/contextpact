import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

import type Database from "better-sqlite3";

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
import { openDatabase } from "../storage/database.js";
import {
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

  create(input: CreateContextInput, actor: ActorContext): ContextItem {
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
      if (actor.source === "agent") {
        if (input.status === "approved") {
          assertCanCreate(actor, { id, type, status: "approved" });
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
      source: input.source ?? actor.source,
      actor: input.actor ?? actor.actor,
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
      actor: actor.actor,
      entity_type: "context_item",
      entity_id: item.id,
      previous_version: null,
      payload: {
        source: actor.source,
        profile:
          actor.profile ?? (isActorElevated(actor) ? "elevated" : "default"),
        status: item.status,
        type: item.type,
        title: item.title,
        supersedes: item.supersedes,
      },
      created_at: item.createdAt,
    });

    if (item.status === "approved" && item.supersedes.length > 0) {
      for (const supersededId of item.supersedes) {
        this.executeSupersession(supersededId, item.id, actor);
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

  approve(id: string, actor: ActorContext): ContextItem {
    const existing = this.getItem(id);
    if (!existing) {
      throw new Error(`Context item '${id}' not found.`);
    }

    if (existing.status === "approved") {
      return existing;
    }

    validateTransition(existing.status, "approved", id);
    assertCanApprove(actor, existing);

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
      actor: actor.actor,
      entity_type: "context_item",
      entity_id: id,
      previous_version: prevVersion,
      payload: {
        source: actor.source,
        profile:
          actor.profile ?? (isActorElevated(actor) ? "elevated" : "default"),
        from_status: existing.status,
        to_status: "approved",
      },
      created_at: now,
    });

    if (updated.supersedes && updated.supersedes.length > 0) {
      for (const supersededId of updated.supersedes) {
        this.executeSupersession(supersededId, updated.id, actor);
      }
    }

    return updated;
  }

  supersede(
    params: { supersededId: string; replacingId: string },
    actor: ActorContext,
  ): { superseded: ContextItem; replacing: ContextItem } {
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
      actor,
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
    const existing = this.getItem(id);
    if (!existing) {
      throw new Error(`Context item '${id}' not found.`);
    }

    if (existing.status === "archived") {
      return existing;
    }

    validateTransition(existing.status, "archived", id);
    assertCanArchive(actor, existing);

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
      actor: actor.actor,
      entity_type: "context_item",
      entity_id: id,
      previous_version: prevVersion,
      payload: {
        source: actor.source,
        profile:
          actor.profile ?? (isActorElevated(actor) ? "elevated" : "default"),
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
    const existing = this.getItem(id);
    if (!existing) {
      throw new Error(`Context item '${id}' not found.`);
    }

    if (existing.status === toStatus) {
      return existing;
    }

    validateTransition(existing.status, toStatus, id);

    if (toStatus === "approved") {
      return this.approve(id, actor);
    }
    if (toStatus === "archived") {
      return this.archive(id, actor);
    }
    if (toStatus === "superseded") {
      if (!options?.replacingId) {
        throw new Error(
          `Superseding context item '${id}' requires a replacingId.`,
        );
      }
      return this.supersede(
        { supersededId: id, replacingId: options.replacingId },
        actor,
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
      actor: actor.actor,
      entity_type: "context_item",
      entity_id: id,
      previous_version: prevVersion,
      payload: {
        source: actor.source,
        profile:
          actor.profile ?? (isActorElevated(actor) ? "elevated" : "default"),
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
      payload: JSON.parse(r.payload_json),
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
      actor: actor.actor,
      entity_type: "context_item",
      entity_id: supersededId,
      previous_version: prevVersion,
      payload: {
        source: actor.source,
        profile:
          actor.profile ?? (isActorElevated(actor) ? "elevated" : "default"),
        from_status: superseded.status,
        to_status: "superseded",
        superseded_by: replacingId,
      },
      created_at: now,
    });

    return updatedSuperseded;
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
  }

  reconcile(options?: ReconcileOptions): ReconciliationResult {
    return reconcileWorkspace(this.workspaceRoot, this.db, options);
  }

  reindex(options?: ReindexOptions): ReindexResult {
    return reindexWorkspace(this.workspaceRoot, this.db, options);
  }

  static recover(workspaceRoot: string): RecoveryResult {
    return recoverDatabase(workspaceRoot);
  }
}
