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

export type ActorProfile = "default" | "elevated" | "human" | "admin" | string;

export type Capability =
  | "approve_durable"
  | "create_approved"
  | "archive_approved"
  | "propose_durable"
  | "write_operational"
  | "read_context"
  | "read_global"
  | "manage_tasks"
  | "manage_policies";

export interface ProfileDefinition {
  name: string;
  description: string;
  capabilities: readonly Capability[];
}

export const BUILTIN_PROFILES: Record<string, ProfileDefinition> = {
  default: {
    name: "default",
    description:
      "Default local agent process holding a task lease. Can propose durable knowledge and write operational notes, but cannot approve durable knowledge.",
    capabilities: [
      "propose_durable",
      "write_operational",
      "read_context",
      "manage_tasks",
    ],
  },
  read_only: {
    name: "read_only",
    description: "Read-only process. Can inspect and read context items.",
    capabilities: ["read_context"],
  },
  elevated: {
    name: "elevated",
    description:
      "Elevated agent reviewer process. Can approve durable proposals from other agents and archive approved knowledge.",
    capabilities: [
      "propose_durable",
      "write_operational",
      "read_context",
      "manage_tasks",
      "approve_durable",
      "archive_approved",
    ],
  },
  human: {
    name: "human",
    description: "Human operator. Holds full capabilities.",
    capabilities: [
      "propose_durable",
      "write_operational",
      "read_context",
      "manage_tasks",
      "approve_durable",
      "create_approved",
      "archive_approved",
      "read_global",
      "manage_policies",
    ],
  },
  admin: {
    name: "admin",
    description: "Local administrator. Holds full capabilities.",
    capabilities: [
      "propose_durable",
      "write_operational",
      "read_context",
      "manage_tasks",
      "approve_durable",
      "create_approved",
      "archive_approved",
      "read_global",
      "manage_policies",
    ],
  },
};

export function getProfileCapabilities(
  profileName: string,
): readonly Capability[] {
  const normalized = profileName.toLowerCase().trim();
  if (normalized in BUILTIN_PROFILES) {
    return BUILTIN_PROFILES[normalized]!.capabilities;
  }
  return BUILTIN_PROFILES["default"]!.capabilities;
}

export function hasCapability(
  profileName: string | undefined,
  capability: Capability,
): boolean {
  if (!profileName) {
    return false;
  }
  return getProfileCapabilities(profileName).includes(capability);
}

export interface ActorContext {
  actor: string;
  source: "agent" | "human" | "cli" | "mcp" | string;
  profile?: ActorProfile | string | undefined;
}

export function actorHasCapability(
  actor: ActorContext,
  capability: Capability,
): boolean {
  if (actor.source === "human") {
    return true;
  }
  const profile = actor.profile ?? "default";
  return hasCapability(profile, capability);
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
  return actorHasCapability(actor, "approve_durable");
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
    if (
      actor.source === "agent" &&
      item.status === "approved" &&
      !actorHasCapability(actor, "create_approved")
    ) {
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
    if (!actorHasCapability(actor, "approve_durable")) {
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
  if (
    item.status === "approved" &&
    !actorHasCapability(actor, "archive_approved")
  ) {
    throw new ApprovalGateError(
      actor,
      "archive_approved",
      item.id,
      `Only human or elevated profile can archive approved knowledge.`,
    );
  }
}
