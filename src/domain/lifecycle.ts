import {
  type ContextItem,
  type ContextStatus,
  type ContextType,
} from "./context.js";

export const DURABLE_CONTEXT_TYPES: readonly ContextType[] = [
  "rule",
  "preference",
  "fact",
  "goal",
  "source",
  "decision",
] as const;

export const OPERATIONAL_CONTEXT_TYPES: readonly ContextType[] = [
  "task_note",
  "handoff",
] as const;

export function isDurableContextType(type: ContextType): boolean {
  return (DURABLE_CONTEXT_TYPES as readonly string[]).includes(type);
}

export function isOperationalContextType(type: ContextType): boolean {
  return (OPERATIONAL_CONTEXT_TYPES as readonly string[]).includes(type);
}

export type ActorProfile = "default" | "elevated" | "human" | "admin";

export interface ActorContext {
  actor: string;
  source: "agent" | "human" | "cli" | "mcp" | string;
  profile?: ActorProfile | string | undefined;
}

export const DEFAULT_MCP_ACTOR: ActorContext = {
  actor: "mcp-agent",
  source: "agent",
  profile: "default",
};

export function isActorElevated(actor: ActorContext): boolean {
  if (actor.source === "human") {
    return true;
  }
  const profile =
    actor.profile ?? (actor.source === "human" ? "human" : "default");
  return profile === "elevated" || profile === "human" || profile === "admin";
}

export const LEGAL_TRANSITIONS: Record<
  ContextStatus,
  readonly ContextStatus[]
> = {
  draft: ["draft", "proposed", "approved", "archived"],
  proposed: ["proposed", "approved", "draft", "archived"],
  approved: ["approved", "superseded", "archived"],
  superseded: ["superseded"],
  archived: ["archived", "draft"],
};

export class LifecycleTransitionError extends Error {
  readonly fromStatus: ContextStatus;
  readonly toStatus: ContextStatus;
  readonly itemId?: string | undefined;

  constructor(
    fromStatus: ContextStatus,
    toStatus: ContextStatus,
    itemId?: string | undefined,
    message?: string,
  ) {
    super(
      message ??
        `Cannot transition context item${itemId ? ` '${itemId}'` : ""} from '${fromStatus}' to '${toStatus}'.`,
    );
    this.name = "LifecycleTransitionError";
    this.fromStatus = fromStatus;
    this.toStatus = toStatus;
    this.itemId = itemId;
  }
}

export class ApprovalGateError extends Error {
  readonly actor: ActorContext;
  readonly operation: string;
  readonly itemId?: string | undefined;

  constructor(
    actor: ActorContext,
    operation: string,
    itemId?: string | undefined,
    message?: string,
  ) {
    const detail = message
      ? `Approval gate refusal: ${message}`
      : `Approval gate refusal for actor '${actor.actor}' during '${operation}'${itemId ? ` on '${itemId}'` : ""}.`;
    super(detail);
    this.name = "ApprovalGateError";
    this.actor = actor;
    this.operation = operation;
    this.itemId = itemId;
  }
}

export function validateTransition(
  fromStatus: ContextStatus,
  toStatus: ContextStatus,
  itemId?: string,
): void {
  const allowed = LEGAL_TRANSITIONS[fromStatus];
  if (!allowed || !allowed.includes(toStatus)) {
    throw new LifecycleTransitionError(fromStatus, toStatus, itemId);
  }
}

export function assertCanCreate(
  actor: ActorContext,
  item: Pick<ContextItem, "type" | "status" | "id">,
): void {
  if (isDurableContextType(item.type)) {
    if (actor.source === "agent" && item.status === "approved") {
      throw new ApprovalGateError(
        actor,
        "create_approved",
        item.id,
        `Agent-authored durable knowledge cannot be created as approved. It must be proposed.`,
      );
    }
  }
}

export function assertCanApprove(
  actor: ActorContext,
  item: Pick<ContextItem, "type" | "actor" | "id">,
): void {
  if (isDurableContextType(item.type)) {
    if (!isActorElevated(actor)) {
      throw new ApprovalGateError(
        actor,
        "approve_durable",
        item.id,
        `Default profile cannot approve durable knowledge. Approval is a human act or the act of an explicitly elevated profile.`,
      );
    }
    if (actor.source === "agent" && actor.actor === item.actor) {
      throw new ApprovalGateError(
        actor,
        "self_approve",
        item.id,
        `Agent '${actor.actor}' cannot approve its own proposal for durable knowledge '${item.id}'. Approval must come from a human or separate elevated reviewer.`,
      );
    }
  }
}

export function assertCanArchive(
  actor: ActorContext,
  item: Pick<ContextItem, "type" | "status" | "id">,
): void {
  if (item.status === "approved" && !isActorElevated(actor)) {
    throw new ApprovalGateError(
      actor,
      "archive_approved",
      item.id,
      `Only human or elevated profile can archive approved knowledge.`,
    );
  }
}
