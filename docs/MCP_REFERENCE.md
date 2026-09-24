# MCP tool reference

Complete reference for the Model Context Protocol (MCP) tools provided by ContextPact.

## Overview

ContextPact exposes its core coordination and context engine over stdio using JSON-RPC 2.0 conforming to the Model Context Protocol specification.

The MCP server operates over standard I/O and provides profile-based tool exposure:

- **Default agent profile**: 14 composable tools covering workspace inspection, context proposals, retrieval, search, task claims/coordination, and structured handoffs. Approval tools are strictly excluded to prevent agent self-approval.
- **Elevated / human reviewer profile**: 15 tools, including `context_approve` for gated knowledge lifecycle transitions.

## Tools

### context_status

Inspect whether a local ContextPact workspace is initialized and check storage health.

**Profile:** default, elevated, human

**Parameters:**

- `workspace` (string, optional): Target workspace directory (default: server workspace root).

**Output:**
Returns workspace initialization status, manifest metadata (id, name, schema version), directory paths, and database existence.

---

### context_propose

Propose a durable context item or record operational state for the local workspace.

**Profile:** default, elevated, human

**Parameters:**

- `workspace` (string, optional): Target workspace directory.
- `id` (string, optional): Custom ID for the context item (generated if omitted).
- `type` (string, required): Context type (`rule`, `preference`, `fact`, `goal`, `source`, `decision`, `task_note`, `handoff`).
- `title` (string, required): Title of the context item (minimum 1 character).
- `content` (string, optional): Markdown content body (default: empty string).
- `scope` (string, optional): Context scope (`global`, `workspace`, `task`, `session`).
- `importance` (string, optional): Priority tier (`low`, `normal`, `high`, `critical`).
- `tags` (array of strings, optional): Categorical tags for search and filtering.
- `supersedes` (array of strings, optional): IDs of prior context items superseded by this proposal.

**Behavior:**
Agent-authored durable items (`rule`, `preference`, `fact`, `goal`, `source`, `decision`) are saved in the `proposed` state pending human or elevated review. Operational types (`task_note`, `handoff`) write immediately with full provenance.

---

### context_approve

Approve a proposed context item through the approval gate.

**Profile:** elevated, human only (hidden from default agent profiles)

**Parameters:**

- `workspace` (string, optional): Target workspace directory.
- `id` (string, required): Unique ID of the proposed context item to approve.

**Behavior:**
Transitions item status from `proposed` to `approved` and increments item version. If the item supersedes older items, those items are transitioned to `superseded` and excluded from default context packs.

---

### context_get

Retrieve a context item by its ID across all lifecycle states.

**Profile:** default, elevated, human

**Parameters:**

- `workspace` (string, optional): Target workspace directory.
- `id` (string, required): Unique context item ID.

**Behavior:**
Returns full metadata, frontmatter attributes, lifecycle status (`draft`, `proposed`, `approved`, `superseded`, `archived`), and markdown content.

---

### context_search

Search workspace knowledge using SQLite FTS5 full-text search with BM25 ranking.

**Profile:** default, elevated, human

**Parameters:**

- `workspace` (string, optional): Target workspace directory.
- `query` (string, required): Search query string. Quoted phrases are preserved; unquoted terms are tokenized and joined with OR.
- `scope` (string, optional): Scope filter (`global`, `workspace`, `task`, `session`).
- `allowGlobal` (boolean, optional): Include global items when filtering by workspace scope.
- `limit` (number, optional): Maximum results to return (integer, 1-100, default: 10).

**Behavior:**
Returns matching items ranked by BM25 relevance score over title, content, and tags.

---

### context_pack

Retrieve the deterministic token-budgeted context pack of approved knowledge.

**Profile:** default, elevated, human

**Parameters:**

- `workspace` (string, optional): Target workspace directory.
- `query` (string, optional): Search query to bias ranking toward relevant knowledge.
- `scope` (string, optional): Target scope filter.
- `taskId` (string, optional): Active task ID to include task-scoped knowledge.
- `sessionId` (string, optional): Active session ID to include session-scoped knowledge.
- `maxTokens` (number, optional): Maximum token budget (integer, 1-32000, default: 4000).
- `allowGlobal` (boolean, optional): Allow global items in the candidate set.

**Behavior:**
Executes deterministic pipeline: candidate filtering → status filtering (approved only, excluding superseded/archived) → ranking (scope → relevance → importance → recency → id) → token budgeting. Omissions and reasons (`budget_exceeded`, `policy_restricted`) are reported explicitly in the pack manifest. Content is framed with `context-data` fences and the untrusted data notice.

---

### context_archive

Archive a context item when no longer relevant.

**Profile:** default, elevated, human

**Parameters:**

- `workspace` (string, optional): Target workspace directory.
- `id` (string, required): Unique ID of the context item to archive.

**Behavior:**
Transitions item status to `archived` and increments version. Archived items are preserved for history and audit, but excluded from context packs.

---

### decision_propose

Propose an architectural or product decision for durable knowledge in the workspace.

**Profile:** default, elevated, human

**Parameters:**

- `workspace` (string, optional): Target workspace directory.
- `id` (string, optional): Custom decision item ID.
- `title` (string, required): Title of the architectural or product decision.
- `content` (string, optional): Markdown decision record including context, options considered, and chosen direction.
- `scope` (string, optional): Scope filter (`global`, `workspace`, `task`, `session`).
- `importance` (string, optional): Priority tier (`low`, `normal`, `high`, `critical`).
- `tags` (array of strings, optional): Decision category tags.
- `supersedes` (array of strings, optional): IDs of previous decisions superseded by this one.

**Behavior:**
Creates a decision item in `proposed` state. When approved, any superseded decisions are marked `superseded` and excluded from default context packs.

---

### task_create

Create a coordination task in the workspace.

**Profile:** default, elevated, human

**Parameters:**

- `workspace` (string, optional): Target workspace directory.
- `id` (string, optional): Custom task ID.
- `title` (string, required): Task title.
- `description` (string, optional): Detailed task description.
- `status` (string, optional): Initial status (`planned`, `active`, `review`, `done`, `blocked`, default: `planned`).
- `scope` (array of strings, optional): File/directory scope paths to prevent conflicting concurrent claims.

**Behavior:**
Records a new coordination task in SQLite operational state with initial version 1.

---

### task_claim

Claim, renew, or takeover a task lease for an agent process.

**Profile:** default, elevated, human

**Parameters:**

- `workspace` (string, optional): Target workspace directory.
- `taskId` (string, required): Unique ID of the task to claim.
- `agentId` (string, optional): Claiming agent identifier (default: caller actor ID).
- `ttlSeconds` (number, optional): Lease duration in seconds (integer, 10-3600, default: 300).
- `scope` (array of strings, optional): Declared working scopes for collision checks.
- `takeoverReason` (string, optional): Justification message required when taking over an expired lease.

**Behavior:**
Atomically evaluates active lease. If unleased or expired, grants lease to `agentId` with heartbeat and expiry timestamps. If active and claimed by another agent, rejects claim with a conflict error unless expired and `takeoverReason` is provided. Conflicting scope claims with active tasks are rejected.

---

### task_release

Release an active task lease and transition task status.

**Profile:** default, elevated, human

**Parameters:**

- `workspace` (string, optional): Target workspace directory.
- `taskId` (string, required): Unique ID of the task.
- `agentId` (string, optional): Releasing agent identifier.
- `status` (string, optional): Terminal status (`planned`, `active`, `review`, `done`, `blocked`, default: `review`).

**Behavior:**
Atomically deletes task lease and updates task status and updated timestamp.

---

### task_get

Retrieve a task by ID, including its current status, scope, and active lease.

**Profile:** default, elevated, human

**Parameters:**

- `workspace` (string, optional): Target workspace directory.
- `id` (string, required): Unique task ID.

**Behavior:**
Returns task metadata, description, status, declared scopes, and current lease details (holder agent, heartbeat, expiresAt).

---

### handoff_create

Record an evidence-bearing structured handoff across a context boundary.

**Profile:** default, elevated, human

**Parameters:**

- `workspace` (string, optional): Target workspace directory.
- `id` (string, optional): Custom handoff ID.
- `taskId` (string, required): Task ID associated with this handoff.
- `agentId` (string, optional): Authoring agent identifier.
- `title` (string, optional): Handoff title.
- `outcome` (string, required): Handoff outcome (`success`, `blocked`, `in_progress`).
- `summary` (string, required): Narrative summary of work accomplished.
- `blockers` (array of strings, optional): Blocking issues preventing completion.
- `nextAction` (object, required): Explicit next step for the resuming agent (must contain `action` string, optional `context` string).
- `evidence` (array of objects, optional): Verified evidence items (`type`, `description`, `path`, `hash`, `timestamp`, `verified`). Success outcomes require at least one verified evidence item.
- `releaseLease` (boolean, optional): Release active task lease upon creating handoff (default: true).
- `tags` (array of strings, optional): Handoff tags.

**Behavior:**
Writes structured operational record to SQLite `handoffs` table and human-readable Markdown narrative to `.contextpact/handoffs/<id>.md`. Enforces evidence verification for success claims.

---

### handoff_get

Retrieve an operational and narrative handoff by ID.

**Profile:** default, elevated, human

**Parameters:**

- `workspace` (string, optional): Target workspace directory.
- `id` (string, required): Unique handoff ID.

**Behavior:**
Returns handoff narrative, outcome, verified evidence records, and recommended next action.

---

### handoff_resume

Resume work from a handoff: claims the task lease and acquires task and handoff context.

**Profile:** default, elevated, human

**Parameters:**

- `workspace` (string, optional): Target workspace directory.
- `handoffId` (string, required): Handoff ID to resume from.
- `agentId` (string, optional): Resuming agent identifier.
- `ttlSeconds` (number, optional): Lease duration in seconds (integer, 10-3600, default: 300).

**Behavior:**
Finds handoff, validates linked task, claims task lease for `agentId`, and returns combined handoff narrative, task details, and next action.
