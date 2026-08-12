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
  formatDesignModePickForAgent,
  type DesignModePickPayload,
} from "./pick.js";
import {
  appendDmChatEvent,
  extractDmChatReplyMarkers,
  formatDmChatPrompt,
  loadDmChatBefore,
  tailDmChat,
  type DmChatEdit,
  type DmChatEvent,
} from "./designModeChat.js";
import {
  matchDmChatReplyToWait,
  mintDmChatTurnId,
  waitPollAgent,
  type DmChatTurnWait,
} from "./designModeChatTurn.js";
import { BrowserSessionController } from "./browserSession.js";
import { IdeBrowserHostServer } from "./hostServer.js";

export type DesignModeState = {
  on: boolean;
  agent: string;
  lastPick: DesignModePickPayload | null;
};

export class IdeBrowserBridgeManager {
  private readonly log: vscode.OutputChannel;
  private readonly workspaceRoot: string;
  private readonly session: BrowserSessionController;
  private readonly host: IdeBrowserHostServer;
  private getWorkspace: (() => WorkspaceShellHandle | undefined) | null = null;
  private designAgent = "grok";
  private lastPick: DesignModePickPayload | null = null;
  private pickHandling = false;
  private onDesignModeChanged: ((state: DesignModeState) => void) | null = null;
  /**
   * Outstanding human-send → agent-reply wait (t-181925 / C-06).
   * Identity is turnId + target agent at send time — not the current UI selection.
   * A single slot is fine; clearing it on any reply was the defect.
   */
  private chatWait: DmChatTurnWait | null = null;
  private chatReplyTimer: ReturnType<typeof setTimeout> | null = null;
  private chatPollTimer: ReturnType<typeof setInterval> | null = null;
  private chatIdleGraceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(workspaceRoot: string, log: vscode.OutputChannel) {
    this.workspaceRoot = path.resolve(workspaceRoot);
    this.log = log;
    this.session = new BrowserSessionController(log);
    this.session.setOnSessionEnded(() => {
      this.onDesignModeChanged?.(this.designMode);
    });
    this.session.cdp.setDesignModePickHandler((raw) => {
      void this.handleDesignPickRaw(raw);
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
      chatReply: async (req: {
        text: string;
        agent?: string;
        turnId?: string;
        edit?: DmChatEdit;
      }) => {
        const result = await this.ingestChatReply(
          req.text,
          "tool",
          req.agent,
          req.turnId,
          req.edit,
        );
        if (!result.ok) return { ok: false as const, error: result.error };
        return { ok: true as const, event: result.event };
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
    if (parsed.__layout === "agents") {
      await this.handleAgentsLayout(parsed);
      return;
    }
    if (parsed.__layout === "chat") {
      await this.handleChatLayout(parsed);
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
      });
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
      }>
      : [];
    return rows
      .filter(
        (r) =>
          r.name
          && (r.kind === undefined || r.kind === "agent")
          && !!r.running
          && !r.dead,
      )
      .map((r) => r.name!)
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b));
  }

  private async pushAgentsToPage(): Promise<void> {
    let agents: string[] = [];
    let emptyReason: string | undefined;
    if (this.cdp.connectionState !== "connected") {
      emptyReason = "Design Mode is disconnected from this page — reopen the IDE Browser.";
    } else {
      try {
        agents = await this.listRunningAgents();
        if (!agents.length) emptyReason = "No agents are running.";
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        emptyReason = `Could not load running agents: ${reason}`;
        this.log.appendLine(`[design-mode] agent list failed: ${reason}`);
      }
    }
    if (agents.length && !agents.includes(this.designAgent)) {
      this.designAgent = agents[0]!;
    }
    await this.cdp.pushDesignModeChat({
      type: "agents",
      agents,
      active: this.designAgent,
      ...(emptyReason ? { emptyReason } : {}),
    });
  }

  private async handleAgentsLayout(parsed: Record<string, unknown>): Promise<void> {
    const action = typeof parsed.action === "string" ? parsed.action : "list";
    if (action === "list") {
      await this.pushAgentsToPage();
      return;
    }
    if (action === "set") {
      const name = typeof parsed.agent === "string" ? parsed.agent.trim() : "";
      if (!name) return;
      const agents = await this.listRunningAgents();
      if (!agents.includes(name)) {
        await this.cdp.pushDesignModeChat({
          type: "error",
          text: `'${name}' is not a running agent — start it first, then select it.`,
        });
        return;
      }
      const from = this.designAgent;
      this.designAgent = name;
      this.onDesignModeChanged?.(this.designMode);
      const ev = await appendDmChatEvent(this.workspaceRoot, {
        kind: "agent_switch",
        from,
        to: name,
        text: `Active agent → ${name}`,
        activeAgent: name,
      });
      await this.cdp.pushDesignModeChat({
        type: "agent_switch",
        event: ev,
        active: name,
      });
      await this.pushAgentsToPage();
      this.log.appendLine(`[design-mode] chat agent ${from} → ${name}`);
    }
  }

  private async hydrateChatTail(limit = 60): Promise<void> {
    const n = Math.min(120, Math.max(10, limit));
    const chunk = tailDmChat(this.workspaceRoot, n);
    this.log.appendLine(
      `[design-mode] chat hydrate tail items=${chunk.items.length} hasMoreBefore=${chunk.hasMoreBefore} file=${path.join(this.workspaceRoot, ".tachyon", "design-mode-chat", "chat.jsonl")}`,
    );
    await this.cdp.pushDesignModeChat({ type: "chunk", mode: "tail", ...chunk });
  }

  private async handleChatLayout(parsed: Record<string, unknown>): Promise<void> {
    const action = typeof parsed.action === "string" ? parsed.action : "";
    if (action === "open") {
      // Always hydrate on open (do not rely on a separate concurrent "tail" post).
      await this.pushAgentsToPage();
      await this.hydrateChatTail(typeof parsed.limit === "number" ? parsed.limit : 60);
      return;
    }
    if (action === "close") {
      return;
    }
    if (action === "tail") {
      await this.hydrateChatTail(Number(parsed.limit) || 60);
      return;
    }
    if (action === "load") {
      const before = Number(parsed.before);
      const limit = Math.min(80, Math.max(10, Number(parsed.limit) || 40));
      if (!Number.isFinite(before)) return;
      const chunk = loadDmChatBefore(this.workspaceRoot, before, limit);
      this.log.appendLine(
        `[design-mode] chat load before=${before} items=${chunk.items.length} hasMoreBefore=${chunk.hasMoreBefore}`,
      );
      await this.cdp.pushDesignModeChat({ type: "chunk", mode: "before", ...chunk });
      return;
    }
    if (action === "openTerminal") {
      try {
        await vscode.commands.executeCommand("tachyon.openAgentTerminalItem", this.designAgent);
        this.log.appendLine(`[design-mode] open terminal → ${this.designAgent}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await this.cdp.pushDesignModeChat({ type: "error", text: `Open terminal failed: ${msg}` });
      }
      return;
    }
    if (action === "send") {
      const text = typeof parsed.text === "string" ? parsed.text.trim() : "";
      if (!text) return;
      await this.sendChatMessage(text);
    }
  }

  /**
   * Sole agent entry point for Design Mode.
   * Optional page selection (`lastPick`) is attached as context; the Selection card never sends.
   */
  private async sendChatMessage(text: string): Promise<void> {
    const ws = this.getWorkspace?.();
    if (!ws) {
      await this.cdp.pushDesignModeChat({
        type: "error",
        text: "No Tachyon workspace — cannot chat.",
      });
      return;
    }
    const agents = await this.listRunningAgents();
    if (!agents.length) {
      await this.cdp.pushDesignModeChat({
        type: "error",
        text: "No running agent — spawn one in the sidebar, then pick it in Design Mode.",
      });
      return;
    }
    if (!agents.includes(this.designAgent)) this.designAgent = agents[0]!;

    const pick = this.lastPick;
    const displayText = pick
      ? `[selection: <${pick.tag.toLowerCase()}> ${pick.selectorHint}]\n${text}`
      : text;

    const pickContext = pick
      ? formatDesignModePickForAgent(pick, { agent: this.designAgent })
      : undefined;

    // Freeze target agent + mint turn id before send so a UI agent switch cannot retarget
    // the in-flight wait, and late replies cannot clear a later turn's wait (t-181925).
    const targetAgent = this.designAgent;
    const turnId = mintDmChatTurnId();
    // Single wire format for free-text and pick+ask turns.
    const prompt = formatDmChatPrompt({
      agent: targetAgent,
      text,
      pageUrl: this.cdp.url,
      workspaceRoot: this.workspaceRoot,
      pickContext,
      turnId,
    });
    const userEv = await appendDmChatEvent(this.workspaceRoot, {
        kind: "message",
        role: "user",
        text: displayText,
        activeAgent: targetAgent,
        delivery: "pending",
    });
    try {
      const attentionAtDelivery = await this.readAgentAttention(targetAgent);
      const receipt = await ws.activity.sendAgentInput(targetAgent, prompt, true);
      const deliveryStatus = receipt.status === "submitted" ? "submitted" : "submit-unconfirmed";
      const deliveryReason = "reason" in receipt ? receipt.reason : receipt.status;
      await appendDmChatEvent(this.workspaceRoot, {
        kind: "delivery",
        messageLineNo: userEv.lineNo,
        status: deliveryStatus,
        reason: deliveryReason,
        activeAgent: targetAgent,
      });
      await this.cdp.pushDesignModeChat({ type: "message", event: { ...userEv, delivery: deliveryStatus } });
      if (receipt.status !== "submitted") {
        await this.pushTyping(false, targetAgent);
        await this.cdp.pushDesignModeChat({
          type: "error",
          text: `Delivery to ${targetAgent} was not confirmed (${deliveryReason}). The message remains saved in Design Mode chat.`,
        });
        return;
      }
      await this.pushTyping(true, targetAgent, "sent");
      this.log.appendLine(
        `[design-mode] chat → ${targetAgent} turn=${turnId}${pick ? " +selection" : ""}: ${text.slice(0, 80)}`,
      );
      // Consume attach after a successful send so the next message is clean unless they re-pick.
      if (pick) {
        this.lastPick = null;
        await this.cdp.pushDesignModeChat({ type: "selection", clear: true, consumed: true });
      }
      const alreadyBusy = attentionAtDelivery.running
        && (attentionAtDelivery.state === "working"
          || attentionAtDelivery.state === "throttled"
          || attentionAtDelivery.state === "needs-input");
      this.beginChatReplyWait(targetAgent, turnId, alreadyBusy);
    } catch (err) {
      this.clearChatReplyWait();
      const msg = err instanceof Error ? err.message : String(err);
      await this.pushTyping(false, targetAgent);
      const draftish = /refused-composer|composer draft/i.test(msg);
      await this.cdp.pushDesignModeChat({
        type: "error",
        text: draftish
          ? `${targetAgent} has a draft in the terminal — clear or submit it, then retry Design Mode chat.`
          : `Send failed: ${msg}`,
      });
    }
  }

  /** Map Tachyon attention to chat typing phase (real agent state, not a timeout guess). */
  private async readAgentAttention(agent: string): Promise<{
    state: "working" | "idle" | "needs-input" | "throttled" | "stopped" | "unknown";
    running: boolean;
  }> {
    const ws = this.getWorkspace?.();
    if (!ws) return { state: "unknown", running: false };

    let running = false;
    try {
      const listed = await ws.extension.query({ action: "agents.list" });
      const rows = Array.isArray(listed)
        ? listed as Array<{ name?: string; running?: boolean; dead?: boolean }>
        : [];
      const row = rows.find((r) => r.name === agent);
      if (row) running = !!row.running && !row.dead;
      if (row && !running) return { state: "stopped", running: false };
    } catch {
      /* ignore */
    }

    // Engine attention monitor (source of truth for working/idle/needs-input/throttled).
    try {
      const attMap = await ws.extension.query({ action: "attention.list" }) as
        | Record<string, { state?: string }>
        | null;
      const st = attMap && typeof attMap === "object" ? attMap[agent]?.state : undefined;
      if (st === "working" || st === "idle" || st === "needs-input" || st === "throttled") {
        return { state: st, running: running || true };
      }
    } catch {
      /* fall through */
    }

    try {
      const att = ws.activity.activityAttention(agent);
      if (att === "working" || att === "idle" || att === "needs-input" || att === "throttled") {
        return { state: att, running: running || true };
      }
    } catch {
      /* ignore */
    }

    try {
      const row = ws.client.presentation.agents.items.find((a) => a.name === agent);
      if (row) {
        const att = row.attention;
        return {
          running: !!row.running,
          state: !row.running
            ? "stopped"
            : att === "working" || att === "idle" || att === "needs-input" || att === "throttled"
              ? att
              : "unknown",
        };
      }
    } catch {
      /* ignore */
    }
    return { state: "unknown", running };
  }

  private async pushTyping(
    on: boolean,
    agent: string,
    phase?: "sent" | "working" | "needs-input" | "throttled" | "idle",
  ): Promise<void> {
    await this.cdp.pushDesignModeChat({
      type: "working",
      on,
      agent,
      phase: phase ?? (on ? "working" : "idle"),
      typing: on, // messenger-style typing indicator
    });
  }

  private beginChatReplyWait(agent: string, turnId: string, alreadyBusyAtDelivery = false): void {
    this.clearChatReplyWait();
    this.chatWait = { turnId, agent, sawBusy: false, awaitPostDeliveryStart: alreadyBusyAtDelivery };
    // Poll real agent attention — never assume "stopped" while still working.
    this.chatPollTimer = setInterval(() => {
      void this.pollChatAgentState();
    }, 900);
    void this.pollChatAgentState();
  }

  private clearChatReplyWait(): void {
    this.chatWait = null;
    if (this.chatReplyTimer) {
      clearTimeout(this.chatReplyTimer);
      this.chatReplyTimer = null;
    }
    if (this.chatPollTimer) {
      clearInterval(this.chatPollTimer);
      this.chatPollTimer = null;
    }
    if (this.chatIdleGraceTimer) {
      clearTimeout(this.chatIdleGraceTimer);
      this.chatIdleGraceTimer = null;
    }
  }

  private async pollChatAgentState(): Promise<void> {
    const wait = this.chatWait;
    if (!wait) return;
    // Poll the agent this turn was sent to — not this.designAgent (agent switch must not retarget).
    const agent = waitPollAgent(wait, this.designAgent) ?? wait.agent;
    const turnId = wait.turnId;
    const { state, running } = await this.readAgentAttention(agent);
    // Wait may have been cleared or superseded while we awaited attention.
    if (!this.chatWait || this.chatWait.turnId !== turnId) return;
    const busy = running && (state === "working" || state === "throttled" || state === "needs-input");

    // A turn that was already busy when delivery happened cannot be this prompt's turn. Observe its
    // end, then require a later non-busy -> busy edge before an idle edge can end this wait.
    if (this.chatWait.awaitPostDeliveryStart) {
      if (!busy) this.chatWait.awaitPostDeliveryStart = false;
      await this.pushTyping(true, agent, "sent");
      return;
    }

    if (busy) {
      this.chatWait.sawBusy = true;
      if (this.chatIdleGraceTimer) {
        clearTimeout(this.chatIdleGraceTimer);
        this.chatIdleGraceTimer = null;
      }
      const phase =
        state === "needs-input" ? "needs-input"
          : state === "throttled" ? "throttled"
            : "working";
      await this.pushTyping(true, agent, phase);
      return;
    }

    // Still waiting for the agent to pick up the turn (not busy yet).
    if (!this.chatWait.sawBusy) {
      await this.pushTyping(true, agent, "sent");
      return;
    }

    // Saw busy, now idle/stopped — wait a short grace for design_mode_chat_reply to land,
    // then surface that the turn ended without a chat reply (do NOT pretend they are still typing).
    if (!this.chatIdleGraceTimer) {
      await this.pushTyping(true, agent, "working"); // brief grace still shows typing
      this.chatIdleGraceTimer = setTimeout(() => {
        this.chatIdleGraceTimer = null;
        void this.onChatTurnEndedWithoutReply(turnId, agent, state, running);
      }, 4_000);
    }
  }

  private async onChatTurnEndedWithoutReply(
    turnId: string,
    agent: string,
    state: string,
    running: boolean,
  ): Promise<void> {
    // Same turn only — a newer send or a matching reply must not get an honest-timeout lie.
    if (!this.chatWait || this.chatWait.turnId !== turnId) return;
    const now = await this.readAgentAttention(agent);
    if (!this.chatWait || this.chatWait.turnId !== turnId) return;
    if (now.running && (now.state === "working" || now.state === "throttled" || now.state === "needs-input")) {
      this.chatWait.sawBusy = true;
      await this.pushTyping(true, agent, now.state === "needs-input" ? "needs-input" : "working");
      return;
    }
    this.clearChatReplyWait();
    const detail = !running
      ? `${agent} is not running`
      : state === "idle"
        ? `${agent} finished the turn without a chat reply`
        : `${agent} is ${state}`;
    const sys = await appendDmChatEvent(this.workspaceRoot, {
      kind: "system",
      text: `${detail}. Call design_mode_chat_reply({ text, turnId: "${turnId}" }) so the panel updates — or open the terminal.`,
      activeAgent: agent,
    });
    await this.pushTyping(false, agent, "idle");
    await this.cdp.pushDesignModeChat({ type: "system", event: sys });
  }

  /**
   * Ingest a plain agent reply from Bridge tool `design_mode_chat_reply`.
   * Happy path is tool-only; marker unwrap is not the product path.
   * Bound to the outstanding wait by host turn id (t-181925 / C-06).
   */
  async ingestChatReply(
    text: string,
    source: "tool" | "markers" | "activity" = "tool",
    agent?: string,
    turnId?: string,
    edit?: DmChatEdit,
  ): Promise<{ ok: true; event: DmChatEvent } | { ok: false; error: string }> {
    const body = text.trim();
    if (!body) return { ok: false, error: "empty reply" };

    const pending = this.chatWait;
    const match = matchDmChatReplyToWait(pending, { turnId, agent });
    if (!match.ok) {
      this.log.appendLine(`[design-mode] chat reply rejected: ${match.error}`);
      return { ok: false, error: match.error };
    }

    // Speaker: wait's agent when resolving a turn; otherwise active Design Mode agent.
    // Optional name only when it matches that bound speaker (ignore spoof / stale names).
    let who = (match.resolvesWait && pending ? pending.agent : this.designAgent).trim() || "agent";
    const claimed = agent?.trim();
    if (claimed && claimed === who) {
      who = claimed;
    } else if (claimed && claimed !== who) {
      this.log.appendLine(
        `[design-mode] chat reply speaker '${claimed}' ignored — using bound '${who}'`,
      );
    }
    // Tool path: plain body. Only unwrap if the entire payload is a clean marker wrap (legacy).
    let plain = body;
    let effectiveSource: "tool" | "markers" | "activity" = source;
    if (source === "tool") {
      const fromMarkers = extractDmChatReplyMarkers(body);
      if (fromMarkers && body.includes(fromMarkers) && body.length <= fromMarkers.length + 80) {
        plain = fromMarkers;
        effectiveSource = "markers";
      }
    } else if (source === "markers") {
      plain = extractDmChatReplyMarkers(body) || body;
      effectiveSource = "markers";
    }
    plain = plain.trim();
    if (!plain || /^(and|or|…|\.\.\.)$/i.test(plain)) {
      return { ok: false, error: "reply empty or instruction residue — ignored" };
    }
    // Strip accidental tool-looking dumps (very rough).
    if (/^\s*\{[\s\S]*"tool_use"/.test(plain) || /^\s*tool_use\b/i.test(plain)) {
      return { ok: false, error: "reply looks like a tool payload — ignored" };
    }
    let normalizedEdit: DmChatEdit | undefined;
    if (edit) {
      const summary = typeof edit.summary === "string" ? edit.summary.trim() : "";
      const patch = typeof edit.patch === "string" ? edit.patch.trim() : "";
      const files = Array.isArray(edit.files)
        ? [...new Set(edit.files.map((file) => String(file).trim()).filter(Boolean))]
        : [];
      if (!summary || summary.length > 1_000) {
        return { ok: false, error: "edit summary required (max 1000 characters)" };
      }
      if (!files.length || files.length > 40 || files.some((file) => file.length > 500)) {
        return { ok: false, error: "edit files required (1-40 workspace-relative paths)" };
      }
      if (!patch || patch.length > 60_000 || !/^diff --git /m.test(patch)) {
        return { ok: false, error: "edit patch must be an exact unified diff with diff --git headers (max 60000 characters)" };
      }
      normalizedEdit = { summary, files, patch };
    }
    const activeAgent = match.resolvesWait && pending ? pending.agent : this.designAgent;
    const reply = plain.slice(0, 12_000);
    const ev = normalizedEdit
      ? await appendDmChatEvent(this.workspaceRoot, {
        kind: "edit",
        role: "agent",
        agent: who,
        reply,
        text: [
          reply,
          "",
          `Changed: ${normalizedEdit.summary}`,
          `Files: ${normalizedEdit.files.join(", ")}`,
          "",
          normalizedEdit.patch,
        ].join("\n"),
        ...normalizedEdit,
        activeAgent,
        source: effectiveSource,
      })
      : await appendDmChatEvent(this.workspaceRoot, {
        kind: "message",
        role: "agent",
        agent: who,
        text: reply,
        activeAgent,
        source: effectiveSource,
      });
    if (match.resolvesWait) {
      this.clearChatReplyWait();
    }
    try {
      await this.pushTyping(false, who, "idle");
      await this.cdp.pushDesignModeChat({ type: "message", event: ev });
    } catch (err) {
      this.log.appendLine(
        `[design-mode] push chat reply failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    this.log.appendLine(
      `[design-mode] chat reply ← ${who} (${effectiveSource})${turnId ? ` turn=${turnId}` : ""}`,
    );
    return { ok: true, event: ev };
  }

  async stop(): Promise<void> {
    await this.session.resetBrowserSession();
    this.session.dispose();
    await this.host.stop();
    this.log.appendLine("[ide-browser] stopped");
  }
}
