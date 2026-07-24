/**
 * Cockpit (desktop POC) — project sysadmin in the editor.
 * Pure model only (safe for webview + host). Disk readers live in cockpit/disk.ts (host only).
 * Top tabs only (no webview left rail). Does not replace VS Code/Tachyon sidebar.
 */

import {
  buildControlInspectorModel,
  formatControlInspectorDiagnostics,
  type ControlInspectorModel,
  type ControlInspectorWorkspaceInput,
} from "../control-inspector/model.js";

/**
 * Order = importance / frequency of use for a project sysadmin.
 * No "soon" tabs — every section is a real module page (data and/or deep-link).
 */
export type CockpitSectionId =
  | "overview"
  | "engine"
  | "fleet"
  | "approvals"
  | "mission"
  | "validations"
  | "handoff"
  | "worktrees"
  | "deliveries"
  | "runtime"
  | "tmux"
  | "plugins"
  | "settings";

export const COCKPIT_SECTION_ORDER: CockpitSectionId[] = [
  "overview",
  "engine",
  "fleet",
  "approvals",
  "mission",
  "validations",
  "handoff",
  "worktrees",
  "deliveries",
  "runtime",
  "tmux",
  "plugins",
  "settings",
];

export interface CockpitAgentRow {
  name: string;
  kind?: string;
  running: boolean;
  declared?: boolean;
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
}

export interface CockpitDeliveryRow {
  id: string;
  phase: string;
  branchRef: string;
  agent?: string;
  worktreePath?: string;
  folder?: string;
  wsHash?: string;
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

export interface CockpitWorkspaceBundle {
  control: ControlInspectorWorkspaceInput;
  agents: CockpitAgentRow[];
  worktrees: CockpitWorktreeRow[];
  /** spec 444 — the classified engine read failed (engine unreachable). The tab shows an honest
   *  error state for this workspace instead of unverified raw rows. */
  worktreesUnavailable?: string;
  deliveries: CockpitDeliveryRow[];
  approvals: CockpitApprovalRow[];
  tmux?: { state: string; version?: string };
  companion?: Omit<CockpitCompanionSettings, "wsHash" | "folderName">;
}

export interface CockpitModel {
  checkedAt: string;
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
    worktreesActive: number;
    deliveriesOpen: number;
    bridges: Array<{ folder: string; url: string; port?: number; ok: boolean }>;
  };
  fleet: CockpitAgentRow[];
  worktrees: CockpitWorktreeRow[];
  /** spec 444 — folders whose classified worktree read failed (engine unreachable), with reasons. */
  worktreesUnavailable?: Array<{ folder: string; reason: string }>;
  deliveries: CockpitDeliveryRow[];
  approvals: CockpitApprovalRow[];
  tmux: Array<{ folder: string; state: string; version?: string }>;
  /**
   * Companion settings for the scoped workspace (single selection, or sole workspace).
   * Undefined when "All workspaces" with multiple roots — UI asks to pick one.
   */
  companion?: CockpitCompanionSettings;
  /** True when multiple workspaces are in scope and none is selected for Companion settings. */
  companionNeedsWorkspacePick?: boolean;
}

export function buildCockpitModel(
  bundles: CockpitWorkspaceBundle[],
  opts?: { section?: CockpitSectionId; nowIso?: string; wsHash?: string },
): CockpitModel {
  // t-d16a39 — the shell-level workspace scope: when a specific workspace is selected, every
  // aggregate section (overview/engine/fleet/worktrees/deliveries/tmux) narrows to that one
  // bundle; "All workspaces" (wsHash undefined, or a hash that no longer exists — e.g. a folder
  // was closed since the selection persisted) keeps today's aggregate behavior. The selector list
  // itself always spans ALL bundles, never the filtered set.
  const workspaces = bundles.map((b) => ({ hash: b.control.wsHash, folder: b.control.folderName }));
  const selected = opts?.wsHash && workspaces.some((w) => w.hash === opts.wsHash) ? opts.wsHash : undefined;
  const scoped = selected ? bundles.filter((b) => b.control.wsHash === selected) : bundles;

  const controlInputs = scoped.map((b) => b.control);
  const control = buildControlInspectorModel(controlInputs, opts?.nowIso);

  const fleet = scoped.flatMap((b) =>
    b.agents.map((a) => ({
      ...a,
      name: scoped.length > 1 ? `${a.name} (${b.control.folderName})` : a.name,
    })),
  );
  const worktrees = scoped.flatMap((b) => b.worktrees);
  const worktreesUnavailable = scoped.flatMap((b) =>
    b.worktreesUnavailable ? [{ folder: b.control.folderName, reason: b.worktreesUnavailable }] : [],
  );
  const deliveries = scoped.flatMap((b) => b.deliveries);
  const approvals = scoped.flatMap((b) => b.approvals);
  const tmux = scoped.map((b) => ({
    folder: b.control.folderName,
    state: b.tmux?.state ?? "unknown",
    version: b.tmux?.version,
  }));

  const deliveriesOpen = deliveries.filter((d) => !["pruned", "abandoned"].includes(d.phase)).length;
  const worktreesActive = worktrees.filter((w) => w.status === "active").length;
  const approvalsPending = approvals.filter((a) => !a.status || a.status === "pending").length;

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

  return {
    checkedAt: control.checkedAt,
    section: opts?.section && COCKPIT_SECTION_ORDER.includes(opts.section) ? opts.section : "overview",
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
      worktreesActive,
      deliveriesOpen,
      bridges: control.workspaces.map((w) => ({
        folder: w.folderName,
        url: w.bridge.url,
        port: w.bridge.port,
        ok: w.engine.state === "attached",
      })),
    },
    fleet,
    worktrees,
    ...(worktreesUnavailable.length > 0 ? { worktreesUnavailable } : {}),
    deliveries,
    approvals,
    tmux,
    ...(companion ? { companion } : {}),
    ...(companionNeedsWorkspacePick ? { companionNeedsWorkspacePick: true } : {}),
  };
}

export function formatCockpitDiagnostics(model: CockpitModel): string {
  return [
    "Tachyon Control (desktop — editor sysadmin; VS Code sidebar unchanged)",
    `section: ${model.section}`,
    `fleet agents: ${model.fleet.filter((a) => a.running).length}/${model.fleet.length} running`,
    `approvals pending: ${model.overview.approvalsPending}`,
    `worktrees active: ${model.overview.worktreesActive}`,
    `deliveries open: ${model.overview.deliveriesOpen}`,
    "",
    formatControlInspectorDiagnostics(model.control),
  ].join("\n");
}

export type { ControlInspectorWorkspaceInput };
