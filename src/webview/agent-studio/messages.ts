/**
 * spec 279 — the SHARED host↔webview envelope for the Agent Studio view (`preact-live`, BOTH directions:
 * the host pushes init/kindInferred/cwd/errors; the webview posts ready/tab/inferKind/browse/submit/cancel).
 * Imported by the host (`AgentForm`), the webview (`agent-studio/main.tsx` + App), and the dev preview harness.
 * Pure — only types + constructors; the form logic itself stays in formLogic.ts (unit-tested).
 */

import type { FormState, StudioKind, QuickAddChip } from "../formLogic";

export { READY, readyMessage, type ReadyMessage } from "../shared/ready";

/** all webview-visible strings, localized extension-side and shipped in `init`. */
export interface StudioStrings {
  titleNewAgent: string; titleNewTerminal: string; titleEditAgent: string; titleEditTerminal: string;
  titleNewCommand: string; titleEditCommand: string; titleNewRunbook: string; titleEditRunbook: string;
  titleNewSchedule: string; titleEditSchedule: string;
  tabAgent: string; tabTerminal: string; tabCommand: string; tabRunbook: string; tabSchedule: string;
  tabHintAgent: string; tabHintTerminal: string; tabHintCommand: string; tabHintRunbook: string; tabHintSchedule: string;
  switchToAgent: string; switchToTerminal: string; quickAdd: string;
  name: string; namePhAgent: string; namePhTerminal: string; namePhCommand: string; namePhRunbook: string; namePhSchedule: string; nameHint: string;
  command: string; commandPhAgent: string; commandPhTerminal: string; commandPhCommand: string;
  stepsLabel: string; stepsPh: string; stepsHint: string; stepRef: string; stepInline: string;
  instructions: string; instructionsPh: string; instructionsHint: string;
  role: string; roleNone: string; roleHint: string;
  watch: string; watchPh: string; watchHint: string;
  cwd: string; cwdRootPh: string; browse: string;
  autostart: string; restart: string; attention: string;
  worktreeSummary: string; worktree: string; branch: string; branchPh: string; worktreeSetup: string; worktreeSetupPh: string; worktreeHint: string;
  verify: string; verifyPh: string; verifyHint: string; verifySuggested: string;
  harnessSummary: string; harness: string; harnessHint: string; harnessInherit: string;
  harnessMcpLabel: string; harnessMcpPh: string; harnessRulesLabel: string; harnessRulesPh: string;
  harnessSkillsLabel: string; harnessSkillsPh: string; harnessHooksLabel: string; harnessHooksPh: string;
  isolate: string; isolateHint: string;
  cancel: string; saveAgent: string; saveTerminal: string; saveCommand: string; saveRunbook: string; saveSchedule: string;
  schedWhen: string; schedEvery: string; schedAt: string; schedEveryPh: string; schedAtPh: string;
  schedAction: string; schedRun: string; schedSpawn: string; schedTargetPh: string; schedCatchUp: string;
  custom: string; notInstalled: string; notInstalledNoHint: string;
  studioNewAgent: string; studioNewTerminal: string; studioNewCommand: string; studioNewSchedule: string; studioNewRunbook: string;
}

// ── host → webview ───────────────────────────────────────────────────────────
export const INIT = "init" as const;
export interface InitPayload {
  strings: StudioStrings;
  chips: QuickAddChip[];
  flagMap: Record<string, string[]>;
  taken: string[];
  commandNames: string[];
  verifyCandidates: string[];
  defaultCwd: string;
  editingName?: string;
  initial?: FormState;
  initialKind?: StudioKind;
}
export interface InitMessage extends InitPayload { type: typeof INIT }
export function initMessage(p: InitPayload): InitMessage { return { type: INIT, ...p }; }

export const KIND_INFERRED = "kindInferred" as const;
export interface KindInferredMessage { type: typeof KIND_INFERRED; kind: StudioKind }
export function kindInferredMessage(kind: StudioKind): KindInferredMessage { return { type: KIND_INFERRED, kind }; }

export const CWD = "cwd" as const;
export interface CwdMessage { type: typeof CWD; value: string }
export function cwdMessage(value: string): CwdMessage { return { type: CWD, value }; }

export const ERRORS = "errors" as const;
export interface ErrorsMessage { type: typeof ERRORS; errors: string[] }
export function errorsMessage(errors: string[]): ErrorsMessage { return { type: ERRORS, errors }; }

export type StudioHostMessage = InitMessage | KindInferredMessage | CwdMessage | ErrorsMessage;

// ── webview → host (inbound actions) ──────────────────────────────────────────
export type StudioAction =
  | { type: "ready" }
  | { type: "tab"; kind: StudioKind }
  | { type: "inferKind"; cmd: string }
  | { type: "browse" }
  | { type: "submit"; state: FormState }
  | { type: "cancel" };

export const tabAction = (kind: StudioKind): StudioAction => ({ type: "tab", kind });
export const inferKindAction = (cmd: string): StudioAction => ({ type: "inferKind", cmd });
export const browseAction = (): StudioAction => ({ type: "browse" });
export const submitAction = (state: FormState): StudioAction => ({ type: "submit", state });
export const cancelAction = (): StudioAction => ({ type: "cancel" });
