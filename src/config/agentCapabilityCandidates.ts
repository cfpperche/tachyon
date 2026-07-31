/**
 * t-5498a6 — what a human may authorize for one agent, in two lists that are NOT interchangeable.
 *
 * ## Why a query and not part of the profile snapshot
 *
 * `AgentProfileStudioSnapshotV1` is revisioned, and the Studio uses that revision as a CAS token.
 * Installing a plugin changes none of it. Candidates carried inside that snapshot would go stale
 * while still claiming to be current, and a save would compare-and-set against a revision that never
 * described them. Candidates are workspace state; the snapshot is profile state.
 *
 * ## Why two lists
 *
 * A skill installed by a Tachyon plugin and one written by hand in this repo are different things
 * with different provenance, and the discriminator is the plugin LOCKFILE, never a content
 * comparison — a plugin skill edited by hand diverges from the plugin tree and is still the plugin's.
 * Comparing content would classify it as hand-written and pin the wrong source.
 */

import fs from "node:fs";
import path from "node:path";

/** Where each runtime loads skills from, mirroring the plugin engine's adapter table. */
const SKILLS_REL: Record<string, string> = {
  claude: ".claude/skills",
  codex: ".agents/skills",
};

export interface AuthorizableWorkspaceSkill {
  name: string;
  /** Workspace-relative path of the skill directory, under the agent runtime's own skills dir. */
  path: string;
}

export interface AuthorizablePlugin {
  name: string;
  version: string;
  /** Runtimes the manifest declares. */
  runtimes: string[];
  /** Skill names this plugin installs FOR THIS AGENT'S RUNTIME. */
  skills: string[];
  /**
   * Target kinds this plugin also exposes that no capability grant can currently carry —
   * `settings-hook`, `view`. Present so the refusal can name them.
   */
  ungrantableKinds: string[];
  /** False when this plugin cannot be authorized for this agent; `reason` says why. */
  authorizable: boolean;
  reason?: string;
}

export interface AuthorizableCapabilities {
  workspaceSkills: AuthorizableWorkspaceSkill[];
  plugins: AuthorizablePlugin[];
  /**
   * t-c01f91 — plugins that act on the CHECKOUT through git hooks and install nothing a capability
   * grant could carry (`verify-gate`). They are omitted from `plugins` because they are not agent
   * capabilities at all: `core.hooksPath` is repository-level config, shared by every worktree, so
   * they already apply and there is nothing to authorize.
   *
   * Named here rather than dropped silently. Listing one as "installs nothing for claude" would be
   * technically true and semantically false — it reads as absence while the gate is working.
   */
  checkoutOnlyPlugins: string[];
}

interface LockedPlugin {
  name: string;
  version: string;
  runtimes: string[];
  targets: { kind: string; file: string; runtime?: string }[];
}

/**
 * List what this agent's runtime could be given.
 *
 * A plugin that does not serve this runtime is RETURNED, not omitted, carrying the reason. An option
 * that is hidden is indistinguishable from one that does not exist, and the human then cannot tell
 * "this plugin installs only for claude" from "this plugin is not installed".
 */
export function listAuthorizableCapabilities(workspaceRoot: string, adapter: string): AuthorizableCapabilities {
  const lock = readPluginLock(workspaceRoot);
  const claimed = new Set<string>();
  for (const plugin of lock) {
    for (const target of plugin.targets) {
      if (target.kind === "skill-dir") claimed.add(path.posix.basename(target.file));
    }
  }

  // A plugin with no targets at all installs nothing a grant could carry, for any runtime. It is not
  // a candidate in either direction — not authorizable, not refusable — so it leaves this list and is
  // reported as what it is.
  const checkoutOnlyPlugins = lock
    .filter((plugin) => plugin.targets.length === 0)
    .map((plugin) => plugin.name)
    .sort();
  const plugins = lock
    .filter((plugin) => plugin.targets.length > 0)
    .map((plugin) => describePlugin(plugin, adapter))
    .sort((left, right) => left.name.localeCompare(right.name));

  const skillsRel = SKILLS_REL[adapter];
  const workspaceSkills: AuthorizableWorkspaceSkill[] = [];
  if (skillsRel) {
    for (const name of readDirNames(path.join(workspaceRoot, skillsRel))) {
      // Claimed by a plugin → it belongs to the plugin list, whatever its content says now.
      if (claimed.has(name)) continue;
      workspaceSkills.push({ name, path: `${skillsRel}/${name}` });
    }
  }

  return {
    workspaceSkills: workspaceSkills.sort((left, right) => left.name.localeCompare(right.name)),
    plugins,
    checkoutOnlyPlugins,
  };
}

function describePlugin(plugin: LockedPlugin, adapter: string): AuthorizablePlugin {
  const mine = plugin.targets.filter((target) => target.runtime === undefined || target.runtime === adapter);
  const skills = mine.filter((target) => target.kind === "skill-dir").map((target) => path.posix.basename(target.file)).sort();
  const ungrantableKinds = [...new Set(mine.filter((target) => target.kind !== "skill-dir").map((target) => target.kind))].sort();
  const base = { name: plugin.name, version: plugin.version, runtimes: plugin.runtimes, skills, ungrantableKinds };

  if (!plugin.runtimes.includes(adapter)) {
    return {
      ...base,
      authorizable: false,
      reason: `installs for ${plugin.runtimes.join(", ") || "no runtime"} — not ${adapter}`,
    };
  }
  // Authorizing a plugin authorizes EVERYTHING it exposes, so a plugin exposing something no grant
  // can carry is refused whole rather than partially. Granting only its skills would report success
  // while half the plugin never reached the agent — the silent-gap failure this whole slice exists to
  // avoid.
  if (ungrantableKinds.length > 0) {
    return {
      ...base,
      authorizable: false,
      reason: `also installs ${ungrantableKinds.join(", ")}, which no capability grant can carry yet — authorizing only its skills would deliver half the plugin`,
    };
  }
  if (skills.length === 0) {
    return { ...base, authorizable: false, reason: `installs nothing for ${adapter}` };
  }
  return { ...base, authorizable: true };
}

function readDirNames(directory: string): string[] {
  try {
    return fs.readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

export function readPluginLock(workspaceRoot: string): LockedPlugin[] {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(path.join(workspaceRoot, ".tachyon/plugins.lock.json"), "utf8"));
  } catch {
    return [];
  }
  const plugins = (raw as { plugins?: Record<string, unknown> } | null)?.plugins;
  if (!plugins || typeof plugins !== "object") return [];
  const parsed: LockedPlugin[] = [];
  for (const value of Object.values(plugins)) {
    const entry = value as Partial<LockedPlugin>;
    if (typeof entry?.name !== "string" || typeof entry.version !== "string") continue;
    parsed.push({
      name: entry.name,
      version: entry.version,
      runtimes: Array.isArray(entry.runtimes) ? entry.runtimes.filter((r): r is string => typeof r === "string") : [],
      targets: Array.isArray(entry.targets)
        ? entry.targets.filter((t): t is { kind: string; file: string; runtime?: string } =>
          typeof (t as { kind?: unknown })?.kind === "string" && typeof (t as { file?: unknown })?.file === "string")
        : [],
    });
  }
  return parsed;
}
