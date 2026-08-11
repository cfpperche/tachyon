import crypto from "node:crypto";
import fs from "node:fs";
import { TextDecoder } from "node:util";
import { z } from "zod";
import {
  commitAgentProfileLifecycle,
  type AgentProfileLifecycleCommitResult,
  type CommitAgentProfileLifecycleInput,
} from "./agentProfileLifecycle.js";
import { closeCanonicalAgentProfile, readAgentProfileReference, readCanonicalAgentProfile } from "./agentProfileReader.js";
import type { AgentProfileLifecycleSnapshot } from "./agentProfileLifecycle.js";
import { DEFAULT_NEW_AGENT_WORKTREE_ENABLED } from "./agentProfileStudio.js";
import type { AgentProfileReferenceV1, AgentProfileV1 } from "./agentProfileSchema.js";
import {
  PERSISTENT_INSTRUCTIONS_FILE_NAME,
  PERSISTENT_INSTRUCTIONS_REFERENCE_ID,
} from "./agentInstructionsDocument.js";

export const PORTABLE_AGENT_PROFILE_BUNDLE_VERSION = 1 as const;
export const PORTABLE_AGENT_PROFILE_BUNDLE_MAX_BYTES = 256 * 1024;
export const PORTABLE_AGENT_PROFILE_DOCUMENT_MAX_BYTES = 64 * 1024;
const DIGEST = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z][A-Za-z0-9._-]{0,127}$/;

const text = (max: number) => z.string().min(1).max(max);
const runtimeSchema = z.object({
  adapter: z.string().regex(ID),
  executable: text(4096),
  model: text(512).optional(),
  provider: text(512).optional(),
  reasoningEffort: text(128).optional(),
  serviceTier: text(128).optional(),
}).strict();
const documentSchema = z.object({
  mediaType: z.literal("text/markdown"),
  sha256: z.string().regex(DIGEST),
  text: z.string().max(PORTABLE_AGENT_PROFILE_DOCUMENT_MAX_BYTES),
}).strict().superRefine((document, ctx) => {
  if (Buffer.byteLength(document.text, "utf8") > PORTABLE_AGENT_PROFILE_DOCUMENT_MAX_BYTES) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["text"], message: "exceeds the UTF-8 byte limit" });
  }
});
const requirementSchema = z.object({
  kind: z.enum(["secret", "environment", "reference", "workspace", "ownership", "lifecycle", "isolation"]),
  field: text(512),
  referenceId: z.string().regex(ID).optional(),
  referenceKind: z.string().regex(ID).optional(),
}).strict();

export const portableAgentProfileBundleSchemaV1 = z.object({
  schemaVersion: z.literal(PORTABLE_AGENT_PROFILE_BUNDLE_VERSION),
  kind: z.literal("tachyon-agent-profile"),
  sourceCanonicalSha256: z.string().regex(DIGEST),
  profile: z.object({
    displayName: text(256).optional(),
    runtime: runtimeSchema,
    documents: z.object({
      instructions: documentSchema.optional(),
    }).strict().optional(),
  }).strict(),
  requiresReauthorization: z.array(requirementSchema).max(256),
}).strict().superRefine((bundle, ctx) => {
  for (const [key, document] of Object.entries(bundle.profile.documents ?? {})) {
    if (document && sha256(document.text) !== document.sha256) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["profile", "documents", key, "sha256"], message: "does not match text" });
    }
  }
});

export type PortableAgentProfileBundleV1 = z.infer<typeof portableAgentProfileBundleSchemaV1>;
export type PortableAgentProfileRequirementV1 = z.infer<typeof requirementSchema>;

export interface PortableAgentProfileBytes {
  bundle: PortableAgentProfileBundleV1;
  bytes: Buffer;
  sha256: string;
}

function sha256(value: string | Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, child]) => [key, canonicalValue(child)]));
  }
  return value;
}

export function renderPortableAgentProfileBundle(bundle: PortableAgentProfileBundleV1): Buffer {
  const parsed = portableAgentProfileBundleSchemaV1.parse(bundle);
  const bytes = Buffer.from(`${JSON.stringify(canonicalValue(parsed), null, 2)}\n`, "utf8");
  if (bytes.length > PORTABLE_AGENT_PROFILE_BUNDLE_MAX_BYTES) throw new Error("portable agent profile bundle is too large");
  return bytes;
}

export function parsePortableAgentProfileBundle(value: string | Buffer): PortableAgentProfileBytes {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
  if (bytes.length === 0 || bytes.length > PORTABLE_AGENT_PROFILE_BUNDLE_MAX_BYTES) {
    throw new Error(`portable agent profile bundle must be 1..${PORTABLE_AGENT_PROFILE_BUNDLE_MAX_BYTES} bytes`);
  }
  let raw: string;
  try { raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new Error("portable agent profile bundle must be valid UTF-8"); }
  let valueObject: unknown;
  try { valueObject = JSON.parse(raw) as unknown; }
  catch { throw new Error("portable agent profile bundle must be valid JSON"); }
  const bundle = portableAgentProfileBundleSchemaV1.parse(valueObject);
  const canonical = renderPortableAgentProfileBundle(bundle);
  if (!bytes.equals(canonical)) throw new Error("portable agent profile bundle is not canonical V1 JSON");
  return { bundle, bytes: canonical, sha256: sha256(canonical) };
}

export function readPortableAgentProfileBundleFile(file: string): PortableAgentProfileBytes {
  const noFollow = fs.constants.O_NOFOLLOW;
  if (typeof noFollow !== "number") throw new Error("host cannot safely open portable bundle without following symlinks");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | noFollow | (fs.constants.O_NONBLOCK ?? 0));
  try {
    const before = fs.fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.size < 1n || before.size > BigInt(PORTABLE_AGENT_PROFILE_BUNDLE_MAX_BYTES)) {
      throw new Error("portable agent profile bundle source must be a bounded regular file");
    }
    const bytes = fs.readFileSync(fd);
    const after = fs.fstatSync(fd, { bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
      throw new Error("portable agent profile bundle changed during read");
    }
    return parsePortableAgentProfileBundle(bytes);
  } finally { fs.closeSync(fd); }
}

function portableDocument(
  workspaceRoot: string,
  agentName: string,
  profile: AgentProfileV1,
  field: "instructions",
): { document?: z.infer<typeof documentSchema>; requirement?: PortableAgentProfileRequirementV1 } {
  const id = profile.prompt?.[field];
  if (!id) return {};
  const reference = profile.references?.find((candidate) => candidate.id === id);
  if (!reference || reference.scope !== "profile" || reference.mode !== "pinned" || !reference.sha256) {
    return { requirement: { kind: "reference", field: `prompt.${field}`, referenceId: id, referenceKind: reference?.kind } };
  }
  const source = readCanonicalAgentProfile(workspaceRoot, agentName);
  if (!source) throw new Error(`canonical profile for '${agentName}' disappeared during export`);
  try {
    const content = readAgentProfileReference(source, reference.path, reference.sha256);
    if (Buffer.byteLength(content.text, "utf8") > PORTABLE_AGENT_PROFILE_DOCUMENT_MAX_BYTES) {
      throw new Error(`portable ${field} document exceeds ${PORTABLE_AGENT_PROFILE_DOCUMENT_MAX_BYTES} bytes`);
    }
    return { document: { mediaType: "text/markdown", sha256: content.sha256, text: content.text } };
  } finally { closeCanonicalAgentProfile(source); }
}

function referencedRequirement(profile: AgentProfileV1, field: string, id: string): PortableAgentProfileRequirementV1 {
  const reference = profile.references?.find((candidate) => candidate.id === id);
  return { kind: "reference", field, referenceId: id, ...(reference ? { referenceKind: reference.kind } : {}) };
}

function excludedRequirements(profile: AgentProfileV1, consumed: ReadonlySet<string>): PortableAgentProfileRequirementV1[] {
  const requirements: PortableAgentProfileRequirementV1[] = [];
  for (const name of Object.keys(profile.environment?.values ?? {})) requirements.push({ kind: "environment", field: `environment.values.${name}` });
  for (const name of Object.keys(profile.environment?.secrets ?? {})) requirements.push({ kind: "secret", field: `environment.secrets.${name}` });
  for (const name of profile.inherit?.environment ?? []) requirements.push({ kind: "environment", field: `inherit.environment.${name}` });
  for (const name of profile.inherit?.workspace ?? []) requirements.push({ kind: "workspace", field: `inherit.workspace.${name}` });
  if (profile.prompt?.memory?.reference) requirements.push(referencedRequirement(profile, "prompt.memory.reference", profile.prompt.memory.reference));
  else if (profile.prompt?.memory) requirements.push({ kind: "reference", field: "prompt.memory" });
  const lists: Array<[string, readonly string[]]> = [
    ["capabilities.skills", profile.capabilities?.skills ?? []],
    ["capabilities.mcp", profile.capabilities?.mcp ?? []],
    ["capabilities.hooks", profile.capabilities?.hooks ?? []],
    ["capabilities.pi.extensions", profile.capabilities?.pi?.extensions ?? []],
    ["capabilities.pi.prompts", profile.capabilities?.pi?.prompts ?? []],
    ["capabilities.pi.themes", profile.capabilities?.pi?.themes ?? []],
    ["capabilities.pi.packages", profile.capabilities?.pi?.packages ?? []],
    ["guidance.project", profile.guidance?.project ?? []],
    ["guidance.bridge", profile.guidance?.bridge ?? []],
  ];
  for (const [field, ids] of lists) ids.forEach((id) => requirements.push(referencedRequirement(profile, field, id)));
  if (profile.workspace) requirements.push({ kind: "workspace", field: "workspace" });
  if (profile.ownership) requirements.push({ kind: "ownership", field: "ownership" });
  if (profile.lifecycle) requirements.push({ kind: "lifecycle", field: "lifecycle" });
  if (profile.isolation) requirements.push({ kind: "isolation", field: "isolation" });
  for (const reference of profile.references ?? []) {
    if (!consumed.has(reference.id) && !requirements.some((requirement) => requirement.referenceId === reference.id)) {
      requirements.push(referencedRequirement(profile, `references.${reference.id}`, reference.id));
    }
  }
  return requirements.sort((left, right) => {
    const leftKey = JSON.stringify(canonicalValue(left));
    const rightKey = JSON.stringify(canonicalValue(right));
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
}

export function exportPortableAgentProfileBundle(input: {
  workspaceRoot: string;
  snapshot: AgentProfileLifecycleSnapshot;
}): PortableAgentProfileBytes {
  const source = readCanonicalAgentProfile(input.workspaceRoot, input.snapshot.agentName);
  if (!source) throw new Error(`canonical profile for '${input.snapshot.agentName}' is missing`);
  try {
    if (source.sha256 !== input.snapshot.provenance.canonical.sha256) throw new Error("canonical profile changed after lifecycle inspection");
  } finally { closeCanonicalAgentProfile(source); }
  const instructions = portableDocument(input.workspaceRoot, input.snapshot.agentName, input.snapshot.profile, "instructions");
  const consumed = new Set<string>();
  if (instructions.document && input.snapshot.profile.prompt?.instructions) consumed.add(input.snapshot.profile.prompt.instructions);
  const bundle: PortableAgentProfileBundleV1 = {
    schemaVersion: 1,
    kind: "tachyon-agent-profile",
    sourceCanonicalSha256: input.snapshot.provenance.canonical.sha256,
    profile: {
      ...(input.snapshot.profile.displayName ? { displayName: input.snapshot.profile.displayName } : {}),
      runtime: { ...input.snapshot.profile.runtime },
      ...(instructions.document ? { documents: {
        ...(instructions.document ? { instructions: instructions.document } : {}),
      } } : {}),
    },
    requiresReauthorization: [
      ...(instructions.requirement ? [instructions.requirement] : []),
      ...excludedRequirements(input.snapshot.profile, consumed),
    ].sort((left, right) => {
      const leftKey = JSON.stringify(canonicalValue(left));
      const rightKey = JSON.stringify(canonicalValue(right));
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    }),
  };
  const bytes = renderPortableAgentProfileBundle(bundle);
  return { bundle, bytes, sha256: sha256(bytes) };
}

type BundleLifecycleDeps = Pick<CommitAgentProfileLifecycleInput,
  "workspaceRoot" | "authority" | "activateState" | "onPhase">;

export interface ImportPortableAgentProfileResult {
  lifecycle: AgentProfileLifecycleCommitResult;
  bundleSha256: string;
  requiresReauthorization: PortableAgentProfileRequirementV1[];
}

export async function importPortableAgentProfileBundle(input: BundleLifecycleDeps & {
  agentName: string;
  bundle: string | Buffer;
}): Promise<ImportPortableAgentProfileResult> {
  const parsed = parsePortableAgentProfileBundle(input.bundle);
  const documents = parsed.bundle.profile.documents;
  const artifacts: Array<{ path: string; text: string; sha256: string }> = [];
  const references: Array<Omit<AgentProfileReferenceV1, "scope" | "owner">> = [];
  const prompt: NonNullable<Omit<AgentProfileV1, "schemaVersion" | "agentId">["prompt"]> = {};
  if (documents?.instructions) {
    // t-d48775 — the id an import mints is the id Agent Studio OWNS, not a private one. It used to be
    // `portable-instructions`, which made an imported agent's instructions foreign to the only form
    // that can edit them: importable, then uneditable forever. A bundle carries no ids (the document
    // travels as text plus digest), so sharing the id changes nothing about what a bundle round-trips.
    prompt.instructions = PERSISTENT_INSTRUCTIONS_REFERENCE_ID;
    artifacts.push({ path: PERSISTENT_INSTRUCTIONS_FILE_NAME, text: documents.instructions.text, sha256: documents.instructions.sha256 });
    references.push({
      id: PERSISTENT_INSTRUCTIONS_REFERENCE_ID,
      kind: "instructions",
      path: PERSISTENT_INSTRUCTIONS_FILE_NAME,
      mode: "pinned",
      sha256: documents.instructions.sha256,
    });
  }
  const lifecycle = await commitAgentProfileLifecycle({
    workspaceRoot: input.workspaceRoot,
    agentName: input.agentName,
    operation: "create",
    createProfile: {
      ...(parsed.bundle.profile.displayName ? { displayName: parsed.bundle.profile.displayName } : {}),
      runtime: { ...parsed.bundle.profile.runtime },
      ...(Object.keys(prompt).length > 0 ? { prompt } : {}),
      lifecycle: { enabled: false },
      // t-4071e4 — a bundle carries no workspace posture by design (it is not portable), so import
      // and clone must CHOOSE one, and the choice was silently "share the human's checkout". They
      // now land on the same creation default as the other two doors. The import still arrives
      // disabled, so a human passes through the Studio and can see and change this before it runs.
      // Written conditionally so the off case stays absence, never an explicit `enabled: false`.
      ...(DEFAULT_NEW_AGENT_WORKTREE_ENABLED ? { workspace: { worktree: { enabled: true } } } : {}),
    },
    ...(references.length > 0 ? { createProfileLocalReferences: references } : {}),
    ...(artifacts.length > 0 ? { artifacts } : {}),
    authority: input.authority,
    activateState: input.activateState,
    ...(input.onPhase ? { onPhase: input.onPhase } : {}),
  });
  return {
    lifecycle,
    bundleSha256: parsed.sha256,
    requiresReauthorization: parsed.bundle.requiresReauthorization.map((requirement) => ({ ...requirement })),
  };
}

export async function clonePortableAgentProfile(input: BundleLifecycleDeps & {
  source: AgentProfileLifecycleSnapshot;
  destinationAgentName: string;
}): Promise<ImportPortableAgentProfileResult> {
  const exported = exportPortableAgentProfileBundle({ workspaceRoot: input.workspaceRoot, snapshot: input.source });
  return importPortableAgentProfileBundle({
    ...input,
    agentName: input.destinationAgentName,
    bundle: exported.bytes,
  });
}
