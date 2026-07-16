/**
 * Cockpit (desktop POC) — project sysadmin surface in the editor.
 * Does NOT replace the sidebar (fleet work surface). Composes control-plane
 * modules; first real module = Engine/Bridge (reuses control-inspector model).
 */

import {
  buildControlInspectorModel,
  formatControlInspectorDiagnostics,
  type ControlInspectorModel,
  type ControlInspectorWorkspaceInput,
} from "../control-inspector/model.js";

export type CockpitSectionId = "overview" | "engine" | "fleet" | "tmux";

export interface CockpitSectionMeta {
  id: CockpitSectionId;
  /** When true, section is navigation-only / deep-link (no full body yet). */
  placeholder?: boolean;
}

export const COCKPIT_SECTIONS: CockpitSectionMeta[] = [
  { id: "overview" },
  { id: "engine" },
  { id: "fleet", placeholder: true },
  { id: "tmux", placeholder: true },
];

export interface CockpitModel {
  /** POC marker for banner. */
  poc: true;
  /** Product framing: editor sysadmin; sidebar stays. */
  framing: "editor-sysadmin";
  checkedAt: string;
  /** Active nav section (host may override on open). */
  section: CockpitSectionId;
  /** Engine/Bridge module (always populated when workspaces exist). */
  control: ControlInspectorModel;
  /** Overview chips derived from control + fleet counts. */
  overview: {
    workspaceCount: number;
    enginesAttached: number;
    enginesError: number;
    agentsRunning: number;
    agentsTotal: number;
    bridges: Array<{ folder: string; url: string; port?: number; ok: boolean }>;
  };
}

export function buildCockpitModel(
  inputs: ControlInspectorWorkspaceInput[],
  opts?: { section?: CockpitSectionId; nowIso?: string },
): CockpitModel {
  const control = buildControlInspectorModel(inputs, opts?.nowIso);
  const bridges = control.workspaces.map((w) => ({
    folder: w.folderName,
    url: w.bridge.url,
    port: w.bridge.port,
    ok: w.engine.state === "attached",
  }));
  return {
    poc: true,
    framing: "editor-sysadmin",
    checkedAt: control.checkedAt,
    section: opts?.section ?? "overview",
    control,
    overview: {
      workspaceCount: control.summary.workspaceCount,
      enginesAttached: control.summary.attachedEngines,
      enginesError: control.summary.engineErrors,
      agentsRunning: control.summary.runningAgents,
      agentsTotal: control.summary.totalAgents,
      bridges,
    },
  };
}

export function formatCockpitDiagnostics(model: CockpitModel): string {
  return [
    "Tachyon Cockpit (desktop POC — editor sysadmin; sidebar unchanged)",
    `section: ${model.section}`,
    "",
    formatControlInspectorDiagnostics(model.control),
  ].join("\n");
}

export type { ControlInspectorWorkspaceInput };
