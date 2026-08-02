import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { asAgent, suggestKindForCommand, instructionsDeliverable, openingPromptCapability, parseEvery, parseAt, resolveBinary, type AgentDef, type EntryKind, type ScheduleDef } from "../config/loadConfig.js";
import { isAttestedRuntime } from "../runtime/attestedRuntimes.js";
import { binaryOf } from "../resume/adapters.js";

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
  /** spec 377 T14 — opt in to the agent's persistent soul profile. */
  soul: boolean;
  /** spec 421 — opt in to Tachyon-owned, human-reviewed evolution. */
  selfEvolution: boolean;
  /** spec 216 — built-in role template ("" = none); agent kind only */
  role: string;
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
  /** spec 214 — verify-gate: a command/runbook name or inline shell run in the worktree to prove it shippable */
  verify: string;
  /** spec 226/228 — isolated harness: scoped MCP/skills/rules/hooks in a private config home (agent kind, claude). */
  harness: boolean;
  /** "none" | "workspace" (default "workspace") */
  harnessInherit: string;
  /** YAML text of the `mcp:` server map ("" = none) */
  harnessMcp: string;
  /** newline-separated rule file paths */
  harnessRules: string;
  /** newline-separated codex instruction file paths */
  harnessInstructions: string;
  /** newline-separated skill dir paths */
  harnessSkills: string;
  /** YAML text of the `hooks:` object ("" = none) */
  harnessHooks: string;
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

/** Parse a YAML/JSON textarea (the harness mcp/hooks fields) into a plain object, or undefined when
 *  blank. Throws on malformed input or a non-mapping — validateForm surfaces it; toEntry runs only
 *  after validation passes. */
export function parseYamlObject(raw: string): Record<string, unknown> | undefined {
  if (raw.trim().length === 0) return undefined;
  const parsed = parseYaml(raw);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("expected a mapping");
  return parsed as Record<string, unknown>;
}

/** Non-throwing: does this harness YAML textarea parse to a mapping (or is blank)? (validateForm) */
function harnessYamlOk(raw: string): boolean {
  try {
    parseYamlObject(raw);
    return true;
  } catch {
    return false;
  }
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
    | "soul-invalid"
    | "soul-runtime-unsupported"
    | "self-evolution-invalid"
    | "timing-invalid"
    | "target-required"
    | "harness-claude-only"
    | "codex-harness-mcp-only"
    | "harness-home-config-only"
    | "harness-empty"
    | "harness-mcp-invalid"
    | "harness-hooks-invalid"
    | "terminal-cmd-is-attested-runtime";
  blocking: boolean;
  param?: string;
}

/** Studio runtimes that expose Isolated harness (must match ResumeAdapter.harness + loadConfig). */
export type HarnessStudioRuntime = "claude" | "codex" | "opencode" | "grok" | "hermes";

const HARNESS_STUDIO_BINS = new Set<string>(["claude", "codex", "opencode", "grok", "hermes"]);

export function harnessRuntimeOf(cmd: string): HarnessStudioRuntime | undefined {
  const binary = binaryOf(cmd);
  return HARNESS_STUDIO_BINS.has(binary) ? (binary as HarnessStudioRuntime) : undefined;
}

/** True when the studio may show CLAUDE.md-style rules for this harness runtime. */
export function harnessShowsRules(runtime: HarnessStudioRuntime | undefined): boolean {
  return runtime === "claude";
}

/** True when the studio may show Codex AGENTS.md instruction files for this harness runtime. */
export function harnessShowsInstructions(runtime: HarnessStudioRuntime | undefined): boolean {
  return runtime === "codex";
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
  if (state.soul !== undefined && typeof state.soul !== "boolean") {
    issues.push({ code: "soul-invalid", blocking: true });
  } else if (state.kind === "agent" && state.soul) {
    const capability = openingPromptCapability(state.cmd);
    if (capability.status !== "prompt") {
      issues.push({ code: "soul-runtime-unsupported", blocking: true, param: capability.runtime });
    }
  }
  if (state.selfEvolution !== undefined && typeof state.selfEvolution !== "boolean") {
    issues.push({ code: "self-evolution-invalid", blocking: true });
  }
  // spec 226/228 — isolated harness (agent kind). The deep rules (${VAR}-only mcp env, reserved cmd
  // flags) are enforced by loadConfig on write; the Studio catches the obvious mistakes early.
  if (state.kind === "agent" && state.harness) {
    const runtime = harnessRuntimeOf(state.cmd);
    if (!runtime) issues.push({ code: "harness-claude-only", blocking: true });
    if (!harnessYamlOk(state.harnessMcp)) issues.push({ code: "harness-mcp-invalid", blocking: true });
    if (!harnessYamlOk(state.harnessHooks)) issues.push({ code: "harness-hooks-invalid", blocking: true });
    if (runtime === "codex" && parseSteps(state.harnessRules).length > 0) {
      issues.push({ code: "codex-harness-mcp-only", blocking: true });
    }
    // opencode/grok/hermes: mcp/skills/hooks only — rules/instructions fields are hidden but
    // still validate if a stale form state carries them.
    if (
      runtime &&
      !harnessShowsRules(runtime) &&
      !harnessShowsInstructions(runtime) &&
      (parseSteps(state.harnessRules).length > 0 || parseSteps(state.harnessInstructions).length > 0)
    ) {
      issues.push({ code: "harness-home-config-only", blocking: true, param: runtime });
    }
    const hasAny =
      state.harnessMcp.trim().length > 0 ||
      state.harnessHooks.trim().length > 0 ||
      parseSteps(state.harnessInstructions).length > 0 ||
      parseSteps(state.harnessRules).length > 0 ||
      parseSteps(state.harnessSkills).length > 0;
    // Codex already has a private home by default — empty harness is meaningless.
    // Other harnessable runtimes allow `harness: {}` (private home + Bridge only) via yml;
    // Studio still requires at least one field when the toggle is on (matches prior claude UX).
    if (!hasAny) issues.push({ code: "harness-empty", blocking: true });
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
  if (state.kind === "agent" && state.role.trim().length > 0) entry.role = state.role.trim();
  if (state.kind === "agent" && state.soul === true) entry.soul = true;
  if (state.kind === "agent" && state.selfEvolution === true) entry.selfEvolution = { enabled: true };
  const watch = state.kind === "terminal" ? parseWatch(state.watch) : [];
  if (watch.length === 1) entry.watch = watch[0];
  else if (watch.length > 1) entry.watch = watch;
  if (state.cwd.trim().length > 0) entry.cwd = state.cwd.trim();
  if (state.autostart) entry.autostart = true;
  if (state.restartOnCrash) entry.restart = "on-crash";
  const attentionDefault = state.kind === "agent";
  if (state.attention !== attentionDefault) entry.attention = state.attention;
  // spec 210 — worktree isolation (agent or terminal kind)
  if (state.worktree) entry.worktree = true;
  if (state.branch.trim().length > 0) entry.branch = state.branch.trim();
  const setup = parseSteps(state.worktreeSetup);
  if (setup.length === 1) entry.worktreeSetup = setup[0];
  else if (setup.length > 1) entry.worktreeSetup = setup;
  // spec 214 — verify-gate (worktree-scoped; written when set so a worktree agent can be verified)
  if (state.verify.trim().length > 0) entry.verify = state.verify.trim();
  // spec 226/228 — isolated harness (agent kind). Runs only after validateForm passed, so the YAML
  // fields parse. Omit empty sub-keys so the written block stays clean.
  if (state.kind === "agent" && state.harness) {
    const h: Record<string, unknown> = { inherit: state.harnessInherit.trim() || "workspace" };
    const mcp = parseYamlObject(state.harnessMcp);
    if (mcp) h.mcp = mcp;
    const rules = parseSteps(state.harnessRules);
    if (rules.length > 0) h.rules = rules;
    const instructions = parseSteps(state.harnessInstructions);
    if (instructions.length > 0) h.instructions = instructions;
    const skills = parseSteps(state.harnessSkills);
    if (skills.length > 0) h.skills = skills;
    const hooks = parseYamlObject(state.harnessHooks);
    if (hooks) h.hooks = hooks;
    entry.harness = h;
  }
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

/** Blank isolated-harness fields (spec 226/228) — spread into every non-agent FormState literal. */
const HARNESS_DEFAULTS = {
  harness: false,
  harnessInherit: "workspace",
  harnessMcp: "",
  harnessRules: "",
  harnessInstructions: "",
  harnessSkills: "",
  harnessHooks: "",
  isolate: false,
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
    verify: "",
    instructions: def.instructions ?? "",
    soul: false,
    selfEvolution: false,
    role: "",
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
    ...HARNESS_DEFAULTS,
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
    verify: "",
    instructions: "",
    soul: false,
    selfEvolution: false,
    role: "",
    watch: "",
    steps: "",
    cwd: def.cwd ?? "",
    autostart: false,
    restartOnCrash: false,
    attention: false,
    ...SCHED_DEFAULTS,
    ...HARNESS_DEFAULTS,
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
    verify: "",
    instructions: "",
    soul: false,
    selfEvolution: false,
    role: "",
    watch: "",
    steps: def.steps.join("\n"),
    cwd: "",
    autostart: false,
    restartOnCrash: false,
    attention: false,
    ...SCHED_DEFAULTS,
    ...HARNESS_DEFAULTS,
  };
}

/** Pre-fills the form from an existing definition (edit mode). */
/** SDD 478 — the studio edits an entry of either kind, so every agent-only field is read through
 *  the Agent arm and falls back to the blank default for a terminal. */
export function fromDef(name: string, entry: AgentDef): FormState {
  const def = asAgent(entry);
  const h = def?.harness;
  return {
    name,
    cmd: entry.cmd,
    kind: entry.kind,
    instructions: def?.instructions ?? "",
    soul: def?.soul === true,
    selfEvolution: def?.selfEvolution?.enabled === true,
    role: def?.role ?? "",
    watch: entry.watch.join(", "),
    steps: "",
    cwd: entry.cwd ?? "",
    autostart: entry.autostart,
    restartOnCrash: entry.restart === "on-crash",
    attention: entry.attention.enabled,
    worktree: def?.worktree ?? false,
    branch: def?.branch ?? "",
    worktreeSetup: (def?.worktreeSetup ?? []).join("\n"),
    verify: def?.verify ?? "",
    ...SCHED_DEFAULTS,
    // spec 226/228 — round-trip the harness into the form (mcp/hooks back to YAML text for editing).
    harness: !!h,
    harnessInherit: h?.inherit ?? "workspace",
    harnessMcp: h?.mcp ? stringifyYaml(h.mcp).trimEnd() : "",
    harnessRules: (h?.rules ?? []).join("\n"),
    harnessInstructions: (h?.instructions ?? []).join("\n"),
    harnessSkills: (h?.skills ?? []).join("\n"),
    harnessHooks: h?.hooks ? stringifyYaml(h.hooks).trimEnd() : "",
    isolate: false,
  };
}
