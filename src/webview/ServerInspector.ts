import * as vscode from "vscode";
import crypto from "node:crypto";
import { buildInspectorModel, type InspectorModel } from "../inspector/model.js";
import type { PaneSnapshot } from "../tmux/TmuxService.js";

/**
 * The tmux Server Inspector — a read-only editor webview over the dedicated
 * `tmux -L tachyon` socket. It shows every Tachyon-owned session grouped by
 * workspace then kind (agent/terminal, command, runbook, engine anchor), each
 * with its live/dead+exit-code state, pid, and running command. Three direct
 * actions per session: Capture (last lines of pane output) and Kill.
 *
 * Cross-workspace by design — the socket is shared, so the inspector surfaces
 * orphans and other open folders' sessions too. Thin like the Agent Studio:
 * all data shaping is pure (inspector/model + classify, unit-tested); the panel
 * renders a posted model and relays capture/kill/refresh messages. Theming via
 * --vscode-* tokens + the bundled codicon font; strings localized extension-side.
 */

export interface InspectorDeps {
  extensionUri: vscode.Uri;
  /** Raw pane snapshot for the whole Tachyon namespace on the socket. */
  snapshot: () => Promise<PaneSnapshot[]>;
  /** Current wsHash -> folder name for open workspaces (for group labels). */
  folderByHash: () => Map<string, string>;
  /** Last lines of a session's pane output. */
  capture: (session: string) => Promise<string>;
  /** Kill a session by exact name. */
  kill: (session: string) => Promise<void>;
}

function strings() {
  const t = vscode.l10n.t;
  return {
    title: t("tmux Server Inspector"),
    subtitle: t("Live view of the dedicated tachyon socket — every session Tachyon owns."),
    refresh: t("Refresh"),
    auto: t("Auto-refresh"),
    empty: t("No Tachyon sessions on the socket. Start an agent, command, or runbook to populate the server."),
    summary: t("{0} sessions · {1} live", "{0}", "{1}"),
    foreignNote: t("not an open workspace — orphaned or owned by another window"),
    pid: t("pid"),
    live: t("live"),
    dead: t("exited"),
    exit: t("exit {0}", "{0}"),
    capture: t("Capture"),
    kill: t("Kill"),
    killConfirm: t("Kill session {0}? This stops the process and removes the pane.", "{0}"),
    kindSession: t("Agents & terminals"),
    kindCommand: t("Commands"),
    kindRunbook: t("Runbook steps"),
    kindAnchor: t("Engine internals"),
    kindUnknown: t("Other"),
    captureEmpty: t("(no output)"),
  };
}

let panel: vscode.WebviewPanel | undefined;

export async function openServerInspector(deps: InspectorDeps): Promise<void> {
  const s = strings();
  if (panel) {
    panel.reveal(vscode.ViewColumn.Active);
  } else {
    panel = vscode.window.createWebviewPanel("tachyonServerInspector", s.title, vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(deps.extensionUri, "dist", "webview")],
    });
    panel.onDidDispose(() => {
      panel = undefined;
    });
  }
  const live = panel;

  const sendModel = async () => {
    let model: InspectorModel;
    try {
      const snap = await deps.snapshot();
      model = buildInspectorModel(snap, deps.folderByHash());
    } catch {
      model = { groups: [], totalSessions: 0, liveSessions: 0 };
    }
    if (panel === live) live.webview.postMessage({ type: "model", model });
  };

  live.webview.onDidReceiveMessage(async (msg: { type: string; session?: string }) => {
    if (panel !== live) return;
    switch (msg.type) {
      case "ready":
        live.webview.postMessage({ type: "init", strings: s });
        await sendModel();
        return;
      case "refresh":
        await sendModel();
        return;
      case "capture": {
        if (!msg.session) return;
        let text = "";
        try {
          text = await deps.capture(msg.session);
        } catch {
          text = "";
        }
        live.webview.postMessage({ type: "capture", session: msg.session, text });
        return;
      }
      case "kill": {
        if (!msg.session) return;
        const ok = await vscode.window.showWarningMessage(
          vscode.l10n.t("Kill session {0}? This stops the process and removes the pane.", msg.session),
          { modal: true },
          vscode.l10n.t("Kill"),
        );
        if (ok) {
          try {
            await deps.kill(msg.session);
          } catch {
            /* already gone */
          }
          await sendModel();
        }
        return;
      }
    }
  });

  const codiconUri = live.webview.asWebviewUri(
    vscode.Uri.joinPath(deps.extensionUri, "dist", "webview", "codicon.css"),
  );
  live.webview.html = html(live.webview, codiconUri);
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
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); background: var(--vscode-editor-background); max-width: 760px; margin: 0 auto; padding: 14px 16px 28px; }
  .head { display: flex; align-items: center; gap: 8px; margin: 2px 0 2px; }
  h2 { font-weight: 600; margin: 0; display: flex; align-items: center; gap: 8px; flex: 1; }
  .sub { font-size: 11px; color: var(--vscode-descriptionForeground); margin: 0 0 12px; }
  .toolbar { display: flex; align-items: center; gap: 14px; margin: 0 0 14px; }
  .summary { font-size: 12px; color: var(--vscode-descriptionForeground); flex: 1; }
  button {
    padding: 5px 12px; border: 1px solid transparent; border-radius: 2px; cursor: pointer;
    font-family: var(--vscode-font-family); font-size: 12px; display: inline-flex; align-items: center; gap: 5px;
    background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground);
  }
  button:hover { background: var(--vscode-button-secondaryHoverBackground); }
  button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
  button.danger:hover { background: var(--vscode-inputValidation-errorBorder, var(--vscode-errorForeground)); color: var(--vscode-button-foreground); }
  label.auto { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--vscode-descriptionForeground); cursor: pointer; }
  input[type=checkbox] { accent-color: var(--vscode-button-background); }
  .group { margin: 0 0 18px; }
  .ws { display: flex; align-items: baseline; gap: 8px; font-size: 13px; font-weight: 600; padding: 4px 0; border-bottom: 1px solid var(--vscode-widget-border, var(--vscode-editorWidget-border, transparent)); }
  .ws .hash { font-family: var(--vscode-editor-font-family); font-weight: 400; font-size: 11px; color: var(--vscode-descriptionForeground); }
  .ws .foreign { font-size: 11px; font-weight: 400; color: var(--vscode-descriptionForeground); font-style: italic; }
  .kind { font-size: 11px; font-weight: 600; color: var(--vscode-descriptionForeground); text-transform: uppercase; letter-spacing: .04em; margin: 12px 0 4px; }
  .sess { display: flex; align-items: center; gap: 10px; padding: 6px 4px; border-bottom: 1px solid var(--vscode-widget-border, transparent); }
  .sess .name { font-weight: 600; font-size: 13px; }
  .sess .meta { font-family: var(--vscode-editor-font-family); font-size: 11px; color: var(--vscode-descriptionForeground); flex: 1; }
  .badge { display: inline-flex; align-items: center; gap: 4px; font-size: 10.5px; padding: 1px 7px; border-radius: 9px; font-weight: 600; }
  .badge.live { background: var(--vscode-testing-iconPassed, #2ea043); color: var(--vscode-editor-background); }
  .badge.dead { background: var(--vscode-descriptionForeground); color: var(--vscode-editor-background); }
  .badge.crashed { background: var(--vscode-errorForeground, #f14c4c); color: var(--vscode-editor-background); }
  .sess .acts { display: flex; gap: 6px; }
  .sess button { padding: 3px 9px; font-size: 11px; }
  pre.cap {
    margin: 0 4px 10px 14px; padding: 8px 10px; max-height: 260px; overflow: auto; white-space: pre-wrap; word-break: break-word;
    background: var(--vscode-textCodeBlock-background, var(--vscode-editor-background)); border: 1px solid var(--vscode-widget-border, transparent);
    border-radius: 3px; font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); color: var(--vscode-foreground);
  }
  .empty { margin-top: 28px; text-align: center; color: var(--vscode-descriptionForeground); font-size: 13px; }
</style>
</head>
<body>
  <div class="head">
    <h2><span class="codicon codicon-server-process"></span><span id="title"></span></h2>
  </div>
  <p class="sub" id="subtitle"></p>
  <div class="toolbar">
    <span class="summary" id="summary"></span>
    <label class="auto"><input type="checkbox" id="auto" checked><span id="lAuto"></span></label>
    <button id="refresh"><span class="codicon codicon-refresh"></span><span id="lRefresh"></span></button>
  </div>
  <div id="body"></div>

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  let S = {};
  let timer;

  const esc = (x) => String(x).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  const KIND_LABEL = () => ({
    session: S.kindSession, command: S.kindCommand, runbook: S.kindRunbook, anchor: S.kindAnchor, unknown: S.kindUnknown,
  });

  function badge(sess) {
    if (!sess.dead) return '<span class="badge live"><span class="codicon codicon-pulse"></span>' + esc(S.live) + '</span>';
    const crashed = typeof sess.exitCode === "number" && sess.exitCode !== 0;
    const label = typeof sess.exitCode === "number" ? S.exit.replace("{0}", sess.exitCode) : S.dead;
    return '<span class="badge ' + (crashed ? "crashed" : "dead") + '">' + esc(label) + '</span>';
  }

  function sessionRow(sess) {
    const meta = S.pid + " " + sess.pid + (sess.currentCommand ? " · " + esc(sess.currentCommand) : "");
    return '<div class="sess" data-session="' + esc(sess.session) + '">' +
      badge(sess) +
      '<span class="name">' + esc(sess.label) + '</span>' +
      '<span class="meta">' + meta + '</span>' +
      '<span class="acts">' +
        '<button class="cap"><span class="codicon codicon-output"></span>' + esc(S.capture) + '</button>' +
        '<button class="kill danger"><span class="codicon codicon-trash"></span>' + esc(S.kill) + '</button>' +
      '</span>' +
    '</div>';
  }

  function render(model) {
    $("summary").textContent = S.summary.replace("{0}", model.totalSessions).replace("{1}", model.liveSessions);
    const body = $("body");
    if (model.groups.length === 0) {
      body.innerHTML = '<div class="empty">' + esc(S.empty) + '</div>';
      return;
    }
    const labels = KIND_LABEL();
    let h = "";
    for (const g of model.groups) {
      h += '<div class="group">';
      h += '<div class="ws"><span>' + esc(g.workspace) + '</span>' +
        (g.wsHash ? '<span class="hash">' + esc(g.wsHash) + '</span>' : "") +
        (g.foreign ? '<span class="foreign">' + esc(S.foreignNote) + '</span>' : "") +
      '</div>';
      let lastKind = null;
      for (const sess of g.sessions) {
        if (sess.kind !== lastKind) {
          h += '<div class="kind">' + esc(labels[sess.kind] || sess.kind) + '</div>';
          lastKind = sess.kind;
        }
        h += sessionRow(sess);
      }
      h += '</div>';
    }
    body.innerHTML = h;

    for (const el of body.querySelectorAll(".sess")) {
      const session = el.getAttribute("data-session");
      el.querySelector(".cap").onclick = () => {
        const existing = el.nextElementSibling;
        if (existing && existing.classList.contains("cap")) { existing.remove(); return; }
        vscode.postMessage({ type: "capture", session });
      };
      el.querySelector(".kill").onclick = () => vscode.postMessage({ type: "kill", session });
    }
  }

  function showCapture(session, text) {
    const row = document.querySelector('.sess[data-session="' + (window.CSS && CSS.escape ? CSS.escape(session) : session) + '"]');
    if (!row) return;
    const next = row.nextElementSibling;
    if (next && next.classList.contains("cap")) next.remove();
    const pre = document.createElement("pre");
    pre.className = "cap";
    pre.textContent = text && text.length > 0 ? text : S.captureEmpty;
    row.insertAdjacentElement("afterend", pre);
  }

  function applyStrings() {
    $("title").textContent = S.title;
    $("subtitle").textContent = S.subtitle;
    $("lRefresh").textContent = S.refresh;
    $("lAuto").textContent = S.auto;
  }

  function setAuto(on) {
    if (timer) { clearInterval(timer); timer = undefined; }
    if (on) timer = setInterval(() => vscode.postMessage({ type: "refresh" }), 2500);
  }

  $("refresh").onclick = () => vscode.postMessage({ type: "refresh" });
  $("auto").onchange = (e) => setAuto(e.target.checked);

  window.addEventListener("message", (e) => {
    const m = e.data;
    if (m.type === "init") { S = m.strings; applyStrings(); setAuto($("auto").checked); }
    else if (m.type === "model") render(m.model);
    else if (m.type === "capture") showCapture(m.session, m.text);
  });

  vscode.postMessage({ type: "ready" });
</script>
</body>
</html>`;
}
