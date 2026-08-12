import { asAgent, defaultAttentionEnabled, suggestKindForCommand, instructionsDeliverable, parseEvery, parseAt, resolveBinary, type AgentDef, type EntryKind, type ScheduleDef } from "../config/loadConfig.js";
import { isAttestedRuntime } from "../runtime/attestedRuntimes.js";

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
 *
 * t-d68b8b — this list is deliberately WIDER than what `quickAddChips` offers today. It is the
 * authoring catalog (label, install hint, logo) for every runtime this repo knows how to name; the
 * chip filter below decides which of them the Agent form may currently create. Trimming an entry
 * here would mean re-authoring it the day its runtime becomes attested, which is exactly the copy
 * this task exists to remove.
 */
export const AGENT_CATALOG: CatalogEntry[] = [
  { bin: "claude", label: "Claude Code", installHint: "npm install -g @anthropic-ai/claude-code", alwaysVisible: true },
  { bin: "codex", label: "OpenAI Codex", installHint: "npm install -g @openai/codex", alwaysVisible: true },
  { bin: "agy", label: "Antigravity CLI", installHint: "curl -fsSL https://antigravity.google/cli/install.sh | bash", alwaysVisible: true },
  { bin: "gemini", label: "Gemini CLI (legacy)", installHint: "npm install -g @google/gemini-cli", alwaysVisible: false },
  { bin: "opencode", label: "OpenCode", installHint: "npm install -g opencode-ai", alwaysVisible: true },
  { bin: "copilot", label: "Copilot CLI", installHint: "npm install -g @github/copilot", alwaysVisible: true },
  { bin: "aider", label: "Aider", installHint: "python -m pip install aider-install", alwaysVisible: false },
  { bin: "goose", label: "goose", alwaysVisible: false },
  { bin: "amp", label: "amp", alwaysVisible: false },
  { bin: "grok", label: "grok", alwaysVisible: false },
  { bin: "qwen", label: "qwen", alwaysVisible: false },
  { bin: "cursor-agent", label: "cursor-agent", alwaysVisible: false },
  { bin: "pi", label: "Pi", installHint: "npm install -g --ignore-scripts @earendil-works/pi-coding-agent", alwaysVisible: true },
  { bin: "hermes", label: "Hermes Agent", installHint: "curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash", alwaysVisible: true },
  { bin: "verboo", label: "Verboo Code", installHint: "npm install -g @verboo/code", alwaysVisible: true },
];

export interface QuickAddChip {
  bin: string;
  label: string;
  detected: boolean;
  installHint?: string;
}

/**
 * Merges the catalog with what's installed: majors always, long-tail only when detected — and only
 * for a runtime Tachyon attests.
 *
 * t-d68b8b — the attestation filter closes a dead end rather than adding a rule. Agent Studio's only
 * writer is the canonical profile door, and that door refuses a runtime outside `ATTESTED_RUNTIMES`
 * (`agentProfileProjection`); a chip for one of the other six offered the human a path whose save
 * then told them to go to Agent Studio — where they already were. Five of those six were
 * `alwaysVisible`, so this was the loudest half of the form.
 *
 * Read from `isAttestedRuntime`, never from a second list here: the day a runtime is attested its
 * chip comes back with no edit to this file, and the day one is withdrawn the chip leaves with it.
 * The block is on the creation path, not a verdict on the runtimes — see `newAgentRuntimeRefusal`.
 */
export function quickAddChips(detected: string[]): QuickAddChip[] {
  const have = new Set(detected);
  return AGENT_CATALOG.filter((e) => isAttestedRuntime(e.bin) && (e.alwaysVisible || have.has(e.bin))).map((e) => ({
    bin: e.bin,
    label: e.label,
    detected: have.has(e.bin),
    installHint: have.has(e.bin) ? undefined : e.installHint,
  }));
}

/** Per-runtime flag suggestions shown as toggle chips under the command field. */
export const FLAG_SUGGESTIONS: Record<string, string[]> = {
  claude: ["--dangerously-skip-permissions", "--model sonnet", "--model haiku", "--permission-mode plan", "--continue"],
  // t-aaa2c6 — `--full-auto` is rejected by codex-cli 0.146.0 ("unexpected argument"); suggesting it
  // handed the human a command that cannot launch. `--sandbox` is what that chip was reaching for.
  codex: ["--yolo", "--model", "--sandbox"],
  agy: ["--dangerously-skip-permissions", "--model", "--sandbox", "--continue"],
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

/** What the Studio can produce: an agents: entry (agent/terminal), a commands: entry, or a runbooks: entry. */
export type StudioKind = EntryKind | "command" | "runbook" | "schedule";

export interface FormState {
  name: string;
  cmd: string;
  kind: StudioKind;
  instructions: string;
  /** comma-separated globs (terminal kind) — parsed into the watch list */
  watch: string;
  /** newline-separated steps (runbook kind) — each line a command name or inline shell */
  steps: string;
  cwd: string;
  autostart: boolean;
  restartOnCrash: boolean;
  attention: boolean;
  /** spec 210 — run this agent/terminal in its own git worktree + branch */
  worktree: boolean;
  /** per-agent literal branch (blank = global template / tachyon/<name>) */
  branch: string;
  /** newline-separated setup commands run once on worktree create */
  worktreeSetup: string;
  /** Deprecated read-compat field; Agent Studio no longer writes isolate: transcript. */
  isolate: boolean;
  /** schedule kind: timing mode + value, action mode + target, catch-up */
  schedTiming: "every" | "at";
  schedEvery: string; // "1h" / "30m"
  schedAt: string; // "09:00"
  schedAction: "run" | "spawn";
  schedTarget: string; // command/runbook name (run) or agent name (spawn)
  catchUp: boolean;
}

/** "src/**, package.json" -> ["src/**", "package.json"] */
export function parseWatch(raw: string): string[] {
  return raw.split(",").map((g) => g.trim()).filter((g) => g.length > 0);
}

/** Textarea -> steps list: one per line, trimmed, blanks dropped. */
export function parseSteps(raw: string): string[] {
  return raw.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
}

/** Live hint for the Runbook tab: how each step line will resolve. */
export function stepResolutions(raw: string, commandNames: string[]): Array<{ step: string; ref: boolean }> {
  return parseSteps(raw).map((step) => ({ step, ref: commandNames.includes(step) }));
}

export interface FormIssue {
  /** stable code — the UI layer maps it to a localized message */
  code:
    | "name-invalid"
    | "name-taken"
    | "cmd-required"
    | "steps-required"
    | "instructions-not-deliverable"
    | "timing-invalid"
    | "target-required"
    | "terminal-cmd-is-attested-runtime";
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
  if (state.kind === "runbook") {
    // a runbook is name + steps; cmd doesn't apply
    if (parseSteps(state.steps).length === 0) issues.push({ code: "steps-required", blocking: true });
    return issues;
  }
  if (state.kind === "schedule") {
    const timing = state.schedTiming === "every" ? state.schedEvery : state.schedAt;
    const ok = state.schedTiming === "every" ? parseEvery(timing) !== null : parseAt(timing) !== null;
    if (!ok) issues.push({ code: "timing-invalid", blocking: true });
    if (state.schedTarget.trim().length === 0) issues.push({ code: "target-required", blocking: true });
    return issues;
  }
  if (state.cmd.trim().length === 0) issues.push({ code: "cmd-required", blocking: true });
  // SDD 478 M6 — a Terminal is a generic process. An attested LLM runtime is an Agent, so Terminal
  // Studio refuses it here rather than creating a terminal that will silently be denied every agent
  // capability the runtime exists for. The refusal names the door to use instead.
  if (state.kind === "terminal" && isAttestedRuntime(resolveBinary(state.cmd))) {
    issues.push({ code: "terminal-cmd-is-attested-runtime", blocking: true, param: resolveBinary(state.cmd) });
  }
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
  if (state.kind === "schedule") {
    const entry: Record<string, unknown> = {};
    if (state.schedTiming === "every") entry.every = state.schedEvery.trim();
    else entry.at = state.schedAt.trim();
    if (state.schedAction === "run") entry.run = state.schedTarget.trim();
    else {
      entry.spawn = state.schedTarget.trim();
      if (state.instructions.trim().length > 0) entry.instructions = state.instructions.trim();
    }
    if (state.schedTiming === "at" && state.catchUp) entry.catchUp = true;
    return entry;
  }
  if (state.kind === "runbook") return { steps: parseSteps(state.steps) };
  const entry: Record<string, unknown> = { cmd: state.cmd.trim() };
  if (state.kind === "command") {
    // commands: entries carry only cmd/cwd — lifecycle fields don't apply to one-shots
    if (state.cwd.trim().length > 0) entry.cwd = state.cwd.trim();
    return entry;
  }
  const inferred = suggestKindForCommand(state.cmd);
  if (state.kind !== inferred) entry.kind = state.kind;
  if (state.kind === "agent" && state.instructions.trim().length > 0) entry.instructions = state.instructions.trim();
  const watch = state.kind === "terminal" ? parseWatch(state.watch) : [];
  if (watch.length === 1) entry.watch = watch[0];
  else if (watch.length > 1) entry.watch = watch;
  if (state.cwd.trim().length > 0) entry.cwd = state.cwd.trim();
  if (state.autostart) entry.autostart = true;
  if (state.restartOnCrash) entry.restart = "on-crash";
  // t-26ba8f — the same statement of the default `upsertAgent` reads to decide what an OMITTED
  // `attention:` key means, so the writer can merge a preserved silenceSec/patterns back onto it.
  if (state.attention !== defaultAttentionEnabled(state.kind)) entry.attention = state.attention;
  // spec 210 — separate worktree checkout (agent or terminal kind)
  if (state.worktree) entry.worktree = true;
  if (state.branch.trim().length > 0) entry.branch = state.branch.trim();
  const setup = parseSteps(state.worktreeSetup);
  if (setup.length === 1) entry.worktreeSetup = setup[0];
  else if (setup.length > 1) entry.worktreeSetup = setup;
  return entry;
}


const SCHED_DEFAULTS = {
  schedTiming: "every" as const,
  schedEvery: "1h",
  schedAt: "09:00",
  schedAction: "run" as const,
  schedTarget: "",
  catchUp: false,
};

/** Pre-fills the form from an existing schedules: entry (edit mode, Schedule tab). */
export function fromScheduleDef(name: string, def: ScheduleDef): FormState {
  return {
    name,
    cmd: "",
    kind: "schedule",
    worktree: false,
    branch: "",
    worktreeSetup: "",
    instructions: def.instructions ?? "",
    watch: "",
    steps: "",
    cwd: "",
    autostart: false,
    restartOnCrash: false,
    attention: false,
    schedTiming: def.at !== undefined ? "at" : "every",
    schedEvery: def.every ?? "1h",
    schedAt: def.at ?? "09:00",
    schedAction: def.spawn !== undefined ? "spawn" : "run",
    schedTarget: def.run ?? def.spawn ?? "",
    catchUp: def.catchUp ?? false,
    isolate: false,
  };
}

/** Pre-fills the form from an existing commands: entry (edit mode, Command tab). */
export function fromCommandDef(name: string, def: { cmd: string; cwd?: string }): FormState {
  return {
    name,
    cmd: def.cmd,
    kind: "command",
    worktree: false,
    branch: "",
    worktreeSetup: "",
    instructions: "",
    watch: "",
    steps: "",
    cwd: def.cwd ?? "",
    autostart: false,
    restartOnCrash: false,
    attention: false,
    ...SCHED_DEFAULTS,
    isolate: false,
  };
}

/** Pre-fills the form from an existing runbooks: entry (edit mode, Runbook tab). */
export function fromRunbookDef(name: string, def: { steps: string[] }): FormState {
  return {
    name,
    cmd: "",
    kind: "runbook",
    worktree: false,
    branch: "",
    worktreeSetup: "",
    instructions: "",
    watch: "",
    steps: def.steps.join("\n"),
    cwd: "",
    autostart: false,
    restartOnCrash: false,
    attention: false,
    ...SCHED_DEFAULTS,
    isolate: false,
  };
}

/** Pre-fills the form from an existing definition (edit mode). */
/** SDD 478 — the studio edits an entry of either kind, so every agent-only field is read through
 *  the Agent arm and falls back to the blank default for a terminal. */
export function fromDef(name: string, entry: AgentDef): FormState {
  const def = asAgent(entry);
  return {
    name,
    cmd: entry.cmd,
    kind: entry.kind,
    instructions: def?.instructions ?? "",
    watch: entry.watch.join(", "),
    steps: "",
    cwd: entry.cwd ?? "",
    autostart: entry.autostart,
    restartOnCrash: entry.restart === "on-crash",
    attention: entry.attention.enabled,
    worktree: def?.worktree ?? false,
    branch: def?.branch ?? "",
    worktreeSetup: (def?.worktreeSetup ?? []).join("\n"),
    ...SCHED_DEFAULTS,
    isolate: false,
  };
}
