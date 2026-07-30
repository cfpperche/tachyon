import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { parse, stringify } from "yaml";
import {
  parseAgentProfileAuthorityRegistry,
  serializeAgentProfileAuthorityRegistry,
  type AgentProfileAuthorityRecord,
} from "../../src/config/agentProfileAuthority.js";
import { agentProfileAuthoritiesSecretKey } from "../../src/workspace/operationalStateKeys.js";
import {
  CLAUDE_CLOSED_PRIVATE_HOME_INPUT_INSPECTOR,
  CODEX_EMPTY_NATIVE_INPUT_INSPECTOR,
  GROK_PRIVATE_HOME_INPUT_INSPECTOR,
  PI_PRIVATE_CAPABILITY_INPUT_INSPECTOR,
} from "../../src/config/agentProfileProjection.js";
import { workspaceHash } from "../../src/tmux/TmuxService.js";
import type { AttestedRuntime } from "../../src/runtime/attestedRuntimes.js";

/**
 * SDD 478 M7 — declare a REAL agent in a headless test workspace.
 *
 * Before this, `Workspace.createForTest` set `allowLegacyAgentFixtures: true` unconditionally, so
 * every headless test ran against an inline `agents:` shape the product refuses. Removing that shim
 * means a test that needs an agent must build what an agent actually is: a Saved profile on disk
 * plus the host-custodied authority that attests it. This helper builds exactly that — it is not a
 * compatibility layer, it produces the same shape a real workspace has.
 *
 * A test that only needs a supervised PROCESS wants `terminals:` instead, and needs none of this.
 */

const INSPECTORS = {
  claude: CLAUDE_CLOSED_PRIVATE_HOME_INPUT_INSPECTOR,
  codex: CODEX_EMPTY_NATIVE_INPUT_INSPECTOR,
  grok: GROK_PRIVATE_HOME_INPUT_INSPECTOR,
  pi: PI_PRIVATE_CAPABILITY_INPUT_INSPECTOR,
} satisfies Record<AttestedRuntime, unknown>;

/** Deterministic v4-shaped id per agent name, so authority and profile agree without a random source. */
function agentIdFor(name: string): string {
  const hex = createHash("sha256").update(`tachyon-test-agent:${name}`).digest("hex");
  return [hex.slice(0, 8), hex.slice(8, 12), `4${hex.slice(13, 16)}`, `8${hex.slice(17, 20)}`, hex.slice(20, 32)].join("-");
}

export interface SavedAgentSpec {
  /** attested runtime; the executable always equals the adapter (the projection requires it). */
  runtime?: AttestedRuntime;
  /**
   * Typed runtime selectors. This is how a Saved agent expresses "run this model at this
   * reasoning effort": NOT as argv. The profile carries the values, the launcher composes the
   * runtime's own flags (`--model`/`--effort` for claude, `-c model=…` for codex), and declaring
   * them requires the matching `nativeConfig.selectors` policy — which this helper writes.
   */
  selectors?: { model?: string; provider?: string; reasoningEffort?: string; serviceTier?: string };
  role?: "coder" | "reviewer" | "tester" | "orchestrator" | "custom";
  /**
   * Not projectable, and t-50bbd4 established that this is permanent rather than pending: Soul,
   * instructions and memory are formation LANES published under transaction and authority, not
   * `prompt.*` fields, so `projectDefinition` refuses them by design. The comment used to say they
   * "belong to t-a2827d" — a task that closed on 2026-07-22 — which read as "coming soon" and was
   * never going to arrive by that route. Kept out of the spec so a caller cannot silently produce a
   * profile the loader rejects.
   */
  cwd?: string;
  autostart?: boolean;
  attention?: { enabled?: boolean; silenceSec?: number; patterns?: string[] };
  /** extra top-level profile sections (evolution selectors, ownership, …). */
  extra?: Record<string, unknown>;
}

export interface SavedAgentFixture {
  name: string;
  agentId: string;
  profilePath: string;
  profileSha256: string;
  authority: AgentProfileAuthorityRecord;
  /** the `agents:` stanza body for tachyon.yml — a POINTER, never a definition. */
  pointerYaml: string;
}

/** Write `.tachyon/agents/<name>/agent.yml` and return the matching host authority record. */
export function writeSavedAgent(root: string, name: string, spec: SavedAgentSpec = {}): SavedAgentFixture {
  const runtime = spec.runtime ?? "codex";
  const agentId = agentIdFor(name);
  const profileDir = path.join(root, ".tachyon", "agents", name);
  fs.mkdirSync(profileDir, { recursive: true });
  const profile = stringify({
    schemaVersion: 1,
    agentId,
    runtime: { adapter: runtime, executable: runtime, ...(spec.selectors ?? {}) },
    ...(spec.selectors
      ? {
        nativeConfig: {
          selectors: {
            source: "agent",
            treatment: "overlay",
            refresh: "every-launch",
            lifecycle: runtime === "claude" ? ["fresh", "restart", "resume", "fork"] : ["fresh", "restart", "resume"],
          },
        },
      }
      : {}),
    ...(spec.role ? { prompt: { role: spec.role } } : {}),
    ...(spec.cwd || spec.autostart !== undefined || spec.attention
      ? {
        ...(spec.cwd ? { workspace: { cwd: spec.cwd } } : {}),
        ...(spec.autostart !== undefined || spec.attention
          ? { lifecycle: { ...(spec.autostart !== undefined ? { autostart: spec.autostart } : {}), ...(spec.attention ? { attention: spec.attention } : {}) } }
          : {}),
      }
      : {}),
    ...(spec.extra ?? {}),
  });
  const profilePath = path.join(profileDir, "agent.yml");
  fs.writeFileSync(profilePath, profile, "utf8");
  return {
    name,
    agentId,
    profilePath,
    profileSha256: createHash("sha256").update(profile).digest("hex"),
    authority: {
      schemaVersion: 1,
      agentName: name,
      agentId,
      revision: `${name}-r1`,
      canonicalSha256: createHash("sha256").update(profile).digest("hex"),
      runtimeInspector: { ...INSPECTORS[runtime] },
    },
    pointerYaml: `  ${name}:\n    profile: .tachyon/agents/${name}/agent.yml\n`,
  };
}

/** The secrets backend a `SharedSecretHost` needs so the workspace can attest these agents. */
export function savedAgentSecrets(root: string, agents: readonly SavedAgentFixture[]): Map<string, string> {
  const secrets = new Map<string, string>();
  secrets.set(
    agentProfileAuthoritiesSecretKey(workspaceHash(root)),
    serializeAgentProfileAuthorityRegistry(new Map(agents.map((agent) => [agent.name, agent.authority]))),
  );
  return secrets;
}

/** `agents:` block for a set of Saved agents (pointers only). */
export function savedAgentsYaml(agents: readonly SavedAgentFixture[]): string {
  return agents.length === 0 ? "agents: {}\n" : `agents:\n${agents.map((agent) => agent.pointerYaml).join("")}`;
}

/**
 * Turn on `selfEvolution` for an already-declared Saved agent.
 *
 * The projection only grants `selfEvolution: { enabled: true }` when the profile pins an
 * `evolution-selector.json` naming the SAME profileId the Evolution store already holds
 * (`AgentManager.evolutionForFreshSession` refuses a spawn when the two disagree). So the store's
 * profile has to exist first — its id is minted by the store, never by the caller — which is why
 * this runs against a live workspace's `evolutionStore` output rather than at declaration time.
 *
 * Nothing in `src/` writes this selector today (the formation lane pins `evolution/profile.json`
 * under a different contract), so this is the only way a test can reach the enabled projection.
 * Rewrites the profile and re-signs its authority; the caller must reload the workspace afterwards,
 * because the authority registry is read once at construction.
 */
export function enableSavedAgentSelfEvolution(
  root: string,
  name: string,
  profileId: string,
  secrets: Map<string, string>,
): void {
  const profileDir = path.join(root, ".tachyon", "agents", name);
  const selector = `${JSON.stringify({ profileId, schemaVersion: 1 })}\n`;
  fs.writeFileSync(path.join(profileDir, "evolution-selector.json"), selector, "utf8");
  const profilePath = path.join(profileDir, "agent.yml");
  const source = parse(fs.readFileSync(profilePath, "utf8")) as Record<string, unknown>;
  const agentId = source.agentId as string;
  const profile = stringify({
    ...source,
    prompt: { ...(source.prompt as Record<string, unknown> | undefined), evolution: "evolution" },
    references: [
      ...((source.references as unknown[] | undefined) ?? []),
      {
        id: "evolution",
        kind: "evolution",
        scope: "profile",
        owner: agentId,
        path: "evolution-selector.json",
        mode: "pinned",
        sha256: createHash("sha256").update(selector).digest("hex"),
      },
    ],
  });
  fs.writeFileSync(profilePath, profile, "utf8");
  const key = agentProfileAuthoritiesSecretKey(workspaceHash(root));
  const registry = parseAgentProfileAuthorityRegistry(secrets.get(key));
  const authority = registry.get(name);
  if (!authority) throw new Error(`no authority for '${name}' — declare it with writeSavedAgent first`);
  registry.set(name, {
    ...authority,
    revision: `${name}-r2`,
    canonicalSha256: createHash("sha256").update(profile).digest("hex"),
  });
  secrets.set(key, serializeAgentProfileAuthorityRegistry(registry));
}
