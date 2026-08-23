/**
 * 514 — the editor tab of a USER-INSTALLED app.
 *
 * ## Why not `SectionPanelManager`
 *
 * That class drives the twelve screens compiled into the product: it is constructed over a row of the
 * app manifest, renders a bundle the build produced, and refuses any row that does not declare
 * `host: "section"`. An installed app has no manifest row, no bundle and no shell — it is a file tree
 * that arrived from disk after the build. Bending the section manager to serve it would mean giving it
 * a second, manifest-less mode, and the drift that follows is exactly what its `throw` exists to stop.
 * Cardinality is the same idea though — one panel per app per window, reopened by revealing.
 *
 * ## What the app is trusted with
 *
 * Everything the human granted by installing it. The page is not sandboxed away from Tachyon: it calls
 * Bridge tools through `window.tachyon.call`, with no allowlist and no per-action consent. That is the
 * whole point of the split this spec makes — plugin views were a restricted surface nobody used, and
 * the capability people actually want is "my own screen, with the same reach my agents have".
 *
 * What it is NOT trusted with is the human's editor: the page loads from `.tachyon/apps/<id>/` and only
 * from there, and it reaches the network only through the calls the host makes on its behalf.
 */
import fs from "node:fs";
import path from "node:path";
import * as vscode from "vscode";

/** The single viewType every installed app's tab is created under (see `open`). */
export const USER_APP_VIEW_TYPE = "tachyonUserApp";

export interface UserAppTarget {
  /** the app's id, which is also its directory name under `.tachyon/apps/`. */
  id: string;
  title: string;
  /** absolute path of the directory the app was installed into. */
  root: string;
  /** entry file, relative to `root`. */
  entry: string;
}

/** Answers a call the page made. `ok:false` carries a message the page renders however it likes. */
export type UserAppCaller = (
  target: UserAppTarget,
  tool: string,
  args: Record<string, unknown>,
) => Promise<{ ok: true; result: unknown } | { ok: false; error: string }>;

interface CallMessage {
  type: "tachyon.call";
  id: string;
  tool: unknown;
  args: unknown;
}

function isCallMessage(value: unknown): value is CallMessage {
  const record = value as Record<string, unknown> | undefined;
  return !!record && record.type === "tachyon.call" && typeof record.id === "string";
}

/**
 * The shim the page gets. Deliberately tiny and deliberately unopinionated: one function, a promise
 * per call, and errors that arrive as rejections rather than as a Tachyon error screen. An app author
 * reading this file should be able to hold all of it in their head.
 */
const BRIDGE_SHIM = `
<script>
(() => {
  const vscode = acquireVsCodeApi();
  const pending = new Map();
  let seq = 0;
  window.addEventListener("message", (event) => {
    const message = event.data;
    if (!message || message.type !== "tachyon.result") return;
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.ok) entry.resolve(message.result);
    else entry.reject(new Error(message.error || "call failed"));
  });
  window.tachyon = {
    call(tool, args) {
      const id = String(++seq);
      vscode.postMessage({ type: "tachyon.call", id, tool, args: args || {} });
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    },
  };
})();
</script>
`;

export class UserAppPanels {
  private readonly panels = new Map<string, vscode.WebviewPanel>();
  private disposed = false;

  constructor(private readonly call: UserAppCaller) {}

  get openIds(): string[] {
    return [...this.panels.keys()];
  }

  /** Open the app's tab, or reveal the one already open for it. */
  open(target: UserAppTarget): void {
    if (this.disposed) return;
    const existing = this.panels.get(target.id);
    if (existing) {
      existing.reveal(existing.viewColumn ?? vscode.ViewColumn.Active);
      return;
    }
    const rootUri = vscode.Uri.file(target.root);
    // ONE viewType for every installed app, with the app id carried by the panel rather than by the
    // type. A type per app would be a serializer per app, and VS Code cannot register those for ids it
    // learns about after activation.
    const panel = vscode.window.createWebviewPanel(
      USER_APP_VIEW_TYPE,
      target.title,
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [rootUri] },
    );
    panel.iconPath = vscode.Uri.file(path.join(target.root, "icon.png"));
    panel.webview.html = this.render(panel.webview, target);
    panel.webview.onDidReceiveMessage(async (message: unknown) => {
      if (!isCallMessage(message)) return;
      const tool = typeof message.tool === "string" ? message.tool : "";
      const args = message.args !== null && typeof message.args === "object" && !Array.isArray(message.args)
        ? message.args as Record<string, unknown>
        : {};
      if (!tool) {
        void panel.webview.postMessage({ type: "tachyon.result", id: message.id, ok: false, error: "call needs a tool name" });
        return;
      }
      const answer = await this.call(target, tool, args);
      // The error goes back to the PAGE and dies there: an app that calls a tool it may not call is
      // not a Tachyon failure, and a notification for it would put the app's bugs on the human.
      void panel.webview.postMessage(
        answer.ok
          ? { type: "tachyon.result", id: message.id, ok: true, result: answer.result }
          : { type: "tachyon.result", id: message.id, ok: false, error: answer.error },
      );
    });
    panel.onDidDispose(() => this.panels.delete(target.id));
    this.panels.set(target.id, panel);
  }

  /** Close the tab of an app that is no longer installed (or was replaced by a reinstall). */
  close(id: string): void {
    this.panels.get(id)?.dispose();
  }

  dispose(): void {
    this.disposed = true;
    for (const panel of [...this.panels.values()]) panel.dispose();
    this.panels.clear();
  }

  private render(webview: vscode.Webview, target: UserAppTarget): string {
    const entry = path.join(target.root, target.entry);
    let html: string;
    try {
      html = fs.readFileSync(entry, "utf8");
    } catch (error) {
      // A page that cannot be read is the app's problem, said plainly, in the tab the human opened.
      return `<!doctype html><meta charset="utf-8"><body style="font-family:sans-serif;padding:16px">`
        + `<h3>${escapeHtml(target.title)}</h3><p>Could not read <code>${escapeHtml(target.entry)}</code>: `
        + `${escapeHtml(error instanceof Error ? error.message : String(error))}</p></body>`;
    }
    // `<base>` is what makes an app's own relative paths work unchanged: the author writes
    // `./app.js` and the webview resolves it under the app's directory.
    const base = `<base href="${webview.asWebviewUri(vscode.Uri.file(target.root)).toString()}/">`;
    const head = `${base}${BRIDGE_SHIM}`;
    return html.includes("<head>") ? html.replace("<head>", `<head>${head}`) : `${head}${html}`;
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[character] ?? character
  ));
}
