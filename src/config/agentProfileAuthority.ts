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

const recordSchema = z.object({
  schemaVersion: z.literal(AGENT_PROFILE_AUTHORITY_SCHEMA_VERSION),
  agentName: z.string().regex(AGENT_NAME_PATTERN),
  agentId: z.string().uuid(),
  revision: publicId,
  canonicalSha256: digest,
  runtimeInspector: inspector,
}).strict();

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
  };
}
