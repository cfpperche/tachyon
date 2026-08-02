/**
 * t-09edf2 — projecting an installed plugin's GATE hook into an agent's own session.
 *
 * ## The defect this exists for
 *
 * `secrets-guard` ships two independent layers. Layer 1 is a `pre-commit` git hook loaded through
 * `core.hooksPath`, which is repository-level config and therefore already reaches every linked
 * worktree. Layer 2 is a `PreToolUse(Bash)` shape-gate that refuses `git commit --no-verify` (and the
 * other bypass shapes) BEFORE Git runs — and it is installed as a `settings-hook` into
 * `.claude/settings.json` / `.codex/hooks.json` of the checkout the human installed into.
 *
 * Measured 2026-08-01 on a Codex agent in a delegated worktree: layer 1 blocked a synthetic staged
 * credential with `leaks found: 1`, while `git commit --no-verify --definitely-invalid-option` reached
 * the Git binary and exited 129. Layer 2 was simply not there. It misses for a different reason in each
 * runtime, which is why neither runtime's absence is evidence about the other:
 *
 *  - **Codex** runs with a private `CODEX_HOME` and its cwd is the delegated worktree, which has no
 *    `.codex/hooks.json` — the file exists only in the authority checkout.
 *  - **Claude** saved agents run with `--setting-sources user`, which closes the `project` source
 *    outright; delegated Claude agents keep the project source but their cwd is, again, a worktree
 *    without a `.claude/` tree.
 *
 * ## Why this is not "re-open inheritance"
 *
 * `worktreeProjection.ts` retired `.claude/skills` / `.agents/skills` under a standing ruling: an agent
 * given its own worktree that did not explicitly ask to inherit the workspace's configuration must not
 * have it. That ruling is not weakened here, and this module is built so it cannot be:
 *
 *  1. **Nothing is discovered from the agent's environment.** The material is the plugin LOCKFILE the
 *     human installed into the authority checkout — the same custodied record `uninstall` replays — and
 *     never the cwd, never an ambient settings file, never `$HOME`.
 *  2. **Nothing projects unless the workspace says so, by name.** `settings.agentHookProjection` maps a
 *     plugin name to the class the human assigns it. An unclassified plugin projects nothing. That
 *     explicit statement IS the "unless the user says so" the ruling asks for.
 *  3. **Only `enforcement` projects, and only on GATE events.** A hook that can add prompt content,
 *     observe, or hand the agent a capability stays out whatever the workspace calls it — the event
 *     allowlist is `FAIL_CLOSED_HOOK_EVENTS`, the product's existing name for "a hook whose failure must
 *     block". Classification therefore cannot be spent on anything but refusal.
 *
 * ## Who else can reach this (docs/project-guidance.md)
 *
 * The plan is a pure function of (lockfile, classification, runtime), so every door that spawns a
 * session recomputes the SAME plan rather than each door carrying its own copy of the policy:
 *
 *  - *Interface × install* — writes the authority lockfile. A live pane keeps the argv it was born with;
 *    the next door picks the change up. Nothing here reaches into a running session.
 *  - *Agent Claude × create/restart/resume/fork* — one channel, the per-spawn `--settings` layer.
 *  - *Agent Codex × create/restart/resume/fork* — one channel, the per-spawn `-c hooks.<Event>=` flags.
 *  - *Tachyon × crash-recovery* — recovery re-derives from the custodied lockfile, so a recovered
 *    session is projected exactly like a fresh one and imports nothing from the environment it woke in.
 *  - *Grok (and every other runtime)* — refused by name with a reason, never silently empty. The
 *    `secrets-guard` 2.0.4 manifest declares no Grok block, so Tachyon must not claim layer 2 there.
 */

import fs from "node:fs";
import path from "node:path";
import { LOCKFILE_REL_PATH, parseLockfile, type PluginLock } from "./lockfile.js";
import type { HookGroup, HooksBlock } from "./adapters/hooks.js";
import { FAIL_CLOSED_HOOK_EVENTS, parseOwnedHooks } from "./adapters/hooks.js";
import { CLAUDE_HOOK_EVENTS } from "./adapters/claude.js";
import { CODEX_HOOK_EVENTS } from "./adapters/codex.js";

/**
 * The class a workspace assigns an installed plugin's hooks. Deliberately the same vocabulary as the
 * profile-capability `hookClass`, so a human who has classified a hook in one place reads the other
 * without translation. Only `enforcement` is projectable.
 */
export type ProjectedHookClass = "capability" | "prompt-transform" | "observability" | "enforcement";

export const PROJECTED_HOOK_CLASSES: readonly ProjectedHookClass[] = [
  "capability",
  "prompt-transform",
  "observability",
  "enforcement",
];

/** Runtimes whose per-spawn channel Tachyon owns end-to-end and can therefore project into. */
export const PROJECTABLE_HOOK_RUNTIMES = ["claude", "codex"] as const;
export type ProjectableHookRuntime = (typeof PROJECTABLE_HOOK_RUNTIMES)[number];

const KNOWN_EVENTS: Record<ProjectableHookRuntime, ReadonlySet<string>> = {
  claude: CLAUDE_HOOK_EVENTS,
  codex: CODEX_HOOK_EVENTS,
};

/** Workspace classification: plugin name → the class the human assigned it. */
export type AgentHookProjectionPolicy = Readonly<Record<string, ProjectedHookClass>>;

export interface ProjectedHookSource {
  plugin: string;
  version: string;
  event: string;
  /** How many hook groups this plugin contributes to that event. */
  groups: number;
}

export interface WithheldHookSource {
  plugin: string;
  /** Human-readable, and deliberately specific: "not classified" and "classified observability" differ. */
  reason: string;
}

export interface ProjectedPluginHooks {
  runtime: string;
  /** event → groups, ready to hand to the runtime's own channel. Empty when nothing projects. */
  hooks: HooksBlock;
  projected: ProjectedHookSource[];
  withheld: WithheldHookSource[];
}

function isProjectableRuntime(runtime: string): runtime is ProjectableHookRuntime {
  return (PROJECTABLE_HOOK_RUNTIMES as readonly string[]).includes(runtime);
}

/** Narrow the lockfile to what this decision needs, so a caller may pass a hand-built record in a test. */
export interface HookProjectionCandidate {
  name: string;
  version: string;
  targets: readonly { runtime?: string; kind: string; file: string; ref?: string; removal?: unknown }[];
}

export function hookProjectionCandidates(plugins: readonly PluginLock[]): HookProjectionCandidate[] {
  return plugins.map((plugin) => ({ name: plugin.name, version: plugin.version, targets: plugin.targets }));
}

/**
 * Read the candidates from the AUTHORITY checkout's lockfile — `workspaceRoot`, never an agent's cwd.
 *
 * This is the only I/O in the module, and it is deliberately the only place a path is involved: an
 * unreadable or malformed lockfile yields no candidates, so a corrupt record can withhold a gate but can
 * never invent one. Callers pass the same root the plugin engine installed into, so a delegated worktree
 * reads its authority's record rather than looking for a `.tachyon/` tree it does not have.
 */
export function readHookProjectionCandidates(workspaceRoot: string): HookProjectionCandidate[] {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(workspaceRoot, LOCKFILE_REL_PATH), "utf8");
  } catch {
    return [];
  }
  const parsed = parseLockfile(raw);
  return parsed.lockfile ? hookProjectionCandidates(Object.values(parsed.lockfile.plugins)) : [];
}

/**
 * Decide, for one runtime, exactly which installed-plugin hook groups reach an agent session.
 *
 * Fail-closed at every step: an unknown runtime, an unclassified plugin, a non-`enforcement` class, a
 * non-gate event and a lockfile `removal` that no longer parses each produce a WITHHELD entry with its
 * reason rather than a silently smaller result. A caller that reports "nothing projected" without the
 * reasons would be indistinguishable from a caller whose policy is simply empty — which is the exact
 * confusion that let layer 2 be missing for a day without anyone noticing.
 */
export function planProjectedPluginHooks(input: {
  plugins: readonly HookProjectionCandidate[];
  runtime: string;
  policy: AgentHookProjectionPolicy;
}): ProjectedPluginHooks {
  const classified = Object.entries(input.policy)
    .filter(([, hookClass]) => hookClass === "enforcement")
    .map(([plugin]) => plugin);
  if (!isProjectableRuntime(input.runtime)) {
    // Named, never silent. A runtime with no Tachyon-owned per-spawn hook channel cannot be given
    // layer 2, and claiming it is protected would be worse than saying it is not.
    return {
      runtime: input.runtime,
      hooks: {},
      projected: [],
      withheld: classified.sort().map((plugin) => ({
        plugin,
        reason: `runtime '${input.runtime}' has no Tachyon-owned per-spawn hook channel — layer 2 is NOT projected there`,
      })),
    };
  }

  const runtime: ProjectableHookRuntime = input.runtime;
  const hooks: HooksBlock = {};
  const projected: ProjectedHookSource[] = [];
  const withheld: WithheldHookSource[] = [];
  const known = KNOWN_EVENTS[runtime];

  // A plugin the workspace classified that is not installed at all. Named rather than ignored: the human
  // wrote the line believing a gate would follow, and silence would leave them believing it still.
  const installed = new Set(input.plugins.map((plugin) => plugin.name));
  for (const plugin of classified.filter((name) => !installed.has(name)).sort()) {
    withheld.push({ plugin, reason: "is classified 'enforcement' but is not installed in this workspace" });
  }

  for (const plugin of [...input.plugins].sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))) {
    const targets = plugin.targets.filter((target) => target.kind === "settings-hook" && target.runtime === input.runtime);
    const assigned = input.policy[plugin.name];
    if (targets.length === 0) {
      // Classified but installs no hook for THIS runtime — `secrets-guard` 2.0.4 has claude and codex
      // blocks and nothing else, so a Grok agent must hear that rather than read an empty result as safe.
      if (assigned === "enforcement") {
        withheld.push({ plugin: plugin.name, reason: `installs no ${input.runtime} settings-hook — its manifest declares no ${input.runtime} block` });
      }
      continue;
    }
    if (assigned === undefined) {
      withheld.push({
        plugin: plugin.name,
        reason: `installs ${input.runtime} settings-hooks but settings.agentHookProjection does not classify it — nothing is projected`,
      });
      continue;
    }
    if (assigned !== "enforcement") {
      withheld.push({
        plugin: plugin.name,
        reason: `classified '${assigned}'; only 'enforcement' hooks are projected into an agent session`,
      });
      continue;
    }

    for (const target of targets) {
      const event = target.ref;
      if (!event || !known.has(event)) {
        withheld.push({ plugin: plugin.name, reason: `records a ${input.runtime} hook for unknown event ${JSON.stringify(event ?? "")}` });
        continue;
      }
      if (!FAIL_CLOSED_HOOK_EVENTS.has(event)) {
        // Classification buys refusal, not reach. An `enforcement` plugin still cannot project a
        // Stop/UserPromptSubmit hook into a session that was never offered its content.
        withheld.push({
          plugin: plugin.name,
          reason: `event '${event}' is not a gate event; an enforcement class projects only ${[...FAIL_CLOSED_HOOK_EVENTS].sort().join(", ")}`,
        });
        continue;
      }
      // The lockfile is Tachyon-authored but hand-editable, so its opaque `removal` is re-validated
      // with the same parser `uninstall` trusts — a corrupt entry withholds instead of writing garbage
      // into an agent's launch channel.
      const parsed = parseOwnedHooks({ [event]: target.removal });
      const groups = parsed.owned?.[event];
      if (!groups || groups.length === 0) {
        withheld.push({
          plugin: plugin.name,
          reason: `its recorded ${input.runtime} '${event}' groups are unreadable: ${parsed.errors.join("; ") || "empty"}`,
        });
        continue;
      }
      const rejected = groups.filter((group) => !validGroupFor(runtime, group));
      if (rejected.length > 0) {
        withheld.push({ plugin: plugin.name, reason: `its recorded ${input.runtime} '${event}' groups are not valid for ${input.runtime}` });
        continue;
      }
      hooks[event] = [...(hooks[event] ?? []), ...groups];
      projected.push({ plugin: plugin.name, version: plugin.version, event, groups: groups.length });
    }
  }

  return { runtime: input.runtime, hooks, projected, withheld };
}

/**
 * `statusMessage` is a Codex-only field. Writing one into a Claude settings file is the same authoring
 * mistake `parseHooksBlock` fails closed on, so it is refused here too rather than quietly stripped.
 */
function validGroupFor(runtime: ProjectableHookRuntime, group: HookGroup): boolean {
  if (group.hooks.length === 0) return false;
  return group.hooks.every((hook) =>
    hook.type === "command"
    && typeof hook.command === "string"
    && hook.command.trim().length > 0
    && (runtime === "codex" || hook.statusMessage === undefined));
}

/** One line for a log or a completion report; says what reached the session AND what deliberately did not. */
export function describeProjectedPluginHooks(plan: ProjectedPluginHooks): string {
  const parts: string[] = [];
  if (plan.projected.length > 0) {
    parts.push(`projected into the ${plan.runtime} session: ${plan.projected.map((entry) => `${entry.plugin}@${entry.version} ${entry.event}`).join(", ")}`);
  }
  for (const entry of plan.withheld) parts.push(`withheld ${entry.plugin}: ${entry.reason}`);
  return parts.join(" · ") || `no installed plugin declares a projectable ${plan.runtime} gate hook`;
}
