/**
 * IDE Integrated Browser bridge — simple UX for Dev Host dogfood.
 *
 * - Status bar globe: open browser when the user wants (no auto-open)
 * - Status bar inspect: toggle Design Mode (click element → send to agent)
 * - Theme tokens seeded/warmed in background (no editor flash on Design Mode)
 */

import * as vscode from "vscode";
import type { WorkspaceShellHandle } from "../../shell/WorkspaceShellHandle.js";
import { resolveIdeBrowserHomeUrl } from "./homeUrl.js";
import { IdeBrowserBridgeManager } from "./manager.js";
import {
  invalidateDmThemeTokenCache,
  seedDmThemeTokensFromKind,
  warmDmThemeTokensInBackground,
} from "./themeTokens.js";

const OPEN_CMD = "tachyon.ideBrowserBridge.open";
const DESIGN_CMD = "tachyon.ideBrowserBridge.designMode";

let manager: IdeBrowserBridgeManager | null = null;
let log: vscode.OutputChannel | null = null;
let statusBar: vscode.StatusBarItem | null = null;
let designBar: vscode.StatusBarItem | null = null;
let registerOptions: IdeBrowserBridgeRegisterOptions = {};

export type IdeBrowserBridgeRegisterOptions = {
  /** Resolve the active Tachyon workspace shell handle (after engine connects). */
  getWorkspace?: () => WorkspaceShellHandle | undefined;
};

function workspaceRoot(): string {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
    ?? process.cwd();
}

export function registerIdeBrowserBridge(
  context: vscode.ExtensionContext,
  options: IdeBrowserBridgeRegisterOptions = {},
): void {
  registerOptions = options;
  log = vscode.window.createOutputChannel("Tachyon IDE Browser");
  context.subscriptions.push(log);

  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  statusBar.command = OPEN_CMD;
  statusBar.text = "$(globe) IDE Browser";
  statusBar.tooltip =
    "Open Tachyon Integrated Browser (home URL from settings.ideBrowser.homeUrl in tachyon.yml)";
  statusBar.show();
  context.subscriptions.push(statusBar);

  designBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 49);
  designBar.command = DESIGN_CMD;
  designBar.text = "$(inspect) Design Mode";
  designBar.tooltip =
    "Toggle Design Mode: ON opens site + panel side-by-side; OFF removes the widget. Address-bar navigation turns it off.";
  designBar.show();
  context.subscriptions.push(designBar);

  context.subscriptions.push(
    vscode.commands.registerCommand(OPEN_CMD, async (url?: string) => {
      await openIdeBrowser(url);
    }),
    vscode.commands.registerCommand(DESIGN_CMD, async () => {
      await toggleDesignMode();
    }),
    vscode.commands.registerCommand("tachyon.ideBrowserBridge.designModeOn", async () => {
      await setDesignMode(true);
    }),
    vscode.commands.registerCommand("tachyon.ideBrowserBridge.designModeOff", async () => {
      await setDesignMode(false);
    }),
    vscode.commands.registerCommand("tachyon.ideBrowserBridge.start", async () => {
      try {
        const st = await ensureStarted();
        paintStatusBar(st.endpoint, st.cdp, st.url);
        void vscode.window.showInformationMessage(
          `IDE Browser bridge ready (${st.endpoint}). Use Design Mode on the status bar to pick elements.`,
        );
      } catch (err) {
        fail("start", err);
      }
    }),
    vscode.commands.registerCommand("tachyon.ideBrowserBridge.stop", async () => {
      try {
        await manager?.stop();
        manager = null;
        paintStatusBar(undefined, "disconnected", "");
        paintDesignBar(false);
        void vscode.window.showInformationMessage("IDE Browser bridge stopped.");
      } catch (err) {
        fail("stop", err);
      }
    }),
    vscode.commands.registerCommand("tachyon.ideBrowserBridge.status", async () => {
      const st = manager?.status;
      if (!st?.running) {
        void vscode.window.showInformationMessage(
          "IDE Browser bridge is off. Click the globe status bar item or run “Tachyon: Open IDE Browser”.",
        );
        return;
      }
      const dm = manager?.designMode;
      void vscode.window.showInformationMessage(
        `IDE Browser: ${st.endpoint} · CDP ${st.cdp} · ${st.url || "(no page yet)"}`
          + (dm?.on ? ` · Design Mode → ${dm.agent}` : ""),
      );
    }),
  );

  context.subscriptions.push({
    dispose: () => {
      void manager?.stop();
      manager = null;
    },
  });

  // Theme tokens: seed immediately (no UI), warm from live VS Code colors in background.
  // Design Mode inject never opens a probe panel — only reads the cache.
  seedDmThemeTokensFromKind();
  warmDmThemeTokensInBackground((m) => log?.appendLine(m));
  context.subscriptions.push(
    vscode.window.onDidChangeActiveColorTheme(() => {
      invalidateDmThemeTokenCache();
      seedDmThemeTokensFromKind();
      warmDmThemeTokensInBackground((m) => log?.appendLine(m));
    }),
  );

  // Dev Host: do not auto-open browser, agents, or editor tabs.
  // User opens via status bar globe when ready.
  if (context.extensionMode === vscode.ExtensionMode.Development) {
    log?.appendLine("[ide-browser] ready — click status bar globe to open (no auto-boot)");
    paintStatusBar(undefined, "disconnected", "");
    if (statusBar) {
      statusBar.tooltip =
        "Click to open Integrated Browser (Dev Host — manual open, no auto-boot)";
    }
  }
}

/** Workspace home URL for the globe / first Design Mode open (tachyon.yml settings.ideBrowser.homeUrl). */
function homeUrl(): string {
  const ws = registerOptions.getWorkspace?.();
  const configHome = ws?.config?.settings?.ideBrowser?.homeUrl;
  return resolveIdeBrowserHomeUrl({
    workspaceRoot: workspaceRoot(),
    configHomeUrl: configHome,
  });
}

async function openIdeBrowser(url?: string): Promise<void> {
  try {
    let target = typeof url === "string" && url.trim() ? url.trim() : "";
    if (!target) target = homeUrl();
    const st = await ensureStarted();
    paintStatusBar(st.endpoint, "connecting", target);
    const finalUrl = await openAndNavigate(target);
    paintStatusBar(st.endpoint, "connected", finalUrl);
  } catch (err) {
    fail("open", err);
    if (statusBar) {
      statusBar.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
    }
  }
}

async function toggleDesignMode(): Promise<void> {
  try {
    const m = await ensureManager();
    if (!m.running) await m.start();
    if (m.status.cdp !== "connected") {
      // Ensure a page is open so CDP attaches (workspace home, not a hardcoded site).
      await m.navigate(homeUrl());
    }
    if (registerOptions.getWorkspace) {
      m.setWorkspaceResolver(registerOptions.getWorkspace);
    }
    // Prefer dogfood agent name when marker present
    const ws = registerOptions.getWorkspace?.();
    if (ws) {
      try {
        const listed = await ws.extension.query({ action: "agents.list" });
        const rows = Array.isArray(listed) ? listed as Array<{ name?: string; running?: boolean }> : [];
        const grok = rows.find((r) => r.name === "grok" && r.running);
        if (grok?.name) m.setDesignModeAgent(grok.name);
        else {
          const any = rows.find((r) => r.running && r.name);
          if (any?.name) m.setDesignModeAgent(any.name);
        }
      } catch {
        /* keep default grok */
      }
    }
    const state = await m.toggleDesignMode();
    paintDesignBar(state.on, state.agent);
    paintStatusBar(m.status.endpoint, m.status.cdp, m.status.url);
    // Do NOT showInformationMessage here — VS Code freezes the Integrated Browser
    // with "Paused due to Notification" and Design Mode clicks stop working.
    log?.appendLine(
      state.on
        ? `[design-mode] ON → agent ${state.agent} (two panels; Picker toggle for links; status bar off / address bar ends)`
        : "[design-mode] OFF (widget removed)",
    );
  } catch (err) {
    fail("design mode", err);
  }
}

async function setDesignMode(on: boolean): Promise<void> {
  try {
    const m = await ensureManager();
    if (!m.running) await m.start();
    if (m.status.cdp !== "connected") await m.navigate(homeUrl());
    if (registerOptions.getWorkspace) m.setWorkspaceResolver(registerOptions.getWorkspace);
    const state = await m.setDesignMode(on);
    paintDesignBar(state.on, state.agent);
  } catch (err) {
    fail("design mode", err);
  }
}

async function openAndNavigate(url: string): Promise<string> {
  const m = await ensureManager();
  if (!m.running) await m.start();
  return m.navigate(url);
}

async function ensureStarted(): Promise<{ endpoint: string; cdp: string; url: string }> {
  const m = await ensureManager();
  const st = m.running ? m.status : await m.start();
  return {
    endpoint: st.endpoint,
    cdp: st.cdp,
    url: st.url,
  };
}

async function ensureManager(): Promise<IdeBrowserBridgeManager> {
  if (!manager) {
    if (!log) log = vscode.window.createOutputChannel("Tachyon IDE Browser");
    manager = new IdeBrowserBridgeManager(workspaceRoot(), log);
    if (registerOptions.getWorkspace) {
      manager.setWorkspaceResolver(registerOptions.getWorkspace);
    }
    manager.setDesignModeChangedHandler((state) => {
      paintDesignBar(state.on, state.agent);
      // Session end / recovery turns Design Mode off — keep status bar honest.
      const st = manager?.status;
      if (st?.running) {
        paintStatusBar(st.endpoint, st.cdp, st.url);
      } else {
        paintStatusBar(undefined, "disconnected", "");
      }
    });
  }
  return manager;
}

function paintStatusBar(
  endpoint: string | undefined,
  cdp: string,
  url: string,
): void {
  if (!statusBar) return;
  statusBar.backgroundColor = undefined;
  if (!endpoint) {
    statusBar.text = "$(globe) IDE Browser";
    statusBar.tooltip = "Click to start bridge and open Integrated Browser";
    return;
  }
  const short = url && url !== "about:blank" ? truncate(url, 40) : "ready";
  statusBar.text = `$(globe) IDE Browser · ${short}`;
  statusBar.tooltip = [
    "Click to (re)open Integrated Browser",
    `Bridge: ${endpoint}`,
    `CDP: ${cdp}`,
    url ? `URL: ${url}` : "",
  ].filter(Boolean).join("\n");
}

function paintDesignBar(on: boolean, agent?: string): void {
  if (!designBar) return;
  if (on) {
    designBar.text = `$(inspect) Design Mode ON${agent ? ` → ${agent}` : ""}`;
    designBar.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
    designBar.tooltip =
      "Design Mode ON — site + panel framed side-by-side. "
      + "In-page navigation keeps it on; address-bar navigation turns it off. "
      + "Click here to turn off and remove the widget.";
  } else {
    designBar.text = "$(inspect) Design Mode";
    designBar.backgroundColor = undefined;
    designBar.tooltip =
      "Toggle Design Mode: opens two framed panels (site + Design Mode). Address bar ends the session.";
  }
}

function fail(op: string, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  log?.appendLine(`[ide-browser] ${op} failed: ${msg}`);
  void vscode.window.showErrorMessage(`IDE Browser ${op} failed: ${msg}`, "Show log").then((c) => {
    if (c === "Show log") log?.show(true);
  });
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}
