import path from "node:path";
import { z } from "zod";
import { containsUnsafeFramingCharacter } from "./framingSafety.js";
import { agentNativeConfigSchemaV1 } from "./agentNativeConfigSchema.js";
export {
  AGENT_NATIVE_CONFIG_FAMILIES,
  agentNativeConfigPolicySchemaV1,
  agentNativeConfigSchemaV1,
  type AgentNativeConfigPolicyV1,
} from "./agentNativeConfigSchema.js";

export const AGENT_PROFILE_SCHEMA_VERSION = 1 as const;
export const AGENT_PROFILE_MAX_BYTES = 256 * 1024;
export const AGENT_PROFILE_REFERENCE_MAX_BYTES = 1024 * 1024;
export const AGENT_PROFILE_MAX_REFERENCES = 128;
export const AGENT_PROFILE_MAX_PATH_BYTES = 512;

const ID_RE = /^[A-Za-z][A-Za-z0-9._-]{0,127}$/;
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const WINDOWS_DRIVE_RE = /^[A-Za-z]:/;

const boundedText = (label: string, max = 4096) => z.string().min(1, `${label} must not be empty`).max(max);

export function agentProfileRelativePathError(value: string): string | undefined {
  if (value.length === 0) return "must not be empty";
  if (value !== value.trim()) return "must not have leading or trailing whitespace";
  if (Buffer.byteLength(value, "utf8") > AGENT_PROFILE_MAX_PATH_BYTES) {
    return `must be at most ${AGENT_PROFILE_MAX_PATH_BYTES} UTF-8 bytes`;
  }
  if (containsUnsafeFramingCharacter(value)) return "must not contain control characters";
  if (value.includes("\\")) return "must use POSIX '/' separators";
  if (path.posix.isAbsolute(value) || WINDOWS_DRIVE_RE.test(value)) return "must be relative";
  const segments = value.split("/");
  if (segments.some((segment) => segment.length === 0)) return "must not contain empty path segments";
  if (segments.some((segment) => segment === "." || segment === "..")) return "must not contain '.' or '..' path segments";
  if (segments.some((segment) => WINDOWS_DRIVE_RE.test(segment))) return "must not contain drive-relative segments";
  return undefined;
}

const relativePathSchema = z.string().superRefine((value, ctx) => {
  const error = agentProfileRelativePathError(value);
  if (error) ctx.addIssue({ code: z.ZodIssueCode.custom, message: error });
});

const referenceKindSchema = z.enum([
  "soul",
  "instructions",
  "role",
  "evolution",
  "memory",
  "skill",
  "mcp",
  "hook",
  "pi-extension",
  "pi-prompt",
  "pi-theme",
  "pi-package",
  "project-guidance",
  "bridge-guidance",
  "verification",
  "worktree-setup",
  "runtime-adapter",
]);

export const agentProfileReferenceSchema = z.object({
  id: z.string().regex(ID_RE, "must be a stable reference id"),
  kind: referenceKindSchema,
  scope: z.enum(["profile", "project", "product"]),
  owner: boundedText("owner", 256),
  path: relativePathSchema,
  mode: z.enum(["pinned", "floating"]),
  sha256: z.string().regex(SHA256_RE, "must be a lowercase SHA-256 digest").optional(),
  version: boundedText("version", 256).optional(),
}).strict().superRefine((reference, ctx) => {
  if (reference.mode === "pinned" && !reference.sha256) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["sha256"], message: "is required for a pinned reference" });
  }
  if (reference.scope === "profile" && reference.mode !== "pinned") {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["mode"], message: "profile-local references must be pinned" });
  }
  if (["soul", "instructions", "role", "evolution", "memory", "skill", "mcp", "hook", "pi-extension", "pi-prompt", "pi-theme", "pi-package", "bridge-guidance", "verification", "worktree-setup", "runtime-adapter"].includes(reference.kind)
    && reference.mode !== "pinned") {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["mode"], message: `${reference.kind} references must be pinned` });
  }
});

const secretReferenceSchema = z.object({
  provider: z.string().regex(ID_RE, "must be a stable provider id"),
  id: boundedText("secret reference id", 512),
  purpose: boundedText("secret purpose", 256),
}).strict();

const attentionSchema = z.object({
  enabled: z.boolean().optional(),
  silenceSec: z.number().int().min(0).max(86_400).optional(),
  patterns: z.array(boundedText("attention pattern", 1024)).max(128).optional(),
}).strict();

const runtimeSchema = z.object({
  adapter: z.string().regex(ID_RE, "must be a stable runtime adapter id"),
  executable: boundedText("runtime executable", 4096),
  model: boundedText("model", 512).optional(),
  provider: boundedText("provider", 512).optional(),
  reasoningEffort: boundedText("reasoning effort", 128).optional(),
  serviceTier: boundedText("service tier", 128).optional(),
}).strict().superRefine((runtime, ctx) => {
  if (containsUnsafeFramingCharacter(runtime.executable)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["executable"], message: "must not contain control characters" });
  }
  if (/\s/.test(runtime.executable) || /[;&|<>`$(){}*?!#]/.test(runtime.executable)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["executable"], message: "must be one executable token/path without shell syntax or arguments" });
  }
});

const environmentSchema = z.object({
  values: z.record(z.string().regex(ENV_NAME_RE), z.string().max(16 * 1024)).optional(),
  secrets: z.record(z.string().regex(ENV_NAME_RE), secretReferenceSchema).optional(),
}).strict().superRefine((environment, ctx) => {
  for (const name of Object.keys(environment.values ?? {})) {
    if (environment.secrets?.[name]) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["values", name], message: "cannot also be a secret reference" });
    }
  }
});

const promptSchema = z.object({
  soul: z.string().regex(ID_RE).optional(),
  instructions: z.string().regex(ID_RE).optional(),
  role: z.enum(["coder", "reviewer", "tester", "orchestrator", "custom"]).optional(),
  evolution: z.string().regex(ID_RE).optional(),
  memory: z.object({
    policy: z.enum(["disabled", "runtime-managed", "human-approved"]),
    reference: z.string().regex(ID_RE).optional(),
  }).strict().optional(),
}).strict();

const lifecycleSchema = z.object({
  enabled: z.boolean().optional(),
  autostart: z.boolean().optional(),
  watch: z.array(boundedText("watch pattern", 1024)).max(128).optional(),
  attention: attentionSchema.optional(),
  restart: z.enum(["never", "on-crash"]).optional(),
}).strict();

const workspaceSchema = z.object({
  cwd: boundedText("cwd", 4096).optional(),
  worktree: z.object({
    enabled: z.boolean().optional(),
    base: boundedText("worktree base", 4096).optional(),
    branch: boundedText("worktree branch", 1024).optional(),
    setup: z.array(z.string().regex(ID_RE)).max(64).optional(),
  }).strict().optional(),
  verify: z.string().regex(ID_RE).optional(),
}).strict();

const capabilitiesSchema = z.object({
  skills: z.array(z.string().regex(ID_RE)).max(128).optional(),
  mcp: z.array(z.string().regex(ID_RE)).max(128).optional(),
  hooks: z.array(z.string().regex(ID_RE)).max(128).optional(),
  pi: z.object({
    extensions: z.array(z.string().regex(ID_RE)).max(128).optional(),
    prompts: z.array(z.string().regex(ID_RE)).max(128).optional(),
    themes: z.array(z.string().regex(ID_RE)).max(128).optional(),
    packages: z.array(z.string().regex(ID_RE)).max(128).optional(),
  }).strict().optional(),
}).strict();

const guidanceSchema = z.object({
  project: z.array(z.string().regex(ID_RE)).max(32).optional(),
  bridge: z.array(z.string().regex(ID_RE)).max(32).optional(),
}).strict();

export const agentProfileSchemaV1 = z.object({
  schemaVersion: z.literal(AGENT_PROFILE_SCHEMA_VERSION),
  agentId: z.string().uuid(),
  displayName: boundedText("display name", 256).optional(),
  runtime: runtimeSchema,
  environment: environmentSchema.optional(),
  prompt: promptSchema.optional(),
  lifecycle: lifecycleSchema.optional(),
  workspace: workspaceSchema.optional(),
  isolation: z.enum(["transcript"]).optional(),
  ownership: z.object({ subagents: z.array(z.string().regex(ID_RE)).max(128) }).strict().optional(),
  capabilities: capabilitiesSchema.optional(),
  nativeConfig: agentNativeConfigSchemaV1.optional(),
  guidance: guidanceSchema.optional(),
  inherit: z.object({
    environment: z.array(z.string().regex(ENV_NAME_RE)).max(128).optional(),
    workspace: z.array(z.enum(["worktree.base", "worktree.branch", "verify", "projectGuidance", "bridgeGuidance"])).max(16).optional(),
  }).strict().optional(),
  references: z.array(agentProfileReferenceSchema).max(AGENT_PROFILE_MAX_REFERENCES).optional(),
}).strict().superRefine((profile, ctx) => {
  const references = new Map<string, z.infer<typeof agentProfileReferenceSchema>>();
  for (let index = 0; index < (profile.references ?? []).length; index++) {
    const reference = profile.references![index]!;
    if (references.has(reference.id)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["references", index, "id"], message: "duplicates another reference id" });
    }
    if (reference.scope === "profile" && reference.owner !== profile.agentId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["references", index, "owner"], message: "profile-local reference owner must equal agentId" });
    }
    if (reference.scope === "product" && !reference.version) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["references", index, "version"], message: "product references require a version" });
    }
    references.set(reference.id, reference);
  }

  const requireKind = (id: string | undefined, fieldPath: Array<string | number>, kinds: string[]) => {
    if (!id) return;
    const reference = references.get(id);
    if (!reference) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: fieldPath, message: `references unknown id ${JSON.stringify(id)}` });
    } else if (!kinds.includes(reference.kind)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: fieldPath, message: `reference ${JSON.stringify(id)} has kind ${reference.kind}, expected ${kinds.join(" or ")}` });
    }
  };

  requireKind(profile.prompt?.soul, ["prompt", "soul"], ["soul"]);
  requireKind(profile.prompt?.instructions, ["prompt", "instructions"], ["instructions"]);
  requireKind(profile.prompt?.evolution, ["prompt", "evolution"], ["evolution"]);
  requireKind(profile.prompt?.memory?.reference, ["prompt", "memory", "reference"], ["memory"]);
  if (profile.prompt?.memory?.policy === "disabled" && profile.prompt.memory.reference) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["prompt", "memory", "reference"], message: "must be absent when memory policy is disabled" });
  }
  for (const [index, id] of (profile.capabilities?.skills ?? []).entries()) requireKind(id, ["capabilities", "skills", index], ["skill"]);
  for (const [index, id] of (profile.capabilities?.mcp ?? []).entries()) requireKind(id, ["capabilities", "mcp", index], ["mcp"]);
  for (const [index, id] of (profile.capabilities?.hooks ?? []).entries()) requireKind(id, ["capabilities", "hooks", index], ["hook"]);
  for (const [index, id] of (profile.capabilities?.pi?.extensions ?? []).entries()) requireKind(id, ["capabilities", "pi", "extensions", index], ["pi-extension"]);
  for (const [index, id] of (profile.capabilities?.pi?.prompts ?? []).entries()) requireKind(id, ["capabilities", "pi", "prompts", index], ["pi-prompt"]);
  for (const [index, id] of (profile.capabilities?.pi?.themes ?? []).entries()) requireKind(id, ["capabilities", "pi", "themes", index], ["pi-theme"]);
  for (const [index, id] of (profile.capabilities?.pi?.packages ?? []).entries()) requireKind(id, ["capabilities", "pi", "packages", index], ["pi-package"]);
  for (const [index, id] of (profile.guidance?.project ?? []).entries()) requireKind(id, ["guidance", "project", index], ["project-guidance"]);
  for (const [index, id] of (profile.guidance?.bridge ?? []).entries()) requireKind(id, ["guidance", "bridge", index], ["bridge-guidance"]);
  for (const [index, id] of (profile.workspace?.worktree?.setup ?? []).entries()) requireKind(id, ["workspace", "worktree", "setup", index], ["worktree-setup"]);
  requireKind(profile.workspace?.verify, ["workspace", "verify"], ["verification"]);
});

export type AgentProfileReferenceV1 = z.infer<typeof agentProfileReferenceSchema>;
export type AgentProfileV1 = z.infer<typeof agentProfileSchemaV1>;
