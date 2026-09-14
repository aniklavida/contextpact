import { z } from "zod";

import { taskStatusSchema } from "./agent.js";

// ---------------------------------------------------------------------------
// Lease record
// ---------------------------------------------------------------------------

/**
 * Single-machine task lease record.
 *
 * NOTE: The lease model is explicitly single-machine. Leases coordinate local
 * operating-system processes via SQLite transactions on a single host. Leases
 * do not provide distributed multi-machine consensus.
 */
export interface LeaseRecord {
  taskId: string;
  agentId: string;
  acquiredAt: string;
  heartbeatAt: string;
  expiresAt: string;
  version: number;
}

// ---------------------------------------------------------------------------
// Scope overlap
// ---------------------------------------------------------------------------

export interface ScopeConflict {
  /** Scopes declared by the claimant that overlap with the holder's scopes. */
  overlapping: string[];
  /** The scopes declared by the current lease holder. */
  holderScopes: string[];
  /** The scopes declared by the claimant. */
  claimantScopes: string[];
}

// ---------------------------------------------------------------------------
// Claim
// ---------------------------------------------------------------------------

export const claimLeaseSchema = z.object({
  taskId: z.string().min(1),
  agentId: z.string().min(1),
  /** ISO duration or number of seconds. Defaults to 300 seconds (5 min). */
  ttlSeconds: z.number().int().positive().default(300),
  /** Scopes this agent intends to work in (advisory, recorded on the task). */
  scope: z.array(z.string().min(1)).default([]),
});

export type ClaimLeaseInput = z.input<typeof claimLeaseSchema>;

// ---------------------------------------------------------------------------
// Renew
// ---------------------------------------------------------------------------

export const renewLeaseSchema = z.object({
  taskId: z.string().min(1),
  agentId: z.string().min(1),
  ttlSeconds: z.number().int().positive().default(300),
});

export type RenewLeaseInput = z.input<typeof renewLeaseSchema>;

// ---------------------------------------------------------------------------
// Release
// ---------------------------------------------------------------------------

export const releaseLeaseSchema = z.object({
  taskId: z.string().min(1),
  agentId: z.string().min(1),
  finalStatus: taskStatusSchema
    .extract(["review", "done", "blocked", "planned"])
    .default("review"),
});

export type ReleaseLeaseInput = z.input<typeof releaseLeaseSchema>;

// ---------------------------------------------------------------------------
// Stale takeover
// ---------------------------------------------------------------------------

export const takeoverLeaseSchema = z.object({
  taskId: z.string().min(1),
  agentId: z.string().min(1),
  /** Non-empty reason is mandatory — takeovers without one are refused. */
  reason: z.string().min(1, "A reason is required for stale takeover."),
  ttlSeconds: z.number().int().positive().default(300),
  scope: z.array(z.string().min(1)).default([]),
});

export type TakeoverLeaseInput = z.input<typeof takeoverLeaseSchema>;

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

/** Thrown when a claim is refused because the task already has an active lease. */
export class LeaseConflictError extends Error {
  readonly taskId: string;
  readonly holderAgentId: string;
  readonly expiresAt: string;
  readonly scopeConflict: ScopeConflict | null;

  constructor(
    taskId: string,
    holderAgentId: string,
    expiresAt: string,
    scopeConflict: ScopeConflict | null,
  ) {
    const overlap =
      scopeConflict && scopeConflict.overlapping.length > 0
        ? ` Overlapping scopes: [${scopeConflict.overlapping.join(", ")}].`
        : "";
    super(
      `Task '${taskId}' is already claimed by agent '${holderAgentId}' (expires ${expiresAt}).${overlap}`,
    );
    this.name = "LeaseConflictError";
    this.taskId = taskId;
    this.holderAgentId = holderAgentId;
    this.expiresAt = expiresAt;
    this.scopeConflict = scopeConflict;
  }
}

/** Thrown when a takeover is attempted without a reason. */
export class TakeoverReasonRequiredError extends Error {
  readonly taskId: string;

  constructor(taskId: string) {
    super(
      `Stale takeover of task '${taskId}' refused: a non-empty reason is required.`,
    );
    this.name = "TakeoverReasonRequiredError";
    this.taskId = taskId;
  }
}

/** Thrown when a lease operation targets a task without an active lease. */
export class NoActiveLeaseError extends Error {
  readonly taskId: string;

  constructor(taskId: string, operation: string) {
    super(`Cannot ${operation} lease for task '${taskId}': no active lease.`);
    this.name = "NoActiveLeaseError";
    this.taskId = taskId;
  }
}

/** Thrown when the caller is not the current lease holder. */
export class LeaseOwnershipError extends Error {
  readonly taskId: string;
  readonly expectedAgentId: string;
  readonly actualAgentId: string;

  constructor(taskId: string, expectedAgentId: string, actualAgentId: string) {
    super(
      `Agent '${expectedAgentId}' does not hold the lease for task '${taskId}' (held by '${actualAgentId}').`,
    );
    this.name = "LeaseOwnershipError";
    this.taskId = taskId;
    this.expectedAgentId = expectedAgentId;
    this.actualAgentId = actualAgentId;
  }
}

/** Thrown when a takeover is attempted but the lease has not yet expired. */
export class LeaseNotStaleError extends Error {
  readonly taskId: string;
  readonly expiresAt: string;

  constructor(taskId: string, expiresAt: string) {
    super(
      `Task '${taskId}' lease is not stale (expires ${expiresAt}). Takeover is only allowed after the lease has expired.`,
    );
    this.name = "LeaseNotStaleError";
    this.taskId = taskId;
    this.expiresAt = expiresAt;
  }
}
