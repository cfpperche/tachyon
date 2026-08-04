/**
 * Cockpit (desktop POC) — project sysadmin in the editor.
 * Pure model only (safe for webview + host). There are no disk readers left beside it: `cockpit/disk.ts`
 * was deleted once its last raw-JSON reader went away (spec 444 took the worktree one, t-43c6fa the
 * delivery one, and t-e88c8a retired the Deliveries tab outright). The Worktrees tab reads the
 * engine's validated, classified RPC.
 * Top tabs only (no webview left rail). Does not replace VS Code/Tachyon sidebar.
 */

import {
  buildControlInspectorModel,
  formatControlInspectorDiagnostics,
  type ControlInspectorModel,
  type ControlInspectorWorkspaceInput,
} from "../control-inspector/model.js";
import { DEFAULT_TEMPORARY_BACKSTOP_THRESHOLD_MS } from "../workspace/TemporaryBackstopMonitor.js";
import type { AgentInstanceLifetime } from "../resume/SessionLedger.js";

/**
 * t-585d5c — the product default in the unit Settings speaks. DERIVED from the monitor's constant,
 * so the number the UI shows cannot drift from the number the monitor applies.
 */
export const DEFAULT_IDLE_NOTIFY_MINUTES = DEFAULT_TEMPORARY_BACKSTOP_THRESHOLD_MS / 60_000;

/**
 * Order = importance / frequency of use for a project sysadmin.
 * No "soon" tabs — every section is a real module page (data and/or deep-link).
 */
export type CockpitSectionId =
  | "overview"
  | "engine"
  | "fleet"
  // t-e76acc — the unified Human Inbox: approvals + validations under ONE navigation and ONE count.
  // It is a projection, not a replacement: `approvals` and `validations` below still exist and still
  // own their kind-specific flows. The ratified direction removes that duplication only once the
  // unified surface demonstrably covers them, which is a later slice, not this one.
  | "inbox"
  | "approvals"
  | "mission"
  | "validations"
  // t-ace77f — Project Handoff is NOT a section: it is a detail route (`project-handoff` in
  // route.ts) opened from the sidebar's `handoff · N` entry, with its breadcrumb back to Overview.
  // It never was a dashboard tab's worth of navigation — one document per workspace.
  | "worktrees"
  // SDD 480 Phase 4 — the Execution Graph. Read-only by construction: the section's model is a
  // projection of the append-only ledger, and the projection cannot describe a destructive action.
  | "execution-graph"
  | "runtime"
  | "runtime-config"
  | "tmux"
  | "plugins"
  | "settings";

/**
 * The sections CONTROL ITSELF RENDERS, in product order.
 *
 * SDD 485 C5 — `mission` left this list when the Board became a standalone app. It is still a
 * `CockpitSectionId` and still a decodable route (a persisted pre-485 panel must be READABLE so it can be
 * redirected rather than silently mistaken for something else), and it is still a launcher tile — but the
 * tile opens the app, and Control has no renderer for it. This is the shape Phase D repeats: a migrated
 * section moves from here to the compatibility list below, and its tile's destination changes.
 *
 * SDD 485 D1 — `tmux` left the same way, and it is the second of ten. Phase D's whole shape is this one
 * edit: an id moves from here into the compatibility list, `WEBVIEW_APPS` gains a row, and the tile does
 * not move at all. D2 — `plugins`, the third, by exactly that edit and no other. D3 — `runtime`
 * (Runtime Ops), the fourth. D4 — `inbox` (the Human Inbox), the fifth, and the
 * first whose departure also takes a SUBROUTE with it: `inbox-item` is rendered inside that app now, so
 * both route kinds redirect (see `navigate()` in Cockpit.ts).
 */
export const COCKPIT_SECTION_ORDER: CockpitSectionId[] = [
  "overview",
  "execution-graph",
  "settings",
];

/**
 * All accepted section routes. Approvals and Validations remain valid compatibility/deep-link targets, but
 * the Human Inbox is still their only top-level navigation entry — it is an APP now (SDD 485 D4) rather
 * than a section, which changes where it opens and not what it aggregates. `mission` (C5), `tmux` (D1),
 * `plugins` (D2), `runtime` (D3) and `inbox` (D4) are here for that reason: all five are apps, and these
 * entries are what let a persisted or deep-linked `section:<id>` still DECODE, so it can be redirected to
 * the app instead of falling back to Overview and losing which screen the human had.
 */
export const COCKPIT_SECTION_IDS: CockpitSectionId[] = [
  ...COCKPIT_SECTION_ORDER,
  "approvals",
  "engine",
  "fleet",
  "inbox",
  "mission",
  "plugins",
  "runtime",
  "runtime-config",
  "tmux",
  "worktrees",
  "validations",
];

export interface CockpitAgentRow {
  name: string;
  kind?: string;
  running: boolean;
  /**
   * t-04052d — replaces `declared`. Optional because a row collected from a workspace whose projection
   * was unavailable carries no agents at all; a PRESENT row always states it.
   */
  lifetime?: AgentInstanceLifetime;
  attention?: string;
  /** Present when collected from a live workspace shell (for Control actions). */
  folder?: string;
  wsHash?: string;
}

export interface CockpitWorktreeRow {
  id: string;
  kind: string;
  path: string;
  branch: string;
  status: string;
  slug?: string;
  agent?: string;
  folder?: string;
  wsHash?: string;
  /** spec 444 — branch-deletion consent is offered only when Tachyon created the branch. */
  tachyonCreatedBranch?: boolean;
  /**
   * spec 444 — fail-closed hygiene classification (see `src/worktree/classify.ts`). Computed
   * host-side in `CockpitDeps.collect()` before this row reaches `buildCockpitModel` (a pure,
   * synchronous composer — classification itself requires async git probes, so it is never
   * computed here). Absent only for a row sourced from the fail-closed `disk.ts` fallback path
   * (the classifier itself threw); the client must never treat "absent" as "safe".
   */
  classification?: import("../worktree/classify.js").WorktreeClassification;
  /**
   * t-621613 — for an `agent` row, whether the agent it belongs to still exists anywhere Tachyon
   * knows. Computed host-side alongside `classification` (it reads the roster, the ledger and tmux).
   * `absent` is the only value that unlocks anything: `unknown` — an unreadable roster, an ambiguous
   * tmux read, or a row from the fail-closed fallback that never asked — must read as "somebody
   * lives here", exactly as it does in the engine's own authority decision.
   */
  ownerPresence?: import("../worktree/hygieneAuthority.js").OwnerPresence;
}

/**
 * SDD 479 phase 5 — which card-template home is in effect, for the statement the settings surface
 * owes the human (ratified fork 1: "the settings UI says which one is in effect").
 *
 * Live state, not a restatement of the precedence rule: the failure this prevents is a personal
 * override quietly contradicting the project's template, which is indistinguishable from a broken
 * project template until something says which one the cards are actually using.
 */
export interface CockpitCardTemplateState {
  /** the personal override in the global Tachyon settings file: absent, in effect, or refused */
  personal: "none" | "active" | "refused";
  /** why it was refused — the same diagnostics the sidebar banner shows, from the same validator */
  personalErrors?: string[];
  /** one row per scoped workspace: does its own tachyon.yml write a template, and was it honored */
  projects: Array<{ folder: string; configured: boolean; refused: boolean }>;
}

export interface CockpitApprovalRow {
  id: string;
  status?: string;
  title?: string;
}

/** SDD 414 — one paired Companion client row (Control → Connected devices). */
export interface CockpitCompanionDevice {
  id: string;
  kind: string;
  name: string;
  version: string;
  pairedAt: string;
  expiresAt?: string;
  live: boolean;
}

/** SDD 414 — Companion tab tools (Bridge list opt-in) + devices for Control Settings. */
export interface CockpitCompanionSettings {
  wsHash: string;
  folderName: string;
  /** settings.companion.tabTools — tools listed on Bridge when true. */
  tabTools: boolean;
  /**
   * settings.companion.allowedHosts — host globs for user_browser_* (empty = all hosts).
   * Written from Control Settings; optional.
   */
  allowedHosts: string[];
  /** Companion device session present on this engine (any device in devices[]). */
  paired: boolean;
  baseUrl?: string;
  engineLabel?: string;
  /** 0–1 today; array-shaped for multi-device later. */
  devices: CockpitCompanionDevice[];
}

/**
 * t-af3eef — which expensive slices a collect is being asked for.
 *
 * `worktrees.classified` is real engine work — it walks every managed checkout, of which this repo
 * had 17 at the time of writing, and it grows with the fleet. Collecting it on EVERY navigation meant
 * opening a Task Detail paid for it across every workspace before a single pixel could change.
 *
 * t-e88c8a — this was a two-slice type; `deliveries.classified` went with the Deliveries tab. It
 * stays an OBJECT rather than collapsing to a boolean, because the shape is what makes adding the
 * next expensive slice a one-line change instead of a signature migration.
 *
 * The needs are derived from the section being rendered, never stored, so there is one authority for
 * "what does this view consume" and no cache to invalidate.
 */
export interface CockpitCollectNeeds {
  worktrees: boolean;
}

/** Sections that actually read the classified worktree rows (or their Overview counter). */
const SECTIONS_NEEDING_WORKTREES = new Set(["overview", "worktrees"]);

/** What a given section needs. Unknown sections get nothing expensive — they render without it. */
export function collectNeedsFor(section: string): CockpitCollectNeeds {
  return { worktrees: SECTIONS_NEEDING_WORKTREES.has(section) };
}

/** Everything. For diagnostics dumps, which are explicitly a full picture of the world. */
export const COLLECT_EVERYTHING: CockpitCollectNeeds = { worktrees: true };

export interface CockpitWorkspaceBundle {
  control: ControlInspectorWorkspaceInput;
  agents: CockpitAgentRow[];
  /**
   * t-af3eef — ABSENT means "not collected for this view", never "none exist". The distinction is the
   * same one `worktreesUnavailable` already draws: this file's own comment on the validation slice
   * says absent means not collected, and a silent empty list is exactly the lie that convention
   * exists to prevent.
   */
  worktrees?: CockpitWorktreeRow[];
  /** spec 444 — the classified engine read failed (engine unreachable). The tab shows an honest
   *  error state for this workspace instead of unverified raw rows. */
  worktreesUnavailable?: string;
  /** t-af3eef — absent means "not collected for this view", never "none". See `worktrees` above. */
  approvals: CockpitApprovalRow[];
  /**
   * t-e76acc — validations still awaiting a HUMAN in this workspace, counted host-side with the very
   * predicate the Inbox list uses (`validationAwaitsHuman`). A number, not rows: Overview only counts
   * them, and the section that renders them reads the store itself.
   *
   * Absent means "not collected", never "none" — the same fail-loud shape `worktreesUnavailable` uses.
   * The alternative (default 0) is precisely the § 4.1 defect this whole surface exists to answer: a
   * counter that reads zero while work waits on disk.
   */
  validationsAwaitingHuman?: number;
  /** SDD 479 phase 5 — does THIS folder's tachyon.yml write a card template, and was it honored? */
  cardTemplate?: { configured: boolean; refused: boolean };
  tmux?: { state: string; version?: string };
  companion?: Omit<CockpitCompanionSettings, "wsHash" | "folderName">;
  /**
   * t-585d5c — this folder's `settings.agentNotifications.idleAfterMinutes`, exactly as written.
   *
   * Undefined means the folder configured NOTHING, which is not the same as the default having been
   * written down. Settings says "using the default" in words rather than showing a number the human
   * never chose, so a later reader can tell a deliberate 10 from an untouched setting.
   */
  idleAfterMinutes?: number | "never";
}

export interface CockpitModel {
  checkedAt: string;
  /**
   * SDD 480 Phase 4 — the Execution Graph view-model for the `execution-graph` section.
   *
   * Optional: a host that does not serve the ledger simply omits it and the section renders its
   * `no-telemetry` state, which is the honest answer rather than an empty diagram.
   */
  executionGraph?: import("./executionGraphVm.js").ExecutionGraphVm;
  /** Which NAV TAB reads as active (a subroute's parent section, e.g. task-detail -> "mission"). */
  section: CockpitSectionId;
  /**
   * t-610705 (Phase C.1) — the exact route being rendered, when it's more specific than the bare
   * section (a subroute). Undefined for a plain section route — the client's existing `section`
   * switch already covers that case, so this stays absent rather than redundantly echoing it.
   * Attached by Cockpit.ts's sendModel() (this pure builder stays route-shape-agnostic); import is
   * type-only, so there is no runtime coupling to route.ts.
   */
  activeRoute?: import("./route.js").CockpitRoute;
  /**
   * t-610705 (Phase D, D0) — the CURRENT studio binding's host-issued mount nonce, present only
   * when `activeRoute` is a studio-new/studio-edit route AND the host has a live binding for it.
   * The studio App echoes this (plus the derived routeKey) back on its "ready" handshake so the
   * host can reject a stale ready from a torn-down mount re-entering the SAME route
   * (studios-routes-design.md's round-2 F3). Attached by Cockpit.ts's sendModel(), same convention
   * as `activeRoute` itself.
   */
  studioMountNonce?: string;
  /**
   * t-c3c819 — the CURRENT studio binding's `persisted` flag, present under the same conditions as
   * `studioMountNonce`. `false` means `activeRoute`'s `entityId` was pre-minted (Task Studio's
   * staged-create pattern, see `mintTaskId()`'s doc comment) but the entity has never actually been
   * saved to disk — used to stop `parentRoute()`'s task-detail parent (correct for a REAL edit) from
   * being trusted for a brand-new, still-unsaved task, whose "parent" is really just the studio's
   * section (task-detail(entityId) would 404: "never found on disk"). Attached by Cockpit.ts's
   * sendModel(), same convention as `activeRoute`/`studioMountNonce`.
   */
  studioPersisted?: boolean;
  /** t-d16a39 — every configured workspace, for the shell-level workspace selector. */
  workspaces: Array<{ hash: string; folder: string }>;
  /** t-d16a39 — the shell-selected workspace scoping every section; undefined = "All workspaces". */
  selectedWsHash?: string;
  control: ControlInspectorModel;
  overview: {
    workspaceCount: number;
    enginesAttached: number;
    enginesError: number;
    agentsRunning: number;
    agentsTotal: number;
    approvalsPending: number;
    /**
     * t-e76acc — everything waiting on a human: pending approvals PLUS validations whose executor is
     * human and which are not closed. The single number the unified navigation shows, and it is a
     * SUM of the two real reads rather than a third source that could drift from either.
     */
    inboxPending: number;
    worktreesActive: number;
    bridges: Array<{ folder: string; url: string; port?: number; ok: boolean }>;
  };
  fleet: CockpitAgentRow[];
  worktrees: CockpitWorktreeRow[];
  /** t-af3eef — false when this view never asked for the classified read, so an empty `worktrees`
   *  means "not collected" rather than "none exist". The counters below are omitted in that case. */
  worktreesCollected: boolean;
  /** spec 444 — folders whose classified worktree read failed (engine unreachable), with reasons. */
  worktreesUnavailable?: Array<{ folder: string; reason: string }>;
  approvals: CockpitApprovalRow[];
  tmux: Array<{ folder: string; state: string; version?: string }>;
  /**
   * Companion settings for the scoped workspace (single selection, or sole workspace).
   * Undefined when "All workspaces" with multiple roots — UI asks to pick one.
   */
  companion?: CockpitCompanionSettings;
  /** True when multiple workspaces are in scope and none is selected for Companion settings. */
  companionNeedsWorkspacePick?: boolean;
  /**
   * t-585d5c — the idle-notification threshold for the scoped workspace (Control -> Settings).
   * Scoped exactly like `companion`: the setting is per folder, so with several roots in view there
   * is no single value to show and none to write back.
   */
  idleNotify?: { wsHash: string; folderName: string; configured?: number | "never"; defaultMinutes: number };
  /** SDD 479 phase 5 — see CockpitCardTemplateState. */
  cardTemplate?: CockpitCardTemplateState;
  /**
   * t-aaad95 — the per-person, per-machine half of Tachyon's settings, read from the global Tachyon
   * file. It arrives as an option rather than as bundle data for the same reason `cardTemplate` does:
   * it belongs to one person on one machine, not to any workspace, and it must answer with zero
   * workspaces open.
   */
  globalSettings?: CockpitGlobalSettingsState;
}

export interface CockpitGlobalSettingsState {
  /** the hand-editable path, shown verbatim because it is also the documented recovery surface */
  file: string;
  activityCodeTheme: "auto" | "dark" | "light";
  agentPaneEnabled: boolean;
  gitPath: string;
  /** whether a personal card template is authored; the template itself is edited in its own block */
  hasCardTemplate: boolean;
  /** named errors when the document was refused and the last known good is in use */
  refusal?: string[];
}

export function buildCockpitModel(
  bundles: CockpitWorkspaceBundle[],
  opts?: {
    section?: CockpitSectionId;
    nowIso?: string;
    wsHash?: string;
    /**
     * SDD 479 phase 5 — the PERSONAL override's state, read from the global Tachyon settings file
     * by the host (t-aaad95; it was VS Code settings before). It
     * arrives as an option rather than as bundle data because it belongs to one person on one
     * machine: no workspace owns it, and no engine should ever project it.
     */
    personalCardTemplate?: { state: "none" | "active" | "refused"; errors?: string[] },
    /** t-aaad95 — the global Tachyon settings file's current state; see CockpitGlobalSettingsState. */
    globalSettings?: CockpitGlobalSettingsState,
  },
): CockpitModel {
  // t-d16a39 — the shell-level workspace scope: when a specific workspace is selected, every
  // aggregate section (overview/engine/fleet/worktrees/tmux) narrows to that one
  // bundle; "All workspaces" (wsHash undefined, or a hash that no longer exists — e.g. a folder
  // was closed since the selection persisted) keeps today's aggregate behavior. The selector list
  // itself always spans ALL bundles, never the filtered set.
  const workspaces = bundles.map((b) => ({ hash: b.control.wsHash, folder: b.control.folderName }));
  const requested = opts?.wsHash && workspaces.some((w) => w.hash === opts.wsHash) ? opts.wsHash : undefined;
  /**
   * t-4917e4 — with exactly ONE root the effective selection IS that root, and saying so here is what
   * keeps the selector from rendering blank.
   *
   * The Overview selector deliberately omits the "All workspaces" option when there is a single root
   * (offering it and the root would be two labels for the same data). But the model left
   * `selectedWsHash` undefined until someone chose explicitly, so the control bound the
   * "All workspaces" sentinel to a list that did not contain it — a value with no option, which
   * renders as an empty button. That is the reported bug, and it needed fixing HERE rather than by
   * having the UI substitute a value: the model is the one authority for scope, and a UI-side default
   * would be a second one that the host's next authoritative model could silently contradict.
   *
   * Nothing about scoping changes: with one bundle, filtering to it and not filtering are the same
   * set, so this names the state that already existed instead of altering it.
   */
  const selected = requested ?? (workspaces.length === 1 ? workspaces[0]!.hash : undefined);
  const scoped = selected ? bundles.filter((b) => b.control.wsHash === selected) : bundles;

  const controlInputs = scoped.map((b) => b.control);
  const control = buildControlInspectorModel(controlInputs, opts?.nowIso);

  const fleet = scoped.flatMap((b) =>
    b.agents.map((a) => ({
      ...a,
      name: scoped.length > 1 ? `${a.name} (${b.control.folderName})` : a.name,
    })),
  );
  // t-af3eef — a bundle that was not asked for this slice contributes nothing, which is different
  // from contributing an empty list: `worktreesCollected` below carries that difference forward so a
  // view can say "not collected" instead of showing a confident zero.
  const worktreesCollected = scoped.some((b) => b.worktrees !== undefined);
  const worktrees = scoped.flatMap((b) => b.worktrees ?? []);
  const worktreesUnavailable = scoped.flatMap((b) =>
    b.worktreesUnavailable ? [{ folder: b.control.folderName, reason: b.worktreesUnavailable }] : [],
  );
  const approvals = scoped.flatMap((b) => b.approvals);
  const tmux = scoped.map((b) => ({
    folder: b.control.folderName,
    state: b.tmux?.state ?? "unknown",
    version: b.tmux?.version,
  }));

  const worktreesActive = worktrees.filter((w) => w.status === "active").length;
  const approvalsPending = approvals.filter((a) => !a.status || a.status === "pending").length;
  // t-e76acc — a missing per-bundle count contributes nothing rather than a zero it cannot vouch for.
  const validationsAwaitingHuman = scoped.reduce((sum, b) => sum + (b.validationsAwaitingHuman ?? 0), 0);
  const inboxPending = approvalsPending + validationsAwaitingHuman;

  // Companion tabTools UI needs exactly one workspace in scope.
  let companion: CockpitCompanionSettings | undefined;
  let companionNeedsWorkspacePick = false;
  if (scoped.length === 1) {
    const b = scoped[0]!;
    companion = {
      wsHash: b.control.wsHash,
      folderName: b.control.folderName,
      tabTools: b.companion?.tabTools === true,
      allowedHosts: Array.isArray(b.companion?.allowedHosts) ? b.companion!.allowedHosts! : [],
      paired: b.companion?.paired === true || (b.companion?.devices?.length ?? 0) > 0,
      baseUrl: b.companion?.baseUrl,
      engineLabel: b.companion?.engineLabel,
      devices: Array.isArray(b.companion?.devices) ? b.companion!.devices! : [],
    };
  } else if (scoped.length > 1) {
    companionNeedsWorkspacePick = true;
  }

  // t-585d5c — same single-workspace scoping, same reason as companion above.
  const idleBundle = scoped.length === 1 ? scoped[0]! : undefined;
  const idleNotify = idleBundle
    ? {
        wsHash: idleBundle.control.wsHash,
        folderName: idleBundle.control.folderName,
        ...(idleBundle.idleAfterMinutes === undefined ? {} : { configured: idleBundle.idleAfterMinutes }),
        defaultMinutes: DEFAULT_IDLE_NOTIFY_MINUTES,
      }
    : undefined;

  // SDD 479 phase 5 — the two homes side by side, so the block can say which one the cards use.
  const cardTemplate: CockpitCardTemplateState = {
    personal: opts?.personalCardTemplate?.state ?? "none",
    ...(opts?.personalCardTemplate?.errors?.length ? { personalErrors: opts.personalCardTemplate.errors } : {}),
    projects: scoped.map((b) => ({
      folder: b.control.folderName,
      configured: b.cardTemplate?.configured === true,
      refused: b.cardTemplate?.refused === true,
    })),
  };

  return {
    checkedAt: control.checkedAt,
    section: opts?.section && COCKPIT_SECTION_IDS.includes(opts.section) ? opts.section : "overview",
    workspaces,
    ...(selected ? { selectedWsHash: selected } : {}),
    control,
    overview: {
      workspaceCount: control.summary.workspaceCount,
      enginesAttached: control.summary.attachedEngines,
      enginesError: control.summary.engineErrors,
      agentsRunning: control.summary.runningAgents,
      agentsTotal: control.summary.totalAgents,
      approvalsPending,
      inboxPending,
      worktreesActive,
      bridges: control.workspaces.map((w) => ({
        folder: w.folderName,
        url: w.bridge.url,
        port: w.bridge.port,
        ok: w.engine.state === "attached",
      })),
    },
    fleet,
    worktrees,
    worktreesCollected,
    ...(worktreesUnavailable.length > 0 ? { worktreesUnavailable } : {}),
    approvals,
    tmux,
    ...(companion ? { companion } : {}),
    ...(companionNeedsWorkspacePick ? { companionNeedsWorkspacePick: true } : {}),
    ...(idleNotify ? { idleNotify } : {}),
    cardTemplate,
    ...(opts?.globalSettings ? { globalSettings: opts.globalSettings } : {}),
  };
}

export function formatCockpitDiagnostics(model: CockpitModel): string {
  return [
    "Tachyon Control (desktop — editor sysadmin; VS Code sidebar unchanged)",
    `section: ${model.section}`,
    `fleet agents: ${model.fleet.filter((a) => a.running).length}/${model.fleet.length} running`,
    `approvals pending: ${model.overview.approvalsPending}`,
    `human inbox waiting: ${model.overview.inboxPending}`,
    `worktrees active: ${model.overview.worktreesActive}`,
    "",
    formatControlInspectorDiagnostics(model.control),
  ].join("\n");
}

export type { ControlInspectorWorkspaceInput };
