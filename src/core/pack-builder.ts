import type {
  ContextItem,
  ContextScope,
  ContextStatus,
  ContextType,
  Importance,
} from "../domain/context.js";

export interface ContextPackItem {
  id: string;
  type: ContextType;
  scope: ContextScope;
  title: string;
  content: string;
  status: ContextStatus;
  importance: Importance;
  version: number;
  supersedes: string[];
  tags: string[];
  updatedAt: string;
}

export interface ContextPack {
  workspaceId: string;
  generatedAt: string;
  items: ContextPackItem[];
  totalItems: number;
}

const IMPORTANCE_WEIGHT: Record<Importance, number> = {
  critical: 4,
  high: 3,
  normal: 2,
  low: 1,
};

export interface PackBuilderOptions {
  workspaceId: string;
  scope?: ContextScope | undefined;
  includeSuperseded?: boolean | undefined;
  includeArchived?: boolean | undefined;
  includeProposed?: boolean | undefined;
  includeDraft?: boolean | undefined;
}

export function buildContextPack(
  items: ContextItem[],
  options: PackBuilderOptions,
): ContextPack {
  const {
    workspaceId,
    scope,
    includeSuperseded = false,
    includeArchived = false,
    includeProposed = false,
    includeDraft = false,
  } = options;

  const filtered = items.filter((item) => {
    if (scope && item.scope !== scope) {
      return false;
    }
    if (item.status === "superseded" && !includeSuperseded) {
      return false;
    }
    if (item.status === "archived" && !includeArchived) {
      return false;
    }
    if (item.status === "proposed" && !includeProposed) {
      return false;
    }
    if (item.status === "draft" && !includeDraft) {
      return false;
    }
    return true;
  });

  const sorted = [...filtered].sort((a, b) => {
    const weightA = IMPORTANCE_WEIGHT[a.importance] ?? 0;
    const weightB = IMPORTANCE_WEIGHT[b.importance] ?? 0;
    if (weightA !== weightB) {
      return weightB - weightA;
    }
    if (a.type !== b.type) {
      return a.type.localeCompare(b.type);
    }
    return a.id.localeCompare(b.id);
  });

  const packItems: ContextPackItem[] = sorted.map((item) => ({
    id: item.id,
    type: item.type,
    scope: item.scope,
    title: item.title,
    content: item.content,
    status: item.status,
    importance: item.importance,
    version: item.version,
    supersedes: [...(item.supersedes ?? [])],
    tags: [...(item.tags ?? [])],
    updatedAt: item.updatedAt,
  }));

  return {
    workspaceId,
    generatedAt: new Date().toISOString(),
    items: packItems,
    totalItems: packItems.length,
  };
}
