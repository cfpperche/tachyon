import * as vscode from "vscode";
import crypto from "node:crypto";
import { FLAG_SUGGESTIONS, fromDef, type FormState } from "./formLogic.js";
import type { AgentDef, EntryKind } from "../config/loadConfig.js";

/**
 * The Agent Studio panel — a webview form for creating/editing agents.
 * Thin by design: all validation/entry-building lives in formLogic (unit-tested);
 * the panel renders state and relays messages. Submit goes through the same
 * comment-preserving yml mutation path as every other UI edit.
 */

export interface StudioSubmit {
  state: FormState;
  editingName?: string;
}

export interface StudioDeps {
  detectClis: () => Promise<string[]>;
  takenNames: () => string[];
  defaultCwd: string;
  inferKind: (cmd: string) => EntryKind;
  onSubmit: (submit: StudioSubmit) => string[] | undefined; // returns blocking errors, undefined = success
}

let panel: vscode.WebviewPanel | undefined;

export async function openAgentStudio(deps: StudioDeps, edit?: { name: string; def: AgentDef }): Promise<void> {
  const title = edit ? `Agent Studio — ${edit.name}` : "Agent Studio — New Agent";
  if (panel) panel.dispose(); // one studio at a time; reopening resets state

  panel = vscode.window.createWebviewPanel("tachyonAgentStudio", title, vscode.ViewColumn.Active, {
    enableScripts: true,
    retainContextWhenHidden: true,
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

  panel.webview.html = html();
}

function html(): string {
  const nonce = crypto.randomBytes(16).toString("hex");
  return /* html */ `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); max-width: 640px; margin: 0 auto; padding: 24px 16px; }
  h2 { font-weight: 600; margin: 0 0 16px; }
  label { display: block; margin: 14px 0 4px; font-size: 12px; color: var(--vscode-descriptionForeground); text-transform: uppercase; letter-spacing: .04em; }
  input[type=text], textarea { width: 100%; box-sizing: border-box; padding: 6px 8px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); border-radius: 3px; font-family: var(--vscode-editor-font-family); }
  input:focus, textarea:focus { outline: 1px solid var(--vscode-focusBorder); }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; margin: 6px 0; }
  .chip { padding: 3px 10px; border-radius: 10px; border: 1px solid var(--vscode-button-secondaryBackground); background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); cursor: pointer; font-size: 12px; }
  .chip.active { border-color: var(--vscode-focusBorder); background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .row { display: flex; gap: 8px; align-items: center; }
  .row input[type=text] { flex: 1; }
  .hint { font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 3px; }
  .checks { display: flex; gap: 18px; margin-top: 14px; flex-wrap: wrap; }
  .checks label { display: flex; align-items: center; gap: 6px; margin: 0; text-transform: none; font-size: 13px; color: var(--vscode-foreground); }
  details { margin-top: 14px; } summary { cursor: pointer; font-size: 13px; }
  button { padding: 6px 14px; border: none; border-radius: 3px; cursor: pointer; }
  .primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  .actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 22px; }
  .errors { color: var(--vscode-errorForeground); font-size: 12px; margin-top: 10px; white-space: pre-line; }
  .note { color: var(--vscode-descriptionForeground); }
  .kind { display: flex; gap: 6px; }
</style>
</head>
<body>
  <h2 id="title">New Agent</h2>

  <label>Quick add (detected on this machine)</label>
  <div class="chips" id="cliChips"></div>

  <label>Name</label>
  <input type="text" id="name" placeholder="frontend, revisor, dev…">
  <div class="hint">A free label — the same CLI can back many agents.</div>

  <label>Command</label>
  <input type="text" id="cmd" placeholder="claude · codex · npm run dev">
  <div class="chips" id="flagChips"></div>

  <label>Kind</label>
  <div class="kind chips">
    <span class="chip" id="kindAgent">🤖 Agent</span>
    <span class="chip" id="kindTerminal">▣ Terminal</span>
  </div>
  <div class="hint" id="kindHint"></div>

  <details id="instrDetails">
    <summary>Instructions (role prompt)</summary>
    <textarea id="instructions" rows="4" placeholder="you are a code reviewer; read the diff and flag correctness issues…"></textarea>
    <div class="hint">Delivered as a startup prompt for claude / codex / gemini.</div>
  </details>

  <label>Working directory</label>
  <div class="row">
    <input type="text" id="cwd" placeholder="(workspace root)">
    <button class="secondary" id="browse">Browse</button>
  </div>

  <div class="checks">
    <label><input type="checkbox" id="autostart"> Auto-start</label>
    <label><input type="checkbox" id="restart"> Restart on crash</label>
    <label><input type="checkbox" id="attention" checked> Attention detection</label>
  </div>

  <div class="errors" id="errors"></div>

  <div class="actions">
    <button class="secondary" id="cancel">Cancel</button>
    <button class="primary" id="submit">Save agent</button>
  </div>

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  let flagMap = {}, taken = [], editingName = undefined, kind = "agent", kindTouched = false, attentionTouched = false;

  function setKind(k, touched) {
    kind = k;
    if (touched) kindTouched = true;
    $("kindAgent").classList.toggle("active", k === "agent");
    $("kindTerminal").classList.toggle("active", k === "terminal");
    $("kindHint").textContent = k === "agent" ? "AI CLI — grouped under Agents, attention on by default" : "server / shell / build — grouped under Terminals, attention off by default";
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

  window.addEventListener("message", (e) => {
    const msg = e.data;
    if (msg.type === "init") {
      flagMap = msg.flagMap; taken = msg.taken; editingName = msg.editingName;
      const box = $("cliChips");
      for (const cli of msg.clis) {
        const chip = document.createElement("span");
        chip.className = "chip";
        chip.textContent = "✓ " + cli;
        chip.onclick = () => {
          $("cmd").value = cli;
          if (!$("name").value || !editingName) {
            let n = cli, i = 2;
            while (taken.includes(n) && n !== editingName) n = cli + "-" + (i++);
            $("name").value = n;
          }
          setKind("agent", false);
          renderFlags();
        };
        box.appendChild(chip);
      }
      if (msg.initial) {
        $("title").textContent = "Edit Agent — " + msg.editingName;
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
      $("cwd").placeholder = "(workspace root: " + msg.defaultCwd + ")";
    }
    if (msg.type === "kindInferred") setKind(msg.kind, false);
    if (msg.type === "cwd") $("cwd").value = msg.value;
    if (msg.type === "errors") $("errors").textContent = msg.errors.join("\\n");
  });

  vscode.postMessage({ type: "ready" });
</script>
</body>
</html>`;
}
