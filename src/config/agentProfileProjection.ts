import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseDocument } from "yaml";
import type { AgentEntry } from "./loadConfig.js";
import {
  agentProfileRuntimeSelectorsSha256,
  resolveAgentProfile,
  type NativeRuntimeAttestation,
  type ExternalProfileReference,
  type ResolvedAgentProfile,
  type WorkspaceProfileDefaults,
} from "./agentProfileResolver.js";
import { agentProfileSchemaV1, type AgentProfileV1 } from "./agentProfileSchema.js";
import { authoritySnapshotFor, type AgentProfileAuthorityRecord } from "./agentProfileAuthority.js";
import {
  closeCanonicalAgentProfile,
  readAgentProfileReference,
  readCanonicalAgentProfile,
  type CanonicalAgentProfileSource,
} from "./agentProfileReader.js";
import { AgentCapabilitySourceError, captureCapabilitySourceAtRoot } from "./agentCapabilitySource.js";
import { isAttestedRuntime, type AttestedRuntime } from "../runtime/attestedRuntimes.js";
import {
  projectAgentNativeConfig,
  resolveAgentNativeConfigSupport,
  validateAgentNativeConfigPolicy,
} from "./agentNativeConfigPolicy.js";
import type {
  AgentNativeConfigFamily,
  ResolvedAgentNativeConfigProjection,
} from "./agentNativeConfigPolicy.js";
import { projectCodexScalarNativeConfig } from "./codexNativeConfigProjection.js";
import { projectClaudeNativeConfig } from "./claudeNativeConfigProjection.js";
import { projectGrokNativeConfig } from "./grokNativeConfigProjection.js";

const INSPECTOR_CONTRACT = "tachyon/codex-empty-native-input-inspector/v1";
const PI_INSPECTOR_CONTRACT = "tachyon/pi-private-capability-input-inspector/v1";
/**
 * The Grok contract as it shipped before t-26f508, retained VERBATIM because its sha256 is what an
 * already-created canonical Grok authority names. Never edit this string: it is a fingerprint of a
 * contract that is already on disk in someone's workspace, not a description we are free to improve.
 */
const GROK_INSPECTOR_CONTRACT_V1 = [
  "tachyon/grok-private-home-input-inspector/v1",
  "literal executable grok",
  "GROK_HOME is Tachyon-owned bridge-mcp/<agent>.grok on every canonical launch",
  "config.toml and trusted_folders.toml are rewritten before launch",
  "auth.json is an external credential symlink",
  "ambient ~/.grok config, memory and plugins are not inherited",
].join("\n");
/**
 * The Grok contract as it shipped between t-26f508 and t-de73e0, retained VERBATIM for the same
 * reason as v1: its sha256 is what an authority created in that window names. Never edit it.
 */
const GROK_INSPECTOR_CONTRACT_V2 = [
  "tachyon/grok-private-home-input-inspector/v2",
  "literal executable grok",
  "GROK_HOME and HOME are Tachyon-owned bridge-mcp/<agent>.grok on every canonical launch",
  "config.toml and trusted_folders.toml are rewritten before launch",
  "config.toml carries only closed global profile-projected scalars plus typed agent-owned selectors",
  "compat cells for cursor, claude and codex are pinned off",
  "memory is disabled in config and pinned off by GROK_MEMORY",
  "auth.json is an external credential symlink",
  "ambient project .grok tooling and AGENTS.md must be absent",
  "unselected ambient ~/.grok config, memory and plugins are not inherited",
].join("\n");
/**
 * t-de73e0 — v2 promised "auth.json is an external credential symlink", and that promise is what
 * destroyed the credential of the machine this was measured on: the runtime WRITES the file it is
 * handed, and a write through a symlink lands on the person's own credential. The contract now says
 * what the code does — a private copy, harvested back when the agent refreshes it — because an
 * inspector contract is an attestation, and attesting to a symlink that must not exist would be
 * attesting to the defect.
 */
const GROK_INSPECTOR_CONTRACT = [
  "tachyon/grok-private-home-input-inspector/v3",
  "literal executable grok",
  "GROK_HOME and HOME are Tachyon-owned bridge-mcp/<agent>.grok on every canonical launch",
  "config.toml and trusted_folders.toml are rewritten before launch",
  "config.toml carries only closed global profile-projected scalars plus typed agent-owned selectors",
  "compat cells for cursor, claude and codex are pinned off",
  "memory is disabled in config and pinned off by GROK_MEMORY",
  "auth.json is a private copy of the external credential, never a pointer to it, because the runtime writes it",
  "a refreshed private credential is harvested back to the external credential",
  "ambient project .grok tooling and AGENTS.md must be absent",
  "unselected ambient ~/.grok config, memory and plugins are not inherited",
].join("\n");
const CLAUDE_INSPECTOR_CONTRACT = [
  "tachyon/claude-closed-private-home-input-inspector/v5",
  "literal executable claude",
  "CLAUDE_CONFIG_DIR is Tachyon-owned harness/<agent> on every canonical launch",
  "--setting-sources user plus --settings selects only closed global/workspace profile-projected scalar settings",
  "--model and --effort select only typed agent-owned selectors",
  "autoMemoryEnabled is forced false",
  "--strict-mcp-config selects a host-custodied Bridge-only MCP file",
  "workspace settings.local and plugins are not inherited",
  "selected owner-captured skills, hooks and MCP require exact host grants and are reprojected",
  "ambient CLAUDE.md, agents, commands and plugin roots must be absent",
  "credentials and allowlisted onboarding markers remain external auth/bootstrap",
].join("\n");
const PROFILE_ATTENTION_DEFAULT_SILENCE_SEC = 8;
const NATIVE_CONFIG_MAX_BYTES = 1024 * 1024;
export const CODEX_EMPTY_NATIVE_INPUT_INSPECTOR = Object.freeze({
  adapter: "codex",
  id: "tachyon.codex-empty-native-inputs",
  version: "1",
  sha256: crypto.createHash("sha256").update(INSPECTOR_CONTRACT).digest("hex"),
});
export const PI_PRIVATE_CAPABILITY_INPUT_INSPECTOR = Object.freeze({
  adapter: "pi",
  id: "tachyon.pi-private-capability-inputs",
  version: "1",
  sha256: crypto.createHash("sha256").update(PI_INSPECTOR_CONTRACT).digest("hex"),
});
export const GROK_PRIVATE_HOME_INPUT_INSPECTOR = Object.freeze({
  adapter: "grok",
  id: "tachyon.grok-private-home-inputs",
  version: "3",
  sha256: crypto.createHash("sha256").update(GROK_INSPECTOR_CONTRACT).digest("hex"),
});
export const CLAUDE_CLOSED_PRIVATE_HOME_INPUT_INSPECTOR = Object.freeze({
  adapter: "claude",
  id: "tachyon.claude-closed-private-home-inputs",
  version: "5",
  sha256: crypto.createHash("sha256").update(CLAUDE_INSPECTOR_CONTRACT).digest("hex"),
});

/**
 * SDD 478 M1 — keyed by `AttestedRuntime` and exhaustive by type: a runtime added to
 * `ATTESTED_RUNTIMES` without a measured inspector is a compile error here, which is what keeps
 * "attested" from drifting into "listed somewhere".
 */
const RUNTIME_INSPECTORS = {
  codex: CODEX_EMPTY_NATIVE_INPUT_INSPECTOR,
  pi: PI_PRIVATE_CAPABILITY_INPUT_INSPECTOR,
  grok: GROK_PRIVATE_HOME_INPUT_INSPECTOR,
  claude: CLAUDE_CLOSED_PRIVATE_HOME_INPUT_INSPECTOR,
} satisfies Record<AttestedRuntime, unknown>;

export function profileRuntimeInspectorFor(adapter: string) {
  return isAttestedRuntime(adapter) ? RUNTIME_INSPECTORS[adapter] : undefined;
}

/**
 * t-26f508 (review by claude-reviewer) — inspector descriptors that an ALREADY-CREATED authority may
 * still name, each superseded by a strictly stricter current inspector of the same id.
 *
 * This exists because a version bump is otherwise unrecoverable, and not merely for the agent that
 * bumped. `inspectMeasuredNativeInputs` returns a projection error, `loadProfileAwareConfig` returns
 * `{errors}` for the WHOLE config, so a single stale Grok authority stops every agent of every
 * runtime in that workspace from loading. And nothing can repair it in-product: `authorityFor` copies
 * `prior.runtimeInspector` on every edit, so a profile created under v1 can never reach v2 by being
 * edited. The only exits would be `forget` + recreate (destructive) or hand-editing a host authority
 * (which the trust model forbids). "No canonical Grok agent exists" was true of this dogfood
 * workspace and says nothing about an installed base that has been able to create one all along.
 *
 * Acceptance is safe only in one direction, and only per named sha: the current inspector must be a
 * strict SUPERSET of the superseded one — it may inspect more and isolate more, never less. v2 adds
 * the ambient project-input refusal and the `[compat.*]`/`[memory]` pins on top of everything v1
 * asserted, so a v1 authority loaded under v2 gets a stricter guarantee than it authorized, never a
 * weaker one. A future contract that RELAXES a guarantee must not be listed here.
 *
 * The attestation still carries the descriptor the AUTHORITY names, so `assertNativeAttestation`'s
 * exact match keeps holding and the record never claims a human authorized v2. `authorityFor` adopts
 * the current inspector on the next lifecycle transaction, which is where re-attestation belongs.
 */
const SUPERSEDED_RUNTIME_INSPECTORS: Partial<Record<AttestedRuntime, readonly InspectorDescriptor[]>> = {
  grok: [
    Object.freeze({
      adapter: "grok",
      id: "tachyon.grok-private-home-inputs",
      version: "1",
      sha256: crypto.createHash("sha256").update(GROK_INSPECTOR_CONTRACT_V1).digest("hex"),
    }),
    Object.freeze({
      adapter: "grok",
      id: "tachyon.grok-private-home-inputs",
      version: "2",
      sha256: crypto.createHash("sha256").update(GROK_INSPECTOR_CONTRACT_V2).digest("hex"),
    }),
  ],
};

export interface InspectorDescriptor {
  adapter: string;
  id: string;
  version: string;
  sha256: string;
}

function sameInspector(a: InspectorDescriptor, b: InspectorDescriptor): boolean {
  return a.adapter === b.adapter && a.id === b.id && a.version === b.version && a.sha256 === b.sha256;
}

/**
 * The descriptor to attest with for `actual`, or undefined when the authority names an inspector this
 * build does not recognize at all. Returns the CURRENT descriptor on an exact match and the
 * superseded one when it is explicitly listed, so the caller can attest to what the human authorized.
 */
export function acceptedRuntimeInspectorFor(
  adapter: string,
  actual: InspectorDescriptor,
): InspectorDescriptor | undefined {
  const current = profileRuntimeInspectorFor(adapter);
  if (current && sameInspector(current, actual)) return current;
  if (!isAttestedRuntime(adapter)) return undefined;
  return (SUPERSEDED_RUNTIME_INSPECTORS[adapter] ?? []).find((candidate) => sameInspector(candidate, actual));
}

/** Whether `actual` is a superseded descriptor this build still accepts — the adoption trigger. */
export function isSupersededRuntimeInspector(adapter: string, actual: InspectorDescriptor): boolean {
  if (!isAttestedRuntime(adapter)) return false;
  return (SUPERSEDED_RUNTIME_INSPECTORS[adapter] ?? []).some((candidate) => sameInspector(candidate, actual));
}

export interface ProjectAgentProfileInput {
  workspaceRoot: string;
  agentName: string;
  authority: AgentProfileAuthorityRecord;
  workspaceDefaults?: WorkspaceProfileDefaults;
  homeDir?: string;
}

export type ProjectAgentProfileResult =
  | { ok: true; definition: AgentEntry; resolved: ResolvedAgentProfile; warnings: string[] }
  | { ok: false; errors: string[] };

function closeQuietly(fd: number): void {
  try {
    fs.closeSync(fd);
  } catch {
    // Preserve the inspection result.
  }
}

function descriptorPath(fd: number): string {
  const expected = fs.fstatSync(fd, { bigint: true });
  for (const base of ["/proc/self/fd", "/dev/fd"]) {
    const candidate = `${base}/${fd}`;
    try {
      const actual = fs.statSync(candidate, { bigint: true });
      if (actual.dev === expected.dev && actual.ino === expected.ino) return candidate;
    } catch {
      // Try the next descriptor filesystem.
    }
  }
  throw new Error("host has no verified descriptor-relative filesystem path");
}

function inspectEmptyFileAt(root: string, segments: string[]): string | undefined {
  const label = path.join(root, ...segments);
  const noFollow = fs.constants.O_NOFOLLOW;
  const directory = fs.constants.O_DIRECTORY;
  const nonBlock = fs.constants.O_NONBLOCK;
  if (typeof noFollow !== "number" || typeof directory !== "number" || typeof nonBlock !== "number") {
    return `profile/native-attestation: no-follow inspection is unsupported for ${label}`;
  }
  const opened: number[] = [];
  try {
    const canonicalRoot = fs.realpathSync.native(root);
    let parent = fs.openSync(canonicalRoot, fs.constants.O_RDONLY | directory | noFollow | nonBlock);
    opened.push(parent);
    for (const segment of segments.slice(0, -1)) {
      const candidate = `${descriptorPath(parent)}/${segment}`;
      let child: number;
      try {
        child = fs.openSync(candidate, fs.constants.O_RDONLY | directory | noFollow | nonBlock);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        return `profile/native-attestation: cannot safely inspect ${label}`;
      }
      if (!fs.fstatSync(child).isDirectory()) {
        closeQuietly(child);
        return `profile/native-attestation: native config ancestry is not a regular no-follow directory: ${label}`;
      }
      opened.push(child);
      parent = child;
    }

    const candidate = `${descriptorPath(parent)}/${segments.at(-1)!}`;
    let file: number;
    try {
      file = fs.openSync(candidate, fs.constants.O_RDONLY | noFollow | nonBlock);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      return `profile/native-attestation: cannot safely inspect ${label}`;
    }
    opened.push(file);
    const before = fs.fstatSync(file, { bigint: true });
    if (!before.isFile()) return `profile/native-attestation: native config source is not a regular no-follow file: ${label}`;
    if (before.size > BigInt(NATIVE_CONFIG_MAX_BYTES)) {
      return `profile/native-attestation: native config exceeds the inspection limit: ${label}`;
    }
    const text = fs.readFileSync(file, "utf8");
    const after = fs.fstatSync(file, { bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
      return `profile/native-attestation: native config changed during inspection: ${label}`;
    }
    return text.trim().length > 0
      ? `profile/native-attestation: non-empty native config is not supported by the v1 Codex inspector: ${label}`
      : undefined;
  } catch {
    return `profile/native-attestation: cannot safely inspect ${label}`;
  } finally {
    for (const fd of opened.reverse()) closeQuietly(fd);
  }
}

function readNativeConfigTextAt(root: string, segments: string[]): { text?: string; error?: string } {
  const label = path.join(root, ...segments);
  const noFollow = fs.constants.O_NOFOLLOW;
  const directory = fs.constants.O_DIRECTORY;
  const nonBlock = fs.constants.O_NONBLOCK;
  if (typeof noFollow !== "number" || typeof directory !== "number" || typeof nonBlock !== "number") {
    return { error: `profile/native-config-source: no-follow reading is unsupported for ${label}` };
  }
  const opened: number[] = [];
  try {
    const canonicalRoot = fs.realpathSync.native(root);
    let parent = fs.openSync(canonicalRoot, fs.constants.O_RDONLY | directory | noFollow | nonBlock);
    opened.push(parent);
    for (const segment of segments.slice(0, -1)) {
      const candidate = `${descriptorPath(parent)}/${segment}`;
      let child: number;
      try {
        child = fs.openSync(candidate, fs.constants.O_RDONLY | directory | noFollow | nonBlock);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
        return { error: `profile/native-config-source: cannot safely read ${label}` };
      }
      if (!fs.fstatSync(child).isDirectory()) {
        closeQuietly(child);
        return { error: `profile/native-config-source: ancestry is not a regular no-follow directory: ${label}` };
      }
      opened.push(child);
      parent = child;
    }
    const candidate = `${descriptorPath(parent)}/${segments.at(-1)!}`;
    let file: number;
    try {
      file = fs.openSync(candidate, fs.constants.O_RDONLY | noFollow | nonBlock);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      return { error: `profile/native-config-source: cannot safely read ${label}` };
    }
    opened.push(file);
    const before = fs.fstatSync(file, { bigint: true });
    if (!before.isFile()) return { error: `profile/native-config-source: source is not a regular no-follow file: ${label}` };
    if (before.size > BigInt(NATIVE_CONFIG_MAX_BYTES)) return { error: `profile/native-config-source: source exceeds the read limit: ${label}` };
    const text = fs.readFileSync(file, "utf8");
    const after = fs.fstatSync(file, { bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
      return { error: `profile/native-config-source: source changed during reading: ${label}` };
    }
    return { text };
  } catch {
    return { error: `profile/native-config-source: cannot safely read ${label}` };
  } finally {
    for (const fd of opened.reverse()) closeQuietly(fd);
  }
}

function parseCanonicalProfile(workspaceRoot: string, agentName: string): { profile?: AgentProfileV1; errors: string[] } {
  let source: CanonicalAgentProfileSource | undefined;
  try {
    source = readCanonicalAgentProfile(workspaceRoot, agentName);
    if (!source) return { errors: [`profile/missing: .tachyon/agents/${agentName}/agent.yml`] };
    const doc = parseDocument(source.text, { uniqueKeys: true });
    if (doc.errors.length > 0) return { errors: [`profile/invalid-yaml: ${doc.errors[0]!.message}`] };
    const parsed = agentProfileSchemaV1.safeParse(doc.toJS());
    if (!parsed.success) return { errors: parsed.error.issues.map((issue) => `profile/schema: ${issue.path.join(".") || "profile"}: ${issue.message}`) };
    return { profile: parsed.data, errors: [] };
  } catch (error) {
    return { errors: [error instanceof Error ? error.message : String(error)] };
  } finally {
    if (source) closeCanonicalAgentProfile(source);
  }
}

function inspectMeasuredNativeInputs(input: ProjectAgentProfileInput, profile: AgentProfileV1): NativeRuntimeAttestation | string[] {
  if (!isAttestedRuntime(profile.runtime.adapter) || profile.runtime.executable !== profile.runtime.adapter) {
    return ["profile/native-attestation: measured profile projection supports only literal 'codex', 'pi', 'grok' and 'claude' executables"];
  }
  const hasRuntimeSelectors = Boolean(
    profile.runtime.model || profile.runtime.provider || profile.runtime.reasoningEffort || profile.runtime.serviceTier,
  );
  const selectorPolicy = profile.nativeConfig?.selectors;
  if (hasRuntimeSelectors && (
    !selectorPolicy
    || resolveAgentNativeConfigSupport(profile.runtime.adapter, "selectors", selectorPolicy).support !== "supported"
  )) {
    return ["profile/native-attestation: runtime selector migration requires a later measured projector"];
  }
  const actual = input.authority.runtimeInspector;
  // The descriptor to attest with: the current inspector, or an explicitly superseded one this build
  // still accepts. The CHECKS below are always the current build's — acceptance widens which
  // authority may load, never which inspection runs (t-26f508 review).
  const expected = acceptedRuntimeInspectorFor(profile.runtime.adapter, actual);
  if (!expected) {
    return [`profile/native-attestation: host authority does not select the registered ${profile.runtime.adapter} inspector`];
  }

  const hasCapabilities = [
    ...(profile.capabilities?.skills ?? []),
    ...(profile.capabilities?.mcp ?? []),
    ...(profile.capabilities?.hooks ?? []),
    ...Object.values(profile.capabilities?.pi ?? {}).flatMap((values) => values ?? []),
  ].length > 0;

  if (profile.runtime.adapter === "codex") {
    // Canonical Codex launch removes the private-home config before spawn
    // (`inheritNativeConfig:false`). A file left there by a legacy launch is a
    // stale projection, not an effective native input. Workspace config remains
    // effective and must still be empty under this inspector.
    const workspaceSelected = Object.values(profile.nativeConfig ?? {}).some((policy) => policy?.source === "workspace");
    const candidates: Array<[string, string[]]> = workspaceSelected
      ? []
      : [[input.workspaceRoot, [".codex", "config.toml"]]];
    const blockers: string[] = [];
    for (const [root, segments] of candidates) {
      const blocker = inspectEmptyFileAt(root, segments);
      if (blocker) blockers.push(blocker);
    }
    if (blockers.length > 0) return blockers;
  }
  if (profile.runtime.adapter === "grok") {
    // t-26f508 — redirecting GROK_HOME does NOT stop project discovery. Measured on 0.2.112 with
    // `grok inspect --json`: a `.grok/config.toml` in the project loads as a `project` config layer
    // and its `[mcp_servers]` entry reached the effective server list under a private home. The same
    // directory carries skills, plugins, agents, hooks, workflows and LSP definitions, and `AGENTS.md`
    // is read as project instructions. None of that is selectable by a family, so its presence is
    // refused rather than silently inherited — the Claude arm below does the same for its own roots.
    const ambientCandidates = [
      "AGENTS.md",
      ".grok/config.toml",
      ".grok/skills",
      ".grok/plugins",
      ".grok/agents",
      ".grok/hooks",
      ".grok/workflows",
      ".grok/lsp.json",
      ".grok/sandbox.toml",
    ];
    const blockers = ambientCandidates.flatMap((relative) => {
      try {
        fs.lstatSync(path.join(input.workspaceRoot, ...relative.split("/")));
        return [`profile/native-attestation: ambient Grok input must be absent: ${relative}`];
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === "ENOENT"
          ? []
          : [`profile/native-attestation: cannot safely inspect ambient Grok input: ${relative}`];
      }
    });
    if (blockers.length > 0) return blockers;
  }
  if (profile.runtime.adapter === "claude") {
    const ambientCandidates = [
      "CLAUDE.md",
      "CLAUDE.local.md",
      ".claude/agents",
      ".claude/commands",
      ".claude/plugins",
      ".claude-plugin",
    ];
    const blockers = ambientCandidates.flatMap((relative) => {
      try {
        fs.lstatSync(path.join(input.workspaceRoot, ...relative.split("/")));
        return [`profile/native-attestation: ambient Claude input must be absent: ${relative}`];
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === "ENOENT"
          ? []
          : [`profile/native-attestation: cannot safely inspect ambient Claude input: ${relative}`];
      }
    });
    if (blockers.length > 0) return blockers;
  }

  const runtime = { ...profile.runtime };
  return {
    adapter: profile.runtime.adapter,
    exhaustive: true,
    authorityRevision: input.authority.revision,
    selectorsSha256: agentProfileRuntimeSelectorsSha256(runtime),
    inspector: { id: expected.id, version: expected.version, sha256: expected.sha256 },
    observations: profile.runtime.adapter === "grok"
      ? [
          { field: "environment.GROK_HOME", source: "environment", suppressed: true },
          { field: "capabilities.mcp", source: "private-runtime-config", suppressed: true },
        ]
      : profile.runtime.adapter === "claude"
        ? [
            { field: "environment.CLAUDE_CONFIG_DIR", source: "environment", suppressed: true },
            { field: "capabilities.mcp", source: "private-runtime-config", suppressed: true },
            { field: "capabilities.hooks", source: "private-runtime-config", suppressed: true },
            { field: "capabilities.skills", source: "private-runtime-config", suppressed: true },
          ]
      : hasCapabilities ? [{
          field: profile.runtime.adapter === "pi" ? "capabilities.pi" : "capabilities.mcp",
          source: "private-runtime-config",
          suppressed: true,
        }] : [],
  };
}

const CAPABILITY_REFERENCE_KINDS = new Set(["skill", "mcp", "hook", "pi-extension", "pi-prompt", "pi-theme", "pi-package"]);

/**
 * `t-d185e1` — the selector's profile-local path, shared with the writer so the two cannot drift.
 * The reader below refuses any reference pointing anywhere else.
 */
export const EVOLUTION_SELECTOR_PATH = "evolution-selector.json";

function readEvolutionSelector(
  workspaceRoot: string,
  agentName: string,
  profile: AgentProfileV1,
): { profileId: string; selectorSha256: string } | string[] | undefined {
  const id = profile.prompt?.evolution;
  if (!id) return undefined;
  const reference = profile.references?.find((candidate) => candidate.id === id);
  if (!reference || reference.kind !== "evolution" || reference.scope !== "profile"
    || reference.owner !== profile.agentId || reference.path !== EVOLUTION_SELECTOR_PATH
    || reference.mode !== "pinned" || !reference.sha256) {
    return ["profile/evolution-selector: canonical Evolution selector reference is invalid"];
  }
  const source = readCanonicalAgentProfile(workspaceRoot, agentName);
  if (!source) return ["profile/evolution-selector: canonical profile disappeared"];
  try {
    const selected = readAgentProfileReference(source, reference.path, reference.sha256);
    const parsed = JSON.parse(selected.text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
      || (parsed as Record<string, unknown>).schemaVersion !== 1
      || typeof (parsed as Record<string, unknown>).profileId !== "string"
      || !/^[A-Za-z0-9][A-Za-z0-9._:+-]{0,255}$/.test((parsed as { profileId: string }).profileId)
      || Object.keys(parsed as Record<string, unknown>).sort().join(",") !== "profileId,schemaVersion") {
      return ["profile/evolution-selector: selector bytes are invalid"];
    }
    return { profileId: (parsed as { profileId: string }).profileId, selectorSha256: selected.sha256 };
  } catch (error) {
    return [`profile/evolution-selector: ${error instanceof Error ? error.message : String(error)}`];
  } finally {
    closeCanonicalAgentProfile(source);
  }
}

function captureProjectCapabilities(input: ProjectAgentProfileInput, profile: AgentProfileV1): ExternalProfileReference[] | string[] {
  const external: ExternalProfileReference[] = [];
  const selected = new Set([
    ...(profile.capabilities?.skills ?? []),
    ...(profile.capabilities?.mcp ?? []),
    ...(profile.capabilities?.hooks ?? []),
    ...Object.values(profile.capabilities?.pi ?? {}).flatMap((values) => values ?? []),
  ]);
  for (const reference of profile.references ?? []) {
    if (reference.scope !== "project" || !CAPABILITY_REFERENCE_KINDS.has(reference.kind) || !selected.has(reference.id)) continue;
    try {
      const capturedCapability = captureCapabilitySourceAtRoot(input.workspaceRoot, reference.path, reference.sha256!);
      external.push({
        id: reference.id,
        scope: "project",
        owner: reference.owner,
        path: reference.path,
        sha256: capturedCapability.sha256,
        ...(reference.version ? { version: reference.version } : {}),
        capturedCapability,
      });
    } catch (error) {
      if (error instanceof AgentCapabilitySourceError) return [`${error.code}: ${error.message}`];
      return [`profile/reference-unavailable: ${reference.path}: project capability could not be captured`];
    }
  }
  return external;
}

function projectDefinition(
  resolved: ResolvedAgentProfile,
  evolutionSelector?: { profileId: string; selectorSha256: string },
  nativeConfigProjection?: ResolvedAgentNativeConfigProjection,
): AgentEntry | string[] {
  const definition = resolved.definition;
  const errors: string[] = [];
  if (!resolved.agentId) errors.push("profile/projection: canonical profile identity is missing");
  if (!isAttestedRuntime(definition.runtime.adapter) || definition.runtime.executable !== definition.runtime.adapter || definition.runtime.args?.length) {
    errors.push("profile/projection: unsupported runtime projection");
  }
  if (definition.environment?.secrets && Object.keys(definition.environment.secrets).length > 0) {
    errors.push("profile/projection: secret injection belongs to a later slice");
  }
  errors.push(...validateAgentNativeConfigPolicy(definition.runtime.adapter, definition.nativeConfig));
  if (definition.prompt?.soul || definition.prompt?.instructions || definition.prompt?.memory) {
    // t-50bbd4 — this used to defer to t-a2827d, which CLOSED on 2026-07-22, so the message pointed
    // at nobody. The structural fact is what a reader needs: these three do not project into
    // `prompt.*` at all. They are formation LANES, published under transaction and authority
    // (`humanLaneTransactions.ts`), and reached at spawn through the lifecycle port rather than
    // through this projection. Naming the mechanism outlasts naming a task.
    errors.push(
      "profile/projection: Soul, instructions and memory are formation lanes, not projected prompt fields — "
        + "publish them through the profile's lane authority instead",
    );
  }
  if (definition.prompt?.evolution && !evolutionSelector) {
    errors.push("profile/projection: Evolution selector is unavailable");
  }
  const nonCapabilityReferences = resolved.references.filter((reference) =>
    !CAPABILITY_REFERENCE_KINDS.has(reference.kind) && reference.id !== definition.prompt?.evolution
  );
  if (nonCapabilityReferences.length > 0) errors.push("profile/projection: referenced setup/prompt materialization is not available yet");
  if (definition.workspace?.verify || definition.workspace?.worktree?.setup?.length) {
    errors.push("profile/projection: verification/setup references are not materialized yet");
  }
  if (definition.workspace?.worktree?.base) {
    errors.push("profile/projection: per-agent worktree.base is not representable by the current runtime");
  }
  const attention = definition.lifecycle?.attention;
  if (attention?.silenceSec === 0) errors.push("profile/projection: attention.silenceSec must be at least 1 for the current runtime");
  if (errors.length > 0) return errors;

  const projected: AgentEntry = {
    cmd: definition.runtime.executable,
    autostart: definition.lifecycle?.autostart ?? false,
    watch: [...(definition.lifecycle?.watch ?? [])],
    attention: {
      enabled: attention?.enabled ?? true,
      silenceSec: attention?.silenceSec ?? PROFILE_ATTENTION_DEFAULT_SILENCE_SEC,
      patterns: [...(attention?.patterns ?? [])],
    },
    restart: definition.lifecycle?.restart ?? "never",
    kind: "agent",
  };
  if (definition.workspace?.cwd) projected.cwd = definition.workspace.cwd;
  if (definition.environment?.values) projected.env = { ...definition.environment.values };
  if (definition.prompt?.role) projected.role = definition.prompt.role;
  if (evolutionSelector) {
    projected.selfEvolution = { enabled: true };
    projected.profileEvolution = evolutionSelector;
  }
  if (definition.workspace?.worktree?.enabled !== undefined) projected.worktree = definition.workspace.worktree.enabled;
  if (definition.workspace?.worktree?.branch) projected.branch = definition.workspace.worktree.branch;
  if (definition.isolation) projected.isolate = definition.isolation;
  if (definition.ownership?.subagents) projected.subagents = [...definition.ownership.subagents];
  if (resolved.capabilityProjection) {
    projected.profileCapabilities = { ...resolved.capabilityProjection, effectiveProfileSha256: resolved.effectiveSha256 };
  }
  if (nativeConfigProjection) projected.profileNativeConfig = nativeConfigProjection;
  projected.profileLifecycle = {
    enabled: definition.lifecycle?.enabled ?? true,
    agentId: resolved.agentId!,
    canonicalSha256: resolved.sourceSha256,
    authorityRevision: resolved.authorityRevision,
  };
  return projected;
}

export function projectCanonicalAgentProfile(input: ProjectAgentProfileInput): ProjectAgentProfileResult {
  const parsed = parseCanonicalProfile(input.workspaceRoot, input.agentName);
  if (!parsed.profile) return { ok: false, errors: parsed.errors };
  if (parsed.profile.agentId !== input.authority.agentId || input.authority.agentName !== input.agentName) {
    return { ok: false, errors: ["profile/authority-boundary: authority identity does not match canonical profile"] };
  }
  const externalReferences = captureProjectCapabilities(input, parsed.profile);
  if (Array.isArray(externalReferences) && externalReferences.length > 0 && typeof externalReferences[0] === "string") {
    return { ok: false, errors: externalReferences as string[] };
  }
  const attestation = inspectMeasuredNativeInputs(input, parsed.profile);
  if (Array.isArray(attestation)) return { ok: false, errors: attestation };
  let nativeConfigProjection = projectAgentNativeConfig(parsed.profile);
  const warnings: string[] = [];
  if (parsed.profile.runtime.adapter === "codex") {
    const selectedSources = new Set(
      Object.values(parsed.profile.nativeConfig ?? {})
        .map((policy) => policy?.source)
        .filter((source): source is "global" | "workspace" => source === "global" || source === "workspace"),
    );
    const sourceTexts: { global?: string; workspace?: string } = {};
    for (const source of selectedSources) {
      const read = source === "global"
        ? readNativeConfigTextAt(input.homeDir ?? os.homedir(), [".codex", "config.toml"])
        : readNativeConfigTextAt(input.workspaceRoot, [".codex", "config.toml"]);
      if (read.error) return { ok: false, errors: [read.error] };
      if (read.text !== undefined) sourceTexts[source] = read.text;
    }
    const scalar = projectCodexScalarNativeConfig(
      parsed.profile,
      sourceTexts,
      nativeConfigProjection ?? { adapter: "codex", selectors: {} },
    );
    if (scalar.errors.length > 0) return { ok: false, errors: scalar.errors };
    warnings.push(...scalar.warnings);
    if (parsed.profile.nativeConfig && Object.keys(parsed.profile.nativeConfig).length > 0) {
      nativeConfigProjection = scalar.projection;
    }
  }
  if (parsed.profile.runtime.adapter === "claude" && nativeConfigProjection) {
    const sourceTexts: { global?: string; workspace?: string } = {};
    for (const source of ["global", "workspace"] as const) {
      const selectedScalar = ["permissions", "interface", "featureFlags"].some(
        (family) => parsed.profile!.nativeConfig?.[family as "permissions" | "interface" | "featureFlags"]?.source === source,
      );
      if (!selectedScalar) continue;
      const read = source === "global"
        ? readNativeConfigTextAt(input.homeDir ?? os.homedir(), [".claude", "settings.json"])
        : readNativeConfigTextAt(input.workspaceRoot, [".claude", "settings.json"]);
      if (read.error) return { ok: false, errors: [read.error] };
      if (read.text !== undefined) sourceTexts[source] = read.text;
    }
    const scalar = projectClaudeNativeConfig(parsed.profile, sourceTexts, nativeConfigProjection);
    if (scalar.errors.length > 0) return { ok: false, errors: scalar.errors };
    nativeConfigProjection = scalar.projection;
  }
  if (parsed.profile.runtime.adapter === "grok" && nativeConfigProjection) {
    // t-26f508 — one source, because `global` is the only source Grok honors for these families.
    const selectsGlobal = ["selectors", "permissions", "interface", "featureFlags"].some((family) =>
      parsed.profile!.nativeConfig?.[family as AgentNativeConfigFamily]?.source === "global",
    );
    const read = selectsGlobal
      ? readNativeConfigTextAt(input.homeDir ?? os.homedir(), [".grok", "config.toml"])
      : {};
    if (read.error) return { ok: false, errors: [read.error] };
    const scalar = projectGrokNativeConfig(
      parsed.profile,
      read.text !== undefined ? { global: read.text } : {},
      nativeConfigProjection,
    );
    if (scalar.errors.length > 0) return { ok: false, errors: scalar.errors };
    warnings.push(...scalar.warnings);
    nativeConfigProjection = scalar.projection;
  }
  const evolutionSelector = readEvolutionSelector(input.workspaceRoot, input.agentName, parsed.profile);
  if (Array.isArray(evolutionSelector)) return { ok: false, errors: evolutionSelector };
  const resolved = resolveAgentProfile({
    workspaceRoot: input.workspaceRoot,
    agentName: input.agentName,
    authority: authoritySnapshotFor(input.authority),
    nativeRuntime: attestation,
    workspaceDefaults: input.workspaceDefaults,
    externalReferences: externalReferences as ExternalProfileReference[],
  });
  if (!resolved.ok) return { ok: false, errors: resolved.errors.map((error) => `${error.code}: ${error.message}`) };
  const definition = projectDefinition(resolved.value, evolutionSelector, nativeConfigProjection);
  if (Array.isArray(definition)) return { ok: false, errors: definition };
  return { ok: true, definition, resolved: resolved.value, warnings };
}
