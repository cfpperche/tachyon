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
  panel.webview.html = html(panel.webview, codiconUri);
}

function html(webview: vscode.Webview, codiconUri: vscode.Uri): string {
  const nonce = crypto.randomBytes(16).toString("hex");
  return /* html */ `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' ${webview.cspSource}; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${codiconUri}">
<style>
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); background: var(--vscode-editor-background); max-width: 640px; margin: 0 auto; padding: 16px 16px 24px; }
  .tabs { display: flex; gap: 2px; border-bottom: 1px solid var(--vscode-widget-border, var(--vscode-editorWidget-border, transparent)); margin-bottom: 4px; }
  .tab {
    display: flex; align-items: center; gap: 6px; padding: 8px 16px; cursor: pointer; user-select: none;
    color: var(--vscode-descriptionForeground); border-bottom: 2px solid transparent; font-size: 13px;
  }
  .tab:hover { color: var(--vscode-foreground); }
  .tab.active { color: var(--vscode-foreground); border-bottom-color: var(--vscode-focusBorder); font-weight: 600; }
  .tab.locked { opacity: .35; cursor: not-allowed; }
  .tabHint { font-size: 11px; color: var(--vscode-descriptionForeground); margin: 4px 0 10px; }
  h2 { font-weight: 600; margin: 6px 0 16px; display: flex; align-items: center; gap: 8px; }
  label.section { display: block; margin: 14px 0 4px; font-size: 11px; font-weight: 600; color: var(--vscode-descriptionForeground); text-transform: uppercase; letter-spacing: .04em; }
  input[type=text], textarea {
    width: 100%; box-sizing: border-box; padding: 6px 8px;
    background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent); border-radius: 2px;
    font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size);
  }
  input::placeholder, textarea::placeholder { color: var(--vscode-input-placeholderForeground); }
  input:focus, textarea:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; margin: 6px 0; }
  .chip {
    display: inline-flex; align-items: center; gap: 5px; padding: 3px 10px; border-radius: 10px;
    border: 1px solid var(--vscode-button-secondaryBackground);
    background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground);
    cursor: pointer; font-size: 12px; user-select: none;
  }
  .chip:hover { background: var(--vscode-button-secondaryHoverBackground); }
  .chip.active { border-color: var(--vscode-focusBorder); background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .chip.active:hover { background: var(--vscode-button-hoverBackground); }
  .chip .codicon { font-size: 13px; }
  .chip.disabled { opacity: 0.45; cursor: not-allowed; }
  .chip.disabled:hover { background: var(--vscode-button-secondaryBackground); }
  .row { display: flex; gap: 8px; align-items: center; }
  .row input[type=text] { flex: 1; }
  .hint { font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 3px; }
  .switchHint { display: none; font-size: 12px; margin-top: 4px; color: var(--vscode-textLink-foreground); cursor: pointer; }
  .switchHint.visible { display: inline-block; }
  .checks { display: flex; gap: 18px; margin-top: 14px; flex-wrap: wrap; }
  .checks label { display: flex; align-items: center; gap: 6px; font-size: 13px; cursor: pointer; }
  input[type=checkbox] { accent-color: var(--vscode-button-background); }
  details { margin-top: 14px; border: 1px solid var(--vscode-widget-border, transparent); border-radius: 3px; padding: 6px 10px; }
  summary { cursor: pointer; font-size: 13px; color: var(--vscode-foreground); }
  details[open] summary { margin-bottom: 6px; }
  button {
    padding: 6px 14px; border: 1px solid transparent; border-radius: 2px; cursor: pointer;
    font-family: var(--vscode-font-family); font-size: 13px;
  }
  button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
  .primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .primary:hover { background: var(--vscode-button-hoverBackground); }
  .secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  .secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
  .actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 22px; }
  .errors {
    display: none; margin-top: 12px; padding: 8px 10px; border-radius: 3px; font-size: 12px; white-space: pre-line;
    background: var(--vscode-inputValidation-errorBackground, transparent);
    border: 1px solid var(--vscode-inputValidation-errorBorder, var(--vscode-errorForeground));
    color: var(--vscode-foreground);
  }
  .errors.visible { display: block; }
</style>
</head>
<body>
  <div class="tabs">
    <span class="tab" id="tabAgent"><span class="codicon codicon-hubot"></span><span id="lTabAgent"></span></span>
    <span class="tab" id="tabTerminal"><span class="codicon codicon-terminal"></span><span id="lTabTerminal"></span></span>
    <span class="tab" id="tabCommand"><span class="codicon codicon-play"></span><span id="lTabCommand"></span></span>
    <span class="tab" id="tabRunbook"><span class="codicon codicon-checklist"></span><span id="lTabRunbook"></span></span>
    <span class="tab" id="tabSchedule"><span class="codicon codicon-clock"></span><span id="lTabSchedule"></span></span>
  </div>
  <div class="tabHint" id="tabHint"></div>

  <h2><span class="codicon codicon-zap"></span><span id="title"></span></h2>

  <div class="agent-only" id="quickAddBlock">
    <label class="section" id="lQuickAdd"></label>
    <div class="chips" id="cliChips"></div>
  </div>

  <label class="section" id="lName"></label>
  <input type="text" id="name">
  <div class="hint" id="hName"></div>

  <div id="cmdBlock">
    <label class="section" id="lCommand"></label>
    <input type="text" id="cmd">
    <span class="switchHint" id="switchHint"></span>
    <div class="chips" id="flagChips"></div>
  </div>

  <div id="stepsBlock" style="display:none">
    <label class="section" id="lSteps"></label>
    <textarea id="steps" rows="5"></textarea>
    <div class="hint" id="hSteps"></div>
    <div class="hint" id="stepsResolution"></div>
  </div>

  <div id="schedBlock" style="display:none">
    <label class="section" id="lSchedWhen"></label>
    <div class="chips">
      <span class="chip" id="schedEveryTab"></span>
      <span class="chip" id="schedAtTab"></span>
    </div>
    <input type="text" id="schedTiming">
    <label class="section" id="lSchedAction"></label>
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
    <label class="section" id="lRole"></label>
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
    <label class="section" id="lWatch"></label>
    <input type="text" id="watch">
    <div class="hint" id="hWatch"></div>
  </div>

  <div id="cwdBlock">
    <label class="section" id="lCwd"></label>
    <div class="row">
      <input type="text" id="cwd">
      <button class="secondary" id="browse"></button>
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
    <label class="section" id="lBranch"></label>
    <input type="text" id="branch">
    <label class="section" id="lWorktreeSetup"></label>
    <textarea id="worktreeSetup" rows="3"></textarea>
    <div class="hint" id="hWorktree"></div>
    <label class="section" id="lVerify"></label>
    <input type="text" id="verify">
    <div class="chips" id="verifyChips"></div>
    <div class="hint" id="hVerify"></div>
  </details>

  <div class="errors" id="errors"></div>

  <div class="actions">
    <button class="secondary" id="cancel"></button>
    <button class="primary" id="submit"></button>
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

  $("cmd").oninput = () => {
    renderFlags();
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
