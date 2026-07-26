import { z } from "zod";

export const AGENT_NATIVE_CONFIG_FAMILIES = [
  "selectors",
  "permissions",
  "interface",
  "tooling",
  "featureFlags",
  "authentication",
  "memory",
  "diagnostics",
] as const;

export const agentNativeConfigPolicySchemaV1 = z.object({
  source: z.enum(["global", "workspace", "agent"]),
  treatment: z.enum(["exclude", "snapshot", "overlay", "external"]),
  refresh: z.enum(["create-once", "every-launch", "runtime-owned"]),
  lifecycle: z.array(z.enum(["fresh", "restart", "resume", "fork"])).min(1).max(4),
  /**
   * SDD 471 — values this specific agent is deliberately permitted to project even though the
   * runtime projector refuses them by default. Inheriting a dangerous value from a person's own
   * global config is never sufficient on its own; the profile has to name it here. Which members
   * are legal is a per-runtime decision made in `resolveAgentNativeConfigSupport`, so the schema
   * only fixes the shape.
   */
  authorize: z.array(z.string().regex(/^[A-Za-z][A-Za-z0-9]*$/, "must be an authorization identifier"))
    .min(1)
    .max(8)
    .optional(),
}).strict().superRefine((policy, ctx) => {
  if (new Set(policy.lifecycle).size !== policy.lifecycle.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["lifecycle"], message: "must not contain duplicate phases" });
  }
  if (policy.authorize && new Set(policy.authorize).size !== policy.authorize.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["authorize"], message: "must not contain duplicate authorizations" });
  }
});

export const agentNativeConfigSchemaV1 = z.object(Object.fromEntries(
  AGENT_NATIVE_CONFIG_FAMILIES.map((family) => [family, agentNativeConfigPolicySchemaV1.optional()]),
) as Record<(typeof AGENT_NATIVE_CONFIG_FAMILIES)[number], z.ZodOptional<typeof agentNativeConfigPolicySchemaV1>>).strict();

export type AgentNativeConfigPolicyV1 = z.infer<typeof agentNativeConfigPolicySchemaV1>;
