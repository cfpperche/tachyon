import * as vscode from "vscode";
import crypto from "node:crypto";
import { FLAG_SUGGESTIONS, fromDef, fromCommandDef, fromRunbookDef, fromScheduleDef, quickAddChips, type FormState, type StudioKind } from "./formLogic.js";
import type { AgentDef, CommandDef, RunbookDef, ScheduleDef, EntryKind } from "../config/loadConfig.js";

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
function studioStrings() {
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
    harnessHint: t("Scoped to THIS agent in a private config home — no sibling agent sees them. claude-only. Put secrets as ${VAR} (resolved from .env / your shell)."),
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
    isolateHint: t("Gives this claude agent its own transcript namespace so several agents in ONE folder each keep an attributable, durable history — without the full isolated-harness MCP setup. Project config (CLAUDE.md / .claude / .mcp.json) and your login still apply. claude-only. Redundant when 'Isolated harness' is on."),
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

  panel.webview.onDidReceiveMessage(async (msg: { type: string; state?: FormState; cmd?: string; kind?: StudioKind }) => {
    if (!panel) return;
    switch (msg.type) {
      case "ready":
        panel.webview.postMessage({
          type: "init",
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
        });
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
        panel.webview.postMessage({ type: "kindInferred", kind: deps.inferKind(msg.cmd ?? "") });
        return;
      case "browse": {
        const picked = await vscode.window.showOpenDialog({
          canSelectFiles: false,
          canSelectFolders: true,
          canSelectMany: false,
          defaultUri: vscode.Uri.file(deps.defaultCwd),
        });
        if (picked?.[0]) panel.webview.postMessage({ type: "cwd", value: picked[0].fsPath });
        return;
      }
      case "submit": {
        if (!msg.state) return;
        const errors = deps.onSubmit({ state: msg.state, editingName: edit?.name });
        if (errors && errors.length > 0) {
          panel.webview.postMessage({ type: "errors", errors });
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

  const codiconUri = panel.webview.asWebviewUri(
    vscode.Uri.joinPath(deps.extensionUri, "dist", "webview", "codicon.css"),
  );
  const dsUri = panel.webview.asWebviewUri(
    vscode.Uri.joinPath(deps.extensionUri, "dist", "webview", "design-system.css"),
  );
  panel.webview.html = html(panel.webview, codiconUri, dsUri);
}

function html(webview: vscode.Webview, codiconUri: vscode.Uri, dsUri: vscode.Uri): string {
  const nonce = crypto.randomBytes(16).toString("hex");
  return /* html */ `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' ${webview.cspSource}; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${codiconUri}">
<link rel="stylesheet" href="${dsUri}">
<style>
  /* spec 252 — panel-specific deltas only; shared tokens + components live in design-system.css (.ds-*). */
  body { max-width: 640px; margin: 0 auto; padding: 16px 16px var(--ds-5); }
  .ds-tabs { gap: 2px; margin-bottom: 4px; }
  .ds-tab { gap: 6px; padding: 8px 16px; font-size: 13px; cursor: pointer; user-select: none; }
  .ds-tab:hover { color: var(--ds-fg); }
  .ds-tab.locked { opacity: .35; cursor: not-allowed; }
  .tabHint { font-size: var(--ds-micro); color: var(--ds-muted); margin: var(--ds-1) 0 var(--ds-3); }
  .ds-title { margin: var(--ds-2) 0 var(--ds-4); }
  /* form rhythm (internal ≤ external): 16px above a label separates fields; 4px below hugs its input */
  label.ds-section { display: block; margin: var(--ds-4) 0 var(--ds-1); }
  input[type=text], textarea {
    width: 100%; box-sizing: border-box; padding: 7px 11px;
    background: var(--ds-input-bg); color: var(--ds-input-fg);
    border: 1px solid var(--ds-border); border-radius: 5px;
    font-family: var(--ds-mono); font-size: var(--ds-small);
  }
  input::placeholder, textarea::placeholder { color: var(--ds-muted); }
  input:focus, textarea:focus { outline: 1px solid var(--ds-focus); outline-offset: -1px; }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; margin: 6px 0; }
  .chip {
    display: inline-flex; align-items: center; gap: 5px; padding: 3px 10px; border-radius: 10px;
    border: 1px solid var(--ds-border);
    background: color-mix(in srgb, var(--ds-fg) 8%, transparent); color: var(--ds-fg);
    cursor: pointer; font-size: var(--ds-small); user-select: none;
  }
  .chip:hover { background: var(--ds-hover); }
  .chip.active { border-color: var(--ds-focus); background: var(--ds-btn-bg); color: var(--ds-btn-fg); }
  .chip.active:hover { background: var(--ds-btn-hover); }
  .chip .codicon { font-size: 13px; }
  .chip.disabled { opacity: 0.45; cursor: not-allowed; }
  .chip.disabled:hover { background: color-mix(in srgb, var(--ds-fg) 8%, transparent); }
  .row { display: flex; gap: var(--ds-2); align-items: center; }
  .row input[type=text] { flex: 1; }
  .hint { font-size: var(--ds-micro); color: var(--ds-muted); margin-top: var(--ds-1); }
  .switchHint { display: none; font-size: var(--ds-small); margin-top: 4px; color: var(--ds-link); cursor: pointer; }
  .switchHint.visible { display: inline-block; }
  .checks { display: flex; gap: var(--ds-5); margin-top: var(--ds-4); flex-wrap: wrap; }
  .checks label { display: flex; align-items: center; gap: 6px; font-size: 13px; cursor: pointer; }
  input[type=checkbox] { accent-color: var(--ds-btn-bg); }
  details { margin-top: var(--ds-4); border: 1px solid var(--ds-border); border-radius: 3px; padding: var(--ds-2) var(--ds-3); }
  summary { cursor: pointer; font-size: 13px; color: var(--ds-fg); }
  details[open] summary { margin-bottom: 6px; }
  .actions { display: flex; justify-content: flex-end; gap: var(--ds-2); margin-top: var(--ds-5); }
  .errors {
    display: none; margin-top: var(--ds-3); padding: var(--ds-2) 10px; border-radius: 3px; font-size: var(--ds-small); white-space: pre-line;
    background: color-mix(in srgb, var(--ds-err) 8%, transparent);
    border: 1px solid color-mix(in srgb, var(--ds-err) 45%, transparent);
    color: var(--ds-fg);
  }
  .errors.visible { display: block; }
</style>
</head>
<body>
  <div class="ds-tabs">
    <span class="ds-tab" id="tabAgent"><span class="codicon codicon-hubot"></span><span id="lTabAgent"></span></span>
    <span class="ds-tab" id="tabTerminal"><span class="codicon codicon-terminal"></span><span id="lTabTerminal"></span></span>
    <span class="ds-tab" id="tabCommand"><span class="codicon codicon-play"></span><span id="lTabCommand"></span></span>
    <span class="ds-tab" id="tabRunbook"><span class="codicon codicon-checklist"></span><span id="lTabRunbook"></span></span>
    <span class="ds-tab" id="tabSchedule"><span class="codicon codicon-clock"></span><span id="lTabSchedule"></span></span>
  </div>
  <div class="tabHint" id="tabHint"></div>

  <h2 class="ds-title"><span class="codicon codicon-zap"></span><span id="title"></span></h2>

  <div class="agent-only" id="quickAddBlock">
    <label class="ds-section" id="lQuickAdd"></label>
    <div class="chips" id="cliChips"></div>
  </div>

  <label class="ds-section" id="lName"></label>
  <input type="text" id="name">
  <div class="hint" id="hName"></div>

  <div id="cmdBlock">
    <label class="ds-section" id="lCommand"></label>
    <input type="text" id="cmd">
    <span class="switchHint" id="switchHint"></span>
    <div class="chips" id="flagChips"></div>
  </div>

  <div id="stepsBlock" style="display:none">
    <label class="ds-section" id="lSteps"></label>
    <textarea id="steps" rows="5"></textarea>
    <div class="hint" id="hSteps"></div>
    <div class="hint" id="stepsResolution"></div>
  </div>

  <div id="schedBlock" style="display:none">
    <label class="ds-section" id="lSchedWhen"></label>
    <div class="chips">
      <span class="chip" id="schedEveryTab"></span>
      <span class="chip" id="schedAtTab"></span>
    </div>
    <input type="text" id="schedTiming">
    <label class="ds-section" id="lSchedAction"></label>
    <div class="chips">
      <span class="chip" id="schedRunTab"></span>
      <span class="chip" id="schedSpawnTab"></span>
    </div>
    <input type="text" id="schedTarget">
    <div class="hint" id="hSchedTarget"></div>
    <div class="checks" id="schedCatchUpBlock" style="display:none">
      <label><input type="checkbox" id="catchUp"> <span id="lSchedCatchUp"></span></label>
    </div>
  </div>

  <div id="roleBlock" class="agent-only">
    <label class="ds-section" id="lRole"></label>
    <select id="role">
      <option value=""></option>
      <option value="coder">coder</option>
      <option value="reviewer">reviewer</option>
      <option value="tester">tester</option>
      <option value="orchestrator">orchestrator</option>
      <option value="custom">custom</option>
    </select>
    <div class="hint" id="hRole"></div>
  </div>

  <details id="instrDetails" class="agent-only">
    <summary id="lInstructions"></summary>
    <textarea id="instructions" rows="4"></textarea>
    <div class="hint" id="hInstructions"></div>
  </details>

  <div class="terminal-only" id="watchBlock" style="display:none">
    <label class="ds-section" id="lWatch"></label>
    <input type="text" id="watch">
    <div class="hint" id="hWatch"></div>
  </div>

  <div id="cwdBlock">
    <label class="ds-section" id="lCwd"></label>
    <div class="row">
      <input type="text" id="cwd">
      <button class="ds-btn" id="browse"></button>
    </div>
  </div>

  <div class="checks" id="lifecycleChecks">
    <label><input type="checkbox" id="autostart"> <span id="lAutostart"></span></label>
    <label><input type="checkbox" id="restart"> <span id="lRestart"></span></label>
    <label><input type="checkbox" id="attention" checked> <span id="lAttention"></span></label>
  </div>

  <details id="wtDetails">
    <summary id="sWorktree"></summary>
    <label class="check"><input type="checkbox" id="worktree"> <span id="lWorktree"></span></label>
    <label class="ds-section" id="lBranch"></label>
    <input type="text" id="branch">
    <label class="ds-section" id="lWorktreeSetup"></label>
    <textarea id="worktreeSetup" rows="3"></textarea>
    <div class="hint" id="hWorktree"></div>
    <label class="ds-section" id="lVerify"></label>
    <input type="text" id="verify">
    <div class="chips" id="verifyChips"></div>
    <div class="hint" id="hVerify"></div>
  </details>

  <div id="isolateBlock" class="agent-only">
    <label class="check"><input type="checkbox" id="isolate"> <span id="lIsolate"></span></label>
    <div class="hint" id="hIsolate"></div>
  </div>

  <details id="harnessDetails" class="agent-only">
    <summary id="sHarness"></summary>
    <label class="check"><input type="checkbox" id="harness"> <span id="lHarness"></span></label>
    <div class="hint" id="hHarness"></div>
    <label class="ds-section" id="lHarnessInherit"></label>
    <select id="harnessInherit"><option value="workspace">workspace</option><option value="none">none</option></select>
    <label class="ds-section" id="lHarnessMcp"></label>
    <textarea id="harnessMcp" rows="6"></textarea>
    <label class="ds-section" id="lHarnessRules"></label>
    <textarea id="harnessRules" rows="2"></textarea>
    <label class="ds-section" id="lHarnessSkills"></label>
    <textarea id="harnessSkills" rows="2"></textarea>
    <label class="ds-section" id="lHarnessHooks"></label>
    <textarea id="harnessHooks" rows="4"></textarea>
  </details>

  <div class="errors" id="errors"></div>

  <div class="actions">
    <button class="ds-btn" id="cancel"></button>
    <button class="ds-btn-primary" id="submit"></button>
  </div>

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  let S = {}, flagMap = {}, taken = [], commandNames = [], verifyCandidates = [], editingName = undefined, kind = "agent", attentionTouched = false, inferred = "agent";
  let schedTiming = "every", schedAction = "run";

  // The tab IS the kind. Switching preserves shared fields; titles and the
  // save button follow; tabs never switch on their own (see switchHint).
  function setTab(k) {
    kind = k;
    $("tabAgent").classList.toggle("active", k === "agent");
    $("tabTerminal").classList.toggle("active", k === "terminal");
    $("tabCommand").classList.toggle("active", k === "command");
    $("tabRunbook").classList.toggle("active", k === "runbook");
    $("tabSchedule").classList.toggle("active", k === "schedule");
    const hint = { agent: S.tabHintAgent, terminal: S.tabHintTerminal, command: S.tabHintCommand, runbook: S.tabHintRunbook, schedule: S.tabHintSchedule };
    $("tabHint").textContent = hint[k];
    const titleNew = { agent: S.titleNewAgent, terminal: S.titleNewTerminal, command: S.titleNewCommand, runbook: S.titleNewRunbook, schedule: S.titleNewSchedule };
    const titleEdit = { agent: S.titleEditAgent, terminal: S.titleEditTerminal, command: S.titleEditCommand, runbook: S.titleEditRunbook, schedule: S.titleEditSchedule };
    $("title").textContent = editingName ? titleEdit[k].replace("{0}", editingName) : titleNew[k];
    $("submit").textContent = { agent: S.saveAgent, terminal: S.saveTerminal, command: S.saveCommand, runbook: S.saveRunbook, schedule: S.saveSchedule }[k];
    $("name").placeholder = { agent: S.namePhAgent, terminal: S.namePhTerminal, command: S.namePhCommand, runbook: S.namePhRunbook, schedule: S.namePhSchedule }[k];
    $("cmd").placeholder = k === "agent" ? S.commandPhAgent : k === "terminal" ? S.commandPhTerminal : S.commandPhCommand;
    $("quickAddBlock").style.display = k === "agent" ? "" : "none";
    $("instrDetails").style.display = (k === "agent" || k === "schedule") ? "" : "none"; // schedule+spawn can carry instructions
    $("roleBlock").style.display = k === "agent" ? "" : "none"; // spec 216 — role templates: agents only
    $("watchBlock").style.display = k === "terminal" ? "" : "none";
    // each kind shows only its own fields
    $("cmdBlock").style.display = (k === "runbook" || k === "schedule") ? "none" : "";
    $("stepsBlock").style.display = k === "runbook" ? "" : "none";
    $("schedBlock").style.display = k === "schedule" ? "" : "none";
    $("cwdBlock").style.display = (k === "runbook" || k === "schedule") ? "none" : "";
    // one-shots/runbooks/schedules have no agent lifecycle checkboxes
    $("lifecycleChecks").style.display = (k === "agent" || k === "terminal") ? "" : "none";
    $("wtDetails").style.display = (k === "agent" || k === "terminal") ? "" : "none"; // worktree: agent + terminal only
    syncHarnessUI(); // spec 226/228 — isolated harness: claude agents only (gated by cmd, not just kind)
    if (k === "schedule") syncSchedUI();
    if (!attentionTouched) $("attention").checked = (k === "agent");
    // edit mode: visually lock the non-active tabs (the kind can't change — see pickTab).
    if (editingName) for (const id of ["tabAgent", "tabTerminal", "tabCommand", "tabRunbook", "tabSchedule"]) $(id).classList.toggle("locked", !$(id).classList.contains("active"));
    updateSwitchHint();
    vscode.postMessage({ type: "tab", kind: k });
  }
  // An entry's kind is fixed once it exists — editing can't flip agent↔terminal (or any kind),
  // so the tabs are locked in edit mode (spec 215; the submit path rejects a mismatch too).
  const pickTab = (k) => { if (!editingName) setTab(k); };
  $("tabAgent").onclick = () => pickTab("agent");
  $("tabTerminal").onclick = () => pickTab("terminal");
  $("tabCommand").onclick = () => pickTab("command");
  $("tabRunbook").onclick = () => pickTab("runbook");
  $("tabSchedule").onclick = () => pickTab("schedule");

  // Schedule sub-toggles (timing every|at, action run|spawn).
  function syncSchedUI() {
    $("schedEveryTab").classList.toggle("active", schedTiming === "every");
    $("schedAtTab").classList.toggle("active", schedTiming === "at");
    $("schedRunTab").classList.toggle("active", schedAction === "run");
    $("schedSpawnTab").classList.toggle("active", schedAction === "spawn");
    $("schedTiming").placeholder = schedTiming === "every" ? S.schedEveryPh : S.schedAtPh;
    $("schedCatchUpBlock").style.display = schedTiming === "at" ? "" : "none";
    $("hSchedTarget").textContent = S.schedTargetPh;
    // instructions block (shared with agent) only meaningful for spawn
    $("instrDetails").style.display = (kind === "schedule") ? (schedAction === "spawn" ? "" : "none") : $("instrDetails").style.display;
  }
  $("schedEveryTab").onclick = () => { schedTiming = "every"; syncSchedUI(); };
  $("schedAtTab").onclick = () => { schedTiming = "at"; syncSchedUI(); };
  $("schedRunTab").onclick = () => { schedAction = "run"; syncSchedUI(); };
  $("schedSpawnTab").onclick = () => { schedAction = "spawn"; syncSchedUI(); };

  // Live resolution hint: how each step line will run (mirror of formLogic.stepResolutions).
  function renderStepsResolution() {
    const lines = $("steps").value.split("\\n").map((l) => l.trim()).filter((l) => l.length > 0);
    $("stepsResolution").textContent = lines
      .map((l) => l + " → " + (commandNames.includes(l) ? S.stepRef : S.stepInline))
      .join(" · ");
  }
  $("attention").onchange = () => { attentionTouched = true; };

  function updateSwitchHint() {
    const el = $("switchHint");
    // No "switch tab?" nudge while editing — the kind is locked (spec 215).
    const mismatch = !editingName && (kind === "agent" || kind === "terminal") && $("cmd").value.trim().length > 0 && inferred !== kind;
    el.classList.toggle("visible", mismatch);
    if (mismatch) el.textContent = inferred === "agent" ? S.switchToAgent : S.switchToTerminal;
  }
  $("switchHint").onclick = () => { if (!editingName) setTab(inferred); };

  function renderFlags() {
    const cmd = $("cmd").value;
    const base = (cmd.trim().split(/\\s+/)[0] || "").split("/").pop();
    const flags = flagMap[base] || [];
    const box = $("flagChips");
    box.innerHTML = "";
    for (const flag of flags) {
      const chip = document.createElement("span");
      chip.className = "chip" + (cmd.includes(flag) ? " active" : "");
      chip.textContent = flag;
      chip.onclick = () => {
        const has = cmd.includes(" " + flag) || cmd.trim().endsWith(flag);
        $("cmd").value = has ? cmd.replace(" " + flag, "").trim() : cmd.trim() + " " + flag;
        renderFlags();
      };
      box.appendChild(chip);
    }
    syncHarnessUI(); // every cmd change flows through here → keep the harness section claude-gated
  }

  // spec 214 — verify-gate suggestion chips: stack candidates + declared command/runbook names.
  // Clicking a chip fills the field (pick); the human can always type their own (final word).
  function renderVerifyChips() {
    const box = $("verifyChips");
    if (!box) return;
    const current = $("verify").value.trim();
    box.innerHTML = "";
    for (const cand of verifyCandidates) {
      const chip = document.createElement("span");
      chip.className = "chip" + (cand === current ? " active" : "");
      chip.textContent = cand;
      chip.onclick = () => { $("verify").value = cand; renderVerifyChips(); };
      box.appendChild(chip);
    }
  }

  // spec 226/228 — the isolated-harness section is claude-only; show it only for a claude agent
  // (sees through env/npx/flag tokens). Non-claude agents never see it (validateForm is the backstop).
  function syncHarnessUI() {
    const isClaude = $("cmd").value.trim().split(/\\s+/).some((t) => (t.split("/").pop()) === "claude");
    const show = (kind === "agent" && isClaude);
    $("harnessDetails").style.display = show ? "" : "none";
    // spec 240 — lightweight transcript isolation: same claude+agent gate; harness already isolates, so disable.
    $("isolateBlock").style.display = show ? "" : "none";
    $("isolate").disabled = $("harness").checked;
  }
  $("harness").onchange = syncHarnessUI;
  $("cmd").oninput = () => {
    renderFlags(); // also re-runs syncHarnessUI (harness is claude-gated)
    vscode.postMessage({ type: "inferKind", cmd: $("cmd").value });
  };
  $("verify").oninput = renderVerifyChips;
  $("browse").onclick = () => vscode.postMessage({ type: "browse" });
  $("cancel").onclick = () => vscode.postMessage({ type: "cancel" });
  $("steps").oninput = renderStepsResolution;
  $("submit").onclick = () => vscode.postMessage({ type: "submit", state: {
    name: $("name").value.trim(),
    cmd: $("cmd").value.trim(),
    kind,
    instructions: $("instructions").value,
    role: $("role").value,
    watch: $("watch").value,
    steps: $("steps").value,
    cwd: $("cwd").value.trim(),
    autostart: $("autostart").checked,
    restartOnCrash: $("restart").checked,
    attention: $("attention").checked,
    worktree: $("worktree").checked,
    branch: $("branch").value.trim(),
    worktreeSetup: $("worktreeSetup").value,
    verify: $("verify").value.trim(),
    harness: $("harness").checked,
    harnessInherit: $("harnessInherit").value,
    harnessMcp: $("harnessMcp").value,
    harnessRules: $("harnessRules").value,
    harnessSkills: $("harnessSkills").value,
    harnessHooks: $("harnessHooks").value,
    isolate: $("isolate").checked,
    schedTiming,
    schedEvery: schedTiming === "every" ? $("schedTiming").value.trim() : "1h",
    schedAt: schedTiming === "at" ? $("schedTiming").value.trim() : "09:00",
    schedAction,
    schedTarget: $("schedTarget").value.trim(),
    catchUp: $("catchUp").checked,
  }});

  function applyStrings() {
    $("lTabAgent").textContent = S.tabAgent;
    $("lTabTerminal").textContent = S.tabTerminal;
    $("lTabCommand").textContent = S.tabCommand;
    $("lTabRunbook").textContent = S.tabRunbook;
    $("lTabSchedule").textContent = S.tabSchedule;
    $("lSchedWhen").textContent = S.schedWhen; $("lSchedAction").textContent = S.schedAction;
    $("schedEveryTab").textContent = S.schedEvery; $("schedAtTab").textContent = S.schedAt;
    $("schedRunTab").textContent = S.schedRun; $("schedSpawnTab").textContent = S.schedSpawn;
    $("schedTarget").placeholder = S.schedTargetPh; $("lSchedCatchUp").textContent = S.schedCatchUp;
    $("lSteps").textContent = S.stepsLabel; $("steps").placeholder = S.stepsPh; $("hSteps").textContent = S.stepsHint;
    $("lQuickAdd").textContent = S.quickAdd;
    $("lName").textContent = S.name; $("hName").textContent = S.nameHint;
    $("lCommand").textContent = S.command;
    $("lInstructions").textContent = S.instructions; $("instructions").placeholder = S.instructionsPh; $("hInstructions").textContent = S.instructionsHint;
    $("lRole").textContent = S.role; $("hRole").textContent = S.roleHint; $("role").options[0].textContent = S.roleNone;
    $("lWatch").textContent = S.watch; $("watch").placeholder = S.watchPh; $("hWatch").textContent = S.watchHint;
    $("lCwd").textContent = S.cwd; $("browse").textContent = S.browse;
    $("lAutostart").textContent = S.autostart; $("lRestart").textContent = S.restart; $("lAttention").textContent = S.attention;
    $("sWorktree").textContent = S.worktreeSummary;
    $("lWorktree").textContent = S.worktree; $("lBranch").textContent = S.branch; $("branch").placeholder = S.branchPh;
    $("lWorktreeSetup").textContent = S.worktreeSetup; $("worktreeSetup").placeholder = S.worktreeSetupPh; $("hWorktree").textContent = S.worktreeHint;
    $("lVerify").textContent = S.verify; $("verify").placeholder = S.verifyPh; $("hVerify").textContent = S.verifyHint; $("verifyChips").title = S.verifySuggested;
    $("sHarness").textContent = S.harnessSummary;
    $("lHarness").textContent = S.harness; $("hHarness").textContent = S.harnessHint;
    $("lHarnessInherit").textContent = S.harnessInherit;
    $("lHarnessMcp").textContent = S.harnessMcpLabel; $("harnessMcp").placeholder = S.harnessMcpPh;
    $("lHarnessRules").textContent = S.harnessRulesLabel; $("harnessRules").placeholder = S.harnessRulesPh;
    $("lHarnessSkills").textContent = S.harnessSkillsLabel; $("harnessSkills").placeholder = S.harnessSkillsPh;
    $("lHarnessHooks").textContent = S.harnessHooksLabel; $("harnessHooks").placeholder = S.harnessHooksPh;
    $("lIsolate").textContent = S.isolate; $("hIsolate").textContent = S.isolateHint;
    $("cancel").textContent = S.cancel;
  }

  window.addEventListener("message", (e) => {
    const msg = e.data;
    if (msg.type === "init") {
      S = msg.strings; flagMap = msg.flagMap; taken = msg.taken; commandNames = msg.commandNames || []; verifyCandidates = msg.verifyCandidates || []; editingName = msg.editingName;
      applyStrings();
      renderVerifyChips();
      const box = $("cliChips");
      for (const c of msg.chips) {
        const chip = document.createElement("span");
        if (c.detected) {
          chip.className = "chip";
          chip.innerHTML = '<span class="codicon codicon-check"></span>';
          chip.appendChild(document.createTextNode(c.label));
          chip.title = c.bin;
          chip.onclick = () => {
            $("cmd").value = c.bin;
            if (!$("name").value || !editingName) {
              let n = c.bin, i = 2;
              while (taken.includes(n) && n !== editingName) n = c.bin + "-" + (i++);
              $("name").value = n;
            }
            inferred = "agent";
            renderFlags();
            updateSwitchHint();
          };
        } else {
          chip.className = "chip disabled";
          chip.innerHTML = '<span class="codicon codicon-circle-slash"></span>';
          chip.appendChild(document.createTextNode(c.label));
          chip.title = c.installHint ? S.notInstalled.replace("{0}", c.installHint) : S.notInstalledNoHint;
        }
        box.appendChild(chip);
      }
      // Custom — the explicit door for uncataloged runtimes.
      const custom = document.createElement("span");
      custom.className = "chip";
      custom.innerHTML = '<span class="codicon codicon-edit"></span>';
      custom.appendChild(document.createTextNode(S.custom));
      custom.onclick = () => {
        $("cmd").value = "";
        $("name").value = "";
        renderFlags();
        updateSwitchHint();
        $("cmd").focus();
      };
      box.appendChild(custom);

      if (msg.initial) {
        $("name").value = msg.initial.name;
        $("cmd").value = msg.initial.cmd;
        $("instructions").value = msg.initial.instructions;
        if (msg.initial.instructions) $("instrDetails").open = true;
        $("role").value = msg.initial.role || "";
        $("watch").value = msg.initial.watch;
        $("steps").value = msg.initial.steps;
        $("cwd").value = msg.initial.cwd;
        $("autostart").checked = msg.initial.autostart;
        $("restart").checked = msg.initial.restartOnCrash;
        $("attention").checked = msg.initial.attention;
        $("worktree").checked = !!msg.initial.worktree;
        $("branch").value = msg.initial.branch || "";
        $("worktreeSetup").value = msg.initial.worktreeSetup || "";
        $("verify").value = msg.initial.verify || "";
        renderVerifyChips();
        if (msg.initial.worktree || msg.initial.branch || msg.initial.worktreeSetup || msg.initial.verify) $("wtDetails").open = true;
        $("harness").checked = !!msg.initial.harness;
        $("harnessInherit").value = msg.initial.harnessInherit || "workspace";
        $("harnessMcp").value = msg.initial.harnessMcp || "";
        $("harnessRules").value = msg.initial.harnessRules || "";
        $("harnessSkills").value = msg.initial.harnessSkills || "";
        $("harnessHooks").value = msg.initial.harnessHooks || "";
        if (msg.initial.harness) $("harnessDetails").open = true;
        $("isolate").checked = !!msg.initial.isolate;
        schedTiming = msg.initial.schedTiming || "every";
        schedAction = msg.initial.schedAction || "run";
        $("schedTiming").value = schedTiming === "at" ? (msg.initial.schedAt || "") : (msg.initial.schedEvery || "");
        $("schedTarget").value = msg.initial.schedTarget || "";
        $("catchUp").checked = !!msg.initial.catchUp;
        attentionTouched = true;
        inferred = msg.initial.kind;
        setTab(msg.initial.kind);
        renderFlags();
        renderStepsResolution();
      } else {
        setTab(msg.initialKind || "agent");
      }
      $("cwd").placeholder = S.cwdRootPh.replace("{0}", msg.defaultCwd);
    }
    if (msg.type === "kindInferred") { inferred = msg.kind; updateSwitchHint(); }
    if (msg.type === "cwd") $("cwd").value = msg.value;
    if (msg.type === "errors") { const el = $("errors"); el.textContent = msg.errors.join("\\n"); el.classList.add("visible"); }
  });

  vscode.postMessage({ type: "ready" });
</script>
</body>
</html>`;
}
