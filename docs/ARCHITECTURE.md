# Architecture

## Principles

- Local-first and useful without a network.
- Human-readable durable knowledge.
- Atomic operational coordination.
- One core, multiple transports.
- Deterministic retrieval before optional semantic complexity.

## Components

```text
CLI ─────┐
         ├── Application core ── Context/decision services
MCP ─────┘                    ├── Task/lease/handoff services
                             └── Policy and pack builder
                                      │
                         ┌────────────┴────────────┐
                         │                         │
                  Markdown vault             SQLite database
                  durable content       operations, audit and FTS
```

Adapters translate requests only. Domain rules, storage ownership, policy and context-pack construction remain transport-independent.

## Workspace layout

```text
.contextpact/
├── pact.yaml
├── knowledge/
│   ├── rules/
│   ├── preferences/
│   ├── facts/
│   ├── goals/
│   ├── decisions/
│   └── sources/
├── handoffs/
├── exports/
└── contextpact.db
```

## Consistency

Markdown writes use temporary-file replacement. SQLite uses foreign keys, WAL and transactions. Stable IDs and versions connect the stores. File-derived search rows can be rebuilt; task leases and audit events cannot.

## Retrieval

Identity/workspace resolution → policy → active task/session → status filtering → FTS/links → deterministic ranking → token-budget packing → provenance/conflict metadata.

## Security boundary

The v1 permission model prevents accidental cross-scope access by correctly configured clients. It does not claim to isolate mutually hostile local processes. Secrets must not be stored as context.

## Evolution

Schema migrations are ordered and reversible where practical. Team/remote sync is planned for v1.0 as a self-hosted adapter — a local server, optionally exposed on the network, authenticated by a shared key or password — not yet implemented; protocol, conflict resolution and test coverage are open design work for a future implementation effort. Hosted cloud sync, embeddings and a dashboard remain deferred and require separate evidence and design decisions.
