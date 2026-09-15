import { z } from "zod";

import { contextScopeSchema, type ContextScope } from "./context.js";

export const policyRulesSchema = z
  .object({
    allowGlobal: z.boolean().optional(),
    allowedScopes: z.array(contextScopeSchema).optional(),
    visibleScopes: z.array(contextScopeSchema).optional(),
    maxBudget: z.number().int().positive().optional(),
  })
  .passthrough();

export type PolicyRules = z.infer<typeof policyRulesSchema>;

export const createPolicySchema = z.preprocess(
  (raw) => {
    if (raw && typeof raw === "object") {
      const val = { ...(raw as Record<string, unknown>) };
      if (!val.policyJson && typeof val.policy_json === "string") {
        val.policyJson = val.policy_json;
      }
      return val;
    }
    return raw;
  },
  z.object({
    id: z.string().min(1).optional(),
    name: z.string().min(1),
    description: z.string().default(""),
    rules: policyRulesSchema.optional(),
    policyJson: z.string().optional(),
  }),
);

export type CreatePolicyInput = z.infer<typeof createPolicySchema>;

export interface PolicyRecord {
  id: string;
  name: string;
  description: string;
  rules: PolicyRules;
  policyJson: string;
  createdAt: string;
  updatedAt: string;
}

export function isScopeVisibleByPolicy(
  scope: ContextScope,
  rules?: PolicyRules,
): boolean {
  if (!rules) {
    return scope !== "global";
  }

  // 1. Check allowGlobal restriction
  if (scope === "global" && rules.allowGlobal !== true) {
    return false;
  }

  // 2. Check explicit allowedScopes or visibleScopes list if present
  const scopesList = rules.allowedScopes ?? rules.visibleScopes;
  if (scopesList && scopesList.length > 0) {
    return scopesList.includes(scope);
  }

  // Default: global requires explicit allowGlobal: true, other scopes are visible
  return scope !== "global" || rules.allowGlobal === true;
}
