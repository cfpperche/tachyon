/**
 * Browser session controller — editor-browser launch + CDP recovery (t-47503a).
 *
 * Owns: debug-session lifecycle, ensure/launch, reset, withCdpRecovery, navigate.
 * Does not own HTTP, Design Mode chat, or pick assembly.
 *
 * Session correlation note (t-849f52, recorded only — not fixed here):
 * - `launchBrowser` accepts the first `isBrowserDebugSession` child with a parent;
 *   there is no correlation id linking the child to *this* launch.
 * - `resetBrowserSession` may also stop `vscode.debug.activeDebugSession` when its
 *   name includes "Tachyon", which can cross-stop another manager's session.
 */

import * as vscode from "vscode";
import { IdeBrowserCdpSession, isBrowserDebugSession } from "./cdpSession.js";

export type BrowserSessionLog = { appendLine: (line: string) => void };

export class BrowserSessionController {
  readonly cdp = new IdeBrowserCdpSession();
  private launching: Promise<void> | null = null;
  private sessionEndSub: vscode.Disposable | null = null;
  private readonly log: BrowserSessionLog;
  private onSessionEnded: (() => void) | null = null;

  constructor(log: BrowserSessionLog) {
    this.log = log;
    // When the user closes the Integrated Browser tab, the debug session ends —
    // drop stale CDP so the next open relaunches cleanly.
    this.sessionEndSub = vscode.debug.onDidTerminateDebugSession((session) => {
      if (this.cdp.session && this.cdp.session.id === session.id) {
        this.log.appendLine("[ide-browser] debug session ended (tab closed?) — resetting CDP");
        this.cdp.dispose();
        this.onSessionEnded?.();
      }
    });
  }

  setOnSessionEnded(fn: (() => void) | null): void {
    this.onSessionEnded = fn;
  }

  /**
   * Run a CDP operation; if the socket/session died (tab closed), reset and
   * retry once so open/navigate recover without a full bridge restart.
   */
  async withCdpRecovery<T>(
    relaunchUrl: string | undefined,
    fn: () => Promise<T>,
  ): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (!IdeBrowserCdpSession.isClosedError(err)) throw err;
      const warmUrl = relaunchUrl || this.cdp.url || "about:blank";
      this.log.appendLine(
        `[ide-browser] CDP dead (${err instanceof Error ? err.message : String(err)}) — recovering → ${warmUrl}`,
      );
      await this.resetBrowserSession();
      await this.ensureBrowser(warmUrl);
      return await fn();
    }
  }

  /** Open/ensure browser and navigate. */
  async navigate(url: string): Promise<string> {
    return this.withCdpRecovery(url, async () => {
      await this.ensureBrowser(url);
      await this.cdp.navigate(url);
      return this.cdp.url;
    });
  }

  /** Stop debug session + dispose CDP (HTTP bridge stays up when called from manager). */
  async resetBrowserSession(): Promise<void> {
    const session = this.cdp.session;
    this.cdp.dispose();
    if (session) {
      try {
        await vscode.debug.stopDebugging(session);
      } catch {
        /* already gone */
      }
      // Also stop parent if present (editor-browser launches parent+child).
      if (session.parentSession) {
        try {
          await vscode.debug.stopDebugging(session.parentSession);
        } catch {
          /* ignore */
        }
      }
    }
    // Best-effort: stop any leftover Tachyon IDE Browser sessions.
    // NOTE (t-849f52): only inspects activeDebugSession; name match can cross managers.
    for (const s of vscode.debug.activeDebugSession
      ? [vscode.debug.activeDebugSession]
      : []) {
      if (isBrowserDebugSession(s) && s.name.includes("Tachyon")) {
        try {
          await vscode.debug.stopDebugging(s);
        } catch {
          /* ignore */
        }
      }
    }
    this.onSessionEnded?.();
  }

  async ensureBrowser(initialUrl?: string): Promise<void> {
    if (this.cdp.connectionState === "connected") {
      if (this.cdp.isLive && (await this.cdp.probeAlive())) {
        return;
      }
      this.log.appendLine("[ide-browser] CDP marked connected but dead — relaunching");
      await this.resetBrowserSession();
    }
    if (this.launching) {
      try {
        await this.launching;
      } catch {
        /* first launcher failed — fall through and try ourselves */
      }
      // After concurrent launch, re-check liveness.
      if (this.cdp.isLive && (await this.cdp.probeAlive())) return;
      if (this.cdp.connectionState === "connected") {
        await this.resetBrowserSession();
      }
    }
    this.launching = this.launchBrowser(initialUrl || "about:blank");
    try {
      await this.launching;
    } finally {
      this.launching = null;
    }
  }

  /**
   * Launch editor-browser and attach CDP to the child session.
   * No correlation id on the startDebugging call / child acceptance (t-849f52).
   */
  async launchBrowser(initialUrl: string): Promise<void> {
    this.log.appendLine(`[ide-browser] launching editor-browser url=${initialUrl}`);

    let childResolve: (s: vscode.DebugSession | null) => void;
    const childPromise = new Promise<vscode.DebugSession | null>((resolve) => {
      childResolve = resolve;
    });
    const timeout = setTimeout(() => childResolve(null), 20_000);
    const sub = vscode.debug.onDidStartDebugSession((session) => {
      // First browser child with a parent wins — not scoped to this launch's correlation.
      if (isBrowserDebugSession(session) && session.parentSession) {
        clearTimeout(timeout);
        sub.dispose();
        childResolve(session);
      }
    });

    const launched = await vscode.debug.startDebugging(undefined, {
      type: "editor-browser",
      request: "launch",
      name: "Tachyon IDE Browser",
      url: initialUrl,
      internalConsoleOptions: "neverOpen",
    }, {
      noDebug: true,
      suppressDebugToolbar: true,
      suppressDebugView: true,
      suppressDebugStatusbar: true,
    } as vscode.DebugSessionOptions);

    if (!launched) {
      clearTimeout(timeout);
      sub.dispose();
      // Fallback: open integrated browser command (no CDP)
      try {
        await vscode.commands.executeCommand("workbench.action.browser.open", initialUrl);
      } catch {
        await vscode.commands.executeCommand("simpleBrowser.api.open", vscode.Uri.parse(initialUrl));
      }
      throw new Error(
        "Failed to launch editor-browser debug session (CDP unavailable). Opened Simple/Integrated Browser without automation.",
      );
    }

    const child = await childPromise;
    if (!child) {
      throw new Error("Timed out waiting for editor-browser child debug session (CDP).");
    }
    await this.cdp.connectToDebugSession(child, (m) => this.log.appendLine(`[ide-browser] ${m}`));
    this.log.appendLine("[ide-browser] CDP connected");
  }

  dispose(): void {
    this.sessionEndSub?.dispose();
    this.sessionEndSub = null;
    this.cdp.dispose();
  }
}
