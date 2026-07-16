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
  | "worktrees"
  | "deliveries"
  | "runtime"
  | "tmux"
  | "plugins"
  | "schedules"
  | "settings";

export const COCKPIT_SECTION_ORDER: CockpitSectionId[] = [
  "overview",
  "engine",
  "fleet",
  "approvals",
  "mission",
  "worktrees",
  "deliveries",
  "runtime",
  "tmux",
  "plugins",
  "schedules",
  "settings",
];

export interface CockpitAgentRow {
  name: string;
  kind?: string;
  running: boolean;
  declared?: boolean;
  attention?: string;
}

export interface CockpitWorktreeRow {
  id: string;
  kind: string;
  path: string;
  branch: string;
  status: string;
  slug?: string;
  agent?: string;
}

export interface CockpitDeliveryRow {
  id: string;
  phase: string;
  branchRef: string;
  agent?: string;
  worktreePath?: string;
}

export interface CockpitApprovalRow {
  id: string;
  status?: string;
  title?: string;
}

export interface CockpitScheduleRow {
  name: string;
  paused?: boolean;
}

export interface CockpitWorkspaceBundle {
  control: ControlInspectorWorkspaceInput;
  agents: CockpitAgentRow[];
  worktrees: CockpitWorktreeRow[];
  deliveries: CockpitDeliveryRow[];
  approvals: CockpitApprovalRow[];
  schedules: CockpitScheduleRow[];
  tmux?: { state: string; version?: string };
}

export interface CockpitModel {
  poc: true;
  framing: "editor-sysadmin";
  checkedAt: string;
  section: CockpitSectionId;
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
  schedules: CockpitScheduleRow[];
  tmux: Array<{ folder: string; state: string; version?: string }>;
}

export function buildCockpitModel(
  bundles: CockpitWorkspaceBundle[],
  opts?: { section?: CockpitSectionId; nowIso?: string },
): CockpitModel {
  const controlInputs = bundles.map((b) => b.control);
  const control = buildControlInspectorModel(controlInputs, opts?.nowIso);

  const fleet = bundles.flatMap((b) =>
    b.agents.map((a) => ({
      ...a,
      name: bundles.length > 1 ? `${a.name} (${b.control.folderName})` : a.name,
    })),
  );
  const worktrees = bundles.flatMap((b) => b.worktrees);
  const deliveries = bundles.flatMap((b) => b.deliveries);
  const approvals = bundles.flatMap((b) => b.approvals);
  const schedules = bundles.flatMap((b) => b.schedules);
  const tmux = bundles.map((b) => ({
    folder: b.control.folderName,
    state: b.tmux?.state ?? "unknown",
    version: b.tmux?.version,
  }));

  const deliveriesOpen = deliveries.filter((d) => !["pruned", "abandoned"].includes(d.phase)).length;
  const worktreesActive = worktrees.filter((w) => w.status === "active").length;
  const approvalsPending = approvals.filter((a) => !a.status || a.status === "pending").length;

  return {
    poc: true,
    framing: "editor-sysadmin",
    checkedAt: control.checkedAt,
    section: opts?.section && COCKPIT_SECTION_ORDER.includes(opts.section) ? opts.section : "overview",
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
    schedules,
    tmux,
  };
}

export function formatCockpitDiagnostics(model: CockpitModel): string {
  return [
    "Tachyon Cockpit (desktop — editor sysadmin; VS Code sidebar unchanged)",
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
