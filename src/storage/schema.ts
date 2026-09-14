export const schemaVersion = 4;

export const schemaSql = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS workspace (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  client_kind TEXT NOT NULL,
  profile TEXT NOT NULL,
  last_seen_at TEXT,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  task_id TEXT REFERENCES tasks(id),
  status TEXT NOT NULL CHECK (status IN ('active', 'ended', 'failed')),
  started_at TEXT NOT NULL,
  ended_at TEXT
) STRICT;

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('planned', 'active', 'review', 'done', 'blocked')),
  scope_json TEXT NOT NULL DEFAULT '[]',
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS task_leases (
  task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  acquired_at TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1
) STRICT;

CREATE TABLE IF NOT EXISTS context_items (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  scope TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  source TEXT NOT NULL,
  actor TEXT NOT NULL,
  status TEXT NOT NULL,
  importance TEXT NOT NULL,
  visibility_json TEXT NOT NULL DEFAULT '[]',
  tags_json TEXT NOT NULL DEFAULT '[]',
  document_path TEXT,
  document_hash TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT
) STRICT;

CREATE TABLE IF NOT EXISTS context_supersedes (
  context_id TEXT NOT NULL REFERENCES context_items(id) ON DELETE CASCADE,
  superseded_id TEXT NOT NULL REFERENCES context_items(id),
  PRIMARY KEY (context_id, superseded_id)
) STRICT;

CREATE TABLE IF NOT EXISTS audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,
  actor TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  previous_version INTEGER,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS policies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  policy_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE VIRTUAL TABLE IF NOT EXISTS context_fts USING fts5(
  context_id UNINDEXED,
  title,
  content,
  tags
);

CREATE TRIGGER IF NOT EXISTS trg_context_items_ai AFTER INSERT ON context_items BEGIN
  DELETE FROM context_fts WHERE context_id = new.id;
  INSERT INTO context_fts (context_id, title, content, tags)
  VALUES (new.id, new.title, new.content, new.tags_json);
END;

CREATE TRIGGER IF NOT EXISTS trg_context_items_au AFTER UPDATE ON context_items BEGIN
  DELETE FROM context_fts WHERE context_id = old.id;
  INSERT INTO context_fts (context_id, title, content, tags)
  VALUES (new.id, new.title, new.content, new.tags_json);
END;

CREATE TRIGGER IF NOT EXISTS trg_context_items_ad AFTER DELETE ON context_items BEGIN
  DELETE FROM context_fts WHERE context_id = old.id;
END;

CREATE INDEX IF NOT EXISTS idx_context_workspace_scope_status ON context_items(workspace_id, scope, status);
CREATE INDEX IF NOT EXISTS idx_context_scope_status ON context_items(scope, status);
CREATE INDEX IF NOT EXISTS idx_context_updated ON context_items(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_events(entity_type, entity_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_policies_name ON policies(name);
`;
