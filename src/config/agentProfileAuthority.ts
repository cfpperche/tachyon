import { z } from "zod";
import type { AgentProfileAuthoritySnapshot } from "./agentProfileResolver.js";
import { AGENT_NAME_PATTERN } from "./nameValidation.js";

export const AGENT_PROFILE_AUTHORITY_SCHEMA_VERSION = 1 as const;

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const publicId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:+-]{0,255}$/);

const inspector = z.object({
  adapter: publicId,
  id: publicId,
  version: publicId,
  sha256: digest,
}).strict();

const capabilityGrant = z.object({
  referenceId: publicId,
  sourceSha256: digest,
  adapter: z.enum(["claude", "codex", "pi"]),
  kind: z.enum(["skill", "mcp", "hook", "pi-extension", "pi-package"]),
  hookClass: z.enum(["capability", "prompt-transform", "observability", "enforcement"]).optional(),
}).strict().superRefine((grant, ctx) => {
  if (grant.kind === "hook" && !grant.hookClass) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["hookClass"], message: "is required for a hook grant" });
  }
  if (grant.kind !== "hook" && grant.hookClass) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["hookClass"], message: "is allowed only for a hook grant" });
  }
});

const recordSchema = z.object({
  schemaVersion: z.literal(AGENT_PROFILE_AUTHORITY_SCHEMA_VERSION),
  agentName: z.string().regex(AGENT_NAME_PATTERN),
  agentId: z.string().uuid(),
  revision: publicId,
  canonicalSha256: digest,
  runtimeInspector: inspector,
  capabilityGrants: z.array(capabilityGrant).max(256).optional(),
}).strict().superRefine((record, ctx) => {
  const seen = new Set<string>();
  for (let index = 0; index < (record.capabilityGrants ?? []).length; index++) {
    const grant = record.capabilityGrants![index]!;
    if (seen.has(grant.referenceId)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["capabilityGrants", index, "referenceId"], message: "duplicates another capability grant" });
    }
    seen.add(grant.referenceId);
  }
});

export type AgentProfileAuthorityRecord = z.infer<typeof recordSchema>;

const registrySchema = z.object({
  schemaVersion: z.literal(AGENT_PROFILE_AUTHORITY_SCHEMA_VERSION),
  records: z.array(recordSchema).max(1024),
}).strict();

export function parseAgentProfileAuthorityRegistry(raw: string | undefined): Map<string, AgentProfileAuthorityRecord> {
  if (raw === undefined || raw.trim().length === 0) return new Map();
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error(`agent profile authority registry is corrupt: ${error instanceof Error ? error.message : String(error)}`);
  }
  const parsed = registrySchema.safeParse(value);
  if (!parsed.success) throw new Error("agent profile authority registry has an invalid schema");
  const records = new Map<string, AgentProfileAuthorityRecord>();
  for (const record of parsed.data.records) {
    if (records.has(record.agentName)) throw new Error(`agent profile authority registry duplicates '${record.agentName}'`);
    records.set(record.agentName, record);
  }
  return records;
}

export function serializeAgentProfileAuthorityRegistry(records: ReadonlyMap<string, AgentProfileAuthorityRecord>): string {
  const ordered = [...records.values()].sort((left, right) => left.agentName < right.agentName ? -1 : left.agentName > right.agentName ? 1 : 0);
  return `${JSON.stringify({ schemaVersion: AGENT_PROFILE_AUTHORITY_SCHEMA_VERSION, records: ordered }, null, 2)}\n`;
}

export function authoritySnapshotFor(record: AgentProfileAuthorityRecord): AgentProfileAuthoritySnapshot {
  return {
    revision: record.revision,
    canonical: { state: "present", sha256: record.canonicalSha256 },
    runtimeInspector: { ...record.runtimeInspector },
    capabilityGrants: record.capabilityGrants?.map((grant) => ({ ...grant })),
  };
}
