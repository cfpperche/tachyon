/**
 * Minimal CDP session over vscode-js-debug requestCDPProxy (thimo fallback path).
 * Single-tab prototype — enough for navigate / eval / screenshot / url.
 */

import * as vscode from "vscode";
import { buildDesignModeInjectExpression } from "./designModeInject.js";
import { getCachedDmThemeTokens } from "./themeTokens.js";

/** Minimal WebSocket surface (avoid @types/ws; package is CJS). */
type WsSocket = {
  readyState: number;
  send(data: string): void;
  close(): void;
  on(event: "open", cb: () => void): void;
  on(event: "error", cb: (err: Error) => void): void;
  on(event: "message", cb: (data: unknown) => void): void;
  on(event: "close", cb: () => void): void;
};
type WsCtor = new (url: string) => WsSocket;

type Pending = {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
};

export type CdpProxyInfo = {
  host?: string;
  port?: number;
  webSocketDebuggerUrl?: string;
  path?: string;
};

const DESIGN_MODE_BINDING = "tachyonDesignModePick";

export class IdeBrowserCdpSession {
  private ws: WsSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private pageSessionId: string | null = null;
  private lastUrl = "";
  private state: "disconnected" | "connecting" | "connected" = "disconnected";
  private debugSession: vscode.DebugSession | null = null;
  private WebSocket: WsCtor | null = null;
  private designModeOn = false;
  /** Whether the in-page side panel was open (survive URL changes). */
  private designPanelOpen = false;
  /** Side panel width px (resizable sash; survive URL changes). */
  private designPanelWidth = 340;
  /** Picker armed (true) vs browse/links (false). */
  private designPickMode = true;
  private designModeLog: ((m: string) => void) | null = null;
  private onDesignPick: ((rawJson: string) => void) | null = null;
  /** Address-bar / main-frame navigation while Design Mode was on → host paints status bar OFF. */
  private onDesignModeForcedOff: (() => void) | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  /** While Design Mode is on, poll that the inject chrome still exists (URL-bar nav is flaky on CDP). */
  private presenceWatchTimer: ReturnType<typeof setInterval> | null = null;
  private presenceChecking = false;

  get connectionState(): "disconnected" | "connecting" | "connected" {
    return this.state;
  }

  /** True only when state is connected and the WebSocket is still OPEN. */
  get isLive(): boolean {
    return this.state === "connected" && !!this.ws && this.ws.readyState === 1;
  }

  get url(): string {
    return this.lastUrl;
  }

  get session(): vscode.DebugSession | null {
    return this.debugSession;
  }

  get isDesignModeOn(): boolean {
    return this.designModeOn;
  }

  /**
   * Lightweight liveness probe. Returns false if the page target or WS is dead
   * (e.g. user closed the Integrated Browser tab).
   */
  async probeAlive(): Promise<boolean> {
    if (!this.isLive) return false;
    try {
      await Promise.race([
        this.send("Runtime.evaluate", {
          expression: "1",
          returnByValue: true,
        }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("probe timeout")), 3_000),
        ),
      ]);
      return true;
    } catch {
      return false;
    }
  }

  /** True for errors that mean the CDP socket / debug session is gone. */
  static isClosedError(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return /connection is closed|cdp not connected|websocket closed|cdp disposed|socket.*closed|not connected/i.test(
      msg,
    );
  }

  /** Register host callback for page-side Design Mode picks (JSON string). */
  setDesignModePickHandler(handler: ((rawJson: string) => void) | null): void {
    this.onDesignPick = handler;
  }

  /**
   * Called when Design Mode is forced OFF by main-frame (address bar) navigation.
   * In-iframe navigations do not fire this — Design Mode stays on.
   */
  setDesignModeForcedOffHandler(handler: (() => void) | null): void {
    this.onDesignModeForcedOff = handler;
  }

  /** Track side-panel open state from page `__layout` events (survives URL change). */
  setDesignPanelOpen(open: boolean): void {
    this.designPanelOpen = open;
  }

  get isDesignPanelOpen(): boolean {
    return this.designPanelOpen;
  }

  setDesignPanelWidth(width: number): void {
    if (Number.isFinite(width) && width >= 240) {
      this.designPanelWidth = Math.round(width);
    }
  }

  get panelWidthPx(): number {
    return this.designPanelWidth;
  }

  setDesignPickMode(on: boolean): void {
    this.designPickMode = on;
  }

  get isPickModeOn(): boolean {
    return this.designPickMode;
  }

  async connectToDebugSession(session: vscode.DebugSession, log: (m: string) => void): Promise<void> {
    // Drop any previous socket/session so reconnect after tab-close is clean.
    this.resetSocketOnly();
    this.debugSession = session;
    this.state = "connecting";
    // ws ships without types in this monorepo; structural cast is enough for the proto.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = await (Function('return import("ws")')() as Promise<{ default?: WsCtor } & WsCtor>);
    this.WebSocket = (mod.default ?? mod) as WsCtor;
    log(`requestCDPProxy on session ${session.name} (${session.id})`);
    const proxy = (await Promise.race([
      session.customRequest("requestCDPProxy"),
      new Promise((_, reject) => setTimeout(() => reject(new Error("requestCDPProxy timed out")), 30_000)),
    ])) as CdpProxyInfo;

    const wsUrl =
      proxy.webSocketDebuggerUrl
      || (proxy.host && proxy.port
        ? `ws://${proxy.host}:${proxy.port}${proxy.path || ""}`
        : null);
    if (!wsUrl) {
      throw new Error(`requestCDPProxy returned no WebSocket URL: ${JSON.stringify(proxy)}`);
    }
    log(`CDP WebSocket ${wsUrl}`);
    await this.openSocket(wsUrl, log);
    await this.bootstrap(log);
    this.state = "connected";
  }

  /** Close WS and clear pending without dropping design-mode prefs / handlers. */
  private resetSocketOnly(): void {
    this.stopPickPoll();
    for (const [, p] of this.pending) p.reject(new Error("CDP reconnecting"));
    this.pending.clear();
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
    this.pageSessionId = null;
    this.state = "disconnected";
  }

  private openSocket(wsUrl: string, log: (m: string) => void): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.WebSocket) {
        reject(new Error("WebSocket constructor not loaded"));
        return;
      }
      const ws = new this.WebSocket(wsUrl);
      this.ws = ws;
      const timer = setTimeout(() => {
        reject(new Error("CDP WebSocket connect timed out"));
        try {
          ws.close();
        } catch {
          /* ignore */
        }
      }, 15_000);
      ws.on("open", () => {
        clearTimeout(timer);
        resolve();
      });
      ws.on("error", (err: Error) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      });
      ws.on("message", (data: unknown) => {
        try {
          const msg = JSON.parse(String(data)) as {
            id?: number;
            method?: string;
            params?: Record<string, unknown>;
            result?: unknown;
            error?: { message?: string };
            sessionId?: string;
          };
          if (typeof msg.id === "number" && this.pending.has(msg.id)) {
            const p = this.pending.get(msg.id)!;
            this.pending.delete(msg.id);
            if (msg.error) p.reject(new Error(msg.error.message || "CDP error"));
            else p.resolve(msg.result);
            return;
          }
          // Main-frame navigation → Design Mode OFF (best-effort; presence watch is the reliable path).
          // In-site navigations happen inside #tachyon-dm-viewport iframe (frame has parentId).
          if (msg.method === "Page.frameNavigated") {
            const frame = (msg.params as { frame?: { url?: string; parentId?: string } } | undefined)?.frame;
            const isMain = !!frame?.url && !frame.parentId;
            if (isMain) {
              this.lastUrl = frame!.url!;
              if (this.designModeOn) {
                this.forceDesignModeOff(log, "address-bar / main-frame navigation");
              }
            }
          }
          // js-debug sometimes surfaces address-bar loads as targetInfoChanged instead of frameNavigated.
          if (msg.method === "Target.targetInfoChanged" && this.designModeOn) {
            const info = (msg.params as { targetInfo?: { type?: string; url?: string } } | undefined)?.targetInfo;
            if (info?.type === "page" && info.url && info.url !== "about:blank") {
              const prev = this.lastUrl;
              if (prev && info.url !== prev && !info.url.startsWith("about:")) {
                this.lastUrl = info.url;
                this.forceDesignModeOff(log, `targetInfoChanged ${prev} → ${info.url}`);
              }
            }
          }
          if (msg.method === "Runtime.bindingCalled") {
            const p = msg.params as { name?: string; payload?: string } | undefined;
            if (p?.name === DESIGN_MODE_BINDING && typeof p.payload === "string") {
              this.onDesignPick?.(p.payload);
            }
          }
        } catch (err) {
          log(`CDP message parse error: ${err}`);
        }
      });
      ws.on("close", () => {
        this.state = "disconnected";
        for (const [, p] of this.pending) p.reject(new Error("CDP WebSocket closed"));
        this.pending.clear();
      });
    });
  }

  private async bootstrap(log: (m: string) => void): Promise<void> {
    await this.reattachPageTarget(log);
    try {
      await this.send("Page.setLifecycleEventsEnabled", { enabled: true });
    } catch {
      /* optional */
    }
    try {
      const evalResult = (await this.send("Runtime.evaluate", {
        expression: "location.href",
        returnByValue: true,
      })) as { result?: { value?: string } };
      if (typeof evalResult?.result?.value === "string") {
        this.lastUrl = evalResult.result.value;
      }
    } catch {
      /* ignore */
    }
  }

  /**
   * Re-bind CDP page session after address-bar navigation (js-debug may keep a
   * dead pageSessionId until we Target.attachToTarget again).
   * Target.* must go on the root socket (no page sessionId).
   */
  private async reattachPageTarget(log: (m: string) => void): Promise<void> {
    try {
      await this.sendInternal("Target.setDiscoverTargets", { discover: true }, false);
      const targets = (await this.sendInternal("Target.getTargets", {}, false)) as {
        targetInfos?: Array<{ targetId: string; type: string; url: string }>;
      };
      const pages = (targets.targetInfos || []).filter((t) => t.type === "page");
      // Prefer non-empty http(s) page; fall back to any page target.
      const page =
        pages.find((t) => /^https?:/i.test(t.url || ""))
        || pages.find((t) => t.url && t.url !== "about:blank")
        || pages[0];
      if (!page) {
        log("reattach: no page target");
        return;
      }
      const attached = (await this.sendInternal(
        "Target.attachToTarget",
        { targetId: page.targetId, flatten: true },
        false,
      )) as { sessionId?: string };
      if (attached.sessionId) {
        this.pageSessionId = attached.sessionId;
        log(`reattach page sessionId=${this.pageSessionId} url=${page.url || "?"}`);
      }
      if (page.url) this.lastUrl = page.url;
    } catch (err) {
      log(`reattach Target.* failed (continuing): ${err}`);
    }
    try {
      await this.send("Page.enable", {});
    } catch {
      /* ignore */
    }
    try {
      await this.send("Runtime.enable", {});
    } catch {
      /* ignore */
    }
    try {
      await this.send("Page.setLifecycleEventsEnabled", { enabled: true });
    } catch {
      /* ignore */
    }
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    return this.sendInternal(method, params, true);
  }

  /**
   * CDP send. When `usePageSession` is false, message goes to the root/browser
   * session (needed for Target.* after we have attached a page sessionId).
   */
  private sendInternal(
    method: string,
    params: Record<string, unknown>,
    usePageSession: boolean,
  ): Promise<unknown> {
    // ws.OPEN === 1
    if (!this.ws || this.ws.readyState !== 1) {
      return Promise.reject(new Error("CDP not connected"));
    }
    const id = this.nextId++;
    const msg: Record<string, unknown> = { id, method, params };
    if (usePageSession && this.pageSessionId) msg.sessionId = this.pageSessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws!.send(JSON.stringify(msg));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP ${method} timed out`));
        }
      }, 30_000);
    });
  }

  async navigate(url: string): Promise<void> {
    // Full main-frame navigation (agent or host) ends Design Mode — same as address bar.
    if (this.designModeOn) {
      this.forceDesignModeOff(
        this.designModeLog ?? (() => undefined),
        "ide_browser_navigate / host navigate",
      );
    }
    await this.send("Page.navigate", { url });
    this.lastUrl = url;
    await new Promise((r) => setTimeout(r, 400));
    try {
      const evalResult = (await this.send("Runtime.evaluate", {
        expression: "location.href",
        returnByValue: true,
      })) as { result?: { value?: string } };
      if (typeof evalResult?.result?.value === "string") this.lastUrl = evalResult.result.value;
    } catch {
      /* ignore */
    }
  }

  async evaluate(expression: string): Promise<unknown> {
    const result = (await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })) as { result?: { value?: unknown; description?: string }; exceptionDetails?: unknown };
    if (result.exceptionDetails) {
      throw new Error(`Eval exception: ${JSON.stringify(result.exceptionDetails).slice(0, 500)}`);
    }
    return result.result?.value;
  }

  /**
   * Evaluate JS against the page document.
   * Design Mode moves live DOM into #tachyon-dm-viewport (same document — not an iframe),
   * so agent click/eval run against the normal page context.
   */
  async evaluateInPage(expression: string): Promise<unknown> {
    return this.evaluate(expression);
  }

  async screenshotPngBase64(clip?: {
    x: number;
    y: number;
    width: number;
    height: number;
  }): Promise<string> {
    const params: Record<string, unknown> = {
      format: "png",
      fromSurface: true,
    };
    if (clip && clip.width > 0 && clip.height > 0) {
      params.clip = {
        x: Math.max(0, clip.x),
        y: Math.max(0, clip.y),
        width: clip.width,
        height: clip.height,
        scale: 1,
      };
    }
    const result = (await this.send("Page.captureScreenshot", params)) as { data?: string };
    if (!result.data) throw new Error("Screenshot returned no data");
    return result.data;
  }

  /**
   * Enable or disable Design Mode from the VS Code status bar.
   * ON → inject chrome and open the two framed panels immediately.
   * OFF → remove widget entirely.
   * Address-bar (main-frame) navigation forces OFF; in-site iframe nav keeps ON.
   */
  async setDesignMode(on: boolean, log?: (m: string) => void): Promise<void> {
    this.designModeLog = log ?? this.designModeLog;
    const L = this.designModeLog ?? (() => undefined);
    if (this.state !== "connected") {
      throw new Error("CDP not connected — open the IDE Browser first");
    }
    if (on) {
      try {
        await this.send("Page.enable", {});
      } catch {
        /* already enabled */
      }
      try {
        await this.send("Runtime.enable", {});
      } catch {
        /* ignore */
      }
      try {
        await this.send("Runtime.addBinding", { name: DESIGN_MODE_BINDING });
      } catch (err) {
        L(`Runtime.addBinding: ${err}`);
      }
      this.designModeOn = true;
      this.designPanelOpen = true;
      this.designPickMode = true;
      try {
        const href = (await this.evaluate("location.href")) as string;
        if (typeof href === "string") this.lastUrl = href;
      } catch {
        /* ignore */
      }
      // Open both framed panels immediately (no FAB-only first step).
      await this.injectDesignModeScript({
        restorePanelOpen: true,
        restorePickMode: true,
        panelWidth: this.designPanelWidth,
      });
      this.startPickPoll(L);
      this.startPresenceWatch(L);
      L("Design Mode ON — two panels open (status bar toggles off; address bar ends session)");
    } else {
      this.stopPresenceWatch();
      this.stopPickPoll();
      await this.removeDesignModeScript();
      this.designModeOn = false;
      this.designPanelOpen = false;
      this.designPickMode = true;
      L("Design Mode OFF — widget removed");
    }
  }

  /**
   * Reliable detection when address bar replaces the main document:
   * Design Mode inject chrome disappears. CDP frameNavigated is often missing on
   * Integrated Browser URL-bar navigations, so we poll presence while ON.
   */
  private startPresenceWatch(log: (m: string) => void): void {
    this.stopPresenceWatch();
    this.presenceWatchTimer = setInterval(() => {
      void this.presenceWatchTick(log);
    }, 400);
  }

  private stopPresenceWatch(): void {
    if (this.presenceWatchTimer) {
      clearInterval(this.presenceWatchTimer);
      this.presenceWatchTimer = null;
    }
    this.presenceChecking = false;
  }

  private async presenceWatchTick(log: (m: string) => void): Promise<void> {
    if (!this.designModeOn || !this.isLive || this.presenceChecking) return;
    this.presenceChecking = true;
    try {
      // Prefer reattach when session looks dead — then probe chrome markers.
      let snap: { hasChrome?: boolean; href?: string } | null = null;
      try {
        snap = (await this.evaluate(`(() => ({
          hasChrome: !!(document.getElementById('tachyon-dm-root') || document.getElementById('tachyon-dm-shell')),
          href: location.href
        }))()`)) as { hasChrome?: boolean; href?: string };
      } catch {
        // Page session often dies on address-bar nav before frameNavigated is delivered.
        await this.reattachPageTarget(log);
        try {
          snap = (await this.evaluate(`(() => ({
            hasChrome: !!(document.getElementById('tachyon-dm-root') || document.getElementById('tachyon-dm-shell')),
            href: location.href
          }))()`)) as { hasChrome?: boolean; href?: string };
        } catch {
          this.forceDesignModeOff(log, "page unreachable after address-bar navigation");
          return;
        }
      }
      if (snap?.href && typeof snap.href === "string") {
        this.lastUrl = snap.href;
      }
      if (!snap?.hasChrome) {
        this.forceDesignModeOff(log, "widget gone (address-bar navigation)");
      }
    } finally {
      this.presenceChecking = false;
    }
  }

  /**
   * Main-frame / address-bar navigation: drop host Design Mode state and refresh URL for status bar.
   * Page document is already going away — do not require evaluate cleanup of the inject.
   */
  private forceDesignModeOff(log: (m: string) => void, reason: string): void {
    if (!this.designModeOn) return;
    this.stopPresenceWatch();
    this.stopPickPoll();
    this.designModeOn = false;
    this.designPanelOpen = false;
    this.designPickMode = true;
    log(`Design Mode OFF — ${reason}`);
    // Refresh lastUrl so globe status bar shows the post-nav page, then paint host UI.
    void (async () => {
      try {
        await this.reattachPageTarget(log);
        const href = (await this.evaluate("location.href")) as string;
        if (typeof href === "string" && href) this.lastUrl = href;
      } catch {
        /* ignore */
      }
      try {
        this.onDesignModeForcedOff?.();
      } catch {
        /* ignore host paint errors */
      }
    })();
  }

  private startPickPoll(log: (m: string) => void): void {
    this.stopPickPoll();
    this.pollTimer = setInterval(() => {
      void this.pollPagePickQueue(log);
    }, 250);
  }

  private stopPickPoll(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /**
   * Reliable path when Runtime.bindingCalled is flaky on the js-debug proxy:
   * page stores picks in window.__tachyonDmQueue; host drains via evaluate.
   */
  private async pollPagePickQueue(log: (m: string) => void): Promise<void> {
    if (!this.designModeOn || this.state !== "connected") return;
    try {
      const drained = (await this.evaluate(`(() => {
        const q = window.__tachyonDmQueue;
        if (!Array.isArray(q) || q.length === 0) return null;
        const out = q.splice(0, q.length);
        return out;
      })()`)) as string[] | null;
      if (!drained?.length) return;
      for (const raw of drained) {
        if (typeof raw === "string") {
          log(`poll pick (${raw.length} chars)`);
          this.onDesignPick?.(raw);
        }
      }
    } catch {
      /* navigating */
    }
  }

  private async injectDesignModeScript(opts?: {
    restorePanelOpen?: boolean;
    restorePickMode?: boolean;
    panelWidth?: number;
  }): Promise<void> {
    // Companion-style: launcher only / restore panel; site in iframe + side panel cards.
    // Theme tokens from background-warmed cache (never open a probe panel here).
    const expression = buildDesignModeInjectExpression({
      bindingName: DESIGN_MODE_BINDING,
      themeVars: getCachedDmThemeTokens(),
      panelWidth: opts?.panelWidth ?? this.designPanelWidth,
      restorePanelOpen: opts?.restorePanelOpen === true,
      restorePickMode: opts?.restorePickMode ?? this.designPickMode,
    });
    await this.evaluate(expression);
  }

  private async removeDesignModeScript(): Promise<void> {
    try {
      await this.evaluate(`(() => {
        if (window.__tachyonDmCleanup) { window.__tachyonDmCleanup(); return true; }
        return false;
      })()`);
    } catch {
      /* page may be gone */
    }
  }

  async snapshotText(): Promise<string> {
    // Prefer accessibility tree; fall back to title+url+body text.
    try {
      await this.send("Accessibility.enable", {});
      const tree = (await this.send("Accessibility.getFullAXTree", {})) as {
        nodes?: Array<{ role?: { value?: string }; name?: { value?: string } }>;
      };
      const lines: string[] = [];
      for (const n of tree.nodes || []) {
        const role = n.role?.value;
        const name = n.name?.value;
        if (role && name) lines.push(`${role}: ${name}`);
        if (lines.length >= 200) break;
      }
      if (lines.length) return lines.join("\n");
    } catch {
      /* fall through */
    }
    const body = await this.evaluate(
      `({ title: document.title, url: location.href, text: (document.body?.innerText||'').slice(0,8000) })`,
    );
    return JSON.stringify(body, null, 2);
  }

  dispose(): void {
    this.stopPresenceWatch();
    this.stopPickPoll();
    this.designModeOn = false;
    this.designPanelOpen = false;
    this.designPickMode = true;
    this.designPanelWidth = 340;
    this.onDesignPick = null;
    this.onDesignModeForcedOff = null;
    for (const [, p] of this.pending) p.reject(new Error("CDP disposed"));
    this.pending.clear();
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
    this.pageSessionId = null;
    this.debugSession = null;
    this.lastUrl = "";
    this.state = "disconnected";
  }
}

export function isBrowserDebugSession(session: vscode.DebugSession): boolean {
  return (
    session.type === "pwa-editor-browser"
    || session.type === "editor-browser"
    || session.type === "pwa-chrome"
    || session.type === "chrome"
  );
}
