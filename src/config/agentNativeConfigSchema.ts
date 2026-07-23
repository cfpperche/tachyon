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
}).strict().superRefine((policy, ctx) => {
  if (new Set(policy.lifecycle).size !== policy.lifecycle.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["lifecycle"], message: "must not contain duplicate phases" });
  }
});

export const agentNativeConfigSchemaV1 = z.object(Object.fromEntries(
  AGENT_NATIVE_CONFIG_FAMILIES.map((family) => [family, agentNativeConfigPolicySchemaV1.optional()]),
) as Record<(typeof AGENT_NATIVE_CONFIG_FAMILIES)[number], z.ZodOptional<typeof agentNativeConfigPolicySchemaV1>>).strict();

export type AgentNativeConfigPolicyV1 = z.infer<typeof agentNativeConfigPolicySchemaV1>;
