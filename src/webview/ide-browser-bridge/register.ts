/**
 * IDE Integrated Browser bridge — status-bar action cluster.
 *
 * Two icon-only StatusBarItems that must stay **adjacent** (nothing between them):
 * shared `name` (overflow / hide-show group) + exclusive fractional priorities.
 * Each item keeps its own command (click = open browser / toggle Design Mode).
 *
 * VS Code always draws a slim gap between entries; we cannot merge into one pill
 * without losing dual-command. The exclusive priority band is what keeps them together.
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

/** Stable ids — required so VS Code can manage hide/show + overflow grouping. */
const BROWSER_BAR_ID = "tachyon.ideBrowser.open";
const DESIGN_BAR_ID = "tachyon.ideBrowser.designMode";
/**
 * Shared name → VS Code lists them as one manage/overflow group ("Tachyon IDE").
 * Must be identical on every item in the cluster.
 */
const BAR_GROUP_NAME = "Tachyon IDE";

/**
 * Exclusive priority band on the left. Floats avoid other extensions inserting
 * between integer slots (50/49 were easy to split). Higher = further left.
 * Order: globe (open) then inspect (design).
 */
const BROWSER_BAR_PRIORITY = 90_210.2;
const DESIGN_BAR_PRIORITY = 90_210.1;

let manager: IdeBrowserBridgeManager | null = null;
let log: vscode.OutputChannel | null = null;
/** Adjacent cluster: globe + inspect (same name, exclusive priority band). */
let browserBar: vscode.StatusBarItem | null = null;
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

function createClusterItem(
  id: string,
  priority: number,
  command: string,
  icon: string,
  tooltip: string,
  a11y: string,
): vscode.StatusBarItem {
  const item = vscode.window.createStatusBarItem(
    id,
    vscode.StatusBarAlignment.Left,
    priority,
  );
  item.name = BAR_GROUP_NAME;
  item.command = command;
  item.text = icon;
  item.tooltip = tooltip;
  item.accessibilityInformation = { label: a11y };
  item.show();
  return item;
}

export function registerIdeBrowserBridge(
  context: vscode.ExtensionContext,
  options: IdeBrowserBridgeRegisterOptions = {},
): void {
  registerOptions = options;
  log = vscode.window.createOutputChannel("Tachyon IDE Browser");
  context.subscriptions.push(log);

  // Create as a tight pair so workbench layout places them next to each other.
  browserBar = createClusterItem(
    BROWSER_BAR_ID,
    BROWSER_BAR_PRIORITY,
    OPEN_CMD,
    "$(globe)",
    "Open Integrated Browser",
    "Open Integrated Browser",
  );
  designBar = createClusterItem(
    DESIGN_BAR_ID,
    DESIGN_BAR_PRIORITY,
    DESIGN_CMD,
    "$(inspect)",
    "Toggle Design Mode",
    "Toggle Design Mode",
  );
  context.subscriptions.push(browserBar, designBar);
  paintBars();

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
        paintBars();
        void vscode.window.showInformationMessage(
          `IDE Browser bridge ready (${st.endpoint}).`,
        );
      } catch (err) {
        fail("start", err);
      }
    }),
    vscode.commands.registerCommand("tachyon.ideBrowserBridge.stop", async () => {
      try {
        await manager?.stop();
        manager = null;
        paintBars();
        void vscode.window.showInformationMessage("IDE Browser bridge stopped.");
      } catch (err) {
        fail("stop", err);
      }
    }),
    vscode.commands.registerCommand("tachyon.ideBrowserBridge.status", async () => {
      await showStatus();
    }),
  );

  context.subscriptions.push({
    dispose: () => {
      void manager?.stop();
      manager = null;
    },
  });

  seedDmThemeTokensFromKind();
  warmDmThemeTokensInBackground((m) => log?.appendLine(m));
  context.subscriptions.push(
    vscode.window.onDidChangeActiveColorTheme(() => {
      invalidateDmThemeTokenCache();
      seedDmThemeTokensFromKind();
      warmDmThemeTokensInBackground((m) => log?.appendLine(m));
    }),
  );

  if (context.extensionMode === vscode.ExtensionMode.Development) {
    log?.appendLine(
      `[ide-browser] ready — status cluster "${BAR_GROUP_NAME}" (globe@${BROWSER_BAR_PRIORITY} + inspect@${DESIGN_BAR_PRIORITY}, no auto-boot)`,
    );
  }
}

/** Workspace home URL (tachyon.yml settings.ideBrowser.homeUrl). */
function homeUrl(): string {
  const ws = registerOptions.getWorkspace?.();
  const configHome = ws?.config?.settings?.ideBrowser?.homeUrl;
  return resolveIdeBrowserHomeUrl({
    workspaceRoot: workspaceRoot(),
    configHomeUrl: configHome,
  });
}

async function showStatus(): Promise<void> {
  const st = manager?.status;
  if (!st?.running) {
    void vscode.window.showInformationMessage(
      "IDE Browser bridge is off. Click the globe icon on the status bar to open.",
    );
    return;
  }
  const dm = manager?.designMode;
  void vscode.window.showInformationMessage(
    `IDE Browser: ${st.endpoint} · CDP ${st.cdp} · ${st.url || "(no page yet)"}`
      + (dm?.on ? ` · Design Mode → ${dm.agent}` : ""),
  );
}

async function openIdeBrowser(url?: string): Promise<void> {
  try {
    let target = typeof url === "string" && url.trim() ? url.trim() : "";
    if (!target) target = homeUrl();
    await ensureStarted();
    paintBars();
    const finalUrl = await openAndNavigate(target);
    paintBars();
    log?.appendLine(`[ide-browser] opened ${finalUrl}`);
  } catch (err) {
    fail("open", err);
    if (browserBar) {
      browserBar.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
    }
  }
}

async function toggleDesignMode(): Promise<void> {
  try {
    const m = await ensureManager();
    if (!m.running) await m.start();
    if (m.status.cdp !== "connected") {
      await m.navigate(homeUrl());
    }
    if (registerOptions.getWorkspace) {
      m.setWorkspaceResolver(registerOptions.getWorkspace);
    }
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
    paintBars();
    log?.appendLine(
      state.on
        ? `[design-mode] ON → agent ${state.agent} (footer toolbar; nav re-injects)`
        : "[design-mode] OFF (overlays removed)",
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
    await m.setDesignMode(on);
    paintBars();
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
    manager.setDesignModeChangedHandler(() => {
      paintBars();
    });
  }
  return manager;
}

/**
 * Paint the cluster: icon-only, shared group name, state in tooltip + background.
 * Never put long labels in `text` — that is what makes the pair look like two separate bars.
 */
function paintBars(): void {
  const st = manager?.status;
  const dm = manager?.designMode;
  const endpoint = st?.running ? st.endpoint : undefined;
  const cdp = st?.cdp ?? "disconnected";
  const url = st?.url ?? "";
  const dmOn = !!dm?.on;

  if (browserBar) {
    browserBar.name = BAR_GROUP_NAME;
    browserBar.command = OPEN_CMD;
    browserBar.text = "$(globe)";
    browserBar.backgroundColor = undefined;
    if (!endpoint) {
      browserBar.tooltip = "Tachyon IDE — Open Integrated Browser (settings.ideBrowser.homeUrl)";
      browserBar.accessibilityInformation = { label: "Tachyon IDE: Open Integrated Browser" };
    } else {
      browserBar.tooltip = [
        "Tachyon IDE — Integrated Browser",
        `Bridge: ${endpoint}`,
        `CDP: ${cdp}`,
        url && url !== "about:blank" ? `URL: ${url}` : "URL: (ready)",
        "",
        "Click to reopen at homeUrl",
      ].join("\n");
      browserBar.accessibilityInformation = {
        label: url && url !== "about:blank"
          ? `Tachyon IDE: Integrated Browser — ${url}`
          : "Tachyon IDE: Integrated Browser — ready",
      };
    }
  }

  if (designBar) {
    designBar.name = BAR_GROUP_NAME;
    designBar.command = DESIGN_CMD;
    designBar.text = "$(inspect)";
    if (dmOn) {
      designBar.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
      designBar.tooltip = [
        "Tachyon IDE — Design Mode ON",
        dm?.agent ? `Agent: ${dm.agent}` : "",
        "Footer toolbar: picker + responsive presets",
        "Navigations re-inject while ON",
        "",
        "Click to turn off",
      ].filter(Boolean).join("\n");
      designBar.accessibilityInformation = {
        label: `Tachyon IDE: Design Mode ON${dm?.agent ? ` — ${dm.agent}` : ""}`,
      };
    } else {
      designBar.backgroundColor = undefined;
      designBar.tooltip = [
        "Tachyon IDE — Design Mode OFF",
        "Overlay Picker + responsive presets on the page",
        "",
        "Click to turn on",
      ].join("\n");
      designBar.accessibilityInformation = { label: "Tachyon IDE: Design Mode OFF — click to enable" };
    }
  }
}

function fail(op: string, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  log?.appendLine(`[ide-browser] ${op} failed: ${msg}`);
  void vscode.window.showErrorMessage(`IDE Browser ${op} failed: ${msg}`, "Show log").then((c) => {
    if (c === "Show log") log?.show(true);
  });
}
