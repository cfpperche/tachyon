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
  /** Per-session CPU activity over the last interval (busy=true). Empty off-Linux. */
  cpuBusy: (rows: PaneSnapshot[]) => Map<string, boolean>;
  /** Last lines of a session's pane output. */
  capture: (session: string) => Promise<string>;
  /** Open the session in an editor terminal (attach). */
  open: (session: string) => void;
  /** Kill a session by exact name. */
  kill: (session: string) => Promise<void>;
  /** Reap all dead-pane sessions; returns how many were killed (after a confirm). */
  reapDead: () => Promise<number>;
  /** Reap all sessions owned by closed/foreign workspaces; returns how many (after a confirm). */
  reapOrphans: () => Promise<number>;
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
    busy: t("busy"),
    idle: t("idle"),
    open: t("Open"),
    capture: t("Capture"),
    kill: t("Kill"),
    reapDead: t("Kill {0} dead", "{0}"),
    reapOrphans: t("Reap {0} orphaned", "{0}"),
    killConfirm: t("Kill session {0}? This stops the process and removes the pane.", "{0}"),
    kindSession: t("Agents & terminals"),
    kindCommand: t("Commands"),
    kindRunbook: t("Runbook steps"),
    kindAnchor: t("Engine internals"),
    kindUnknown: t("Other"),
    captureEmpty: t("(no output)"),
    ageSeconds: t("{0}s", "{0}"),
    ageMinutes: t("{0}m", "{0}"),
    ageHours: t("{0}h", "{0}"),
    ageDays: t("{0}d", "{0}"),
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
      const busy = deps.cpuBusy(snap);
      model = buildInspectorModel(snap, deps.folderByHash(), busy);
    } catch {
      model = { groups: [], totalSessions: 0, liveSessions: 0, deadSessions: 0, orphanSessions: 0 };
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
      case "open":
        if (msg.session) deps.open(msg.session);
        return;
      case "reapDead": {
        await deps.reapDead();
        await sendModel();
        return;
      }
      case "reapOrphans": {
        await deps.reapOrphans();
        await sendModel();
        return;
      }
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
  const dsUri = live.webview.asWebviewUri(
    vscode.Uri.joinPath(deps.extensionUri, "dist", "webview", "design-system.css"),
  );
  live.webview.html = html(live.webview, codiconUri, dsUri);
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
  body { max-width: 760px; margin: 0 auto; padding: 14px 16px var(--ds-5); }
  .head { display: flex; align-items: center; gap: var(--ds-2); margin: 2px 0; }
  .head .ds-title { flex: 1; }
  .ds-sub { margin: 0 0 var(--ds-3); }
  .toolbar { display: flex; align-items: center; gap: 14px; margin: 0 0 14px; }
  .summary { font-size: var(--ds-small); color: var(--ds-muted); flex: 1; }
  .ds-btn.danger:hover { background: color-mix(in srgb, var(--ds-err) 16%, transparent); color: var(--ds-err); border-color: color-mix(in srgb, var(--ds-err) 55%, transparent); }
  label.auto { display: inline-flex; align-items: center; gap: 6px; font-size: var(--ds-small); color: var(--ds-muted); cursor: pointer; }
  input[type=checkbox] { accent-color: var(--ds-btn-bg); }
  .group { margin: 0 0 18px; }
  .ws { display: flex; align-items: baseline; gap: var(--ds-2); font-size: 13px; font-weight: 600; padding: 4px 0; border-bottom: 1px solid var(--ds-border); }
  .ws .hash { font-family: var(--ds-mono); font-weight: 400; font-size: var(--ds-micro); color: var(--ds-muted); }
  .ws .foreign { font-size: var(--ds-micro); font-weight: 400; color: var(--ds-muted); font-style: italic; }
  .kind { font-size: var(--ds-micro); font-weight: 600; color: var(--ds-muted); text-transform: uppercase; letter-spacing: .04em; margin: var(--ds-3) 0 4px; }
  .sess { display: flex; align-items: center; gap: 10px; padding: 6px 4px; border-bottom: 1px solid var(--ds-border); }
  .sess .name { font-weight: 600; font-size: 13px; }
  .sess .meta { font-family: var(--ds-mono); font-size: var(--ds-micro); color: var(--ds-muted); flex: 1; }
  .sess .acts { display: flex; gap: 6px; }
  .sess .ds-btn { padding: 3px 9px; font-size: var(--ds-micro); }
  /* filled status pill — a high-visibility live/dead/crashed indicator (a deliberate panel delta, not .ds-badge) */
  .badge { display: inline-flex; align-items: center; gap: 4px; font-size: 10.5px; padding: 1px 7px; border-radius: 9px; font-weight: 600; }
  .badge.live { background: var(--ds-ok); color: var(--vscode-editor-background); }
  .badge.dead { background: var(--ds-muted); color: var(--vscode-editor-background); }
  .badge.crashed { background: var(--ds-err); color: var(--vscode-editor-background); }
  .cpu { font-size: 10px; padding: 0 5px; border-radius: 6px; border: 1px solid var(--ds-border); color: var(--ds-muted); }
  .cpu.busy { color: var(--ds-warn); border-color: var(--ds-warn); }
  .age { font-family: var(--ds-mono); font-size: var(--ds-micro); color: var(--ds-muted); }
  pre.cap {
    margin: 0 4px 10px 14px; padding: var(--ds-2) 10px; max-height: 260px; overflow: auto; white-space: pre-wrap; word-break: break-word;
    background: var(--vscode-textCodeBlock-background, var(--ds-card)); border: 1px solid var(--ds-border);
    border-radius: 3px; font-family: var(--ds-mono); font-size: var(--vscode-editor-font-size); color: var(--ds-fg);
  }
</style>
</head>
<body>
  <div class="head">
    <h2 class="ds-title"><span class="codicon codicon-server-process"></span><span id="title"></span></h2>
  </div>
  <p class="ds-sub" id="subtitle"></p>
  <div class="toolbar">
    <span class="summary" id="summary"></span>
    <button id="reapOrphans" class="ds-btn danger" style="display:none"><span class="codicon codicon-database"></span><span id="lReapOrphans"></span></button>
    <button id="reapDead" class="ds-btn danger" style="display:none"><span class="codicon codicon-trash"></span><span id="lReapDead"></span></button>
    <label class="auto"><input type="checkbox" id="auto" checked><span id="lAuto"></span></label>
    <button id="refresh" class="ds-btn"><span class="codicon codicon-refresh"></span><span id="lRefresh"></span></button>
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

  function ago(epochSec) {
    if (!epochSec) return "";
    const s = Math.max(0, Math.floor(Date.now() / 1000 - epochSec));
    if (s < 60) return S.ageSeconds.replace("{0}", s);
    if (s < 3600) return S.ageMinutes.replace("{0}", Math.floor(s / 60));
    if (s < 86400) return S.ageHours.replace("{0}", Math.floor(s / 3600));
    return S.ageDays.replace("{0}", Math.floor(s / 86400));
  }

  function cpuTag(sess) {
    if (!sess.cpu) return "";
    const label = sess.cpu === "busy" ? S.busy : S.idle;
    return '<span class="cpu ' + sess.cpu + '">' + esc(label) + '</span>';
  }

  function sessionRow(sess) {
    const meta = S.pid + " " + sess.pid + (sess.currentCommand ? " · " + esc(sess.currentCommand) : "");
    const age = ago(sess.createdAt);
    return '<div class="sess" data-session="' + esc(sess.session) + '">' +
      badge(sess) +
      cpuTag(sess) +
      '<span class="name">' + esc(sess.label) + '</span>' +
      '<span class="meta">' + meta + '</span>' +
      (age ? '<span class="age">' + esc(age) + '</span>' : "") +
      '<span class="acts">' +
        '<button class="open ds-btn"><span class="codicon codicon-link-external"></span>' + esc(S.open) + '</button>' +
        '<button class="cap ds-btn"><span class="codicon codicon-output"></span>' + esc(S.capture) + '</button>' +
        '<button class="kill danger ds-btn"><span class="codicon codicon-trash"></span>' + esc(S.kill) + '</button>' +
      '</span>' +
    '</div>';
  }

  function reapButton(id, count, template) {
    const btn = $(id);
    if (count > 0) { btn.querySelector("span:last-child").textContent = template.replace("{0}", count); btn.style.display = ""; }
    else btn.style.display = "none";
  }

  function render(model) {
    $("summary").textContent = S.summary.replace("{0}", model.totalSessions).replace("{1}", model.liveSessions);
    reapButton("reapDead", model.deadSessions, S.reapDead);
    reapButton("reapOrphans", model.orphanSessions, S.reapOrphans);
    const body = $("body");
    if (model.groups.length === 0) {
      body.innerHTML = '<div class="ds-empty">' + esc(S.empty) + '</div>';
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
      el.querySelector(".open").onclick = () => vscode.postMessage({ type: "open", session });
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

  $("reapDead").onclick = () => vscode.postMessage({ type: "reapDead" });
  $("reapOrphans").onclick = () => vscode.postMessage({ type: "reapOrphans" });

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
