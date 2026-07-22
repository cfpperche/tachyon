import { isMap, isScalar, parseDocument, type Scalar, type YAMLMap } from "yaml";
import { parseConfig, type AgentDef, type ParseResult, type TachyonConfig } from "./loadConfig.js";
import type { WorkspaceProfileDefaults } from "./agentProfileResolver.js";
import type { AgentProfileAuthorityRecord } from "./agentProfileAuthority.js";
import { scanAgentProfilePointers } from "./agentProfilePointer.js";
import { projectCanonicalAgentProfile } from "./agentProfileProjection.js";
import {
  closeCanonicalAgentProfile,
  readCanonicalAgentProfile,
  type CanonicalAgentProfileSource,
} from "./agentProfileReader.js";
import { isValidAgentName } from "./nameValidation.js";

export type AgentConfigSource =
  | { mode: "legacy"; source: string }
  | {
      mode: "profile";
      source: string;
      agentId: string;
      profileSha256: string;
      effectiveSha256: string;
      authorityRevision: string;
    };

export type ProfileAwareTachyonConfig = TachyonConfig & {
  agentSources: Record<string, AgentConfigSource>;
};

export type ProfileAwareParseResult = Omit<ParseResult, "config"> & {
  config?: ProfileAwareTachyonConfig;
};

export interface LoadProfileAwareConfigInput {
  yamlText: string;
  workspaceRoot: string;
  authorities: ReadonlyMap<string, AgentProfileAuthorityRecord>;
  workspaceDefaults?: WorkspaceProfileDefaults;
  homeDir?: string;
}

/**
 * Syntax-only compatibility pass for constructor-time settings. It proves the
 * pointer shape but deliberately does not claim that a profile is spawnable.
 */
export function parseProfileAwareConfigSyntax(yamlText: string): ParseResult {
  const scan = scanAgentProfilePointers(yamlText);
  if (scan.errors.length > 0) return { errors: scan.errors, warnings: [] };
  if (scan.pointers.size === 0) return parseConfig(yamlText);
  const doc = parseDocument(yamlText, { uniqueKeys: true });
  for (const agentName of scan.pointers.keys()) {
    doc.setIn(["agents", agentName], { cmd: "codex" });
  }
  return parseConfig(String(doc));
}

function scalarText(value: unknown): string | undefined {
  return isScalar(value) && typeof (value as Scalar).value === "string"
    ? String((value as Scalar).value)
    : undefined;
}

function declaredAgentNames(doc: ReturnType<typeof parseDocument>): string[] {
  const agents = doc.get("agents", true);
  if (!isMap(agents)) return [];
  return (agents as YAMLMap).items
    .map((pair) => scalarText(pair.key))
    .filter((name): name is string => name !== undefined);
}

function inlineCanonicalConflict(workspaceRoot: string, agentName: string): string | undefined {
  let source: CanonicalAgentProfileSource | undefined;
  try {
    source = readCanonicalAgentProfile(workspaceRoot, agentName);
    if (!source) return undefined;
    return `agents.${agentName}: inline configuration conflicts with canonical profile ${source.source}; remove one authority source`;
  } catch (error) {
    return `agents.${agentName}: cannot prove canonical profile absence while inline configuration is authoritative: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    if (source) closeCanonicalAgentProfile(source);
  }
}

/**
 * Trusted second-phase loader. YAML declaration parsing remains pure; profile
 * bytes, host authority and runtime-native inputs are resolved only here.
 */
export function loadProfileAwareConfig(input: LoadProfileAwareConfigInput): ProfileAwareParseResult {
  const scan = scanAgentProfilePointers(input.yamlText);
  if (scan.errors.length > 0) return { errors: scan.errors, warnings: [] };

  const doc = parseDocument(input.yamlText, { uniqueKeys: true });
  const errors: string[] = [];
  const profileSources: Record<string, AgentConfigSource> = {};
  const projected = new Map<string, AgentDef>();

  for (const agentName of declaredAgentNames(doc)) {
    if (!isValidAgentName(agentName)) continue;
    const pointer = scan.pointers.get(agentName);
    if (!pointer) {
      const conflict = inlineCanonicalConflict(input.workspaceRoot, agentName);
      if (conflict) errors.push(conflict);
      continue;
    }
    const authority = input.authorities.get(agentName);
    if (!authority) {
      errors.push(`agents.${agentName}.profile: host profile authority is missing`);
      continue;
    }
    const result = projectCanonicalAgentProfile({
      workspaceRoot: input.workspaceRoot,
      agentName,
      authority,
      workspaceDefaults: input.workspaceDefaults,
      homeDir: input.homeDir,
    });
    if (!result.ok) {
      errors.push(...result.errors.map((error) => `agents.${agentName}.profile: ${error}`));
      continue;
    }
    projected.set(agentName, result.definition);
    profileSources[agentName] = {
      mode: "profile",
      source: pointer.path,
      agentId: authority.agentId,
      profileSha256: result.resolved.sourceSha256,
      effectiveSha256: result.resolved.effectiveSha256,
      authorityRevision: result.resolved.authorityRevision,
    };
  }

  if (errors.length > 0) return { errors, warnings: [] };
  for (const [agentName, definition] of projected) {
    const { profileCapabilities: _profileCapabilities, ...publicDefinition } = definition;
    const parserInput: Record<string, unknown> = { ...publicDefinition };
    // The legacy parser's normalized output always contains watch: [], while
    // its source syntax deliberately rejects an explicitly empty watch list.
    if (definition.watch.length === 0) delete parserInput.watch;
    doc.setIn(["agents", agentName], parserInput);
  }

  const parsed = parseConfig(String(doc));
  if (!parsed.config) return { errors: parsed.errors, warnings: parsed.warnings };
  const warnings = parsed.warnings.filter((warning) => {
    const profileName = [...projected.keys()].find((name) => warning.startsWith(`agents.${name}: isolate: transcript is deprecated`));
    return profileName === undefined;
  });
  for (const [agentName, definition] of projected) {
    if (definition.profileCapabilities) parsed.config.agents[agentName]!.profileCapabilities = definition.profileCapabilities;
  }
  const agentSources: Record<string, AgentConfigSource> = {};
  for (const name of Object.keys(parsed.config.agents)) {
    agentSources[name] = profileSources[name] ?? {
      mode: "legacy",
      source: `tachyon.yml#agents-or-terminals.${name}`,
    };
  }
  return { ...parsed, warnings, config: { ...parsed.config, agentSources } };
}
