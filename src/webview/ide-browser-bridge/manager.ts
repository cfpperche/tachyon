/**
 * IDE Integrated Browser bridge manager (thimo-style debug-session path).
 * Launches editor-browser, attaches CDP via requestCDPProxy, serves HTTP for the engine.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import type { WorkspaceShellHandle } from "../../shell/WorkspaceShellHandle.js";
import type { IdeBrowserEnvelope, IdeBrowserInstanceFile, IdeBrowserStatus } from "../../ide-browser/protocol.js";
import { IDE_BROWSER_INSTANCES_DIR_NAME } from "../../ide-browser/protocol.js";
import { IdeBrowserCdpSession, isBrowserDebugSession } from "./cdpSession.js";
import {
  assembleDesignModePick,
  formatDesignModePickForAgent,
  type DesignModePickPayload,
} from "./pick.js";

export type DesignModeState = {
  on: boolean;
  agent: string;
  lastPick: DesignModePickPayload | null;
};

export class IdeBrowserBridgeManager {
  private server: http.Server | null = null;
  private port = 0;
  private token = "";
  private instancePath: string | null = null;
  private cdp = new IdeBrowserCdpSession();
  private launching: Promise<void> | null = null;
  private readonly log: vscode.OutputChannel;
  private readonly workspaceRoot: string;
  private getWorkspace: (() => WorkspaceShellHandle | undefined) | null = null;
  private designAgent = "grok";
  private lastPick: DesignModePickPayload | null = null;
  private pickHandling = false;
  private onDesignModeChanged: ((state: DesignModeState) => void) | null = null;
  private sessionEndSub: vscode.Disposable | null = null;

  constructor(workspaceRoot: string, log: vscode.OutputChannel) {
    this.workspaceRoot = path.resolve(workspaceRoot);
    this.log = log;
    this.cdp.setDesignModePickHandler((raw) => {
      void this.handleDesignPickRaw(raw);
    });
    this.cdp.setDesignModeForcedOffHandler(() => {
      // Address bar / main-frame nav ends Design Mode — keep Design Mode + globe URL in sync.
      this.lastPick = null;
      this.log.appendLine(
        `[design-mode] OFF (address bar / main-frame) url=${this.cdp.url || "(unknown)"}`,
      );
      this.onDesignModeChanged?.(this.designMode);
    });
    // When the user closes the Integrated Browser tab, the debug session ends —
    // drop stale CDP so the next open relaunches cleanly.
    this.sessionEndSub = vscode.debug.onDidTerminateDebugSession((session) => {
      if (this.cdp.session && this.cdp.session.id === session.id) {
        this.log.appendLine("[ide-browser] debug session ended (tab closed?) — resetting CDP");
        this.cdp.dispose();
        this.onDesignModeChanged?.(this.designMode);
      }
    });
  }

  setWorkspaceResolver(fn: () => WorkspaceShellHandle | undefined): void {
    this.getWorkspace = fn;
  }

  setDesignModeChangedHandler(fn: ((state: DesignModeState) => void) | null): void {
    this.onDesignModeChanged = fn;
  }

  setDesignModeAgent(agent: string): void {
    const name = agent.trim();
    if (name) this.designAgent = name;
  }

  get designMode(): DesignModeState {
    return {
      on: this.cdp.isDesignModeOn,
      agent: this.designAgent,
      lastPick: this.lastPick,
    };
  }

  get running(): boolean {
    return this.server !== null;
  }

  get status(): IdeBrowserStatus {
    return {
      running: this.running,
      cdp: this.cdp.connectionState,
      transport: this.cdp.connectionState === "connected" ? "websocket" : "none",
      url: this.cdp.url,
      endpoint: this.port ? `http://127.0.0.1:${this.port}` : "",
      workspaceRoot: this.workspaceRoot,
      pid: process.pid,
    };
  }

  async start(): Promise<IdeBrowserStatus> {
    if (this.server) return this.status;
    this.token = crypto.randomBytes(16).toString("hex");
    this.server = http.createServer((req, res) => {
      void this.handleHttp(req, res);
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.listen(0, "127.0.0.1", () => resolve());
      this.server!.on("error", reject);
    });
    const addr = this.server.address();
    if (!addr || typeof addr === "string") throw new Error("Failed to bind IDE browser bridge");
    this.port = addr.port;
    await this.writeInstanceFile();
    this.log.appendLine(`[ide-browser] HTTP listening 127.0.0.1:${this.port}`);
    return this.status;
  }

  /** Open/ensure browser and navigate (used by commands and HTTP /navigate). */
  async navigate(url: string): Promise<string> {
    return this.withCdpRecovery(url, async () => {
      await this.ensureBrowser(url);
      await this.cdp.navigate(url);
      return this.cdp.url;
    });
  }

  /**
   * Toggle Design Mode on the live Integrated Browser tab.
   * When on, human clicks yield a pick sent to the configured Tachyon agent.
   */
  async setDesignMode(on: boolean): Promise<DesignModeState> {
    return this.withCdpRecovery(undefined, async () => {
      await this.ensureBrowser();
      await this.cdp.setDesignMode(on, (m) => this.log.appendLine(`[design-mode] ${m}`));
      const state = this.designMode;
      this.onDesignModeChanged?.(state);
      return state;
    });
  }

  async toggleDesignMode(): Promise<DesignModeState> {
    return this.setDesignMode(!this.cdp.isDesignModeOn);
  }

  private async handleDesignPickRaw(rawJson: string): Promise<void> {
    if (this.pickHandling) return;
    this.pickHandling = true;
    try {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(rawJson) as Record<string, unknown>;
      } catch {
        this.log.appendLine("[design-mode] pick JSON parse failed");
        return;
      }
      if (parsed.__cancel === true) {
        this.log.appendLine("[design-mode] cancelled (Esc / Exit)");
        await this.cdp.setDesignMode(false, (m) => this.log.appendLine(`[design-mode] ${m}`));
        this.onDesignModeChanged?.(this.designMode);
        return;
      }

      // Side-panel open/close/resize/pickMode — survive URL changes.
      if (parsed.__layout === "open") {
        this.cdp.setDesignPanelOpen(true);
        if (typeof parsed.panelWidth === "number") this.cdp.setDesignPanelWidth(parsed.panelWidth);
        if (typeof parsed.pickMode === "boolean") this.cdp.setDesignPickMode(parsed.pickMode);
        return;
      }
      if (parsed.__layout === "close") {
        this.cdp.setDesignPanelOpen(false);
        if (typeof parsed.panelWidth === "number") this.cdp.setDesignPanelWidth(parsed.panelWidth);
        if (typeof parsed.pickMode === "boolean") this.cdp.setDesignPickMode(parsed.pickMode);
        return;
      }
      if (parsed.__layout === "resize") {
        if (typeof parsed.panelWidth === "number") this.cdp.setDesignPanelWidth(parsed.panelWidth);
        return;
      }
      if (parsed.__layout === "pickMode") {
        if (typeof parsed.pickMode === "boolean") this.cdp.setDesignPickMode(parsed.pickMode);
        return;
      }

      const isPreview = parsed.__preview === true;
      const isSend = parsed.__send === true;
      // Widget click without Send is preview-only (fills panel). Send button sets __send.
      // Legacy path (no flags) treats as send for back-compat.
      const shouldSend = isSend || (!isPreview && !isSend && parsed.tag);

      const bounds = (parsed.bounds ?? {}) as {
        x?: number;
        y?: number;
        width?: number;
        height?: number;
      };

      const pick = assembleDesignModePick({
        url: typeof parsed.url === "string" ? parsed.url : this.cdp.url,
        tag: typeof parsed.tag === "string" ? parsed.tag : "UNKNOWN",
        id: typeof parsed.id === "string" ? parsed.id : "",
        className: typeof parsed.className === "string" ? parsed.className : "",
        text: typeof parsed.text === "string" ? parsed.text : "",
        html: typeof parsed.html === "string" ? parsed.html : "",
        bounds: {
          x: Number(bounds.x) || 0,
          y: Number(bounds.y) || 0,
          width: Number(bounds.width) || 0,
          height: Number(bounds.height) || 0,
        },
        styles: (parsed.styles && typeof parsed.styles === "object"
          ? parsed.styles
          : {}) as Record<string, string>,
        note: typeof parsed.note === "string" ? parsed.note : undefined,
      });
      this.lastPick = pick;
      this.log.appendLine(
        `[design-mode] ${isPreview ? "preview" : "pick"} <${pick.tag.toLowerCase()}> ${pick.selectorHint}`,
      );

      if (!shouldSend || isPreview) {
        // Selection only — user must hit Send in the in-page panel (no VS Code toast:
        // integrated browser freezes under "Paused due to Notification").
        return;
      }

      let screenshotPath: string | undefined;
      try {
        if (bounds.width && bounds.height) {
          const b64 = await this.cdp.screenshotPngBase64({
            x: Number(bounds.x) || 0,
            y: Number(bounds.y) || 0,
            width: Number(bounds.width) || 1,
            height: Number(bounds.height) || 1,
          });
          screenshotPath = this.writePickScreenshot(b64);
          this.lastPick = { ...pick, screenshotPath };
        }
      } catch (err) {
        this.log.appendLine(
          `[design-mode] element screenshot failed (continuing without): ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      const finalPick = this.lastPick ?? pick;
      const agent = this.designAgent;
      const prompt = formatDesignModePickForAgent(finalPick, { agent });
      this.log.appendLine(
        `[design-mode] SEND → agent ${agent}${screenshotPath ? ` shot=${screenshotPath}` : ""}`,
      );

      const ws = this.getWorkspace?.();
      if (!ws) {
        this.log.appendLine("[design-mode] no Tachyon workspace — pick not delivered");
        // Status bar only — avoid browser-pausing notification overlay.
        return;
      }
      await ws.activity.sendAgentInput(agent, prompt, true);
      this.log.appendLine(`[design-mode] delivered to ${agent}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.appendLine(`[design-mode] handle pick failed: ${msg}`);
      void vscode.window.showErrorMessage(`Design Mode pick failed: ${msg}`);
    } finally {
      this.pickHandling = false;
    }
  }

  private writePickScreenshot(base64Png: string): string {
    const dir = path.join(this.workspaceRoot, ".tachyon", "ide-browser-picks");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const name = `pick-${Date.now()}-${crypto.randomBytes(3).toString("hex")}.png`;
    const file = path.join(dir, name);
    fs.writeFileSync(file, Buffer.from(base64Png, "base64"));
    return file;
  }

  async stop(): Promise<void> {
    await this.resetBrowserSession();
    this.sessionEndSub?.dispose();
    this.sessionEndSub = null;
    await new Promise<void>((resolve) => {
      if (!this.server) {
        resolve();
        return;
      }
      this.server.close(() => resolve());
    });
    this.server = null;
    this.port = 0;
    await this.removeInstanceFile();
    this.log.appendLine("[ide-browser] stopped");
  }

  private async writeInstanceFile(): Promise<void> {
    const dir = path.join(os.homedir(), ".tachyon", IDE_BROWSER_INSTANCES_DIR_NAME);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const id = crypto.createHash("sha256").update(`${this.workspaceRoot}:${process.pid}`).digest("hex").slice(0, 12);
    this.instancePath = path.join(dir, `${id}.json`);
    const body: IdeBrowserInstanceFile = {
      schemaVersion: 1,
      kind: "tachyon-ide-browser",
      workspaceRoot: this.workspaceRoot,
      port: this.port,
      token: this.token,
      pid: process.pid,
      startedAt: new Date().toISOString(),
    };
    fs.writeFileSync(this.instancePath, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
  }

  private async removeInstanceFile(): Promise<void> {
    if (this.instancePath) {
      try {
        fs.unlinkSync(this.instancePath);
      } catch {
        /* ignore */
      }
      this.instancePath = null;
    }
  }

  private authOk(req: http.IncomingMessage): boolean {
    return req.headers["x-tachyon-ide-browser-token"] === this.token;
  }

  private async handleHttp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    const json = (status: number, body: IdeBrowserEnvelope): void => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    try {
      if (url.pathname === "/status" && req.method === "GET") {
        // status is unauthenticated enough for local discovery health? Prefer token.
        if (!this.authOk(req)) {
          json(401, { ok: false, error: "unauthorized" });
          return;
        }
        json(200, { ok: true, data: this.status });
        return;
      }
      if (!this.authOk(req)) {
        json(401, { ok: false, error: "unauthorized" });
        return;
      }

      if (url.pathname === "/navigate" && req.method === "POST") {
        const body = await readJson(req);
        const target = typeof body.url === "string" ? body.url : "";
        if (!target) {
          json(400, { ok: false, error: "url required" });
          return;
        }
        const finalUrl = await this.navigate(target);
        json(200, { ok: true, data: { url: finalUrl } });
        return;
      }

      if (url.pathname === "/eval" && req.method === "POST") {
        const body = await readJson(req);
        const expression = typeof body.expression === "string" ? body.expression : "";
        if (!expression) {
          json(400, { ok: false, error: "expression required" });
          return;
        }
        const value = await this.withCdpRecovery(undefined, async () => {
          await this.ensureBrowser();
          // Prefer Design Mode site iframe when shell is open.
          return this.cdp.evaluateInPage(expression);
        });
        json(200, { ok: true, data: { value } });
        return;
      }

      if (url.pathname === "/screenshot" && req.method === "GET") {
        const data = await this.withCdpRecovery(undefined, async () => {
          await this.ensureBrowser();
          return this.cdp.screenshotPngBase64();
        });
        json(200, { ok: true, data: { mime: "image/png", base64: data, url: this.cdp.url } });
        return;
      }

      if (url.pathname === "/snapshot" && req.method === "GET") {
        const text = await this.withCdpRecovery(undefined, async () => {
          await this.ensureBrowser();
          return this.cdp.snapshotText();
        });
        json(200, { ok: true, data: { text, url: this.cdp.url } });
        return;
      }

      if (url.pathname === "/url" && req.method === "GET") {
        await this.withCdpRecovery(undefined, async () => {
          await this.ensureBrowser();
        });
        json(200, { ok: true, data: { url: this.cdp.url } });
        return;
      }

      if (url.pathname === "/click" && req.method === "POST") {
        const body = await readJson(req);
        const selector = typeof body.selector === "string" ? body.selector : "";
        if (!selector) {
          json(400, { ok: false, error: "selector required" });
          return;
        }
        await this.withCdpRecovery(undefined, async () => {
          await this.ensureBrowser();
          await this.cdp.evaluateInPage(`(() => {
            const el = document.querySelector(${JSON.stringify(selector)});
            if (!el) throw new Error('No element for selector: ' + ${JSON.stringify(selector)});
            el.click();
            return true;
          })()`);
        });
        json(200, { ok: true, data: { clicked: selector } });
        return;
      }

      json(404, { ok: false, error: `unknown route ${url.pathname}` });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.appendLine(`[ide-browser] error: ${message}`);
      json(500, { ok: false, error: message });
    }
  }

  /**
   * Run a CDP operation; if the socket/session died (tab closed), reset and
   * retry once so open/navigate recover without a full bridge restart.
   */
  private async withCdpRecovery<T>(
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

  /** Stop debug session + dispose CDP (HTTP bridge stays up). */
  private async resetBrowserSession(): Promise<void> {
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
    this.onDesignModeChanged?.(this.designMode);
  }

  private async ensureBrowser(initialUrl?: string): Promise<void> {
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

  private async launchBrowser(initialUrl: string): Promise<void> {
    this.log.appendLine(`[ide-browser] launching editor-browser url=${initialUrl}`);

    let childResolve: (s: vscode.DebugSession | null) => void;
    const childPromise = new Promise<vscode.DebugSession | null>((resolve) => {
      childResolve = resolve;
    });
    const timeout = setTimeout(() => childResolve(null), 20_000);
    const sub = vscode.debug.onDidStartDebugSession((session) => {
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
}

function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8") || "{}";
        resolve(JSON.parse(text) as Record<string, unknown>);
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}
