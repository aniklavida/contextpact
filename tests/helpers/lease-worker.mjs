#!/usr/bin/env node
/**
 * Child-process worker for concurrency tests.
 *
 * Invocation:
 *   node tests/helpers/lease-worker.mjs <workspace-dir> <command> [args-json]
 *
 * Commands:
 *   setup-agents   -- register agent-alpha and agent-beta (idempotent)
 *   claim          -- claim a lease; args: {taskId, agentId, ttlSeconds}
 *   release        -- release a lease; args: {taskId, agentId, finalStatus}
 *   takeover       -- take over a stale lease; args: {taskId, agentId, reason, ttlSeconds}
 *   expire-lease   -- backdates the lease expiry so it is immediately stale; args: {taskId}
 *
 * Output: one JSON line on stdout with {ok:true, ...} or {ok:false, error:"...", name:"..."}
 */

import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

// We build the service inline using the source (tsx is not available here;
// the test runner invokes this with the same Node binary that runs the tests).
// Use dynamic import so we can resolve the TypeScript source via tsx/register.
//
// The test runner passes this script to `node --import tsx/esm` so the source
// TypeScript modules are transparently transpiled at runtime.

const [, , workspaceDir, command, argsJson] = process.argv;
const args = argsJson ? JSON.parse(argsJson) : {};

async function main() {
  const { ContextService } = await import("../../src/index.js");

  const service = new ContextService(workspaceDir);

  try {
    if (command === "setup-agents") {
      service.registerAgent({
        id: "agent-alpha",
        displayName: "Alpha",
        clientKind: "mcp",
        profile: "default",
      });
      service.registerAgent({
        id: "agent-beta",
        displayName: "Beta",
        clientKind: "mcp",
        profile: "default",
      });
      write({ ok: true });
    } else if (command === "claim") {
      const lease = service.claimLease({
        taskId: args.taskId,
        agentId: args.agentId,
        ttlSeconds: args.ttlSeconds ?? 300,
        scope: args.scope ?? [],
      });
      write({ ok: true, lease });
    } else if (command === "release") {
      const task = service.releaseLease({
        taskId: args.taskId,
        agentId: args.agentId,
        finalStatus: args.finalStatus ?? "done",
      });
      write({ ok: true, task });
    } else if (command === "takeover") {
      const lease = service.takeoverLease({
        taskId: args.taskId,
        agentId: args.agentId,
        reason: args.reason,
        ttlSeconds: args.ttlSeconds ?? 300,
        scope: args.scope ?? [],
      });
      write({ ok: true, lease });
    } else if (command === "expire-lease") {
      const pastExpiry = new Date(Date.now() - 2000).toISOString();
      service
        .getDatabase()
        .prepare("UPDATE task_leases SET expires_at = ? WHERE task_id = ?")
        .run(pastExpiry, args.taskId);
      write({ ok: true });
    } else {
      write({
        ok: false,
        error: `Unknown command: ${command}`,
        name: "UnknownCommand",
      });
    }
  } catch (err) {
    write({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      name: err instanceof Error ? err.constructor.name : "Error",
    });
  } finally {
    service.close();
  }
}

function write(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

main().catch((err) => {
  write({ ok: false, error: String(err), name: "FatalError" });
  process.exit(1);
});
