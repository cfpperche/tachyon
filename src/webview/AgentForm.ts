import * as vscode from "vscode";
import crypto from "node:crypto";
import { FLAG_SUGGESTIONS, fromDef, quickAddChips, type FormState } from "./formLogic.js";
import type { AgentDef, EntryKind } from "../config/loadConfig.js";

/**
 * The Agent Studio panel — a webview form for creating/editing agents.
 * Layout: the KIND is a pair of TABS at the top (Agent | Terminal); each tab
 * shows its own fields (agent: quick-add catalog + instructions; terminal:
 * watch globs), shared fields persist across tab switches, and the form/panel
 * titles follow the active tab. Tabs never switch on their own — typing a
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
    tabAgent: t("Agent"),
    tabTerminal: t("Terminal"),
    tabHintAgent: t("AI CLI — grouped under Agents, attention on by default"),
    tabHintTerminal: t("server / shell / build — grouped under Terminals, attention off by default"),
    switchToAgent: t("Detected as an agent — switch tab?"),
    switchToTerminal: t("Detected as a terminal — switch tab?"),
    quickAdd: t("Quick add (detected on this machine)"),
    name: t("Name"),
    namePhAgent: t("frontend, revisor, dev…"),
    namePhTerminal: t("dev, build, db…"),
    nameHint: t("A free label — the same CLI can back many agents."),
    command: t("Command"),
    commandPhAgent: t("claude · codex · npm run dev"),
    commandPhTerminal: t("npm run dev · docker compose up · bash"),
    instructions: t("Instructions (role prompt)"),
    instructionsPh: t("you are a code reviewer; read the diff and flag correctness issues…"),
    instructionsHint: t("Delivered as a startup prompt for claude / codex / gemini."),
    watch: t("Watch files (restart on change)"),
    watchPh: t("src/**, package.json"),
    watchHint: t("Comma-separated globs — the terminal restarts when a matching file changes."),
    cwd: t("Working directory"),
    cwdRootPh: t("(workspace root: {0})", "{0}"),
    browse: t("Browse"),
    autostart: t("Auto-start"),
    restart: t("Restart on crash"),
    attention: t("Attention detection"),
    cancel: t("Cancel"),
    saveAgent: t("Save agent"),
    saveTerminal: t("Save terminal"),
    custom: t("Custom…"),
    notInstalled: t("Not installed — {0}", "{0}"),
    notInstalledNoHint: t("Not installed on this machine"),
    studioNewAgent: t("Agent Studio — New Agent"),
    studioNewTerminal: t("Agent Studio — New Terminal"),
  };
}

let panel: vscode.WebviewPanel | undefined;

export async function openAgentStudio(deps: StudioDeps, edit?: { name: string; def: AgentDef }): Promise<void> {
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

  const initial: FormState | undefined = edit ? fromDef(edit.name, edit.def) : undefined;
  const clis = await deps.detectClis();

  panel.webview.onDidReceiveMessage(async (msg: { type: string; state?: FormState; cmd?: string; kind?: EntryKind }) => {
    if (!panel) return;
    switch (msg.type) {
      case "ready":
        panel.webview.postMessage({
          type: "init",
          strings,
          chips: quickAddChips(clis),
          flagMap: FLAG_SUGGESTIONS,
          taken: deps.takenNames(),
          defaultCwd: deps.defaultCwd,
          editingName: edit?.name,
          initial,
        });
        return;
      case "tab":
        // Panel (editor tab) title follows the active form tab in create mode.
        if (!edit) panel.title = msg.kind === "terminal" ? strings.studioNewTerminal : strings.studioNewAgent;
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

  <label class="section" id="lCommand"></label>
  <input type="text" id="cmd">
  <span class="switchHint" id="switchHint"></span>
  <div class="chips" id="flagChips"></div>

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

  <label class="section" id="lCwd"></label>
  <div class="row">
    <input type="text" id="cwd">
    <button class="secondary" id="browse"></button>
  </div>

  <div class="checks">
    <label><input type="checkbox" id="autostart"> <span id="lAutostart"></span></label>
    <label><input type="checkbox" id="restart"> <span id="lRestart"></span></label>
    <label><input type="checkbox" id="attention" checked> <span id="lAttention"></span></label>
  </div>

  <div class="errors" id="errors"></div>

  <div class="actions">
    <button class="secondary" id="cancel"></button>
    <button class="primary" id="submit"></button>
  </div>

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  let S = {}, flagMap = {}, taken = [], editingName = undefined, kind = "agent", attentionTouched = false, inferred = "agent";

  // The tab IS the kind. Switching preserves shared fields; titles and the
  // save button follow; tabs never switch on their own (see switchHint).
  function setTab(k) {
    kind = k;
    $("tabAgent").classList.toggle("active", k === "agent");
    $("tabTerminal").classList.toggle("active", k === "terminal");
    $("tabHint").textContent = k === "agent" ? S.tabHintAgent : S.tabHintTerminal;
    $("title").textContent = editingName
      ? (k === "agent" ? S.titleEditAgent : S.titleEditTerminal).replace("{0}", editingName)
      : (k === "agent" ? S.titleNewAgent : S.titleNewTerminal);
    $("submit").textContent = k === "agent" ? S.saveAgent : S.saveTerminal;
    $("name").placeholder = k === "agent" ? S.namePhAgent : S.namePhTerminal;
    $("cmd").placeholder = k === "agent" ? S.commandPhAgent : S.commandPhTerminal;
    $("quickAddBlock").style.display = k === "agent" ? "" : "none";
    $("instrDetails").style.display = k === "agent" ? "" : "none";
    $("watchBlock").style.display = k === "terminal" ? "" : "none";
    if (!attentionTouched) $("attention").checked = (k === "agent");
    updateSwitchHint();
    vscode.postMessage({ type: "tab", kind: k });
  }
  $("tabAgent").onclick = () => setTab("agent");
  $("tabTerminal").onclick = () => setTab("terminal");
  $("attention").onchange = () => { attentionTouched = true; };

  function updateSwitchHint() {
    const el = $("switchHint");
    const mismatch = $("cmd").value.trim().length > 0 && inferred !== kind;
    el.classList.toggle("visible", mismatch);
    if (mismatch) el.textContent = inferred === "agent" ? S.switchToAgent : S.switchToTerminal;
  }
  $("switchHint").onclick = () => setTab(inferred);

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

  $("cmd").oninput = () => {
    renderFlags();
    vscode.postMessage({ type: "inferKind", cmd: $("cmd").value });
  };
  $("browse").onclick = () => vscode.postMessage({ type: "browse" });
  $("cancel").onclick = () => vscode.postMessage({ type: "cancel" });
  $("submit").onclick = () => vscode.postMessage({ type: "submit", state: {
    name: $("name").value.trim(),
    cmd: $("cmd").value.trim(),
    kind,
    instructions: $("instructions").value,
    watch: $("watch").value,
    cwd: $("cwd").value.trim(),
    autostart: $("autostart").checked,
    restartOnCrash: $("restart").checked,
    attention: $("attention").checked,
  }});

  function applyStrings() {
    $("lTabAgent").textContent = S.tabAgent;
    $("lTabTerminal").textContent = S.tabTerminal;
    $("lQuickAdd").textContent = S.quickAdd;
    $("lName").textContent = S.name; $("hName").textContent = S.nameHint;
    $("lCommand").textContent = S.command;
    $("lInstructions").textContent = S.instructions; $("instructions").placeholder = S.instructionsPh; $("hInstructions").textContent = S.instructionsHint;
    $("lWatch").textContent = S.watch; $("watch").placeholder = S.watchPh; $("hWatch").textContent = S.watchHint;
    $("lCwd").textContent = S.cwd; $("browse").textContent = S.browse;
    $("lAutostart").textContent = S.autostart; $("lRestart").textContent = S.restart; $("lAttention").textContent = S.attention;
    $("cancel").textContent = S.cancel;
  }

  window.addEventListener("message", (e) => {
    const msg = e.data;
    if (msg.type === "init") {
      S = msg.strings; flagMap = msg.flagMap; taken = msg.taken; editingName = msg.editingName;
      applyStrings();
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
        $("watch").value = msg.initial.watch;
        $("cwd").value = msg.initial.cwd;
        $("autostart").checked = msg.initial.autostart;
        $("restart").checked = msg.initial.restartOnCrash;
        $("attention").checked = msg.initial.attention;
        attentionTouched = true;
        inferred = msg.initial.kind;
        setTab(msg.initial.kind);
        renderFlags();
      } else {
        setTab("agent");
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
