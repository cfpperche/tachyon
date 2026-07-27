import { isMap, isScalar, parseDocument, type Scalar, type YAMLMap } from "yaml";
import { asAgent, parseConfig, type AgentEntry, type ParseResult, type TachyonConfig } from "./loadConfig.js";
import type { WorkspaceProfileDefaults } from "./agentProfileResolver.js";
import type { AgentProfileAuthorityRecord } from "./agentProfileAuthority.js";
import { scanAgentProfilePointers } from "./agentProfilePointer.js";
import { projectCanonicalAgentProfile } from "./agentProfileProjection.js";
import { isValidAgentName } from "./nameValidation.js";

export type AgentConfigSource =
  | { mode: "terminal"; source: string }
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
  const doc = parseDocument(yamlText, { uniqueKeys: true });
  const inlineAgents = declaredAgentNames(doc).filter((name) => !scan.pointers.has(name));
  if (inlineAgents.length > 0) {
    return {
      errors: inlineAgents.map((name) =>
        `agents.${name}: inline agent definitions are no longer supported; create or edit the canonical agent in Agent Studio`),
      warnings: [],
    };
  }
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
  const projected = new Map<string, AgentEntry>();

  for (const agentName of declaredAgentNames(doc)) {
    if (!isValidAgentName(agentName)) continue;
    const pointer = scan.pointers.get(agentName);
    if (!pointer) {
      errors.push(
        `agents.${agentName}: inline agent definitions are no longer supported; create or edit the canonical agent in Agent Studio`,
      );
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
    const {
      profileCapabilities: _profileCapabilities,
      profileNativeConfig: _profileNativeConfig,
      profileEvolution: _profileEvolution,
      profileLifecycle: _profileLifecycle,
      ...publicDefinition
    } = definition;
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
    // A canonical profile projects an Agent, and the re-parse carries its stored `kind: agent`
    // through — so this narrowing always succeeds. If it ever did not, the internal projections
    // below would have no arm to land on, which is a refusal rather than a silent drop.
    const entry = asAgent(parsed.config.agents[agentName]);
    if (!entry) return { errors: [`agents.${agentName}.profile: canonical projection did not reload as an agent`], warnings: [] };
    if (definition.profileCapabilities) entry.profileCapabilities = definition.profileCapabilities;
    if (definition.profileNativeConfig) entry.profileNativeConfig = definition.profileNativeConfig;
    if (definition.profileEvolution) entry.profileEvolution = definition.profileEvolution;
    if (definition.profileLifecycle) entry.profileLifecycle = definition.profileLifecycle;
  }
  const agentSources: Record<string, AgentConfigSource> = {};
  for (const name of Object.keys(parsed.config.agents)) {
    agentSources[name] = profileSources[name] ?? {
      mode: "terminal",
      source: `tachyon.yml#terminals.${name}`,
    };
  }
  return { ...parsed, warnings, config: { ...parsed.config, agentSources } };
}
