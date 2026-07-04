import { validateForm, fromDef, type FormState, type FormIssue, type QuickAddChip } from "../formLogic.js";
import type { StudioError, StudioValidationResult } from "../shared/studio/errorTaxonomy.js";
import type { AgentDef } from "../../config/loadConfig.js";

/**
 * spec 350 Phase 3 T1 — the Agent-kind studio's vscode-free domain: WRAPS formLogic.ts (the validated,
 * unit-tested domain contract from spec 279) rather than reimplementing validation/entry-building. Both
 * AgentStudioAdapter.ts (host) and agent-studio-shell/App.tsx (webview) import THIS module directly, so
 * client-side save-gating and the host's persistence-time re-validation can never drift apart — the same
 * convention as pipeline-studio/domain.ts and task-studio/domain.ts. formLogic.ts itself is UNTOUCHED.
 *
 * This studio only ever creates/edits `kind: "agent"` entries (Terminal/Command/Runbook/Schedule stay on the
 * legacy AgentForm during coexistence) — `FormState.kind` is always `"agent"` here, so the schedule/runbook
 * fields formLogic's shared FormState type carries along are always left at their blank defaults.
 */

export const AGENT_STUDIO_DOMAIN_MESSAGE_NAMES = ["browse", "cwd"] as const;

/** The load-time snapshot: the agent's current FormState (kind fixed "agent") plus the reference data the
 *  form needs to render (quick-add chips, flag suggestions, default cwd, verify-gate suggestions, and the
 *  taken names client-side name validation checks against) — mirrors TaskDetailEntity's convention of
 *  carrying read-only reference data alongside the editable snapshot. */
export interface AgentStudioEntity {
  /** undefined in "new" mode. */
  name?: string;
  fields: FormState;
  chips: QuickAddChip[];
  flagMap: Record<string, string[]>;
  defaultCwd: string;
  verifyCandidates: string[];
  takenNames: string[];
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

/** Pre-fills the form from an existing `agents:` entry (edit mode) — a thin re-export of formLogic's own
 *  `fromDef` so callers don't need to reach into formLogic.js directly for this one conversion. */
export function agentFieldsFromDef(name: string, def: AgentDef): FormState {
  return fromDef(name, def);
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

/** English-fallback text for each formLogic `FormIssue` code (errorTaxonomy.ts: "`message` here is a stable,
 *  localization-free fallback"). Mirrors Workspace.ts's `issueMessage` (the legacy form's localized version)
 *  minus the vscode.l10n dependency this vscode-free module can't take. steps-required/timing-invalid/
 *  target-required are unreachable for `kind: "agent"` (formLogic only raises them for runbook/schedule) but
 *  listed for FormIssue exhaustiveness. */
const ISSUE_MESSAGES: Record<FormIssue["code"], (param?: string) => string> = {
  "name-invalid": () => "name: letters/digits/_/-, starting with a letter",
  "name-taken": (param) => `name '${param ?? ""}' already exists`,
  "cmd-required": () => "command: required",
  "steps-required": () => "steps: at least one step is required",
  "instructions-not-deliverable": () => "note: this CLI doesn't accept a startup prompt — instructions will be saved but not auto-delivered",
  "timing-invalid": () => "timing: invalid",
  "target-required": () => "target: required",
  "harness-claude-only": () => "isolated harness: supported for Claude/Codex agents only",
  "codex-harness-mcp-only": () => "isolated harness: Codex does not support rules; use instruction files instead",
  "harness-empty": () => "isolated harness: declare at least one of MCP / rules / skills / hooks",
  "harness-mcp-invalid": () => "isolated harness: MCP servers must be a valid YAML mapping",
  "harness-hooks-invalid": () => "isolated harness: hooks must be a valid YAML mapping",
};

function toStudioError(issue: FormIssue): StudioError {
  return { code: `validation/${issue.code}`, message: ISSUE_MESSAGES[issue.code](issue.param), source: "validation", blocking: issue.blocking };
}

/** Store-authoritative validation (errorTaxonomy.ts): WRAPS formLogic's `validateForm` — never reimplements
 *  it. Both the webview (instant Save-button gating, called with the loaded entity's own name excluded from
 *  `takenNames` via `editingName`) and `AgentStudioAdapter.save()` (persistence-time re-check via
 *  `Workspace.studioSubmit`, which calls `validateForm` the same way) run the same underlying rules. */
export function validateAgentFields(fields: FormState, takenNames: string[], editingName?: string): StudioValidationResult {
  const issues = validateForm(fields, takenNames, editingName);
  const blocking = issues.filter((i) => i.blocking).map(toStudioError);
  const nonBlocking = issues.filter((i) => !i.blocking).map(toStudioError);
  return { blocking, nonBlocking };
}
