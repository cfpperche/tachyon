import type { FormState, QuickAddChip } from "../formLogic.js";

/**
 * spec 350 Phase 3 T1 — the Agent-kind studio's vscode-free AND node-free domain: pure entity/fields/patch
 * shapes + the adapter's declared dirty/title hooks, mirroring pipeline-studio/domain.ts's and task-studio/
 * domain.ts's convention — both AgentStudioAdapter.ts (host) and agent-studio-shell/App.tsx (webview) import
 * THIS module directly.
 *
 * Only `type`-imports from formLogic.ts here (erased at build — zero runtime dependency): formLogic.ts's
 * RUNTIME exports (`validateForm`, `fromDef`, ...) transitively pull in `../config/loadConfig.js`, which
 * imports `node:fs` — fine for AgentStudioAdapter.ts (a Node/vscode host file) but fatal for this surface's
 * browser bundle (confirmed empirically: esbuild's browser target can't resolve `node:fs`). So the actual
 * formLogic WRAP (validate/build) lives in AgentStudioAdapter.ts, host-side only; this module only carries
 * the FormState *type* + the shell's own pure dirty/title bookkeeping.
 *
 * Validation is NOT client-side/live here — same precedent as TaskStudioAdapter.validate() (spec 350 T1):
 * the legacy Agent Studio only ever surfaced formLogic's errors AFTER a submit round trip (not per-keystroke
 * live gating either), so `AgentStudioAdapter.validate()` returns `NO_VALIDATION_ERRORS` and `save()`'s
 * `Workspace.studioSubmit` call (formLogic's `validateForm` + `YamlConfigEditor.upsertAgent`) is the single
 * authoritative check, same as before this migration.
 *
 * This studio only ever creates/edits `kind: "agent"` entries (Terminal/Command/Runbook/Schedule stay on the
 * legacy AgentForm during coexistence) — `FormState.kind` is always `"agent"` here, so the schedule/runbook
 * fields formLogic's shared FormState type carries along are always left at their blank defaults.
 */

export const AGENT_STUDIO_DOMAIN_MESSAGE_NAMES = ["browse", "cwd"] as const;

/** The load-time snapshot: the agent's current FormState (kind fixed "agent") plus the reference data the
 *  form needs to render (quick-add chips, flag suggestions, default cwd, verify-gate suggestions). Mirrors
 *  TaskDetailEntity's convention of carrying read-only reference data alongside the editable snapshot. */
export interface AgentStudioEntity {
  /** undefined in "new" mode. */
  name?: string;
  fields: FormState;
  chips: QuickAddChip[];
  flagMap: Record<string, string[]>;
  defaultCwd: string;
  verifyCandidates: string[];
}

export type AgentStudioFields = FormState;
export type AgentStudioPatch = FormState;

/** A blank agent-kind FormState — same defaults as the legacy agent-studio/App.tsx's BLANK for the Agent tab
 *  (attention on by default, no harness/worktree/isolate). */
export function blankAgentFields(): FormState {
  return {
    name: "",
    cmd: "",
    kind: "agent",
    instructions: "",
    role: "",
    watch: "",
    steps: "",
    cwd: "",
    autostart: false,
    restartOnCrash: false,
    attention: true,
    worktree: false,
    branch: "",
    worktreeSetup: "",
    verify: "",
    harness: false,
    harnessInherit: "workspace",
    harnessMcp: "",
    harnessRules: "",
    harnessInstructions: "",
    harnessSkills: "",
    harnessHooks: "",
    isolate: false,
    schedTiming: "every",
    schedEvery: "1h",
    schedAt: "09:00",
    schedAction: "run",
    schedTarget: "",
    catchUp: false,
  };
}

export function computeAgentDirty(entity: AgentStudioEntity | undefined, fields: FormState): boolean {
  const base = entity?.fields ?? blankAgentFields();
  return JSON.stringify(base) !== JSON.stringify(fields);
}

export function serializeAgentPatch(fields: FormState, dirty: boolean): FormState | undefined {
  return dirty ? fields : undefined;
}

export function canDiscardAgentFields(fields: FormState): boolean {
  return JSON.stringify(fields) === JSON.stringify(blankAgentFields());
}

export function agentStudioTitleFor(mode: "new" | "edit", entityId: string | undefined, entity: AgentStudioEntity | undefined): string {
  if (mode === "new") return "New Agent";
  return `Agent Studio — ${entity?.name ?? entityId ?? ""}`;
}
