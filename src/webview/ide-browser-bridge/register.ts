/**
 * IDE Integrated Browser bridge — status-bar action cluster.
 *
 * Two icon-only StatusBarItems that must stay **adjacent** (nothing between them):
 * shared `name` (overflow / hide-show group) + exclusive fractional priorities.
 * Each item keeps its own command (click = open browser / toggle Design Mode).
 *
 * VS Code always draws a slim gap between entries; we cannot merge into one pill
 * without losing dual-command. The exclusive priority band is what keeps them together.
 *
 * SDD 488 F4 — settings.ideBrowser.enabled gates this human surface (and call-time on the
 * engine). Tools stay always-registered when ideBrowserRequest is wired (t-3cab05).
 */

import path from "node:path";
import * as vscode from "vscode";
import {
  IDE_BROWSER_FIRST_USE_TIPS,
  isIdeBrowserEnabled,
} from "../../ide-browser/settings.js";
import type { WorkspaceShellHandle } from "../../shell/WorkspaceShellHandle.js";
import { resolveIdeBrowserHomeUrl } from "./homeUrl.js";
import { IdeBrowserBridgeManager } from "./manager.js";
import { DesignModePanel } from "../DesignModePanel.js";
import {
  invalidateDmThemeTokenCache,
  seedDmThemeTokensFromKind,
  warmDmThemeTokensInBackground,
} from "./themeTokens.js";

export { IDE_BROWSER_FIRST_USE_TIPS };

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

/** globalState key — first successful open shows onboarding tips once. */
const ONBOARDING_SEEN_KEY = "tachyon.ideBrowser.onboarding.v1";

const DISABLED_HUMAN_MESSAGE =
  "Integrated Browser is off. Set settings.ideBrowser.enabled: true in tachyon.yml (Control → Settings).";

let manager: IdeBrowserBridgeManager | null = null;
let log: vscode.OutputChannel | null = null;
/** Adjacent cluster: globe + inspect (same name, exclusive priority band). */
let browserBar: vscode.StatusBarItem | null = null;
let designBar: vscode.StatusBarItem | null = null;
let registerOptions: IdeBrowserBridgeRegisterOptions = {};
let extensionContext: vscode.ExtensionContext | null = null;
let designModePanel: DesignModePanel | null = null;

export type IdeBrowserBridgeRegisterOptions = {
  /** Resolve the active Tachyon workspace shell handle (after engine connects). */
  getWorkspace?: () => WorkspaceShellHandle | undefined;
};

function workspaceRoot(): string {
  return registerOptions.getWorkspace?.()?.workspaceRoot
    ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
    ?? process.cwd();
}

function managerForActiveWorkspace(): IdeBrowserBridgeManager | null {
  if (!manager) return null;
  return path.resolve(manager.status.workspaceRoot) === path.resolve(workspaceRoot()) ? manager : null;
}

/** Live opt-in from the active workspace's tachyon.yml (absent = off). */
function featureEnabled(): boolean {
  const ws = registerOptions.getWorkspace?.();
  return isIdeBrowserEnabled(ws?.config?.settings);
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
  // Visibility is owned by paintBars() via settings.ideBrowser.enabled.
  item.hide();
  return item;
}

export function registerIdeBrowserBridge(
  context: vscode.ExtensionContext,
  options: IdeBrowserBridgeRegisterOptions = {},
): Promise<void> {
  registerOptions = options;
  extensionContext = context;
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
      if (!(await requireEnabled("open"))) return;
      await openIdeBrowser(url);
    }),
    vscode.commands.registerCommand(DESIGN_CMD, async () => {
      if (!(await requireEnabled("design mode"))) return;
      await toggleDesignMode();
    }),
    vscode.commands.registerCommand("tachyon.ideBrowserBridge.designModeOn", async () => {
      if (!(await requireEnabled("design mode"))) return;
      await setDesignMode(true);
    }),
    vscode.commands.registerCommand("tachyon.ideBrowserBridge.designModeOff", async () => {
      if (!(await requireEnabled("design mode"))) return;
      await setDesignMode(false);
    }),
    vscode.commands.registerCommand("tachyon.ideBrowserBridge.start", async () => {
      if (!(await requireEnabled("start"))) return;
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
      // Stop remains available even when the gate is off so a running bridge can be torn down.
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

  // Re-paint when the human edits tachyon.yml (enable/disable without reload).
  const ymlWatcher = vscode.workspace.createFileSystemWatcher("**/tachyon.y{a,}ml");
  const onYml = () => {
    void applyGateAfterConfigChange();
  };
  ymlWatcher.onDidChange(onYml);
  ymlWatcher.onDidCreate(onYml);
  ymlWatcher.onDidDelete(onYml);
  context.subscriptions.push(ymlWatcher);

  context.subscriptions.push({
    dispose: () => {
      log?.appendLine("[ide-browser] extension subscription dispose — stopping manager");
      void manager?.stop();
      designModePanel?.dispose();
      designModePanel = null;
      manager = null;
      extensionContext = null;
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
      `[ide-browser] ready — status cluster "${BAR_GROUP_NAME}" (globe@${BROWSER_BAR_PRIORITY} + inspect@${DESIGN_BAR_PRIORITY}; gate=settings.ideBrowser.enabled)`,
    );
  }

  // Opt-in means the agent-facing host is available as soon as the extension is active.
  // This binds loopback + publishes discovery only; Chromium/CDP remain lazy in navigate().
  return startEnabledBridge("activation");
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

async function requireEnabled(op: string): Promise<boolean> {
  if (featureEnabled()) return true;
  log?.appendLine(`[ide-browser] ${op} refused: settings.ideBrowser.enabled is not true`);
  void vscode.window.showWarningMessage(DISABLED_HUMAN_MESSAGE);
  paintBars();
  return false;
}

/**
 * Reconcile the live gate: disabling tears down the host; enabling brings up the agent-facing host
 * without opening a browser tab (Chromium/CDP remain lazy until navigation).
 */
async function applyGateAfterConfigChange(): Promise<void> {
  const active = managerForActiveWorkspace();
  if (!featureEnabled() && active?.running) {
    try {
      await active.stop();
      manager = null;
      log?.appendLine("[ide-browser] stopped — settings.ideBrowser.enabled is off");
    } catch (err) {
      log?.appendLine(
        `[ide-browser] stop after disable failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  } else if (featureEnabled()) {
    await startEnabledBridge("configuration change");
  }
  paintBars();
}

async function startEnabledBridge(trigger: string): Promise<void> {
  if (!featureEnabled()) return;
  try {
    const st = await ensureStarted();
    log?.appendLine(`[ide-browser] host ready on ${trigger} — ${st.endpoint}`);
    paintBars();
  } catch (err) {
    log?.appendLine(
      `[ide-browser] host start on ${trigger} failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function showStatus(): Promise<void> {
  if (!featureEnabled()) {
    void vscode.window.showInformationMessage(DISABLED_HUMAN_MESSAGE);
    return;
  }
  const active = managerForActiveWorkspace();
  const st = active?.status;
  if (!st?.running) {
    void vscode.window.showInformationMessage(
      "IDE Browser bridge is off. Click the globe icon on the status bar to open.",
    );
    return;
  }
  const dm = active?.designMode;
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
    await maybeShowFirstUseTips();
  } catch (err) {
    fail("open", err);
    if (browserBar && featureEnabled()) {
      browserBar.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
    }
  }
}

async function maybeShowFirstUseTips(): Promise<void> {
  const ctx = extensionContext;
  if (!ctx) return;
  if (ctx.globalState.get<boolean>(ONBOARDING_SEEN_KEY) === true) return;
  await ctx.globalState.update(ONBOARDING_SEEN_KEY, true);
  void vscode.window.showInformationMessage(IDE_BROWSER_FIRST_USE_TIPS);
}

async function toggleDesignMode(): Promise<void> {
  try {
    const m = await ensureManager();
    if (!m.running) await m.start();
    if (m.status.cdp !== "connected") {
      await m.navigate(homeUrl());
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
    if (state.on) designModePanel?.open();
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
    await m.setDesignMode(on);
    if (on) designModePanel?.open();
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
  const owner = registerOptions.getWorkspace?.();
  const root = owner?.workspaceRoot ?? workspaceRoot();
  if (manager && path.resolve(manager.status.workspaceRoot) !== path.resolve(root)) {
    await manager.stop();
    manager = null;
    log?.appendLine(`[ide-browser] workspace owner changed → ${root}`);
  }
  if (!manager) {
    if (!log) log = vscode.window.createOutputChannel("Tachyon IDE Browser");
    manager = new IdeBrowserBridgeManager(root, log);
    if (!extensionContext) throw new Error("IDE Browser extension context is unavailable");
    designModePanel?.dispose();
    designModePanel = new DesignModePanel(extensionContext.extensionUri, root, manager);
    manager.setWorkspaceResolver(() => owner);
    manager.setDesignModeChangedHandler(() => {
      paintBars();
    });
  }
  return manager;
}

/**
 * Paint the cluster: icon-only, shared group name, state in tooltip + background.
 * Never put long labels in `text` — that is what makes the pair look like two separate bars.
 * When settings.ideBrowser.enabled is false, hide both items (human surface gate).
 */
function paintBars(): void {
  const enabled = featureEnabled();
  if (!enabled) {
    browserBar?.hide();
    designBar?.hide();
    return;
  }

  const active = managerForActiveWorkspace();
  const st = active?.status;
  const dm = active?.designMode;
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
    browserBar.show();
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
    designBar.show();
  }
}

function fail(op: string, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  log?.appendLine(`[ide-browser] ${op} failed: ${msg}`);
  void vscode.window.showErrorMessage(`IDE Browser ${op} failed: ${msg}`, "Show log").then((c) => {
    if (c === "Show log") log?.show(true);
  });
}
