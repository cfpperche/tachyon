import { isMap, parseDocument, type YAMLMap } from "yaml";
import { asAgent, parseConfig, type AgentEntry, type ParseResult, type TachyonConfig } from "./loadConfig.js";
import type { WorkspaceProfileDefaults } from "./agentProfileResolver.js";
import type { AgentProfileAuthorityRecord } from "./agentProfileAuthority.js";
import { agentRosterDirectoryWarning, scanAgentRosterDirectory } from "./agentRosterDirectory.js";
import { projectCanonicalAgentProfile } from "./agentProfileProjection.js";

export type AgentConfigSource =
  | { mode: "terminal"; source: string }
  | {
      mode: "profile";
      source: string;
      agentId: string;
      profileSha256: string;
      effectiveSha256: string;
      authorityRevision: string;
    }
  /**
   * t-0ad300 — declared, refused, and therefore NOT in `config.agents`.
   *
   * The isolation added by t-588644 keeps the healthy roster loading by deleting the refused
   * agent from the document, which is what the legacy parser needs. Downstream that made "refused"
   * indistinguishable from "never declared", and the agent vanished from the sidebar — the silent
   * failure t-588644 set out to avoid. It also stranded the repair: Agent Studio opens from a
   * roster row, so an agent with a stale pin had no reachable control to reauthorize it.
   *
   * This entry is the one place that still remembers the name. It carries no command on purpose —
   * a refused agent must not be spawnable, and a shape with no `cmd` cannot accidentally become
   * one.
   */
  | { mode: "refused"; source: string; reason: string };

export type ProfileAwareTachyonConfig = TachyonConfig & {
  agentSources: Record<string, AgentConfigSource>;
};

export type ProfileAwareParseResult = Omit<ParseResult, "config"> & {
  config?: ProfileAwareTachyonConfig;
  /**
   * t-588644 — the subset of `errors` that belongs to ONE agent's profile and to nothing else.
   *
   * Every entry is also in `errors`, so a caller that only asks "is this config valid?" keeps
   * refusing exactly what it refused before. The split exists for the one caller that must not: the
   * live load path, where treating a single agent's broken profile as a broken FILE takes the whole
   * roster down with it.
   *
   * Measured before this existed: two agents, one with a pin left stale by a plugin update, and the
   * healthy one — which produced no error at all — did not load either. `config` was undefined and no
   * agent survived. `agentNativeConfigPolicy.ts` had already named the hazard in another context
   * ("a refused profile is not a refused agent"); a plugin update walks into it with no lane out.
   *
   * `config` is populated in that case, carrying the agents that DID project. The refused ones are
   * absent from it, which is why the caller must surface these strings rather than drop them — an
   * agent that vanishes quietly is a worse failure than one that refuses loudly.
   */
  profileErrors: string[];
};

export interface LoadProfileAwareConfigInput {
  yamlText: string;
  workspaceRoot: string;
  authorities: ReadonlyMap<string, AgentProfileAuthorityRecord>;
  workspaceDefaults?: WorkspaceProfileDefaults;
  homeDir?: string;
}

/**
 * t-ae221c — the ONE thing `tachyon.yml` still has to say about `agents:`, and it is a warning.
 *
 * Migration without a migrator. Every `tachyon.yml` in the world still carries the block, and under
 * t-48dd8d a retired key is accepted and ignored rather than refused — so the file a human already
 * wrote keeps loading, its terminals and settings keep working, and the block simply stops meaning
 * anything. Nothing here rewrites the human's file; saying it can go is the whole product answer.
 *
 * Deliberately a WARNING and not a `discarded` entry: `discarded` blocks a programmatic write
 * (t-099be8), and blocking Agent Studio from ever writing a terminal or a setting again until a human
 * hand-edits an inert block would make the forgiving read pointless.
 */
export const LEGACY_AGENTS_BLOCK_WARNING =
  "agents: is no longer the fleet roster — a directory under .tachyon/agents/ with a readable "
  + "agent.yml is. The block was ignored and can be deleted from this file.";

/**
 * Strip the retired `agents:` block, warning when there was one, and stub the roster the caller
 * measured. Returns the warnings; the document is mutated in place.
 */
function replaceAgentsBlock(doc: ReturnType<typeof parseDocument>, rosterNames: readonly string[]): string[] {
  const warnings: string[] = [];
  const declared = doc.get("agents", true);
  if (declared !== undefined && declared !== null && (!isMap(declared) || (declared as YAMLMap).items.length > 0)) {
    warnings.push(LEGACY_AGENTS_BLOCK_WARNING);
  }
  doc.delete("agents");
  for (const agentName of rosterNames) doc.setIn(["agents", agentName], { cmd: "codex" });
  return warnings;
}

/**
 * Syntax-only compatibility pass for constructor-time settings. It reads no bytes off disk, so it
 * cannot know the roster: a caller that needs the fleet in the result measures it with
 * `scanAgentRosterDirectory` and passes the names in. A caller that only wants `settings:` — which is
 * every constructor-time caller — passes nothing and gets an empty roster, which is honest.
 */
export function parseProfileAwareConfigSyntax(yamlText: string, rosterNames: readonly string[] = []): ParseResult {
  const doc = parseDocument(yamlText, { uniqueKeys: true });
  if (doc.errors.length > 0) {
    return { errors: doc.errors.map((error) => `invalid YAML: ${error.message}`), warnings: [], discarded: [] };
  }
  const warnings = replaceAgentsBlock(doc, rosterNames);
  const parsed = parseConfig(String(doc));
  return { ...parsed, warnings: [...warnings, ...parsed.warnings] };
}

/**
 * Trusted second-phase loader. YAML declaration parsing remains pure; profile
 * bytes, host authority and runtime-native inputs are resolved only here.
 */
export function loadProfileAwareConfig(input: LoadProfileAwareConfigInput): ProfileAwareParseResult {
  const doc = parseDocument(input.yamlText, { uniqueKeys: true });
  // Unreadable YAML is a property of the FILE, not of any one agent: nothing here can be isolated,
  // because the document that carries the terminals and the settings cannot be read at all.
  if (doc.errors.length > 0) {
    return {
      errors: doc.errors.map((error) => `invalid YAML: ${error.message}`),
      warnings: [], discarded: [], profileErrors: [],
    };
  }

  // t-ae221c — THE roster, and the only place it is decided.
  const roster = scanAgentRosterDirectory(input.workspaceRoot);
  const errors: string[] = [];
  // t-588644 — every string pushed here is ALSO pushed to `errors`. This is the isolatable subset,
  // not a second error channel; see the field docs on ProfileAwareParseResult.
  const profileErrors: string[] = [];
  const profileWarnings: string[] = roster.nonMembers.map(agentRosterDirectoryWarning);
  const profileSources: Record<string, AgentConfigSource> = {};
  const projected = new Map<string, AgentEntry>();
  // t-0ad300 — the refused names, kept so they can still be rendered as refused. Recorded here and
  // merged into `agentSources` only if a healthy remainder survives; when nothing does, the whole
  // file fails and there is no roster to put them in.
  const refused = new Map<string, { source: string; reason: string }>();
  const refuse = (agentName: string, source: string, reason: string) => {
    const message = `agents.${agentName}${reason}`;
    errors.push(message);
    profileErrors.push(message);
    if (!refused.has(agentName)) refused.set(agentName, { source, reason: reason.replace(/^[.:]\s*/, "").replace(/^\.profile:\s*/, "") });
  };

  for (const agentName of roster.members) {
    const home = `.tachyon/agents/${agentName}/agent.yml`;
    const authority = input.authorities.get(agentName);
    if (!authority) {
      refuse(agentName, home, ".profile: host profile authority is missing");
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
      for (const error of result.errors) refuse(agentName, home, `.profile: ${error}`);
      continue;
    }
    projected.set(agentName, result.definition);
    profileWarnings.push(...result.warnings.map((warning) => `agents.${agentName}.profile: ${warning}`));
    profileSources[agentName] = {
      mode: "profile",
      source: home,
      agentId: authority.agentId,
      profileSha256: result.resolved.sourceSha256,
      effectiveSha256: result.resolved.effectiveSha256,
      authorityRevision: result.resolved.authorityRevision,
    };
  }

  // t-588644 — a failure that is NOT a single agent's profile still fails the file: it means the
  // declaration itself cannot be trusted, and there is no healthy subset to salvage.
  //
  // Neither is there when EVERY agent was refused. Continuing then would hand the legacy parser an
  // empty `agents` map — which is a valid empty roster after t-f67185 — and silently drop the
  // per-agent refusal reasons. Isolation is for saving a healthy remainder; with no remainder the
  // honest answer is the original failure.
  if (errors.length > profileErrors.length || (errors.length > 0 && projected.size === 0)) {
    return { errors, warnings: [], discarded: [], profileErrors };
  }
  // t-ae221c — the retired block leaves the document before the legacy parser sees it, and the
  // projected roster takes its place. A refused agent is simply never written back, which is what
  // keeps it out of `config.agents` while `agentSources` still remembers its name (t-0ad300).
  profileWarnings.unshift(...replaceAgentsBlock(doc, []));
  for (const [agentName, definition] of projected) {
    const {
      profileCapabilities: _profileCapabilities,
      profileWithheldCapabilities: _profileWithheldCapabilities,
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
  if (!parsed.config) return { errors: parsed.errors, warnings: parsed.warnings, discarded: parsed.discarded, profileErrors };
  const warnings = [...profileWarnings, ...parsed.warnings.filter((warning) => {
    const profileName = [...projected.keys()].find((name) => warning.startsWith(`agents.${name}: isolate: transcript is deprecated`));
    return profileName === undefined;
  })];
  for (const [agentName, definition] of projected) {
    // A canonical profile projects an Agent, and the re-parse carries its stored `kind: agent`
    // through — so this narrowing always succeeds. If it ever did not, the internal projections
    // below would have no arm to land on, which is a refusal rather than a silent drop.
    const entry = asAgent(parsed.config.agents[agentName]);
    if (!entry) return { errors: [`agents.${agentName}.profile: canonical projection did not reload as an agent`], warnings: [], discarded: [], profileErrors };
    if (definition.profileCapabilities) entry.profileCapabilities = definition.profileCapabilities;
    if (definition.profileWithheldCapabilities) entry.profileWithheldCapabilities = definition.profileWithheldCapabilities;
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
  // t-0ad300 — the refused entries go in LAST and never overwrite a projected one. A name cannot be
  // both, but the ordering is what guarantees it rather than the loop above happening to run first.
  for (const [name, entry] of refused) {
    if (agentSources[name] === undefined) agentSources[name] = { mode: "refused", ...entry };
  }
  return { ...parsed, errors, warnings, profileErrors, config: { ...parsed.config, agentSources } };
}
