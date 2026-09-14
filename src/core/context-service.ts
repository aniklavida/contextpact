import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";

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
import { readWorkspaceStatus, workspacePaths } from "../workspace/layout.js";
import { buildContextPack, type ContextPack } from "./pack-builder.js";

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
  status?: ContextStatus | undefined;
  type?: ContextType | undefined;
  scope?: ContextScope | undefined;
  includeSuperseded?: boolean | undefined;
  includeArchived?: boolean | undefined;
  includeProposed?: boolean | undefined;
  includeDraft?: boolean | undefined;
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
    const row = this.db
      .prepare("SELECT id, type, document_path FROM context_items WHERE id = ?")
      .get(id) as
      | { id: string; type: ContextType; document_path: string | null }
      | undefined;

    if (row && row.document_path && existsSync(row.document_path)) {
      return readMarkdownKnowledgeItem(row.document_path);
    }

    const fullRow = this.db
      .prepare(
        `SELECT id, type, scope, title, content, source, actor, status,
                importance, visibility_json, tags_json, version,
                created_at, updated_at, expires_at
         FROM context_items WHERE id = ?`,
      )
      .get(id) as
      | {
          id: string;
          type: ContextType;
          scope: ContextScope;
          title: string;
          content: string;
          source: string;
          actor: string;
          status: ContextStatus;
          importance: Importance;
          visibility_json: string;
          tags_json: string;
          version: number;
          created_at: string;
          updated_at: string;
          expires_at: string | null;
        }
      | undefined;

    if (fullRow) {
      const supersedesRows = this.db
        .prepare(
          "SELECT superseded_id FROM context_supersedes WHERE context_id = ?",
        )
        .all(id) as Array<{ superseded_id: string }>;

      return contextItemSchema.parse({
        id: fullRow.id,
        type: fullRow.type,
        scope: fullRow.scope,
        workspaceId: this.workspaceId,
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

  buildDefaultPack(scope?: ContextScope | undefined): ContextPack {
    const items = this.queryItems({
      status: "approved",
      scope: scope ?? undefined,
    });
    return buildContextPack(items, {
      workspaceId: this.workspaceId,
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

    const upsertSql = `
      INSERT INTO context_items (
        id, type, scope, title, content, source, actor, status,
        importance, visibility_json, tags_json, document_path, document_hash,
        version, created_at, updated_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        type = excluded.type,
        scope = excluded.scope,
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
        item.title,
        item.content,
        item.source,
        item.actor,
        item.status,
        item.importance,
        JSON.stringify(item.visibility ?? []),
        JSON.stringify(item.tags ?? []),
        documentPath,
        null,
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
}
