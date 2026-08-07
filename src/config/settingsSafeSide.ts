/**
 * t-48dd8d — which way the product falls when a `settings:` key is DISCARDED, and what to do about
 * it when the answer is "wider".
 *
 * The loader used to be fail-closed as a whole: one unknown key anywhere put a message in `errors[]`,
 * a non-empty `errors[]` meant no config at all, and the workspace dropped to its degraded roster.
 * One mistyped letter in `settings.ideBrowser` took the fleet down. The owner's decision on
 * 2026-08-07 is that the whole file warns instead: the wrong or unrecognized part is discarded and
 * the rest loads.
 *
 * Discarding is only safe when absence lands on the CLOSED side, and for most keys it does —
 * `settings.auth` is read as `auth ?? true`, so an `auth` typo turns authentication ON. But absence
 * is not always the closed side, and the two worst cases are not obvious:
 *
 *   - `tabSafety.ts` reads `if (!allowedHosts || allowedHosts.length === 0) return true` — a missing
 *     host allowlist permits EVERY host.
 *   - `AgentManager.ts` gives a delegated codex agent `approval_policy="never"` +
 *     `sandbox_mode="danger-full-access"` when nothing is authored — so discarding an authored
 *     `sandboxMode: read-only` does not fall to a runtime default, it falls to full access.
 *
 * So the rule is not "discard and warn". It is: WHEN DISCARDING, FALL TO THE SAFE SIDE. A block that
 * produced any warning is untrustworthy, and the door it governs closes instead of opening.
 *
 * This module is the single source of truth for that decision AND for which keys the parser accepts
 * at all (`loadConfig` reads its key lists from here rather than restating them). That pairing is
 * what gives `scripts/check-settings-fallbacks.mjs` its teeth: a key added to the config type but
 * not declared here is not accepted by the parser and turns the guard red, and a key declared here
 * but absent from the type fails typecheck the moment the parser tries to store it. Nobody can add
 * a permissive-default key without saying so out loud.
 */

import { binaryOf } from "../resume/adapters.js";
import type { AgentPermissionProjectionEntry, ManagedEntryDef, TachyonConfig } from "./loadConfig.js";

/**
 * Which way the product falls when this key is discarded, measured against what the FILE ASKED FOR
 * rather than against some other default. The question is: does there exist a legal value of this
 * key such that discarding it permits or exposes MORE than that value would?
 */
export type FallbackDirection =
  /** discarding can only produce an equal or more restrictive state */
  | "closes"
  /** the key governs no permission or exposure — cosmetic, informational, or a plain preference */
  | "same"
  /** discarding can permit or expose more than some legal value of the key would have */
  | "opens";

/**
 * How the key relates to the `TachyonConfig["settings"]` type. The guard cross-checks both ways, so
 * this has to distinguish a key that is stored from one that is merely tolerated and from an
 * internal field that is written by the parser rather than authored by a human.
 */
export type SettingsKeyKind =
  /** authored, validated, and stored on `TachyonConfig["settings"]` */
  | "stored"
  /** authored and deliberately accepted-and-ignored (retired keys); no property on the type */
  | "ignored"
  /** a property on the type that the parser WRITES; it is not an accepted authoring key */
  | "internal";

export interface SettingsKeyFallback {
  /** dotted path under `settings:` — e.g. `companion.allowedHosts` */
  readonly path: string;
  readonly kind: SettingsKeyKind;
  readonly direction: FallbackDirection;
  /** the survey line: what the product does with this key absent, and where that is read */
  readonly why: string;
  /**
   * Required on an `opens` key that no closure covers: why no safe value can be installed. The guard
   * refuses an `opens` key that has neither a closure nor this, which is the whole point — the cost
   * of leaving a door open has to be written down by whoever leaves it open.
   */
  readonly acceptedRisk?: string;
}

/**
 * Every `settings:` key, with the direction measured at the point of use rather than guessed from
 * the name. The survey behind this table is in the `t-48dd8d` journal.
 */
export const SETTINGS_KEY_FALLBACKS: readonly SettingsKeyFallback[] = [
  {
    path: "maxAgents",
    kind: "stored",
    direction: "opens",
    why: "absent falls to DEFAULT_MAX_AGENTS (8, AgentManager.ts); an authored cap BELOW 8 is widened by discarding it",
    acceptedRisk:
      "a fleet budget, not an authority: there is no safe cap to synthesize from an unreadable one, the product's own answer for a workspace that never mentions the key is 8, and over-spawning is visible in the fleet and reversible",
  },
  {
    path: "agentMemoryMax",
    kind: "stored",
    direction: "opens",
    why: "absent means no systemd MemoryMax wrap at all (agentMemoryScope.ts) — agent spawn trees run with no memory ceiling",
    acceptedRisk:
      "a resource ceiling, not an authority: no byte figure is derivable from an unreadable one, and absence is exactly the state of every workspace that never set it",
  },
  {
    path: "bridgePort",
    kind: "stored",
    direction: "same",
    why: "absent falls to derivePort(wsHash) — a loopback port either way",
  },
  {
    path: "auth",
    kind: "stored",
    direction: "closes",
    why: "read as `auth ?? true` (extension.ts, Workspace.ts) — discarding TURNS AUTHENTICATION ON",
  },
  {
    path: "legacyBridgeAuth",
    kind: "stored",
    direction: "opens",
    why: "read as `legacyBridgeAuth ?? true` (Workspace.ts) — absent ACCEPTS the shared legacy token as a caller identity, so discarding an authored `false` reopens the migration window",
  },
  {
    path: "layout",
    kind: "ignored",
    direction: "same",
    why: "the layouts feature is retired; the key is tolerated so a legacy value is not reported as a typo",
  },
  {
    path: "tmux",
    kind: "stored",
    direction: "same",
    why: "an overlay of preferences on Tachyon's own tmux defaults; `remain-on-exit` and `exit-empty` are reserved and never reach the map",
  },
  {
    path: "worktree.base",
    kind: "stored",
    direction: "same",
    why: "absent falls to the shared XDG-aware default location (WorktreeManager.ts)",
  },
  {
    path: "worktree.branch",
    kind: "stored",
    direction: "same",
    why: "absent falls to the default branch template (WorktreeManager.ts)",
  },
  {
    path: "worktree.verify",
    kind: "stored",
    direction: "opens",
    why: "absent means NO verify gate and no badge (worktree/verify.ts) — a discarded gate is a check that stops running",
    acceptedRisk:
      "a verification command cannot be synthesized from an unreadable one, and inventing a gate would be a promise the product cannot keep; the warning names the key and the gate is opt-in to begin with",
  },
  {
    path: "worktree.revealInWorkspace",
    kind: "stored",
    direction: "opens",
    why: "read as `revealInWorkspace !== false` (workspaceFolderOps.ts) — absent REVEALS worktree folders in the window, so discarding an authored `false` widens what the window exposes",
  },
  {
    path: "worktree.shareDependencies",
    kind: "stored",
    direction: "opens",
    why: "read as `shareDependencies !== false` (WorktreeManager.ts) — absent SHARES node_modules with the primary checkout, so a worktree agent whose tooling writes into node_modules writes into the primary checkout",
  },
  {
    path: "verify.full",
    kind: "stored",
    direction: "same",
    why: "primer text (bridge/primer.ts); accepted per key, so one bad command does not take the others",
  },
  {
    path: "verify.typecheck",
    kind: "stored",
    direction: "same",
    why: "primer text (bridge/primer.ts); accepted per key",
  },
  {
    path: "verify.prepare",
    kind: "stored",
    direction: "same",
    why: "primer text for dependency materialization; accepted per key",
  },
  {
    path: "verify.affected",
    kind: "stored",
    direction: "same",
    why: "primer text for the affected-test tier; accepted per key",
  },
  {
    path: "verify.behavior",
    kind: "ignored",
    direction: "same",
    why: "retired with verify_task and gated delegation; kept known so a workspace is told what happened instead of hunting for a spelling mistake",
  },
  {
    path: "projectGuidance",
    kind: "stored",
    direction: "same",
    why: "paths are accepted individually, so only an unusable path is dropped and the rest of the guidance still travels",
  },
  {
    path: "anchor.auto",
    kind: "stored",
    direction: "closes",
    why: "read as `anchor?.auto ?? false` (Workspace.ts) — the risky live re-anchor injection is opt-in, so absence stops it",
  },
  {
    path: "bridgeGuidance",
    kind: "stored",
    direction: "closes",
    why: "read as `bridgeGuidance ?? true` (AgentManager.ts) — absent APPENDS the coordination guidance; more instruction, never more permission",
  },
  {
    path: "agentHookProjection",
    kind: "stored",
    direction: "closes",
    why: "absent projects NOTHING (Workspace.ts) — naming a plugin here is what authorizes its gate to reach an agent session, so absence is the closed state by design",
  },
  {
    path: "agentPermissionProjection",
    kind: "stored",
    direction: "opens",
    why: "absent does NOT fall to a runtime default for a delegated codex agent: AgentManager applies approval_policy=\"never\" + sandbox_mode=\"danger-full-access\", so discarding an authored `sandboxMode: read-only` falls to full access",
  },
  {
    path: "clipboard",
    kind: "stored",
    direction: "same",
    why: "absent is `auto`, which wires a copy-mode helper; `off` leaves OSC 52. No authority either way",
  },
  {
    path: "handoff.path",
    kind: "stored",
    direction: "same",
    why: "absent falls to `.tachyon/HANDOFF.md`",
  },
  {
    path: "handoff.nudgeEvery",
    kind: "stored",
    direction: "same",
    why: "absent falls to the 30m throttled nudge",
  },
  {
    path: "persistence",
    kind: "ignored",
    direction: "same",
    why: "the silentHooks kill switch is obsolete; silent hooks are the only supported path, so absence is the only state the product has",
  },
  {
    path: "bridgeClientRebind.onHostGenerationBump",
    kind: "stored",
    direction: "same",
    why: "absent is `auto`. Neither side is the closed one: `off` leaves a half-open MCP client behind. The trade is liveness against churn, in both directions",
  },
  {
    path: "bridgeClientRebind.graceMs",
    kind: "stored",
    direction: "same",
    why: "absent is 0 — rebind timing, no authority",
  },
  {
    path: "bridgeClientRebind.stopTimeoutMs",
    kind: "stored",
    direction: "same",
    why: "absent is 15000 — rebind timing, no authority",
  },
  {
    path: "bridgeClientRebind.maxConcurrentRebinds",
    kind: "stored",
    direction: "same",
    why: "absent is 1 — the most serialized value already",
  },
  {
    path: "bridgeClientRebind.circuitFailCount",
    kind: "stored",
    direction: "same",
    why: "absent is 3 — breaker sensitivity, no authority",
  },
  {
    path: "gitDelivery",
    kind: "ignored",
    direction: "same",
    why: "the Delivery tools it authorized are retired, so the authority it granted has nothing left to grant",
  },
  {
    path: "delivery",
    kind: "ignored",
    direction: "same",
    why: "the Delivery subsystem is retired",
  },
  {
    path: "taskNotifications",
    kind: "stored",
    direction: "same",
    why: "absent falls to DEFAULT_TASK_NOTIFICATION_SETTINGS (enabled) — more toasts, never more permission",
  },
  {
    path: "companion.tabTools",
    kind: "stored",
    direction: "opens",
    why: "read as `tabTools === true`, so this key alone is closed by absence — but it is the lever that closes the whole companion door, so it is held to the same rule as its siblings",
  },
  {
    path: "companion.allowedHosts",
    kind: "stored",
    direction: "opens",
    why: "tabSafety.ts reads `if (!allowedHosts || allowedHosts.length === 0) return true` — a missing allowlist permits EVERY host",
  },
  {
    path: "companion.lanAccess",
    kind: "stored",
    direction: "opens",
    why: "absent binds loopback only, so this key is closed by absence — but it rides the same untrustworthy block, so it closes with it",
  },
  {
    path: "ideBrowser.enabled",
    kind: "stored",
    direction: "closes",
    why: "read as `enabled === true` (ide-browser/settings.ts) and refused at CALL time, not merely hidden in the UI",
  },
  {
    path: "ideBrowser.homeUrl",
    kind: "stored",
    direction: "same",
    why: "absent falls to the built-in start page for the globe control",
  },
  {
    path: "sidebar.cardTemplate",
    kind: "stored",
    direction: "same",
    why: "the agent card's layout; a malformed template already refused whole and rendered the default card",
  },
  {
    path: "sidebar.cardTemplateRefusal",
    kind: "internal",
    direction: "same",
    why: "written by the parser so the sidebar's default-card fallback can explain itself; never authored",
  },
  {
    path: "humanInbox.staleAfterHours",
    kind: "stored",
    direction: "same",
    why: "absent falls to DEFAULT_STALE_AFTER_HOURS (24) and the mark is display-only — nothing auto-approves, auto-denies or auto-closes",
  },
  {
    path: "agentNotifications.idleAfterMinutes",
    kind: "stored",
    direction: "same",
    why: "absent falls to the default backstop threshold (TemporaryBackstopMonitor.ts); it only nudges a parent",
  },
];

/** The most closed posture Tachyon can project for codex, chosen from the runtime's own declared
 *  enums rather than invented: no unattended approval, no writes, and MCP tool calls prompt. */
const CODEX_CLOSED_POSTURE = {
  runtime: "codex",
  approvalPolicy: "untrusted",
  sandboxMode: "read-only",
  bridgeToolApproval: "prompt",
} as const satisfies AgentPermissionProjectionEntry;

/** Grok's most confirming mode, from GROK_PERMISSION_MODES. */
const GROK_CLOSED_POSTURE = { runtime: "grok", mode: "default" } as const satisfies AgentPermissionProjectionEntry;

/** What a closure needs beyond the settings themselves: which paths warned, and the roster, because
 *  a permission posture can only be closed once its runtime is known. */
export interface SafeSideContext {
  /** every `settings:` path that produced a warning, dotted and relative to `settings:` */
  readonly warnedPaths: ReadonlySet<string>;
  /** the parsed roster, used to read an agent's runtime from its own command */
  readonly agents: Readonly<Record<string, ManagedEntryDef>>;
}

export interface SettingsDoorClosure {
  /** warnings at this path, or under it, make the door untrustworthy */
  readonly domain: string;
  /** the `opens` keys this closure covers — checked by the guard */
  readonly covers: readonly string[];
  readonly why: string;
  /** install the safe values; returns the warnings that say what was closed and why */
  readonly close: (settings: TachyonConfig["settings"], ctx: SafeSideContext) => string[];
}

export const SETTINGS_DOOR_CLOSURES: readonly SettingsDoorClosure[] = [
  {
    domain: "companion",
    covers: ["companion.tabTools", "companion.allowedHosts", "companion.lanAccess"],
    why:
      "one lever closes all three: with the block gone, tabTools is false (tools unlisted and refused at call time), " +
      "lanAccess is false (loopback only), and allowedHosts has no door left to govern",
    close: (settings) => {
      if (settings.companion === undefined) return [];
      delete settings.companion;
      return [
        "settings.companion was discarded WHOLE because part of it could not be read: an unreadable host " +
        "allowlist permits every host, so Companion tab tools and LAN access are off until the block is fixed",
      ];
    },
  },
  {
    domain: "legacyBridgeAuth",
    covers: ["legacyBridgeAuth"],
    why:
      "the domain is the key itself, never the whole `settings:` block — a typo in an unrelated key must not " +
      "revoke the token identity of the agents that are already running",
    close: (settings) => {
      settings.legacyBridgeAuth = false;
      return [
        "settings.legacyBridgeAuth could not be read, so it was set to false rather than left at its permissive " +
        "default: the shared legacy Bridge token is NOT accepted as a caller identity until the key is fixed",
      ];
    },
  },
  {
    domain: "worktree",
    covers: ["worktree.shareDependencies", "worktree.revealInWorkspace"],
    why: "both are read as `!== false`, so absence is the open side for each",
    close: (settings) => {
      const worktree = settings.worktree ?? {};
      const closed: string[] = [];
      if (worktree.shareDependencies !== false) {
        worktree.shareDependencies = false;
        closed.push("shareDependencies (a worktree gets its OWN node_modules instead of the primary checkout's)");
      }
      if (worktree.revealInWorkspace !== false) {
        worktree.revealInWorkspace = false;
        closed.push("revealInWorkspace (worktree folders stay out of the window)");
      }
      settings.worktree = worktree;
      return closed.length === 0
        ? []
        : [`settings.worktree could not be read in full, so it fell to its closed side: ${closed.join("; ")}`];
    },
  },
  {
    domain: "agentPermissionProjection",
    covers: ["agentPermissionProjection"],
    why:
      "closed per AGENT, not per block: a delegated codex agent with nothing projected gets " +
      "approval_policy=\"never\" + sandbox_mode=\"danger-full-access\", so an entry that failed to parse must " +
      "leave the tightest posture of that runtime's own enum behind rather than nothing at all",
    close: (settings, ctx) => {
      const warnings: string[] = [];
      for (const path of ctx.warnedPaths) {
        if (!path.startsWith("agentPermissionProjection.")) continue;
        const name = path.slice("agentPermissionProjection.".length);
        // An entry naming an agent the roster does not declare targets nobody; there is no door to close.
        const entry = ctx.agents[name];
        if (!entry) continue;
        const runtime = binaryOf(entry.cmd);
        const posture =
          runtime === "codex" ? CODEX_CLOSED_POSTURE : runtime === "grok" ? GROK_CLOSED_POSTURE : undefined;
        // Only grok and codex have a posture Tachyon projects at all; for any other runtime there is
        // no door here to open OR close, and projecting one would break the spawn with a runtime mismatch.
        if (!posture) continue;
        const projection = settings.agentPermissionProjection ?? {};
        projection[name] = posture;
        settings.agentPermissionProjection = projection;
        warnings.push(
          `settings.agentPermissionProjection.${name} could not be read, so '${name}' was projected the most ` +
          `restrictive ${runtime} posture instead of none: ${describePosture(posture)}`,
        );
      }
      return warnings;
    },
  },
];

function describePosture(posture: AgentPermissionProjectionEntry): string {
  return posture.runtime === "grok"
    ? `mode ${posture.mode}`
    : [
        posture.approvalPolicy && `approvalPolicy ${posture.approvalPolicy}`,
        posture.sandboxMode && `sandboxMode ${posture.sandboxMode}`,
        posture.bridgeToolApproval && `bridgeToolApproval ${posture.bridgeToolApproval}`,
      ]
        .filter(Boolean)
        .join(", ");
}

/** True when `path` is the domain itself or sits under it. */
function withinDomain(path: string, domain: string): boolean {
  return path === domain || path.startsWith(`${domain}.`);
}

/**
 * Apply every closure whose door was warned. Returns the warnings naming what closed — the caller
 * appends them so the human reads the discard AND the consequence in one place.
 */
export function closeWarnedSettingsDoors(settings: TachyonConfig["settings"], ctx: SafeSideContext): string[] {
  const out: string[] = [];
  for (const closure of SETTINGS_DOOR_CLOSURES) {
    if (![...ctx.warnedPaths].some((path) => withinDomain(path, closure.domain))) continue;
    out.push(...closure.close(settings, ctx));
  }
  return out;
}

/** Top-level `settings:` keys the parser accepts. Derived, so the parser cannot drift from the table. */
export const SETTINGS_KEYS: readonly string[] = [
  ...new Set(
    SETTINGS_KEY_FALLBACKS.filter((entry) => entry.kind !== "internal").map((entry) => entry.path.split(".")[0]!),
  ),
];

/**
 * The keys a `settings:` sub-block accepts — `settingsBlockKeys("worktree")` is
 * `["base", "branch", "verify", "revealInWorkspace", "shareDependencies"]`. Same derivation, same
 * reason: one table, and the "unknown key" message can never disagree with what is parsed.
 */
export function settingsBlockKeys(block: string): readonly string[] {
  const prefix = `${block}.`;
  return SETTINGS_KEY_FALLBACKS.filter((entry) => entry.kind !== "internal" && entry.path.startsWith(prefix)).map(
    (entry) => entry.path.slice(prefix.length),
  );
}
