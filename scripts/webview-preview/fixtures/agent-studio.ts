/**
 * spec 279 — Agent Studio fixtures for the dev preview harness. The Studio renders from a single `init`
 * message, so the fixture VM IS the InitPayload. Provenance: `synthetic-edge` — the strings are the English
 * l10n defaults; chips/flags mirror formLogic's real catalog (quickAddChips/FLAG_SUGGESTIONS), all typed
 * against the real InitPayload/FormState so a shape drift breaks the build.
 */

import type { FormState, QuickAddChip } from "../../../src/webview/formLogic";
import type { InitPayload, StudioStrings } from "../../../src/webview/agent-studio/messages";
import type { Fixture } from "../routes";

// hand-authored (browser-safe: importing formLogic VALUES would pull loadConfig → node:fs into the browser
// bundle). Typed against the real shapes so a drift breaks the build; mirrors quickAddChips/FLAG_SUGGESTIONS.
const chips: QuickAddChip[] = [
  { bin: "claude", label: "Claude Code", detected: true },
  { bin: "codex", label: "OpenAI Codex", detected: true },
  { bin: "gemini", label: "Gemini CLI", detected: false, installHint: "npm install -g @google/gemini-cli" },
  { bin: "opencode", label: "OpenCode", detected: false, installHint: "npm install -g opencode-ai" },
];
const flagMap: Record<string, string[]> = {
  claude: ["--dangerously-skip-permissions", "--continue", "--model"],
  codex: ["--full-auto", "--model"],
};
const editAgent: FormState = {
  name: "review", cmd: "claude", kind: "agent", instructions: "review diffs", role: "reviewer", watch: "", steps: "", cwd: "",
  autostart: false, restartOnCrash: false, attention: true,
  worktree: false, branch: "", worktreeSetup: "", verify: "",
  harness: false, harnessInherit: "workspace", harnessMcp: "", harnessRules: "", harnessSkills: "", harnessHooks: "",
  isolate: false, schedTiming: "every", schedEvery: "", schedAt: "", schedAction: "run", schedTarget: "", catchUp: false,
};

const strings: StudioStrings = {
  titleNewAgent: "New Agent", titleNewTerminal: "New Terminal", titleEditAgent: "Edit Agent — {0}", titleEditTerminal: "Edit Terminal — {0}",
  titleNewCommand: "New Command", titleEditCommand: "Edit Command — {0}", titleNewRunbook: "New Runbook", titleEditRunbook: "Edit Runbook — {0}",
  titleNewSchedule: "New Schedule", titleEditSchedule: "Edit Schedule — {0}",
  tabAgent: "Agent", tabTerminal: "Terminal", tabCommand: "Command", tabRunbook: "Runbook", tabSchedule: "Schedule",
  tabHintAgent: "AI CLI — grouped under Agents, attention on by default",
  tabHintTerminal: "server / shell / build — grouped under Terminals, attention off by default",
  tabHintCommand: "one-shot — runs, exits, shows pass/fail (exit code); agents can run it via run_command",
  tabHintRunbook: "sequential steps with an exit-code gate — a failing step stops the procedure; agents run it via run_runbook",
  tabHintSchedule: "a timer that fires while the workspace is open — every interval or daily at a time",
  switchToAgent: "Detected as an agent — switch tab?", switchToTerminal: "Detected as a terminal — switch tab?",
  quickAdd: "Quick add (detected on this machine)",
  name: "Name", namePhAgent: "frontend, revisor, dev…", namePhTerminal: "dev, build, db…", namePhCommand: "test, lint, build…",
  namePhRunbook: "ship, deploy, release…", namePhSchedule: "hourly-tests, standup…", nameHint: "A free label — the same CLI can back many agents.",
  command: "Command", commandPhAgent: "claude · codex · npm run dev", commandPhTerminal: "npm run dev · docker compose up · bash", commandPhCommand: "npm test · cargo build · ./deploy.sh",
  stepsLabel: "Steps (one per line)", stepsPh: "lint\ntest\n./deploy.sh", stepsHint: "A line matching a command name references it; anything else runs as inline shell.", stepRef: "command", stepInline: "inline shell",
  instructions: "Instructions (role prompt)", instructionsPh: "you are a code reviewer; read the diff…", instructionsHint: "Delivered as a startup prompt for claude / codex / gemini.",
  role: "Role template", roleNone: "(none)", roleHint: "A reusable task contract prepended to the instructions above.",
  watch: "Watch files (restart on change)", watchPh: "src/**, package.json", watchHint: "Comma-separated globs — the terminal restarts when a matching file changes.",
  cwd: "Working directory", cwdRootPh: "(workspace root: {0})", browse: "Browse",
  autostart: "Auto-start", restart: "Restart on crash", attention: "Attention detection",
  worktreeSummary: "Git worktree isolation", worktree: "Run in its own git worktree + branch", branch: "Branch (blank = tachyon/<name>)", branchPh: "feature/auth-redesign",
  worktreeSetup: "Setup commands (run once on create)", worktreeSetupPh: "pnpm install", worktreeHint: "Isolates this agent so parallel agents don't clobber each other.",
  verify: "Verify gate (proves the branch is shippable)", verifyPh: "npm test · cargo test · a command/runbook name", verifyHint: "Run in the worktree to prove it's shippable.", verifySuggested: "Suggested (pick or type your own)",
  harnessSummary: "Isolated harness", harness: "Give this agent its own MCP / skills / rules / hooks", harnessHint: "Scoped to THIS agent in a private config home — claude-only.", harnessInherit: "Inherit",
  harnessMcpLabel: "MCP servers (YAML)", harnessMcpPh: "tavily:\n  command: npx", harnessRulesLabel: "Rule files — one path per line", harnessRulesPh: "rules/researcher.md",
  harnessSkillsLabel: "Skill dirs — one path per line", harnessSkillsPh: "skills/research", harnessHooksLabel: "Hooks (YAML)", harnessHooksPh: "PreToolUse:",
  isolate: "Isolate transcript (own session namespace, same folder)", isolateHint: "Gives this claude agent its own transcript namespace. claude-only.",
  cancel: "Cancel", saveAgent: "Save agent", saveTerminal: "Save terminal", saveCommand: "Save command", saveRunbook: "Save runbook", saveSchedule: "Save schedule",
  schedWhen: "When", schedEvery: "Every", schedAt: "Daily at", schedEveryPh: "1h · 30m · 2h", schedAtPh: "09:00",
  schedAction: "Action", schedRun: "Run command/runbook", schedSpawn: "Spawn agent", schedTargetPh: "name from your tachyon.yml", schedCatchUp: "Catch up if missed (daily only)",
  custom: "Custom…", notInstalled: "Not installed — {0}", notInstalledNoHint: "Not installed on this machine",
  studioNewAgent: "Agent Studio — New Agent", studioNewTerminal: "Agent Studio — New Terminal", studioNewCommand: "Agent Studio — New Command", studioNewSchedule: "Agent Studio — New Schedule", studioNewRunbook: "Agent Studio — New Runbook",
};

const baseInit: Omit<InitPayload, "initial" | "initialKind" | "editingName"> = {
  strings, chips, flagMap,
  taken: ["build", "review"],
  commandNames: ["test", "lint"],
  verifyCandidates: ["npm test", "lint"],
  defaultCwd: "/home/you/project",
};

export const agentStudioFixtures: Record<string, Fixture<InitPayload>> = {
  // a fresh New-Agent form.
  default: { provenance: "synthetic-edge", vm: { ...baseInit, initialKind: "agent" } },
  // edit mode (tabs locked) seeded from a typed FormState.
  "edit-agent": { provenance: "synthetic-edge", vm: { ...baseInit, editingName: "review", initial: editAgent } },
};
