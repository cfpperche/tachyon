import * as vscode from "vscode";
import { panelIcon } from "./shared/panelIcon.js";
import { FLAG_SUGGESTIONS, fromDef, fromCommandDef, fromRunbookDef, fromScheduleDef, quickAddChips, type FormState, type StudioKind } from "./formLogic.js";
import type { AgentDef, CommandDef, RunbookDef, ScheduleDef, EntryKind } from "../config/loadConfig.js";
import { renderWebviewShell } from "./shared/shell.js";
import { READY } from "./shared/ready.js";
import { initMessage, kindInferredMessage, cwdMessage, errorsMessage, type StudioStrings, type StudioAction } from "./agent-studio/messages.js";

/**
 * The Agent Studio panel — a webview form for creating/editing agents.
 * Layout: the KIND is a row of TABS at the top (Agent | Terminal | Command |
 * Runbook); each tab shows its own fields (agent: quick-add catalog +
 * instructions; terminal: watch globs; command: just name/cmd/cwd; runbook:
 * name + steps textarea with live ref/inline resolution), shared fields
 * persist across tab switches, and the form/panel titles follow the active tab. Tabs never switch on their own — typing a
 * known AI CLI under the Terminal tab shows a clickable "switch tab?" hint.
 *
 * Thin by design: all validation/entry-building lives in formLogic (unit-tested);
 * the panel renders state and relays messages. Submit goes through the same
 * comment-preserving yml mutation path as every other UI edit. Theming:
 * hand-rolled CSS over --vscode-* tokens + the bundled codicon font.
 * Localization: strings resolved extension-side via vscode.l10n, shipped in init.
 */

export interface StudioSubmit {
  state: FormState;
  editingName?: string;
}

export interface StudioDeps {
  extensionUri: vscode.Uri;
  detectClis: () => Promise<string[]>;
  takenNames: () => string[];
  /** declared commands: names — drives the Runbook tab's live step resolution */
  commandNames: () => string[];
  /** spec 214 — stack-derived verify candidates + declared command/runbook names (pick-or-edit chips) */
  verifyCandidates: () => string[];
  defaultCwd: string;
  inferKind: (cmd: string) => EntryKind;
  onSubmit: (submit: StudioSubmit) => string[] | undefined; // returns blocking errors, undefined = success
}

/** All webview-visible strings, localized extension-side. */
function studioStrings(): StudioStrings {
  const t = vscode.l10n.t;
  return {
    titleNewAgent: t("New Agent"),
    titleNewTerminal: t("New Terminal"),
    titleEditAgent: t("Edit Agent — {0}", "{0}"),
    titleEditTerminal: t("Edit Terminal — {0}", "{0}"),
    titleNewCommand: t("New Command"),
    titleEditCommand: t("Edit Command — {0}", "{0}"),
    titleNewRunbook: t("New Runbook"),
    titleEditRunbook: t("Edit Runbook — {0}", "{0}"),
    titleNewSchedule: t("New Schedule"),
    titleEditSchedule: t("Edit Schedule — {0}", "{0}"),
    tabAgent: t("Agent"),
    tabTerminal: t("Terminal"),
    tabCommand: t("Command"),
    tabRunbook: t("Runbook"),
    tabSchedule: t("Schedule"),
    tabHintAgent: t("AI CLI — grouped under Agents, attention on by default"),
    tabHintTerminal: t("server / shell / build — grouped under Terminals, attention off by default"),
    tabHintCommand: t("one-shot — runs, exits, shows pass/fail (exit code); agents can run it via run_command"),
    tabHintRunbook: t("sequential steps with an exit-code gate — a failing step stops the procedure; agents run it via run_runbook"),
    tabHintSchedule: t("a timer that fires while the workspace is open — every interval or daily at a time"),
    switchToAgent: t("Detected as an agent — switch tab?"),
    switchToTerminal: t("Detected as a terminal — switch tab?"),
    quickAdd: t("Quick add (detected on this machine)"),
    name: t("Name"),
    namePhAgent: t("frontend, revisor, dev…"),
    namePhTerminal: t("dev, build, db…"),
    namePhCommand: t("test, lint, build…"),
    namePhRunbook: t("ship, deploy, release…"),
    namePhSchedule: t("hourly-tests, standup…"),
    nameHint: t("A free label — the same CLI can back many agents."),
    command: t("Command"),
    commandPhAgent: t("claude · codex · npm run dev"),
    commandPhTerminal: t("npm run dev · docker compose up · bash"),
    commandPhCommand: t("npm test · cargo build · ./deploy.sh"),
    stepsLabel: t("Steps (one per line)"),
    stepsPh: t("lint\ntest\n./deploy.sh"),
    stepsHint: t("A line matching a command name references it; anything else runs as inline shell."),
    stepRef: t("command"),
    stepInline: t("inline shell"),
    instructions: t("Instructions (role prompt)"),
    instructionsPh: t("you are a code reviewer; read the diff and flag correctness issues…"),
    instructionsHint: t("Delivered as a startup prompt for claude / codex / gemini."),
    role: t("Role template"),
    roleNone: t("(none)"),
    roleHint: t("A reusable task contract prepended to the instructions above (coder/reviewer/tester/orchestrator)."),
    watch: t("Watch files (restart on change)"),
    watchPh: t("src/**, package.json"),
    watchHint: t("Comma-separated globs — the terminal restarts when a matching file changes."),
    cwd: t("Working directory"),
    cwdRootPh: t("(workspace root: {0})", "{0}"),
    browse: t("Browse"),
    autostart: t("Auto-start"),
    restart: t("Restart on crash"),
    attention: t("Attention detection"),
    worktreeSummary: t("Git worktree isolation"),
    worktree: t("Run in its own git worktree + branch"),
    branch: t("Branch (blank = tachyon/<name>)"),
    branchPh: t("feature/auth-redesign"),
    worktreeSetup: t("Setup commands (run once on create)"),
    worktreeSetupPh: t("pnpm install\ncp \"$TACHYON_WORKSPACE_ROOT/.env.local\" .env.local"),
    worktreeHint: t("Isolates this agent so parallel agents don't clobber each other. $TACHYON_WORKSPACE_ROOT / $TACHYON_WORKTREE_ROOT are set during setup."),
    verify: t("Verify gate (proves the branch is shippable)"),
    verifyPh: t("npm test · cargo test · a command/runbook name"),
    verifyHint: t("Run in the worktree to prove it's shippable — a command/runbook name or inline shell. Suggestions come from your stack; you choose. Advisory: shows a ✓/✗/⊘ badge, never blocks."),
    verifySuggested: t("Suggested (pick or type your own)"),
    harnessSummary: t("Isolated harness"),
    harness: t("Give this agent its own MCP / skills / rules / hooks"),
    harnessCodex: t("Give this Codex agent its own MCP config"),
    harnessHint: t("Scoped to THIS agent in a private config home — no sibling agent sees them. Codex supports MCP isolation in this pass; Claude also supports skills/rules/hooks. Put secrets as ${VAR} (resolved from .env / your shell)."),
    harnessCodexHint: t("Scoped to THIS Codex agent in a private CODEX_HOME — no sibling agent sees these MCP servers. Codex rules/skills/hooks are not supported in this pass."),
    harnessInherit: t("Inherit"),
    harnessMcpLabel: t("MCP servers (YAML)"),
    harnessMcpPh: t("tavily:\n  command: npx\n  args: [\"-y\", \"tavily-mcp\"]\n  env:\n    TAVILY_API_KEY: ${TAVILY_API_KEY}"),
    harnessRulesLabel: t("Rule files — one path per line"),
    harnessRulesPh: t("rules/researcher.md"),
    harnessSkillsLabel: t("Skill dirs — one path per line"),
    harnessSkillsPh: t("skills/research"),
    harnessHooksLabel: t("Hooks (YAML)"),
    harnessHooksPh: t("PreToolUse:\n  - hooks: [{ type: command, command: \"./guard.sh\" }]"),
    isolate: t("Isolate transcript (own session namespace, same folder)"),
    isolateHint: t("Gives this Claude/Codex agent its own transcript namespace so several agents in ONE folder each keep an attributable, durable history — without the full isolated-harness MCP setup. Project config and your login still apply. Redundant when 'Isolated harness' is on."),
    cancel: t("Cancel"),
    saveAgent: t("Save agent"),
    saveTerminal: t("Save terminal"),
    saveCommand: t("Save command"),
    saveRunbook: t("Save runbook"),
    saveSchedule: t("Save schedule"),
    schedWhen: t("When"),
    schedEvery: t("Every"),
    schedAt: t("Daily at"),
    schedEveryPh: t("1h · 30m · 2h"),
    schedAtPh: t("09:00"),
    schedAction: t("Action"),
    schedRun: t("Run command/runbook"),
    schedSpawn: t("Spawn agent"),
    schedTargetPh: t("name from your tachyon.yml"),
    schedCatchUp: t("Catch up if missed (daily only)"),
    custom: t("Custom…"),
    notInstalled: t("Not installed — {0}", "{0}"),
    notInstalledNoHint: t("Not installed on this machine"),
    studioNewAgent: t("Agent Studio — New Agent"),
    studioNewTerminal: t("Agent Studio — New Terminal"),
    studioNewCommand: t("Agent Studio — New Command"),
    studioNewSchedule: t("Agent Studio — New Schedule"),
    studioNewRunbook: t("Agent Studio — New Runbook"),
  };
}

let panel: vscode.WebviewPanel | undefined;

export async function openAgentStudio(
  deps: StudioDeps,
  edit?: { name: string; def: AgentDef } | { name: string; commandDef: CommandDef } | { name: string; runbookDef: RunbookDef } | { name: string; scheduleDef: ScheduleDef },
  initialKind?: StudioKind,
): Promise<void> {
  const strings = studioStrings();
  const title = edit ? vscode.l10n.t("Agent Studio — {0}", edit.name) : strings.studioNewAgent;
  if (panel) panel.dispose(); // one studio at a time; reopening resets state

  panel = vscode.window.createWebviewPanel("tachyonAgentStudio", title, vscode.ViewColumn.Active, {
    enableScripts: true,
    retainContextWhenHidden: true,
    localResourceRoots: [vscode.Uri.joinPath(deps.extensionUri, "dist", "webview")],
  });
  panel.iconPath = panelIcon(deps.extensionUri, "hubot"); // spec 282 — contextual editor-tab icon
  panel.onDidDispose(() => {
    panel = undefined;
  });

  const initial: FormState | undefined = edit
    ? "commandDef" in edit
      ? fromCommandDef(edit.name, edit.commandDef)
      : "runbookDef" in edit
        ? fromRunbookDef(edit.name, edit.runbookDef)
        : "scheduleDef" in edit
          ? fromScheduleDef(edit.name, edit.scheduleDef)
          : fromDef(edit.name, edit.def)
    : undefined;
  const clis = await deps.detectClis();

  panel.webview.onDidReceiveMessage(async (msg: { type: StudioAction["type"]; state?: FormState; cmd?: string; kind?: StudioKind }) => {
    if (!panel) return;
    switch (msg.type) {
      case READY:
        panel.webview.postMessage(initMessage({
          strings,
          chips: quickAddChips(clis),
          flagMap: FLAG_SUGGESTIONS,
          taken: deps.takenNames(),
          commandNames: deps.commandNames(),
          verifyCandidates: deps.verifyCandidates(),
          defaultCwd: deps.defaultCwd,
          editingName: edit?.name,
          initial,
          initialKind,
        }));
        return;
      case "tab":
        // Panel (editor tab) title follows the active form tab in create mode.
        if (!edit) {
          panel.title =
            msg.kind === "terminal"
              ? strings.studioNewTerminal
              : msg.kind === "command"
                ? strings.studioNewCommand
                : msg.kind === "runbook"
                  ? strings.studioNewRunbook
                  : msg.kind === "schedule"
                    ? strings.studioNewSchedule
                    : strings.studioNewAgent;
        }
        return;
      case "inferKind":
        panel.webview.postMessage(kindInferredMessage(deps.inferKind(msg.cmd ?? "")));
        return;
      case "browse": {
        const picked = await vscode.window.showOpenDialog({
          canSelectFiles: false,
          canSelectFolders: true,
          canSelectMany: false,
          defaultUri: vscode.Uri.file(deps.defaultCwd),
        });
        if (picked?.[0]) panel.webview.postMessage(cwdMessage(picked[0].fsPath));
        return;
      }
      case "submit": {
        if (!msg.state) return;
        const errors = deps.onSubmit({ state: msg.state, editingName: edit?.name });
        if (errors && errors.length > 0) {
          panel.webview.postMessage(errorsMessage(errors));
        } else {
          panel.dispose();
        }
        return;
      }
      case "cancel":
        panel.dispose();
        return;
    }
  });

  const view = panel; // capture the non-null panel for the closure (it's reassigned to undefined on dispose)
  const uri = (f: string): string => view.webview.asWebviewUri(vscode.Uri.joinPath(deps.extensionUri, "dist", "webview", f)).toString();
  view.webview.html = renderWebviewShell({
    cspSource: view.webview.cspSource,
    title,
    styles: [uri("codicon.css"), uri("design-system.css"), uri("agent-studio.css")],
    bundle: uri("agent-studio.js"),
    mode: "live",
  });
}
