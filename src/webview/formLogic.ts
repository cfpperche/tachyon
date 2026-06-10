import { inferKind, instructionsDeliverable, type AgentDef, type EntryKind } from "../config/loadConfig.js";

/**
 * Pure logic behind the Agent Studio form — everything testable lives here;
 * the webview HTML is a thin rendering of this model.
 */

const NAME_RE = /^[a-zA-Z][a-zA-Z0-9_-]*$/;

export interface CatalogEntry {
  bin: string;
  label: string;
  /** curated 2026-06 — install commands age; treated as a hint, not a contract */
  installHint?: string;
  alwaysVisible: boolean;
}

/**
 * The quick-add catalog: majors are always shown (disabled+install hint when not
 * installed — product discovery); the long tail of KNOWN_AI_CLIS appears only
 * when actually detected on the machine.
 */
export const AGENT_CATALOG: CatalogEntry[] = [
  { bin: "claude", label: "Claude Code", installHint: "npm install -g @anthropic-ai/claude-code", alwaysVisible: true },
  { bin: "codex", label: "OpenAI Codex", installHint: "npm install -g @openai/codex", alwaysVisible: true },
  { bin: "gemini", label: "Gemini CLI", installHint: "npm install -g @google/gemini-cli", alwaysVisible: true },
  { bin: "opencode", label: "OpenCode", installHint: "npm install -g opencode-ai", alwaysVisible: true },
  { bin: "copilot", label: "Copilot CLI", installHint: "npm install -g @github/copilot", alwaysVisible: true },
  { bin: "aider", label: "Aider", installHint: "python -m pip install aider-install", alwaysVisible: true },
  { bin: "goose", label: "goose", alwaysVisible: false },
  { bin: "amp", label: "amp", alwaysVisible: false },
  { bin: "grok", label: "grok", alwaysVisible: false },
  { bin: "qwen", label: "qwen", alwaysVisible: false },
  { bin: "cursor-agent", label: "cursor-agent", alwaysVisible: false },
];

export interface QuickAddChip {
  bin: string;
  label: string;
  detected: boolean;
  installHint?: string;
}

/** Merges the catalog with what's installed: majors always, long-tail only when detected. */
export function quickAddChips(detected: string[]): QuickAddChip[] {
  const have = new Set(detected);
  return AGENT_CATALOG.filter((e) => e.alwaysVisible || have.has(e.bin)).map((e) => ({
    bin: e.bin,
    label: e.label,
    detected: have.has(e.bin),
    installHint: have.has(e.bin) ? undefined : e.installHint,
  }));
}

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
  /** comma-separated globs (terminal kind) — parsed into the watch list */
  watch: string;
  cwd: string;
  autostart: boolean;
  restartOnCrash: boolean;
  attention: boolean;
}

/** "src/**, package.json" -> ["src/**", "package.json"] */
export function parseWatch(raw: string): string[] {
  return raw.split(",").map((g) => g.trim()).filter((g) => g.length > 0);
}

export interface FormIssue {
  /** stable code — the UI layer maps it to a localized message */
  code: "name-invalid" | "name-taken" | "cmd-required" | "instructions-not-deliverable";
  blocking: boolean;
  param?: string;
}

export function validateForm(state: FormState, takenNames: string[], editingName?: string): FormIssue[] {
  const issues: FormIssue[] = [];
  if (!NAME_RE.test(state.name)) {
    issues.push({ code: "name-invalid", blocking: true });
  } else if (takenNames.includes(state.name) && state.name !== editingName) {
    issues.push({ code: "name-taken", blocking: true, param: state.name });
  }
  if (state.cmd.trim().length === 0) issues.push({ code: "cmd-required", blocking: true });
  if (state.instructions.trim().length > 0 && !instructionsDeliverable(state.cmd)) {
    issues.push({ code: "instructions-not-deliverable", blocking: false });
  }
  return issues;
}

/** Hard issues block submit; informational notes don't. */
export function blockingErrors(issues: FormIssue[]): FormIssue[] {
  return issues.filter((i) => i.blocking);
}

/**
 * The yml entry for this form state — only non-default fields are written,
 * keeping hand-readable configs clean (kind omitted when it matches inference, etc.).
 */
export function toEntry(state: FormState): Record<string, unknown> {
  const entry: Record<string, unknown> = { cmd: state.cmd.trim() };
  const inferred = inferKind(state.cmd);
  if (state.kind !== inferred) entry.kind = state.kind;
  if (state.kind === "agent" && state.instructions.trim().length > 0) entry.instructions = state.instructions.trim();
  const watch = state.kind === "terminal" ? parseWatch(state.watch) : [];
  if (watch.length === 1) entry.watch = watch[0];
  else if (watch.length > 1) entry.watch = watch;
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
    watch: def.watch.join(", "),
    cwd: def.cwd ?? "",
    autostart: def.autostart,
    restartOnCrash: def.restart === "on-crash",
    attention: def.attention.enabled,
  };
}
