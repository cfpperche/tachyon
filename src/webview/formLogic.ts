import { inferKind, instructionsDeliverable, type AgentDef, type EntryKind } from "../config/loadConfig.js";

/**
 * Pure logic behind the Agent Studio form — everything testable lives here;
 * the webview HTML is a thin rendering of this model.
 */

const NAME_RE = /^[a-zA-Z][a-zA-Z0-9_-]*$/;

/** Per-runtime flag suggestions shown as toggle chips under the command field. */
export const FLAG_SUGGESTIONS: Record<string, string[]> = {
  claude: ["--dangerously-skip-permissions", "--model sonnet", "--model haiku", "--permission-mode plan", "--continue"],
  codex: ["--yolo", "-m gpt-5-codex", "--full-auto"],
  gemini: ["--yolo"],
  opencode: [],
  aider: ["--yes-always", "--watch-files"],
};

export function flagSuggestionsFor(cmd: string): string[] {
  const base = (cmd.trim().split(/\s+/)[0] ?? "").split("/").pop() ?? "";
  return FLAG_SUGGESTIONS[base] ?? [];
}

/** Toggles a flag inside a command string (chip click). */
export function toggleFlag(cmd: string, flag: string): string {
  const trimmed = cmd.trim();
  if (trimmed.includes(` ${flag}`) || trimmed.endsWith(flag)) {
    return trimmed.replace(new RegExp(`\\s+${flag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=\\s|$)`), "").trim();
  }
  return `${trimmed} ${flag}`;
}

/** Suggests a unique name from a base (claude -> claude-2 -> claude-3 ...). */
export function suggestName(base: string, taken: string[]): string {
  const clean = base.toLowerCase().replace(/[^a-z0-9_-]/g, "-").replace(/^[^a-z]+/, "") || "agent";
  if (!taken.includes(clean)) return clean;
  for (let i = 2; ; i++) {
    if (!taken.includes(`${clean}-${i}`)) return `${clean}-${i}`;
  }
}

export interface FormState {
  name: string;
  cmd: string;
  kind: EntryKind;
  instructions: string;
  cwd: string;
  autostart: boolean;
  restartOnCrash: boolean;
  attention: boolean;
}

export function validateForm(state: FormState, takenNames: string[], editingName?: string): string[] {
  const errors: string[] = [];
  if (!NAME_RE.test(state.name)) {
    errors.push("name: letters/digits/_/-, starting with a letter");
  } else if (takenNames.includes(state.name) && state.name !== editingName) {
    errors.push(`name: '${state.name}' already exists`);
  }
  if (state.cmd.trim().length === 0) errors.push("command: required");
  if (state.instructions.trim().length > 0 && !instructionsDeliverable(state.cmd)) {
    errors.push("note: this CLI doesn't accept a startup prompt — instructions will be saved but not auto-delivered");
  }
  return errors;
}

/** Hard errors block submit; the instructions note is informational. */
export function blockingErrors(errors: string[]): string[] {
  return errors.filter((e) => !e.startsWith("note:"));
}

/**
 * The yml entry for this form state — only non-default fields are written,
 * keeping hand-readable configs clean (kind omitted when it matches inference, etc.).
 */
export function toEntry(state: FormState): Record<string, unknown> {
  const entry: Record<string, unknown> = { cmd: state.cmd.trim() };
  const inferred = inferKind(state.cmd);
  if (state.kind !== inferred) entry.kind = state.kind;
  if (state.instructions.trim().length > 0) entry.instructions = state.instructions.trim();
  if (state.cwd.trim().length > 0) entry.cwd = state.cwd.trim();
  if (state.autostart) entry.autostart = true;
  if (state.restartOnCrash) entry.restart = "on-crash";
  const attentionDefault = state.kind === "agent";
  if (state.attention !== attentionDefault) entry.attention = state.attention;
  return entry;
}

/** Pre-fills the form from an existing definition (edit mode). */
export function fromDef(name: string, def: AgentDef): FormState {
  return {
    name,
    cmd: def.cmd,
    kind: def.kind,
    instructions: def.instructions ?? "",
    cwd: def.cwd ?? "",
    autostart: def.autostart,
    restartOnCrash: def.restart === "on-crash",
    attention: def.attention.enabled,
  };
}
