import * as vscode from "vscode";
import crypto from "node:crypto";
import { FLAG_SUGGESTIONS, fromDef, quickAddChips, type FormState } from "./formLogic.js";
import type { AgentDef, EntryKind } from "../config/loadConfig.js";

/**
 * The Agent Studio panel — a webview form for creating/editing agents.
 * Thin by design: all validation/entry-building lives in formLogic (unit-tested);
 * the panel renders state and relays messages. Submit goes through the same
 * comment-preserving yml mutation path as every other UI edit.
 *
 * Theming: hand-rolled CSS over the full --vscode-* token set + the official
 * codicon font (bundled to dist/webview at build time). Localization: every
 * human string is resolved extension-side with vscode.l10n and shipped to the
 * webview in the init payload.
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
    titleNew: t("New Agent"),
    titleEdit: t("Edit Agent — {0}", "{0}"),
    quickAdd: t("Quick add (detected on this machine)"),
    name: t("Name"),
    namePh: t("frontend, revisor, dev…"),
    nameHint: t("A free label — the same CLI can back many agents."),
    command: t("Command"),
    commandPh: t("claude · codex · npm run dev"),
    kind: t("Kind"),
    kindAgent: t("Agent"),
    kindTerminal: t("Terminal"),
    kindHintAgent: t("AI CLI — grouped under Agents, attention on by default"),
    kindHintTerminal: t("server / shell / build — grouped under Terminals, attention off by default"),
    instructions: t("Instructions (role prompt)"),
    instructionsPh: t("you are a code reviewer; read the diff and flag correctness issues…"),
    instructionsHint: t("Delivered as a startup prompt for claude / codex / gemini."),
    cwd: t("Working directory"),
    cwdRootPh: t("(workspace root: {0})", "{0}"),
    browse: t("Browse"),
    autostart: t("Auto-start"),
    restart: t("Restart on crash"),
    attention: t("Attention detection"),
    cancel: t("Cancel"),
    save: t("Save agent"),
    custom: t("Custom…"),
    notInstalled: t("Not installed — {0}", "{0}"),
    notInstalledNoHint: t("Not installed on this machine"),
  };
}

let panel: vscode.WebviewPanel | undefined;

export async function openAgentStudio(deps: StudioDeps, edit?: { name: string; def: AgentDef }): Promise<void> {
  const strings = studioStrings();
  const title = edit ? vscode.l10n.t("Agent Studio — {0}", edit.name) : vscode.l10n.t("Agent Studio — New Agent");
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

  panel.webview.onDidReceiveMessage(async (msg: { type: string; state?: FormState; cmd?: string }) => {
    if (!panel) return;
    switch (msg.type) {
      case "ready":
        panel.webview.postMessage({
          type: "init",
          strings,
          chips: quickAddChips(clis),
          clis,
          flagMap: FLAG_SUGGESTIONS,
          taken: deps.takenNames(),
          defaultCwd: deps.defaultCwd,
          editingName: edit?.name,
          initial,
        });
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
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); background: var(--vscode-editor-background); max-width: 640px; margin: 0 auto; padding: 24px 16px; }
  h2 { font-weight: 600; margin: 0 0 16px; display: flex; align-items: center; gap: 8px; }
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
  .kindRow { display: flex; gap: 6px; }
</style>
</head>
<body>
  <h2><span class="codicon codicon-zap"></span><span id="title"></span></h2>

  <label class="section" id="lQuickAdd"></label>
  <div class="chips" id="cliChips"></div>

  <label class="section" id="lName"></label>
  <input type="text" id="name">
  <div class="hint" id="hName"></div>

  <label class="section" id="lCommand"></label>
  <input type="text" id="cmd">
  <div class="chips" id="flagChips"></div>

  <label class="section" id="lKind"></label>
  <div class="kindRow chips">
    <span class="chip" id="kindAgent"><span class="codicon codicon-hubot"></span><span id="lKindAgent"></span></span>
    <span class="chip" id="kindTerminal"><span class="codicon codicon-terminal"></span><span id="lKindTerminal"></span></span>
  </div>
  <div class="hint" id="kindHint"></div>

  <details id="instrDetails">
    <summary id="lInstructions"></summary>
    <textarea id="instructions" rows="4"></textarea>
    <div class="hint" id="hInstructions"></div>
  </details>

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
  let S = {}, flagMap = {}, taken = [], editingName = undefined, kind = "agent", kindTouched = false, attentionTouched = false;

  function setKind(k, touched) {
    kind = k;
    if (touched) kindTouched = true;
    $("kindAgent").classList.toggle("active", k === "agent");
    $("kindTerminal").classList.toggle("active", k === "terminal");
    $("kindHint").textContent = k === "agent" ? S.kindHintAgent : S.kindHintTerminal;
    if (!attentionTouched) $("attention").checked = (k === "agent");
  }
  $("kindAgent").onclick = () => setKind("agent", true);
  $("kindTerminal").onclick = () => setKind("terminal", true);
  $("attention").onchange = () => { attentionTouched = true; };

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
    if (!kindTouched) vscode.postMessage({ type: "inferKind", cmd: $("cmd").value });
  };
  $("browse").onclick = () => vscode.postMessage({ type: "browse" });
  $("cancel").onclick = () => vscode.postMessage({ type: "cancel" });
  $("submit").onclick = () => vscode.postMessage({ type: "submit", state: {
    name: $("name").value.trim(),
    cmd: $("cmd").value.trim(),
    kind,
    instructions: $("instructions").value,
    cwd: $("cwd").value.trim(),
    autostart: $("autostart").checked,
    restartOnCrash: $("restart").checked,
    attention: $("attention").checked,
  }});

  function applyStrings() {
    $("title").textContent = editingName ? S.titleEdit.replace("{0}", editingName) : S.titleNew;
    $("lQuickAdd").textContent = S.quickAdd;
    $("lName").textContent = S.name; $("name").placeholder = S.namePh; $("hName").textContent = S.nameHint;
    $("lCommand").textContent = S.command; $("cmd").placeholder = S.commandPh;
    $("lKind").textContent = S.kind; $("lKindAgent").textContent = S.kindAgent; $("lKindTerminal").textContent = S.kindTerminal;
    $("lInstructions").textContent = S.instructions; $("instructions").placeholder = S.instructionsPh; $("hInstructions").textContent = S.instructionsHint;
    $("lCwd").textContent = S.cwd; $("browse").textContent = S.browse;
    $("lAutostart").textContent = S.autostart; $("lRestart").textContent = S.restart; $("lAttention").textContent = S.attention;
    $("cancel").textContent = S.cancel; $("submit").textContent = S.save;
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
            setKind("agent", false);
            renderFlags();
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
        $("cmd").focus();
      };
      box.appendChild(custom);
      if (msg.initial) {
        $("name").value = msg.initial.name;
        $("cmd").value = msg.initial.cmd;
        $("instructions").value = msg.initial.instructions;
        if (msg.initial.instructions) $("instrDetails").open = true;
        $("cwd").value = msg.initial.cwd;
        $("autostart").checked = msg.initial.autostart;
        $("restart").checked = msg.initial.restartOnCrash;
        $("attention").checked = msg.initial.attention;
        attentionTouched = true;
        setKind(msg.initial.kind, true);
        renderFlags();
      } else {
        setKind("agent", false);
      }
      $("cwd").placeholder = S.cwdRootPh.replace("{0}", msg.defaultCwd);
    }
    if (msg.type === "kindInferred") setKind(msg.kind, false);
    if (msg.type === "cwd") $("cwd").value = msg.value;
    if (msg.type === "errors") { const el = $("errors"); el.textContent = msg.errors.join("\\n"); el.classList.add("visible"); }
  });

  vscode.postMessage({ type: "ready" });
</script>
</body>
</html>`;
}
