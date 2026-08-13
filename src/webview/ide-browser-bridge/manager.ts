/**
 * IDE Integrated Browser bridge manager (thimo-style debug-session path).
 *
 * Composition root (t-47503a / AR-02):
 * - IdeBrowserHostServer — HTTP + instance discovery + typed route dispatch
 * - BrowserSessionController — editor-browser launch + CDP recovery
 * - IdeBrowserCdpSession (via controller) — wire protocol to the tab
 * - this class — Design Mode pick/chat/agent orchestration (UI adapter)
 *
 * Zero behavior change vs pre-split manager: same public API, same side effects.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import type { WorkspaceShellHandle } from "../../shell/WorkspaceShellHandle.js";
import type { IdeBrowserStatus } from "../../ide-browser/protocol.js";
import {
  assembleDesignModePick,
  type DesignModePickPayload,
} from "./pick.js";
import { BrowserSessionController } from "./browserSession.js";
import { IdeBrowserHostServer } from "./hostServer.js";
import { loadDesignModeOverlayBundle } from "./designModeInject.js";

export type DesignModeState = {
  on: boolean;
  agent: string;
  lastPick: DesignModePickPayload | null;
};

const DESIGN_ANNOTATION_MAX_COUNT = 20;
const DESIGN_ANNOTATION_SCREENSHOT_MAX_BYTES = 2 * 1024 * 1024;
const DESIGN_ANNOTATION_SCREENSHOT_BATCH_MAX_BYTES = 8 * 1024 * 1024;
type DesignModeViewportPreset = "phone" | "tablet" | "desktop" | "reset";

export function formatDesignAnnotationBatch(annotations: Array<Record<string, unknown> & { index: number }>): string {
  const first = annotations[0] as { page?: { url?: string } } | undefined;
  const lines = [`## Design Feedback: ${first?.page?.url || "current page"}`, ""];
  for (const annotation of annotations) {
    const target = annotation.target as Record<string, unknown> | undefined;
    lines.push(`### ${annotation.index}. ${String(annotation.intent || "change")}: ${String(target?.selector || target?.tag || "element")}`);
    lines.push(String(annotation.comment || ""));
    if (annotation.screenshotPath) lines.push(`Screenshot: ${String(annotation.screenshotPath)}`);
    if (target?.text) lines.push(`Text: ${String(target.text)}`);
    if (target?.html) lines.push(`HTML: ${String(target.html)}`);
    if (target?.bounds) lines.push(`Bounds: ${JSON.stringify(target.bounds)}`);
    lines.push("");
  }
  return lines.join("\n").trim();
}

export class IdeBrowserBridgeManager {
  private readonly log: vscode.OutputChannel;
  private readonly workspaceRoot: string;
  private readonly session: BrowserSessionController;
  private readonly host: IdeBrowserHostServer;
  private getWorkspace: (() => WorkspaceShellHandle | undefined) | null = null;
  private designAgent = "grok";
  private lastPick: DesignModePickPayload | null = null;
  private designAnnotations: Array<Record<string, unknown> & { index: number }> = [];
  private nextDesignAnnotationIndex = 1;
  private designViewportPreset: DesignModeViewportPreset = "reset";
  private pickHandling = false;
  private onDesignModeChanged: ((state: DesignModeState) => void) | null = null;

  constructor(workspaceRoot: string, log: vscode.OutputChannel, extensionRoot?: string) {
    this.workspaceRoot = path.resolve(workspaceRoot);
    this.log = log;
    let overlayBundle: string | undefined;
    this.session = new BrowserSessionController(log, extensionRoot ? () => overlayBundle ??= loadDesignModeOverlayBundle(extensionRoot) : undefined);
    this.session.setOnSessionEnded(() => {
      this.onDesignModeChanged?.(this.designMode);
    });
    this.session.cdp.setDesignModePickHandler((raw) => {
      void this.handleDesignPickRaw(raw);
    });
    this.session.cdp.setDesignModeInvalidatedHandler(() => {
      this.onDesignModeChanged?.(this.designMode);
    });
    this.host = new IdeBrowserHostServer({
      workspaceRoot: this.workspaceRoot,
      log,
      handlers: this.buildHostHandlers(),
    });
  }

  private get cdp() {
    return this.session.cdp;
  }

  private buildHostHandlers() {
    return {
      getStatus: () => this.status,
      navigate: async (url: string) => ({ url: await this.navigate(url) }),
      eval: async (expression: string) => {
        const value = await this.session.withCdpRecovery(undefined, async () => {
          await this.session.ensureBrowser();
          return this.cdp.evaluateInPage(expression);
        });
        return { value };
      },
      screenshot: async () => {
        const data = await this.session.withCdpRecovery(undefined, async () => {
          await this.session.ensureBrowser();
          return this.cdp.screenshotPngBase64();
        });
        return { mime: "image/png" as const, base64: data, url: this.cdp.url };
      },
      snapshot: async () => {
        const text = await this.session.withCdpRecovery(undefined, async () => {
          await this.session.ensureBrowser();
          return this.cdp.snapshotText();
        });
        return { text, url: this.cdp.url };
      },
      currentUrl: async () => {
        await this.session.withCdpRecovery(undefined, async () => {
          await this.session.ensureBrowser();
        });
        return { url: this.cdp.url };
      },
      click: async (selector: string) => {
        await this.session.withCdpRecovery(undefined, async () => {
          await this.session.ensureBrowser();
          await this.cdp.evaluateInPage(`(() => {
            const el = document.querySelector(${JSON.stringify(selector)});
            if (!el) throw new Error('No element for selector: ' + ${JSON.stringify(selector)});
            el.click();
            return true;
          })()`);
        });
        return { clicked: selector };
      },
    };
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
    return this.host.running;
  }

  get status(): IdeBrowserStatus {
    return {
      running: this.running,
      cdp: this.cdp.connectionState,
      transport: this.cdp.connectionState === "connected" ? "websocket" : "none",
      url: this.cdp.url,
      endpoint: this.host.endpoint,
      workspaceRoot: this.workspaceRoot,
      pid: process.pid,
    };
  }

  async start(): Promise<IdeBrowserStatus> {
    if (this.host.running) return this.status;
    // Re-bind handlers in case methods were replaced in tests.
    this.host.setHandlers(this.buildHostHandlers());
    await this.host.start();
    // Tools are always-registered when ideBrowserRequest is wired — do not forceToolListRefresh
    // here (that closes every live MCP session and drops unrelated agent turns mid-call).
    return this.status;
  }

  /** Open/ensure browser and navigate (used by commands and HTTP /navigate). */
  async navigate(url: string): Promise<string> {
    return this.session.navigate(url);
  }

  /**
   * Toggle Design Mode on the live Integrated Browser tab.
   * When on, human clicks yield a pick sent to the configured Tachyon agent.
   */
  async setDesignMode(on: boolean): Promise<DesignModeState> {
    return this.session.withCdpRecovery(undefined, async () => {
      await this.session.ensureBrowser();
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
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(rawJson) as Record<string, unknown>;
    } catch {
      this.log.appendLine("[design-mode] pick JSON parse failed");
      return;
    }

    if (parsed.__annotation === "sync") {
      await this.pushDesignAnnotationsToPage();
      return;
    }
    if (parsed.__annotation === "agents") {
      await this.pushAnnotationAgentsToPage();
      return;
    }
    if (parsed.__annotation === "delete") {
      const index = Number(parsed.index);
      if (Number.isInteger(index)) {
        this.cleanupAnnotationScreenshots(this.designAnnotations.filter((annotation) => annotation.index === index));
        this.designAnnotations = this.designAnnotations.filter((annotation) => annotation.index !== index);
        await this.pushDesignAnnotationsToPage();
      }
      return;
    }
    if (parsed.__annotation === "add") {
      const intent = parsed.intent === "question" ? "question" : parsed.intent === "change" ? "change" : null;
      const comment = typeof parsed.comment === "string" ? parsed.comment.trim().slice(0, 4_000) : "";
      const capture = parsed.capture && typeof parsed.capture === "object" ? parsed.capture as Record<string, unknown> : null;
      // The durable batch is textual/structural. A pick PNG is momentary context and
      // must never hitch a ride in this object (Orca's measured memory boundary).
      if (intent && comment && capture && JSON.stringify(capture).length <= 80_000 && this.designAnnotations.length < DESIGN_ANNOTATION_MAX_COUNT) {
        const annotation = JSON.parse(JSON.stringify(capture, (key, value) => key === "screenshot" || key === "screenshotPath" ? undefined : value)) as Record<string, unknown>;
        let screenshotPath: string | undefined;
        const target = annotation.target as { bounds?: { x?: number; y?: number; width?: number; height?: number } } | undefined;
        const bounds = target?.bounds;
        try {
          if (bounds && Number(bounds.width) > 0 && Number(bounds.height) > 0) {
            const png = await this.cdp.screenshotPngBase64({ x: Number(bounds.x) || 0, y: Number(bounds.y) || 0, width: Number(bounds.width), height: Number(bounds.height) });
            const bytes = Buffer.from(png, "base64").byteLength;
            const batchBytes = this.annotationScreenshotBytes();
            if (bytes <= DESIGN_ANNOTATION_SCREENSHOT_MAX_BYTES && batchBytes + bytes <= DESIGN_ANNOTATION_SCREENSHOT_BATCH_MAX_BYTES) screenshotPath = this.writePickScreenshot(png);
            else this.log.appendLine(`[design-mode] annotation screenshot omitted by budget bytes=${bytes} batch=${batchBytes}`);
          }
        } catch (err) {
          this.log.appendLine(`[design-mode] annotation screenshot failed (continuing without): ${err instanceof Error ? err.message : String(err)}`);
        }
        this.designAnnotations.push({ ...annotation, index: this.nextDesignAnnotationIndex++, intent, comment, ...(screenshotPath ? { screenshotPath } : {}) });
        await this.pushDesignAnnotationsToPage();
      }
      return;
    }
    if (parsed.action === "annotation.send") {
      await this.sendDesignAnnotations(typeof parsed.targetAgent === "string" ? parsed.targetAgent.trim() : "");
      return;
    }
    if (parsed.action === "annotation.clear") {
      this.clearDesignAnnotations();
      await this.pushDesignAnnotationsToPage();
      return;
    }
    if (parsed.action === "viewport.sync") {
      await this.pushAnnotationState("__tachyonDmApplyViewportState", { preset: this.designViewportPreset, status: "idle" });
      return;
    }
    if (parsed.action === "viewport.set") {
      const preset = parsed.preset;
      if (preset === "phone" || preset === "tablet" || preset === "desktop" || preset === "reset") {
        try {
          await this.cdp.setResponsivePreset(preset, (m) => this.log.appendLine(`[design-mode] ${m}`));
          this.designViewportPreset = preset;
          await this.pushAnnotationState("__tachyonDmApplyViewportState", { preset, status: "success" });
        } catch (err) {
          await this.pushAnnotationState("__tachyonDmApplyViewportState", { preset: this.designViewportPreset, status: "error", text: err instanceof Error ? err.message : String(err) });
        }
      }
      return;
    }

    // Layout / chat / agents must NEVER share the pickHandling lock — concurrent posts
    // (open + tail + agents.list) used to drop the hydrate tail silently.
    if (parsed.__cancel === true) {
      this.log.appendLine("[design-mode] cancelled (Esc / Exit)");
      await this.cdp.setDesignMode(false, (m) => this.log.appendLine(`[design-mode] ${m}`));
      this.onDesignModeChanged?.(this.designMode);
      return;
    }
    if (parsed.__layout === "pickMode") {
      if (typeof parsed.pickMode === "boolean") this.cdp.setDesignPickMode(parsed.pickMode);
      return;
    }
    if (parsed.__layout === "responsive") {
      const preset = parsed.preset;
      if (
        preset === "phone"
        || preset === "tablet"
        || preset === "desktop"
        || preset === "reset"
      ) {
        try {
          await this.cdp.setResponsivePreset(preset, (m) => this.log.appendLine(`[design-mode] ${m}`));
        } catch (err) {
          this.log.appendLine(
            `[design-mode] responsive ${String(preset)} failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      return;
    }
    if (parsed.__layout === "internalNav") {
      this.cdp.markInternalNavigation();
      return;
    }

    // Real pick path — **never** calls the agent. Selection is context only; chat is the sole send channel.
    if (this.pickHandling) return;
    this.pickHandling = true;
    try {
      // Clear attach request from chat UI (chip ×).
      if (parsed.__clearSelection === true) {
        this.lastPick = null;
        await this.cdp.pushDesignModeChat({ type: "selection", clear: true });
        this.log.appendLine("[design-mode] selection cleared");
        return;
      }

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
      });

      // Best-effort crop for later chat turn (attach, not auto-send).
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
        }
      } catch (err) {
        this.log.appendLine(
          `[design-mode] element screenshot failed (continuing without): ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      this.lastPick = screenshotPath ? { ...pick, screenshotPath } : pick;
      this.log.appendLine(
        `[design-mode] selection attached <${pick.tag.toLowerCase()}> ${pick.selectorHint}`
        + (screenshotPath ? ` shot=${screenshotPath}` : ""),
      );

      // Push chip to chat + open chat — human types the ask there (single channel).
      await this.cdp.pushDesignModeChat({
        type: "selection",
        attached: true,
        summary: `<${pick.tag.toLowerCase()}> ${pick.selectorHint}`.trim(),
        tag: pick.tag,
        selectorHint: pick.selectorHint,
        text: pick.text.slice(0, 80),
        screenshotPath,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.appendLine(`[design-mode] handle pick failed: ${msg}`);
      void vscode.window.showErrorMessage(`Design Mode pick failed: ${msg}`);
    } finally {
      this.pickHandling = false;
    }
  }

  private async pushDesignAnnotationsToPage(): Promise<void> {
    const annotations = this.designAnnotations.map((annotation) => {
      const screenshotPath = typeof annotation.screenshotPath === "string" ? annotation.screenshotPath : undefined;
      let screenshotPreview: string | undefined;
      if (screenshotPath) {
        try {
          const bytes = fs.readFileSync(screenshotPath);
          if (bytes.byteLength <= DESIGN_ANNOTATION_SCREENSHOT_MAX_BYTES) screenshotPreview = `data:image/png;base64,${bytes.toString("base64")}`;
        } catch { /* A missing optional preview never invalidates textual feedback. */ }
      }
      return { ...annotation, ...(screenshotPreview ? { screenshotPreview } : {}) };
    });
    const state = JSON.stringify(annotations).replace(/</g, "\\u003c");
    try {
      await this.cdp.evaluateInPage(`typeof window.__tachyonDmApplyAnnotationState === 'function' && window.__tachyonDmApplyAnnotationState(${state})`);
    } catch {
      /* Navigation can race the ack; mount requests sync again after re-inject. */
    }
  }

  private async pushAnnotationState(functionName: string, value: unknown): Promise<void> {
    const state = JSON.stringify(value).replace(/</g, "\\u003c");
    try { await this.cdp.evaluateInPage(`typeof window.${functionName} === 'function' && window.${functionName}(${state})`); } catch { /* navigation races are recovered by mount sync */ }
  }

  private async pushAnnotationAgentsToPage(): Promise<void> {
    try {
      const agents = await this.listRunningAgents();
      await this.pushAnnotationState("__tachyonDmApplyAgentState", { agents, active: agents.includes(this.designAgent) ? this.designAgent : agents[0], ...(!agents.length ? { emptyReason: "No agents are running." } : {}) });
    } catch (err) {
      await this.pushAnnotationState("__tachyonDmApplyAgentState", { agents: [], emptyReason: `Could not load running agents: ${err instanceof Error ? err.message : String(err)}` });
    }
  }

  private async sendDesignAnnotations(targetAgent: string): Promise<void> {
    const preserve = async (text: string) => this.pushAnnotationState("__tachyonDmApplySendState", { status: "error", text });
    if (!this.designAnnotations.length) return preserve("There are no annotations to send.");
    if (!targetAgent) return preserve("Choose a running agent.");
    const ws = this.getWorkspace?.();
    if (!ws) return preserve("Tachyon workspace is not connected.");
    try {
      const agents = await this.listRunningAgents();
      if (!agents.includes(targetAgent)) return preserve(`Agent '${targetAgent}' is no longer available. Refresh the roster and choose another agent.`);
      const prompt = formatDesignAnnotationBatch(this.designAnnotations);
      const receipt = await ws.activity.sendAgentInput(targetAgent, prompt, true);
      const reason = "reason" in receipt ? receipt.reason : receipt.status;
      if (receipt.status !== "submitted") return preserve(`Delivery to ${targetAgent} was not confirmed (${reason}). Your annotations were preserved.`);
      this.clearDesignAnnotations();
      this.designAgent = targetAgent;
      await this.pushDesignAnnotationsToPage();
      await this.pushAnnotationState("__tachyonDmApplySendState", { status: "sent", text: `Sent to ${targetAgent}.` });
      this.log.appendLine(`[design-mode] annotation batch → ${targetAgent} receipt=submitted`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const composer = /refused-composer|composer draft/i.test(message);
      await preserve(composer ? `${targetAgent} has a draft in the terminal. Clear or submit it, then retry; your annotations were preserved.` : `Send failed: ${message}. Your annotations were preserved.`);
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

  private annotationScreenshotBytes(): number {
    return this.designAnnotations.reduce((total, annotation) => {
      if (typeof annotation.screenshotPath !== "string") return total;
      try { return total + fs.statSync(annotation.screenshotPath).size; } catch { return total; }
    }, 0);
  }

  private cleanupAnnotationScreenshots(annotations: Array<Record<string, unknown>>): void {
    const root = path.join(this.workspaceRoot, ".tachyon", "ide-browser-picks") + path.sep;
    for (const annotation of annotations) {
      if (typeof annotation.screenshotPath !== "string") continue;
      const file = path.resolve(annotation.screenshotPath);
      if (file.startsWith(root)) try { fs.unlinkSync(file); } catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") this.log.appendLine(`[design-mode] screenshot cleanup failed: ${err instanceof Error ? err.message : String(err)}`); }
    }
  }

  private clearDesignAnnotations(): void {
    this.cleanupAnnotationScreenshots(this.designAnnotations);
    this.designAnnotations = [];
    this.nextDesignAnnotationIndex = 1;
  }

  /**
   * Running runtime agents only (Saved and Temporary; terminals excluded).
   * Design Mode v1 is single-agent: human chats with one live peer.
   */
  private async listRunningAgents(): Promise<string[]> {
    const ws = this.getWorkspace?.();
    if (!ws) throw new Error("Tachyon workspace is not connected");
    const listed = await ws.extension.query({ action: "agents.list" });
    const rows = Array.isArray(listed)
      ? listed as Array<{
        name?: string;
        kind?: string;
        running?: boolean;
        dead?: boolean;
        stopping?: boolean;
      }>
      : [];
    return rows
      .filter(
        (r) =>
          r.name
          && (r.kind === undefined || r.kind === "agent")
          && !!r.running
          && !r.dead
          && !r.stopping,
      )
      .map((r) => r.name!)
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b));
  }
  async stop(): Promise<void> {
    await this.session.resetBrowserSession();
    this.session.dispose();
    await this.host.stop();
    this.log.appendLine("[ide-browser] stopped");
  }
}
