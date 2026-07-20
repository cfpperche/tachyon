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

export interface CockpitWorkspaceBundle {
  control: ControlInspectorWorkspaceInput;
  agents: CockpitAgentRow[];
  worktrees: CockpitWorktreeRow[];
  deliveries: CockpitDeliveryRow[];
  approvals: CockpitApprovalRow[];
  tmux?: { state: string; version?: string };
}

export interface CockpitModel {
  checkedAt: string;
  section: CockpitSectionId;
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
  deliveries: CockpitDeliveryRow[];
  approvals: CockpitApprovalRow[];
  tmux: Array<{ folder: string; state: string; version?: string }>;
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
    deliveries,
    approvals,
    tmux,
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
