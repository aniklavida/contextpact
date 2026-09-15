import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";

import Database from "better-sqlite3";
import YAML from "yaml";

import type {
  AgentRecord,
  SessionRecord,
  TaskRecord,
} from "../domain/agent.js";
import type { ContextItem } from "../domain/context.js";
import {
  type BackupOptions,
  type BackupResult,
  type CollisionPolicy,
  type ExportOptions,
  type ExportResult,
  type ImportCollision,
  ImportCollisionError,
  type ImportOptions,
  type ImportResult,
  type RestoreOptions,
  type RestoreResult,
  type StoredAuditEvent,
  type WorkspaceExportData,
  workspaceExportSchema,
} from "../domain/maintenance.js";
import type { PolicyRecord } from "../domain/policy.js";
import type { LeaseRecord } from "../domain/task.js";
import {
  isDatabaseHealthy,
  openDatabase,
  rebuildFtsIndex,
} from "../storage/database.js";
import { saveKnowledgeItem } from "../storage/markdown.js";
import { computeDocumentHash } from "../storage/reconciliation.js";
import { readWorkspaceStatus, workspacePaths } from "../workspace/layout.js";

export function exportWorkspace(
  workspaceRoot: string,
  db: Database.Database,
  options?: ExportOptions,
): ExportResult {
  const root = resolve(workspaceRoot);
  const paths = workspacePaths(root);
  const status = readWorkspaceStatus(root);

  if (!status.initialized || !status.manifest) {
    throw new Error(
      `Cannot export uninitialized workspace at '${root}'. Workspace must be initialized first.`,
    );
  }

  const itemRows = db
    .prepare(
      `SELECT
        id, type, scope, workspace_id, title, content, source, actor, status,
        importance, visibility_json, tags_json, document_path, document_hash,
        version, created_at, updated_at, expires_at
      FROM context_items
      ORDER BY created_at ASC`,
    )
    .all() as Array<{
    id: string;
    type: string;
    scope: string;
    workspace_id: string;
    title: string;
    content: string;
    source: string;
    actor: string;
    status: string;
    importance: string;
    visibility_json: string;
    tags_json: string;
    document_path: string | null;
    document_hash: string | null;
    version: number;
    created_at: string;
    updated_at: string;
    expires_at: string | null;
  }>;

  const supersedesRows = db
    .prepare("SELECT context_id, superseded_id FROM context_supersedes")
    .all() as Array<{ context_id: string; superseded_id: string }>;

  const supersedesMap = new Map<string, string[]>();
  for (const s of supersedesRows) {
    const list = supersedesMap.get(s.context_id) ?? [];
    list.push(s.superseded_id);
    supersedesMap.set(s.context_id, list);
  }

  const contextItems: ContextItem[] = itemRows.map((r) => {
    let visibility: string[] = [];
    try {
      visibility = JSON.parse(r.visibility_json);
    } catch {
      // fallback
    }
    let tags: string[] = [];
    try {
      tags = JSON.parse(r.tags_json);
    } catch {
      // fallback
    }

    return {
      id: r.id,
      type: r.type as ContextItem["type"],
      scope: r.scope as ContextItem["scope"],
      workspaceId: r.workspace_id,
      title: r.title,
      content: r.content,
      source: r.source,
      actor: r.actor,
      status: r.status as ContextItem["status"],
      importance: r.importance as ContextItem["importance"],
      visibility,
      tags,
      supersedes: supersedesMap.get(r.id) ?? [],
      version: r.version,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      expiresAt: r.expires_at ?? null,
    };
  });

  const taskRows = db
    .prepare(
      "SELECT id, title, description, status, scope_json, version, created_at, updated_at FROM tasks ORDER BY created_at ASC",
    )
    .all() as Array<{
    id: string;
    title: string;
    description: string;
    status: string;
    scope_json: string;
    version: number;
    created_at: string;
    updated_at: string;
  }>;

  const tasks: TaskRecord[] = taskRows.map((t) => {
    let scope: string[] = [];
    try {
      scope = JSON.parse(t.scope_json);
    } catch {
      // fallback
    }
    return {
      id: t.id,
      title: t.title,
      description: t.description,
      status: t.status as TaskRecord["status"],
      scope,
      version: t.version,
      createdAt: t.created_at,
      updatedAt: t.updated_at,
    };
  });

  const leaseRows = db
    .prepare(
      "SELECT task_id, agent_id, acquired_at, heartbeat_at, expires_at, version FROM task_leases ORDER BY acquired_at ASC",
    )
    .all() as Array<{
    task_id: string;
    agent_id: string;
    acquired_at: string;
    heartbeat_at: string;
    expires_at: string;
    version: number;
  }>;

  const taskLeases: LeaseRecord[] = leaseRows.map((l) => ({
    taskId: l.task_id,
    agentId: l.agent_id,
    acquiredAt: l.acquired_at,
    heartbeatAt: l.heartbeat_at,
    expiresAt: l.expires_at,
    version: l.version,
  }));

  const agentRows = db
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

  const agents: AgentRecord[] = agentRows.map((a) => ({
    id: a.id,
    displayName: a.display_name,
    clientKind: a.client_kind,
    profile: a.profile,
    lastSeenAt: a.last_seen_at,
    createdAt: a.created_at,
  }));

  const sessionRows = db
    .prepare(
      "SELECT id, agent_id, task_id, status, started_at, ended_at FROM sessions ORDER BY started_at ASC",
    )
    .all() as Array<{
    id: string;
    agent_id: string;
    task_id: string | null;
    status: string;
    started_at: string;
    ended_at: string | null;
  }>;

  const sessions: SessionRecord[] = sessionRows.map((s) => ({
    id: s.id,
    agentId: s.agent_id,
    taskId: s.task_id,
    status: s.status as SessionRecord["status"],
    startedAt: s.started_at,
    endedAt: s.ended_at,
  }));

  const policyRows = db
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

  const policies: PolicyRecord[] = policyRows.map((p) => {
    let rules: Record<string, unknown> = {};
    try {
      rules = JSON.parse(p.policy_json);
    } catch {
      // fallback
    }
    return {
      id: p.id,
      name: p.name,
      description: p.description,
      rules,
      policyJson: p.policy_json,
      createdAt: p.created_at,
      updatedAt: p.updated_at,
    };
  });

  const auditRows = db
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

  const auditEvents: StoredAuditEvent[] = auditRows.map((a) => {
    let payload: Record<string, unknown> = {};
    try {
      payload = JSON.parse(a.payload_json);
    } catch {
      // fallback
    }
    return {
      id: a.id,
      event_type: a.event_type,
      actor: a.actor,
      entity_type: a.entity_type,
      entity_id: a.entity_id,
      previous_version: a.previous_version,
      payload,
      created_at: a.created_at,
    };
  });

  const exportData: WorkspaceExportData = {
    formatVersion: 1,
    exportedAt: new Date().toISOString(),
    workspace: {
      id: status.manifest.id,
      name: status.manifest.name,
      createdAt: status.manifest.createdAt,
    },
    contextItems,
    operational: {
      tasks,
      taskLeases,
      agents,
      sessions,
      policies,
      auditEvents,
    },
  };

  workspaceExportSchema.parse(exportData);

  const timestamp = exportData.exportedAt.replace(/[:.]/g, "-");
  const defaultExportPath = join(paths.exports, `export-${timestamp}.json`);
  const exportPath = options?.outputPath
    ? resolve(options.outputPath)
    : defaultExportPath;

  mkdirSync(paths.exports, { recursive: true });
  writeFileSync(exportPath, JSON.stringify(exportData, null, 2), "utf8");

  return {
    exportPath,
    exportedAt: exportData.exportedAt,
    contextItemCount: contextItems.length,
    taskCount: tasks.length,
    auditEventCount: auditEvents.length,
    data: exportData,
  };
}

export function importWorkspace(
  workspaceRoot: string,
  db: Database.Database,
  source: string | WorkspaceExportData,
  options?: ImportOptions,
): ImportResult {
  const root = resolve(workspaceRoot);
  const paths = workspacePaths(root);
  const collisionPolicy: CollisionPolicy = options?.onCollision ?? "skip";

  let exportData: WorkspaceExportData;
  if (typeof source === "string") {
    const raw = readFileSync(resolve(source), "utf8");
    exportData = workspaceExportSchema.parse(JSON.parse(raw));
  } else {
    exportData = workspaceExportSchema.parse(source);
  }

  const collisions: ImportCollision[] = [];

  const existingItems = new Set(
    (
      db.prepare("SELECT id FROM context_items").all() as Array<{ id: string }>
    ).map((r) => r.id),
  );
  const existingTasks = new Set(
    (db.prepare("SELECT id FROM tasks").all() as Array<{ id: string }>).map(
      (r) => r.id,
    ),
  );
  const existingAgents = new Set(
    (db.prepare("SELECT id FROM agents").all() as Array<{ id: string }>).map(
      (r) => r.id,
    ),
  );
  const existingPolicies = new Set(
    (db.prepare("SELECT id FROM policies").all() as Array<{ id: string }>).map(
      (r) => r.id,
    ),
  );

  for (const item of exportData.contextItems) {
    if (existingItems.has(item.id)) {
      collisions.push({
        entityType: "context_item",
        id: item.id,
        action: collisionPolicy === "replace" ? "replaced" : "skipped",
        message:
          collisionPolicy === "replace"
            ? `Context item '${item.id}' already exists and was replaced per replace collision policy.`
            : `Context item '${item.id}' already exists; skipped to preserve canonical local state.`,
      });
    }
  }

  for (const task of exportData.operational.tasks) {
    if (existingTasks.has(task.id)) {
      collisions.push({
        entityType: "task",
        id: task.id,
        action: collisionPolicy === "replace" ? "replaced" : "skipped",
        message:
          collisionPolicy === "replace"
            ? `Task '${task.id}' already exists and was replaced per replace collision policy.`
            : `Task '${task.id}' already exists; skipped to preserve canonical local state.`,
      });
    }
  }

  for (const agent of exportData.operational.agents) {
    if (existingAgents.has(agent.id)) {
      collisions.push({
        entityType: "agent",
        id: agent.id,
        action: collisionPolicy === "replace" ? "replaced" : "skipped",
        message:
          collisionPolicy === "replace"
            ? `Agent '${agent.id}' already exists and was replaced per replace collision policy.`
            : `Agent '${agent.id}' already exists; skipped to preserve canonical local state.`,
      });
    }
  }

  for (const policy of exportData.operational.policies) {
    if (existingPolicies.has(policy.id)) {
      collisions.push({
        entityType: "policy",
        id: policy.id,
        action: collisionPolicy === "replace" ? "replaced" : "skipped",
        message:
          collisionPolicy === "replace"
            ? `Policy '${policy.id}' already exists and was replaced per replace collision policy.`
            : `Policy '${policy.id}' already exists; skipped to preserve canonical local state.`,
      });
    }
  }

  if (collisionPolicy === "error" && collisions.length > 0) {
    throw new ImportCollisionError(collisions);
  }

  let importedContextItems = 0;
  let importedTasks = 0;
  let importedLeases = 0;
  let importedAgents = 0;
  let importedSessions = 0;
  let importedPolicies = 0;
  let importedAuditEvents = 0;

  const insertItemStmt = db.prepare(`
    INSERT OR REPLACE INTO context_items (
      id, type, scope, workspace_id, title, content, source, actor, status,
      importance, visibility_json, tags_json, document_path, document_hash,
      version, created_at, updated_at, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const deleteFtsStmt = db.prepare(
    "DELETE FROM context_fts WHERE context_id = ?",
  );
  const insertFtsStmt = db.prepare(
    "INSERT INTO context_fts (context_id, title, content, tags) VALUES (?, ?, ?, ?)",
  );

  const deleteSupersedesStmt = db.prepare(
    "DELETE FROM context_supersedes WHERE context_id = ?",
  );
  const insertSupersedesStmt = db.prepare(
    "INSERT OR IGNORE INTO context_supersedes (context_id, superseded_id) VALUES (?, ?)",
  );

  const insertTaskStmt = db.prepare(`
    INSERT OR REPLACE INTO tasks (
      id, title, description, status, scope_json, version, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertLeaseStmt = db.prepare(`
    INSERT OR REPLACE INTO task_leases (
      task_id, agent_id, acquired_at, heartbeat_at, expires_at, version
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);

  const insertAgentStmt = db.prepare(`
    INSERT OR REPLACE INTO agents (
      id, display_name, client_kind, profile, last_seen_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);

  const insertSessionStmt = db.prepare(`
    INSERT OR REPLACE INTO sessions (
      id, agent_id, task_id, status, started_at, ended_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);

  const insertPolicyStmt = db.prepare(`
    INSERT OR REPLACE INTO policies (
      id, name, description, policy_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);

  const insertAuditStmt = db.prepare(`
    INSERT OR REPLACE INTO audit_events (
      id, event_type, actor, entity_type, entity_id, previous_version, payload_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const importTx = db.transaction(() => {
    for (const agent of exportData.operational.agents) {
      if (existingAgents.has(agent.id) && collisionPolicy === "skip") {
        continue;
      }
      insertAgentStmt.run(
        agent.id,
        agent.displayName,
        agent.clientKind,
        agent.profile,
        agent.lastSeenAt,
        agent.createdAt,
      );
      importedAgents++;
    }

    for (const task of exportData.operational.tasks) {
      if (existingTasks.has(task.id) && collisionPolicy === "skip") {
        continue;
      }
      insertTaskStmt.run(
        task.id,
        task.title,
        task.description,
        task.status,
        JSON.stringify(task.scope),
        task.version,
        task.createdAt,
        task.updatedAt,
      );
      importedTasks++;
    }

    for (const lease of exportData.operational.taskLeases) {
      const taskExists = !!db
        .prepare("SELECT id FROM tasks WHERE id = ?")
        .get(lease.taskId);
      const agentExists = !!db
        .prepare("SELECT id FROM agents WHERE id = ?")
        .get(lease.agentId);
      if (taskExists && agentExists) {
        insertLeaseStmt.run(
          lease.taskId,
          lease.agentId,
          lease.acquiredAt,
          lease.heartbeatAt,
          lease.expiresAt,
          lease.version,
        );
        importedLeases++;
      }
    }

    for (const session of exportData.operational.sessions) {
      const agentExists = !!db
        .prepare("SELECT id FROM agents WHERE id = ?")
        .get(session.agentId);
      if (agentExists) {
        insertSessionStmt.run(
          session.id,
          session.agentId,
          session.taskId,
          session.status,
          session.startedAt,
          session.endedAt,
        );
        importedSessions++;
      }
    }

    for (const policy of exportData.operational.policies) {
      if (existingPolicies.has(policy.id) && collisionPolicy === "skip") {
        continue;
      }
      insertPolicyStmt.run(
        policy.id,
        policy.name,
        policy.description,
        JSON.stringify(policy.rules),
        policy.createdAt,
        policy.updatedAt,
      );
      importedPolicies++;
    }

    for (const item of exportData.contextItems) {
      if (existingItems.has(item.id) && collisionPolicy === "skip") {
        continue;
      }

      let filePath: string;
      if (item.type === "handoff") {
        mkdirSync(paths.handoffs, { recursive: true });
        filePath = join(paths.handoffs, `${item.id}.md`);
        writeFileSync(filePath, item.content, "utf8");
      } else {
        filePath = saveKnowledgeItem(paths.knowledge, item);
      }

      const diskHash = computeDocumentHash(item.content);

      insertItemStmt.run(
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
        filePath,
        diskHash,
        item.version,
        item.createdAt,
        item.updatedAt,
        item.expiresAt ?? null,
      );

      try {
        deleteFtsStmt.run(item.id);
        insertFtsStmt.run(
          item.id,
          item.title,
          item.content,
          (item.tags ?? []).join(" "),
        );
      } catch {
        // ignore virtual table errors
      }

      if (item.supersedes && item.supersedes.length > 0) {
        deleteSupersedesStmt.run(item.id);
        for (const supId of item.supersedes) {
          insertSupersedesStmt.run(item.id, supId);
        }
      }

      importedContextItems++;
    }

    for (const event of exportData.operational.auditEvents) {
      insertAuditStmt.run(
        event.id,
        event.event_type,
        event.actor,
        event.entity_type,
        event.entity_id,
        event.previous_version,
        JSON.stringify(event.payload),
        event.created_at,
      );
      importedAuditEvents++;
    }

    rebuildFtsIndex(db);
  });

  importTx();

  return {
    importedAt: new Date().toISOString(),
    collisionPolicy,
    imported: {
      contextItems: importedContextItems,
      tasks: importedTasks,
      taskLeases: importedLeases,
      agents: importedAgents,
      sessions: importedSessions,
      policies: importedPolicies,
      auditEvents: importedAuditEvents,
    },
    collisions,
  };
}

export function backupWorkspace(
  workspaceRoot: string,
  db?: Database.Database,
  options?: BackupOptions,
): BackupResult {
  const root = resolve(workspaceRoot);
  const paths = workspacePaths(root);
  const status = readWorkspaceStatus(root);

  if (!status.initialized || !status.manifest) {
    throw new Error(
      `Cannot backup uninitialized workspace at '${root}'. Workspace must be initialized first.`,
    );
  }

  if (!existsSync(paths.database) || !isDatabaseHealthy(paths.database)) {
    throw new Error(
      `Cannot backup workspace at '${root}': SQLite database is missing or corrupt.`,
    );
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const defaultBackupPath = join(paths.exports, `backup-${timestamp}`);
  const backupPath = options?.outputPath
    ? resolve(options.outputPath)
    : defaultBackupPath;

  mkdirSync(backupPath, { recursive: true });

  // 1. Copy Markdown vault
  const targetKnowledge = join(backupPath, "knowledge");
  const targetHandoffs = join(backupPath, "handoffs");
  if (existsSync(paths.knowledge)) {
    cpSync(paths.knowledge, targetKnowledge, { recursive: true });
  } else {
    mkdirSync(targetKnowledge, { recursive: true });
  }
  if (existsSync(paths.handoffs)) {
    cpSync(paths.handoffs, targetHandoffs, { recursive: true });
  } else {
    mkdirSync(targetHandoffs, { recursive: true });
  }
  copyFileSync(paths.manifest, join(backupPath, "pact.yaml"));

  // 2. Checkpoint WAL and copy SQLite database
  const ownsDb = !db;
  const activeDb = db ?? openDatabase(paths.database);
  try {
    activeDb.pragma("wal_checkpoint(TRUNCATE)");
  } finally {
    if (ownsDb) {
      activeDb.close();
    }
  }

  const targetDbPath = join(backupPath, "contextpact.db");
  copyFileSync(paths.database, targetDbPath);

  if (!isDatabaseHealthy(targetDbPath)) {
    throw new Error("Backup failed: Snapshot database failed integrity check.");
  }

  // 3. Collect counts from snapshot database
  const checkDb = openDatabase(targetDbPath);
  let itemCount = 0;
  let taskCount = 0;
  let auditEventCount = 0;
  try {
    itemCount = (
      checkDb.prepare("SELECT count(*) as c FROM context_items").get() as {
        c: number;
      }
    ).c;
    taskCount = (
      checkDb.prepare("SELECT count(*) as c FROM tasks").get() as { c: number }
    ).c;
    auditEventCount = (
      checkDb.prepare("SELECT count(*) as c FROM audit_events").get() as {
        c: number;
      }
    ).c;
  } finally {
    checkDb.close();
  }

  // 4. Write backup metadata manifest
  const backupMetadata = {
    formatVersion: 1,
    createdAt: new Date().toISOString(),
    workspace: {
      id: status.manifest.id,
      name: status.manifest.name,
      createdAt: status.manifest.createdAt,
    },
    stores: ["markdown", "sqlite"] as const,
  };
  writeFileSync(
    join(backupPath, "backup.json"),
    JSON.stringify(backupMetadata, null, 2),
    "utf8",
  );

  return {
    backupPath,
    createdAt: backupMetadata.createdAt,
    workspaceId: status.manifest.id,
    workspaceName: status.manifest.name,
    stores: ["markdown", "sqlite"],
    itemCount,
    taskCount,
    auditEventCount,
  };
}

export function restoreWorkspace(
  workspaceRoot: string,
  backupSource: string,
  options?: RestoreOptions,
): RestoreResult {
  const root = resolve(workspaceRoot);
  const paths = workspacePaths(root);
  const sourcePath = resolve(backupSource);

  if (!existsSync(sourcePath)) {
    throw new Error(
      `Cannot restore from backup: source path '${sourcePath}' does not exist.`,
    );
  }

  const sourceDbPath = join(sourcePath, "contextpact.db");
  const sourceManifestPath = join(sourcePath, "pact.yaml");
  const sourceKnowledgePath = join(sourcePath, "knowledge");
  const sourceHandoffsPath = join(sourcePath, "handoffs");

  // Enforce dual-store rule: both stores must be present
  if (!existsSync(sourceDbPath)) {
    throw new Error(
      "Cannot restore from incomplete backup: missing SQLite database 'contextpact.db'. Dual-store backup must cover both stores.",
    );
  }

  if (!existsSync(sourceManifestPath)) {
    throw new Error(
      "Cannot restore from incomplete backup: missing workspace manifest 'pact.yaml'. Dual-store backup must cover both stores.",
    );
  }

  if (!existsSync(sourceKnowledgePath)) {
    throw new Error(
      "Cannot restore from incomplete backup: missing Markdown vault 'knowledge'. Dual-store backup must cover both stores.",
    );
  }

  if (!isDatabaseHealthy(sourceDbPath)) {
    throw new Error(
      "Cannot restore from corrupted backup: SQLite database failed integrity check.",
    );
  }

  if (options?.cleanExisting && existsSync(paths.contextRoot)) {
    rmSync(paths.contextRoot, { recursive: true, force: true });
  }

  mkdirSync(paths.root, { recursive: true });
  mkdirSync(paths.contextRoot, { recursive: true });
  mkdirSync(paths.exports, { recursive: true });

  copyFileSync(sourceManifestPath, paths.manifest);
  cpSync(sourceKnowledgePath, paths.knowledge, { recursive: true });
  if (existsSync(sourceHandoffsPath)) {
    cpSync(sourceHandoffsPath, paths.handoffs, { recursive: true });
  } else {
    mkdirSync(paths.handoffs, { recursive: true });
  }

  if (existsSync(`${paths.database}-wal`)) {
    unlinkSync(`${paths.database}-wal`);
  }
  if (existsSync(`${paths.database}-shm`)) {
    unlinkSync(`${paths.database}-shm`);
  }

  copyFileSync(sourceDbPath, paths.database);

  const restoredDb = openDatabase(paths.database);
  let itemCount = 0;
  let taskCount = 0;
  let auditEventCount = 0;
  let wsId = "restored";
  let wsName = "Restored Workspace";
  try {
    rebuildFtsIndex(restoredDb);
    itemCount = (
      restoredDb.prepare("SELECT count(*) as c FROM context_items").get() as {
        c: number;
      }
    ).c;
    taskCount = (
      restoredDb.prepare("SELECT count(*) as c FROM tasks").get() as {
        c: number;
      }
    ).c;
    auditEventCount = (
      restoredDb.prepare("SELECT count(*) as c FROM audit_events").get() as {
        c: number;
      }
    ).c;
    const wsRow = restoredDb
      .prepare("SELECT id, name FROM workspace LIMIT 1")
      .get() as { id: string; name: string } | undefined;
    if (wsRow) {
      wsId = wsRow.id;
      wsName = wsRow.name;
    }
  } finally {
    restoredDb.close();
  }

  const manifestStatus = readWorkspaceStatus(root);
  if (manifestStatus.manifest) {
    wsId = manifestStatus.manifest.id;
    wsName = manifestStatus.manifest.name;
  }

  return {
    restoredAt: new Date().toISOString(),
    backupPath: sourcePath,
    workspaceId: wsId,
    workspaceName: wsName,
    stores: ["markdown", "sqlite"],
    itemCount,
    taskCount,
    auditEventCount,
  };
}
