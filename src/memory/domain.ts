import crypto from "node:crypto";
import { z } from "zod";
import { AGENT_NAME_PATTERN } from "../config/nameValidation.js";

export const SELECTED_MEMORY_SCHEMA_VERSION = 1 as const;
export const SELECTED_MEMORY_MAX_ENTRIES = 128;
export const SELECTED_MEMORY_MAX_ENTRY_BYTES = 32 * 1024;
export const SELECTED_MEMORY_MAX_TOTAL_BYTES = 256 * 1024;
export const SELECTED_MEMORY_MAX_RENDERED_BYTES = 2 * 1024 * 1024;

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const entryId = z.string().regex(/^memory-[0-9a-f-]{36}$/);

export const selectedMemoryEntrySchema = z.object({
  id: entryId,
  path: z.string().regex(/^active\/memory-[0-9a-f-]{36}\.md$/),
  sha256: digest,
  bytes: z.number().int().min(0).max(SELECTED_MEMORY_MAX_ENTRY_BYTES),
  sourceCandidateId: z.string().regex(/^candidate-[0-9a-f-]{36}$/),
  sourcePrincipal: z.string().min(1).max(256),
  sourceKind: z.enum(["human", "agent", "system"]),
  approvedBy: z.string().min(1).max(256),
  approvedAt: z.string().datetime(),
}).strict();
export type SelectedMemoryEntry = z.infer<typeof selectedMemoryEntrySchema>;

export const selectedMemoryManifestSchema = z.object({
  schemaVersion: z.literal(SELECTED_MEMORY_SCHEMA_VERSION),
  activationId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:+-]{0,255}$/),
  agentId: z.string().uuid(),
  agentName: z.string().regex(AGENT_NAME_PATTERN),
  version: z.number().int().min(0),
  entries: z.array(selectedMemoryEntrySchema).max(SELECTED_MEMORY_MAX_ENTRIES),
  updatedAt: z.string().datetime(),
}).strict().superRefine((manifest, ctx) => {
  const ids = new Set<string>();
  const paths = new Set<string>();
  let total = 0;
  for (const [index, entry] of manifest.entries.entries()) {
    const canonicalPath = entry.path.toLowerCase();
    if (ids.has(entry.id) || paths.has(canonicalPath)
      || (index > 0 && manifest.entries[index - 1]!.path >= entry.path)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["entries", index], message: "entries must have unique ids and case-folded paths and be strictly path-sorted" });
    }
    ids.add(entry.id);
    paths.add(canonicalPath);
    total += entry.bytes;
  }
  if (total > SELECTED_MEMORY_MAX_TOTAL_BYTES) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["entries"], message: "selected memory exceeds its total byte bound" });
  }
});
export type SelectedMemoryManifest = z.infer<typeof selectedMemoryManifestSchema>;

export const selectedMemoryCandidateSchema = z.object({
  schemaVersion: z.literal(SELECTED_MEMORY_SCHEMA_VERSION),
  id: z.string().regex(/^candidate-[0-9a-f-]{36}$/),
  agentId: z.string().uuid(),
  agentName: z.string().regex(AGENT_NAME_PATTERN),
  content: z.string(),
  reason: z.string().min(1).max(2048),
  sourcePrincipal: z.string().min(1).max(256),
  sourceKind: z.enum(["human", "agent", "system"]),
  status: z.enum(["pending", "approved", "rejected"]),
  createdAt: z.string().datetime(),
  resolvedAt: z.string().datetime().optional(),
  promotedVersion: z.number().int().min(1).optional(),
}).strict().superRefine((candidate, ctx) => {
  const bytes = Buffer.byteLength(candidate.content, "utf8");
  if (bytes === 0 || bytes > SELECTED_MEMORY_MAX_ENTRY_BYTES || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(candidate.content)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["content"], message: "must be non-empty bounded UTF-8 text without unsafe control characters" });
  }
});
export type SelectedMemoryCandidate = z.infer<typeof selectedMemoryCandidateSchema>;

export function selectedMemoryCandidateBytes(candidate: SelectedMemoryCandidate): Buffer {
  return Buffer.from(`${JSON.stringify(candidate, null, 2)}\n`, "utf8");
}

export interface SelectedMemoryActiveState {
  manifest: SelectedMemoryManifest;
  contents: Array<{ path: string; content: string }>;
}

export function selectedMemoryManifestBytes(manifest: SelectedMemoryManifest): Buffer {
  return Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

export function selectedMemorySha256(value: Buffer | string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function selectedMemoryActiveDigest(active: SelectedMemoryActiveState): string {
  return selectedMemorySha256(JSON.stringify(active));
}
