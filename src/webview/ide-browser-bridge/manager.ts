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
import { sweepDeadIdeBrowserInstances } from "../../ide-browser/client.js";
import { IdeBrowserCdpSession, isBrowserDebugSession } from "./cdpSession.js";
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
  type DmChatEvent,
} from "./designModeChat.js";

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
  private chatPending = false;
  /** Agent observed as busy (working/throttled/needs-input) at least once this wait. */
  private chatSawBusy = false;
  private chatReplyTimer: ReturnType<typeof setTimeout> | null = null;
  private chatPollTimer: ReturnType<typeof setInterval> | null = null;
  private chatIdleGraceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(workspaceRoot: string, log: vscode.OutputChannel) {
    this.workspaceRoot = path.resolve(workspaceRoot);
    this.log = log;
    this.cdp.setDesignModePickHandler((raw) => {
      void this.handleDesignPickRaw(raw);
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
    // Tools are always-registered when ideBrowserRequest is wired — do not forceToolListRefresh
    // here (that closes every live MCP session and drops unrelated agent turns mid-call).
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
   * Running agents only (saved roster, not Temporary/terminals).
   * Design Mode v1 is single-agent: human chats with one live peer.
   */
  private async listRunningAgents(): Promise<string[]> {
    const ws = this.getWorkspace?.();
    if (!ws) return [];
    try {
      const listed = await ws.extension.query({ action: "agents.list" });
      const rows = Array.isArray(listed)
        ? listed as Array<{
          name?: string;
          kind?: string;
          temporary?: boolean;
          running?: boolean;
          dead?: boolean;
        }>
        : [];
      return rows
        .filter(
          (r) =>
            r.name
            && (r.kind === undefined || r.kind === "agent")
            && !r.temporary
            && !!r.running
            && !r.dead,
        )
        .map((r) => r.name!)
        .filter(Boolean)
        .sort((a, b) => a.localeCompare(b));
    } catch {
      return [];
    }
  }

  private async pushAgentsToPage(): Promise<void> {
    const agents = await this.listRunningAgents();
    if (agents.length && !agents.includes(this.designAgent)) {
      this.designAgent = agents[0]!;
    }
    await this.cdp.pushDesignModeChat({
      type: "agents",
      agents,
      active: this.designAgent,
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
      const ev = appendDmChatEvent(this.workspaceRoot, {
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

    const userEv = appendDmChatEvent(this.workspaceRoot, {
      kind: "message",
      role: "user",
      text: displayText,
      activeAgent: this.designAgent,
    });
    await this.cdp.pushDesignModeChat({ type: "message", event: userEv });
    await this.pushTyping(true, this.designAgent, "sent");

    const pickContext = pick
      ? formatDesignModePickForAgent(pick, { agent: this.designAgent })
      : undefined;

    // Single wire format for free-text and pick+ask turns.
    const prompt = formatDmChatPrompt({
      agent: this.designAgent,
      text,
      pageUrl: this.cdp.url,
      workspaceRoot: this.workspaceRoot,
      pickContext,
    });
    try {
      await ws.activity.sendAgentInput(this.designAgent, prompt, true);
      this.log.appendLine(
        `[design-mode] chat → ${this.designAgent}${pick ? " +selection" : ""}: ${text.slice(0, 80)}`,
      );
      // Consume attach after a successful send so the next message is clean unless they re-pick.
      if (pick) {
        this.lastPick = null;
        await this.cdp.pushDesignModeChat({ type: "selection", clear: true, consumed: true });
      }
      this.beginChatReplyWait();
    } catch (err) {
      this.clearChatReplyWait();
      const msg = err instanceof Error ? err.message : String(err);
      await this.pushTyping(false, this.designAgent);
      await this.cdp.pushDesignModeChat({ type: "error", text: `Send failed: ${msg}` });
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

  private beginChatReplyWait(): void {
    this.clearChatReplyWait();
    this.chatPending = true;
    this.chatSawBusy = false;
    // Poll real agent attention — never assume "stopped" while still working.
    this.chatPollTimer = setInterval(() => {
      void this.pollChatAgentState();
    }, 900);
    void this.pollChatAgentState();
  }

  private clearChatReplyWait(): void {
    this.chatPending = false;
    this.chatSawBusy = false;
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
    if (!this.chatPending) return;
    const agent = this.designAgent;
    const { state, running } = await this.readAgentAttention(agent);
    const busy = running && (state === "working" || state === "throttled" || state === "needs-input");

    if (busy) {
      this.chatSawBusy = true;
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
    if (!this.chatSawBusy) {
      await this.pushTyping(true, agent, "sent");
      return;
    }

    // Saw busy, now idle/stopped — wait a short grace for design_mode_chat_reply to land,
    // then surface that the turn ended without a chat reply (do NOT pretend they are still typing).
    if (!this.chatIdleGraceTimer) {
      await this.pushTyping(true, agent, "working"); // brief grace still shows typing
      this.chatIdleGraceTimer = setTimeout(() => {
        this.chatIdleGraceTimer = null;
        void this.onChatTurnEndedWithoutReply(agent, state, running);
      }, 4_000);
    }
  }

  private async onChatTurnEndedWithoutReply(
    agent: string,
    state: string,
    running: boolean,
  ): Promise<void> {
    if (!this.chatPending) return;
    const now = await this.readAgentAttention(agent);
    if (now.running && (now.state === "working" || now.state === "throttled" || now.state === "needs-input")) {
      this.chatSawBusy = true;
      await this.pushTyping(true, agent, now.state === "needs-input" ? "needs-input" : "working");
      return;
    }
    this.clearChatReplyWait();
    const detail = !running
      ? `${agent} is not running`
      : state === "idle"
        ? `${agent} finished the turn without a chat reply`
        : `${agent} is ${state}`;
    const sys = appendDmChatEvent(this.workspaceRoot, {
      kind: "system",
      text: `${detail}. Call design_mode_chat_reply({ text }) so the panel updates — or open the terminal.`,
      activeAgent: agent,
    });
    await this.pushTyping(false, agent, "idle");
    await this.cdp.pushDesignModeChat({ type: "system", event: sys });
  }

  /**
   * Ingest a plain agent reply from Bridge tool `design_mode_chat_reply`.
   * Happy path is tool-only; marker unwrap is not the product path.
   */
  async ingestChatReply(
    text: string,
    source: "tool" | "markers" | "activity" = "tool",
    agent?: string,
  ): Promise<{ ok: true; event: DmChatEvent } | { ok: false; error: string }> {
    const body = text.trim();
    if (!body) return { ok: false, error: "empty reply" };
    // Prefer active Design Mode agent; optional name only when it matches a known running peer
    // (ignore spoof / stale names from the tool param).
    let who = this.designAgent.trim() || "agent";
    const claimed = agent?.trim();
    if (claimed && claimed === who) {
      who = claimed;
    } else if (claimed && claimed !== who) {
      this.log.appendLine(
        `[design-mode] chat reply speaker '${claimed}' ignored — using active '${who}'`,
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
    const ev = appendDmChatEvent(this.workspaceRoot, {
      kind: "message",
      role: "agent",
      agent: who,
      text: plain.slice(0, 12_000),
      activeAgent: this.designAgent,
      source: effectiveSource,
    });
    this.clearChatReplyWait();
    try {
      await this.pushTyping(false, who, "idle");
      await this.cdp.pushDesignModeChat({ type: "message", event: ev });
    } catch (err) {
      this.log.appendLine(
        `[design-mode] push chat reply failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    this.log.appendLine(`[design-mode] chat reply ← ${who} (${effectiveSource})`);
    return { ok: true, event: ev };
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
    // Prefer passwd home so a redirected $HOME (private runtime) never scatters instance files.
    let home = os.homedir();
    try {
      const u = os.userInfo().homedir;
      if (u) home = u;
    } catch {
      /* keep os.homedir() */
    }
    const dir = path.join(home, ".tachyon", IDE_BROWSER_INSTANCES_DIR_NAME);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    // Drop orphan discovery files so agents/engine don't scan dozens of dead pids.
    const n = sweepDeadIdeBrowserInstances();
    if (n > 0) this.log.appendLine(`[ide-browser] swept ${n} dead instance file(s)`);
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

      if (url.pathname === "/design-mode/chat-reply" && req.method === "POST") {
        const body = await readJson(req);
        const text = typeof body.text === "string" ? body.text : "";
        const agent = typeof body.agent === "string" ? body.agent : undefined;
        const result = await this.ingestChatReply(text, "tool", agent);
        if (!result.ok) {
          json(400, { ok: false, error: result.error });
          return;
        }
        json(200, { ok: true, data: { event: result.event } });
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
