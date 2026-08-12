/**
 * Browser session controller — editor-browser launch + CDP recovery (t-47503a).
 *
 * Owns: debug-session lifecycle, ensure/launch, reset, withCdpRecovery, navigate.
 * Does not own HTTP, Design Mode chat, or pick assembly.
 *
 * Each launch carries a private correlation id on its editor-browser parent.
 * The controller adopts only the direct CDP child of that parent and tears down
 * only the exact sessions it retained (t-849f52).
 */

import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import { IdeBrowserCdpSession, isBrowserDebugSession } from "./cdpSession.js";

export type BrowserSessionLog = { appendLine: (line: string) => void };

/** Discriminators for who ended a tracked editor-browser session (t-1c8195). */
export type IdeBrowserSessionEndInput = {
  endedId: string;
  endedName: string;
  endedType: string;
  endedParentId: string | undefined;
  trackedChildId: string | null;
  trackedParentId: string | null;
  resetInFlight: boolean;
  resetReason: string | null;
  activeId: string | undefined;
  activeName: string | undefined;
  lastTransportEvent: string | null;
};

export type IdeBrowserSessionEndClassification = {
  tracked: "child" | "parent" | "none";
  actor: "controller-reset" | "external";
  trigger:
    | "controller-reset"
    | "child-ended-parent-active"
    | "child-ended-parent-unknown"
    | "parent-ended"
    | "untracked";
};

/**
 * Classify a debug-session termination. The VS Code event has no reason code;
 * parent-still-active vs our own reset is what distinguishes tab-close from
 * child-only Stop (the floating toolbar acts on the child, t-414540).
 */
export function classifyIdeBrowserSessionEnd(
  input: IdeBrowserSessionEndInput,
): IdeBrowserSessionEndClassification {
  const tracked =
    input.endedId === input.trackedChildId
      ? "child"
      : input.endedId === input.trackedParentId
        ? "parent"
        : "none";
  if (input.resetInFlight) {
    return { tracked, actor: "controller-reset", trigger: "controller-reset" };
  }
  if (tracked === "parent") {
    return { tracked, actor: "external", trigger: "parent-ended" };
  }
  if (tracked === "child") {
    if (input.activeId && input.activeId === input.trackedParentId) {
      return { tracked, actor: "external", trigger: "child-ended-parent-active" };
    }
    return { tracked, actor: "external", trigger: "child-ended-parent-unknown" };
  }
  return { tracked, actor: "external", trigger: "untracked" };
}

export class BrowserSessionController {
  readonly cdp = new IdeBrowserCdpSession();
  private launching: Promise<void> | null = null;
  private sessionEndSub: vscode.Disposable | null = null;
  private sessionStartSub: vscode.Disposable | null = null;
  private readonly log: BrowserSessionLog;
  private onSessionEnded: (() => void) | null = null;
  private trackedChildId: string | null = null;
  private trackedParentId: string | null = null;
  private trackedParentSession: vscode.DebugSession | null = null;
  private resetInFlight = false;
  private resetReason: string | null = null;
  private orphanCheckTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(log: BrowserSessionLog) {
    this.log = log;
    this.sessionStartSub = vscode.debug.onDidStartDebugSession((session) => {
      if (!isBrowserDebugSession(session)) return;
      this.log.appendLine(
        `[ide-browser] debug session started id=${session.id} name=${JSON.stringify(session.name)} type=${session.type} parent=${session.parentSession?.id ?? "none"}`,
      );
      if (
        this.trackedParentId
        && session.parentSession?.id === this.trackedParentId
        && session.id !== this.trackedChildId
      ) {
        this.log.appendLine(
          `[ide-browser] replacement child under tracked parent parent=${this.trackedParentId} new=${session.id} (not auto-attached)`,
        );
      }
    });
    this.sessionEndSub = vscode.debug.onDidTerminateDebugSession((session) => {
      this.onDebugSessionEnded(session);
    });
  }

  private onDebugSessionEnded(session: vscode.DebugSession): void {
    const active = vscode.debug.activeDebugSession;
    const classified = classifyIdeBrowserSessionEnd({
      endedId: session.id,
      endedName: session.name,
      endedType: session.type,
      endedParentId: session.parentSession?.id,
      trackedChildId: this.trackedChildId,
      trackedParentId: this.trackedParentId,
      resetInFlight: this.resetInFlight,
      resetReason: this.resetReason,
      activeId: active?.id,
      activeName: active?.name,
      lastTransportEvent: this.cdp.lastTransportEvent,
    });
    const ours =
      (this.cdp.session && this.cdp.session.id === session.id)
      || session.id === this.trackedChildId
      || session.id === this.trackedParentId;
    if (!ours && classified.trigger === "untracked") return;
    this.log.appendLine(
      `[ide-browser] debug session ended actor=${classified.actor} trigger=${classified.trigger}`
        + ` tracked=${classified.tracked}`
        + ` session=${session.id} name=${JSON.stringify(session.name)} type=${session.type}`
        + ` parent=${session.parentSession?.id ?? "none"}`
        + ` active=${active?.id ?? "none"}`
        + ` resetReason=${this.resetReason ?? "none"}`
        + ` lastCdp=${this.cdp.lastTransportEvent ?? "none"}`,
    );
    if (session.id === this.trackedChildId || (this.cdp.session && this.cdp.session.id === session.id)) {
      this.cdp.dispose();
      this.trackedChildId = null;
      if (!this.resetInFlight) this.onSessionEnded?.();
      // VS Code still reports the dying session as activeDebugSession (measured 1.128).
      // Parent-still-alive after a beat is the orphan discriminator: Stop/tab-close
      // also end the parent and destroy the page; a child-only death leaves chrome painted.
      if (this.trackedParentId && !this.resetInFlight) {
        this.scheduleOrphanCheck(this.trackedParentId);
      }
    }
    if (session.id === this.trackedParentId) {
      this.trackedParentId = null;
      this.trackedParentSession = null;
    }
  }

  private scheduleOrphanCheck(parentId: string): void {
    if (this.orphanCheckTimer) {
      clearTimeout(this.orphanCheckTimer);
      this.orphanCheckTimer = null;
    }
    this.orphanCheckTimer = setTimeout(() => {
      this.orphanCheckTimer = null;
      if (this.trackedParentId === parentId) {
        this.log.appendLine(
          `[ide-browser] child ended and parent survived parent=${parentId} — injected Design Mode chrome cannot be removed without CDP`,
        );
      }
    }, 150);
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
      await this.resetBrowserSession("cdp-recovery");
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
  async resetBrowserSession(reason = "unspecified"): Promise<void> {
    this.resetInFlight = true;
    this.resetReason = reason;
    this.log.appendLine(
      `[ide-browser] resetBrowserSession reason=${reason} child=${this.trackedChildId ?? "none"} parent=${this.trackedParentId ?? "none"}`,
    );
    const session = this.cdp.session;
    const parentSession = this.trackedParentSession ?? session?.parentSession ?? null;
    this.cdp.dispose();
    if (session) {
      try {
        await vscode.debug.stopDebugging(session);
      } catch {
        /* already gone */
      }
      // Also stop parent if present (editor-browser launches parent+child).
      if (parentSession) {
        try {
          await vscode.debug.stopDebugging(parentSession);
        } catch {
          /* ignore */
        }
      }
    } else if (parentSession) {
      // The child may already be gone while its editor-browser parent survives.
      // Retaining the exact object lets this controller clean up only its launch.
      try {
        await vscode.debug.stopDebugging(parentSession);
      } catch {
        /* already gone */
      }
    }
    this.trackedChildId = null;
    this.trackedParentId = null;
    this.trackedParentSession = null;
    if (this.orphanCheckTimer) {
      clearTimeout(this.orphanCheckTimer);
      this.orphanCheckTimer = null;
    }
    this.onSessionEnded?.();
    this.resetInFlight = false;
  }

  async ensureBrowser(initialUrl?: string): Promise<void> {
    if (this.cdp.connectionState === "connected") {
      if (this.cdp.isLive && (await this.cdp.probeAlive())) {
        return;
      }
      this.log.appendLine("[ide-browser] CDP marked connected but dead — relaunching");
      await this.resetBrowserSession("ensure-dead");
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
        await this.resetBrowserSession("ensure-stale");
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
   * Launch editor-browser and attach CDP to its direct child session.
   */
  async launchBrowser(initialUrl: string): Promise<void> {
    this.log.appendLine(`[ide-browser] launching editor-browser url=${initialUrl}`);
    const launchId = randomUUID();
    let launchedParent: vscode.DebugSession | null = null;

    let childResolve: (s: vscode.DebugSession | null) => void;
    const childPromise = new Promise<vscode.DebugSession | null>((resolve) => {
      childResolve = resolve;
    });
    const timeout = setTimeout(() => childResolve(null), 20_000);
    const sub = vscode.debug.onDidStartDebugSession((session) => {
      if (
        session.type === "editor-browser"
        && session.configuration.tachyonIdeBrowserLaunchId === launchId
      ) {
        launchedParent = session;
        this.trackedParentId = session.id;
        this.trackedParentSession = session;
        return;
      }
      if (
        launchedParent
        && isBrowserDebugSession(session)
        && session.parentSession?.id === launchedParent.id
      ) {
        clearTimeout(timeout);
        sub.dispose();
        childResolve(session);
      }
    });

    // These options suppress UI only for the parent session created by this API call. The
    // editor-browser adapter then starts the CDP-bearing child through DAP's startDebugging reverse
    // request; VS Code 1.117 creates that child with only { parentSession }. `noDebug` inherits from
    // the parent's configuration, but suppressDebugToolbar/statusbar/view do not, so the active
    // child still shows the floating toolbar (t-414540). The extension API cannot change options on
    // an existing session or supply options for that reverse request. The only current workaround,
    // debug.toolBarLocation="hidden", is global and would also hide real debugging controls; do not
    // mutate it here. Removing the child would remove the CDP session required by Design Mode.
    const launched = await vscode.debug.startDebugging(undefined, {
      type: "editor-browser",
      request: "launch",
      name: "Tachyon IDE Browser",
      url: initialUrl,
      internalConsoleOptions: "neverOpen",
      tachyonIdeBrowserLaunchId: launchId,
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
    this.trackedChildId = child.id;
    this.trackedParentId = child.parentSession?.id ?? null;
    this.trackedParentSession = child.parentSession ?? launchedParent;
    await this.cdp.connectToDebugSession(child, (m) => this.log.appendLine(`[ide-browser] ${m}`));
    this.log.appendLine(
      `[ide-browser] CDP connected child=${child.id} parent=${this.trackedParentId ?? "none"}`,
    );
  }

  dispose(): void {
    if (this.orphanCheckTimer) {
      clearTimeout(this.orphanCheckTimer);
      this.orphanCheckTimer = null;
    }
    this.sessionStartSub?.dispose();
    this.sessionStartSub = null;
    this.sessionEndSub?.dispose();
    this.sessionEndSub = null;
    this.cdp.dispose();
  }
}
