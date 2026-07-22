import http from "node:http";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { handleCompanionHttp, isCompanionPath, type CompanionHttpSurface } from "../companion/CompanionHttp.js";
import { registerTools, type BridgeDeps } from "./tools.js";
import { resolveCaller, type CallerIdentityRegistry, type CallerScope } from "./callerIdentity.js";

export const BRIDGE_PATH = "/mcp";

export const DERIVED_PORT_BASE = 41000;
export const DERIVED_PORT_SPAN = 2000;

/** True when the TCP peer is loopback (IPv4/IPv6 / IPv4-mapped). */
export function isLoopbackRemote(addr: string | undefined): boolean {
  if (!addr) return false;
  if (addr === "127.0.0.1" || addr === "::1") return true;
  if (addr.startsWith("::ffff:127.")) return true; // ::ffff:127.0.0.1
  if (addr === "localhost") return true;
  return false;
}

/**
 * When the Bridge listens beyond loopback, non-loopback peers may only hit companion paths.
 * Pure helper for unit tests + handle().
 */
export function shouldRejectLanNonCompanion(
  listenHost: string,
  remoteAddress: string | undefined,
  urlPath: string,
): boolean {
  if (listenHost === "127.0.0.1") return false;
  if (isLoopbackRemote(remoteAddress)) return false;
  return !isCompanionPath(urlPath);
}

interface BridgeMcpSession {
  transport: StreamableHTTPServerTransport;
  mcp: McpServer;
}

interface BridgeToolState {
  sessions: Set<BridgeMcpSession>;
  signature?: string;
}

const bridgeToolState = ((globalThis as typeof globalThis & { __tachyonBridgeToolState?: BridgeToolState }).__tachyonBridgeToolState ??= { sessions: new Set<BridgeMcpSession>() });

export interface BridgeMetrics {
  requests: number;
  slowRequests: number;
  lastRequestMs: number;
  maxRequestMs: number;
  lastRequestAt?: number;
}

export interface BridgeToolCallInfo {
  tool: string;
  claimedIdentity?: string;
}

export interface BridgeRequestCompleteInfo {
  durationMs: number;
  slow: boolean;
  tool?: string;
  claimedIdentity?: string;
  caller?: BridgeDeps["caller"];
}

/**
 * Stable default port for a workspace: same workspace ⇒ same port forever, so MCP
 * registrations survive editor restarts with zero config. Range 41000–42999;
 * collisions between workspaces are rare and covered by the busy-port fallback
 * plus the explicit `settings.bridgePort` override.
 */
export function derivePort(wsHash: string): number {
  return DERIVED_PORT_BASE + (Number.parseInt(wsHash.slice(0, 4), 16) % DERIVED_PORT_SPAN);
}

/**
 * The Bridge — Tachyon's engine-owned MCP server. Listens on a loopback port for
 * the lifetime of the persistent workspace engine. Stateless streamable-HTTP: each POST gets a
 * fresh transport + McpServer pair, so no session bookkeeping; durable state lives
 * in tmux, not here.
 */
export class Bridge {
  private server?: http.Server;
  private _port?: number;
  private _usedFallback = false;
  /** Actual listen host (127.0.0.1 default; 0.0.0.0 when settings.companion.lanAccess). */
  private _listenHost: string = "127.0.0.1";
  private readonly sessions = new Map<string, BridgeMcpSession>();
  private readonly closingSessions = new Set<string>();
  private metrics: BridgeMetrics = { requests: 0, slowRequests: 0, lastRequestMs: 0, maxRequestMs: 0 };

  constructor(
    private readonly deps: BridgeDeps,
    private readonly options: {
      token?: string;
      /** Dedicated external-client bearer, distinct from the shared/legacy master token. */
      externalToken?: string;
      /** SDD 414 — companion HTTP on the same loopback listener (/companion/v1/*). */
      companion?: CompanionHttpSurface;
      /** spec 351 — lazily reads the digest-only per-agent registry (Workspace loads its HMAC key async,
       *  AFTER constructing the Bridge — a getter, not a value, so the Bridge sees it once it's ready
       *  instead of freezing `undefined` forever). Undefined = agent-token resolution unavailable (falls
       *  straight through to the master/legacy-token check). */
      getRegistry?: () => CallerIdentityRegistry | undefined;
      /** spec 351 — this Bridge's workspace+instance scope, required to resolve/mint against `registry`. */
      scope?: CallerScope;
      /** spec 351 — settings.legacyBridgeAuth; default true (parity — every pre-351 bridge test uses the
       *  shared token and must keep passing under the legacy bypass). */
      legacyCompatEnabled?: boolean;
      /** spec 351 (dueto F1) — every legacy-authenticated call is logged with tool + claimed identity;
       *  wired by Workspace to a durable line, best-effort (never blocks the request). */
      onLegacyCall?: (info: { tool: string; claimedIdentity?: string }) => void;
      onRequestComplete?: (info: BridgeRequestCompleteInfo) => void;
      slowRequestMs?: number;
    } = {},
  ) {}

  get port(): number | undefined {
    return this._port;
  }

  /** Actual engine-owned listener port. */
  get listenerPort(): number | undefined {
    return this._port;
  }

  /** Host passed to `server.listen` (loopback or all-interfaces). */
  get listenHost(): string {
    return this._listenHost;
  }

  /** True when the preferred port was busy and an ephemeral one was used instead. */
  get usedFallback(): boolean {
    return this._usedFallback;
  }

  /**
   * Loopback MCP URL for local runtimes. Even when the socket binds 0.0.0.0 for LAN
   * companion access, agents still connect via 127.0.0.1.
   */
  get url(): string | undefined {
    const port = this.port;
    return port === undefined ? undefined : `http://127.0.0.1:${port}${BRIDGE_PATH}`;
  }

  getMetrics(): BridgeMetrics {
    return { ...this.metrics };
  }

  /** Emits the MCP-standard tool-list change notification to every live Bridge MCP session. */
  announceToolListChanged(): void {
    for (const { mcp } of bridgeToolState.sessions) {
      mcp.sendToolListChanged();
    }
  }

  /**
   * Settings-driven tool catalog change (e.g. settings.companion.tabTools flip).
   * Closes live MCP sessions so the next client request re-runs registerTools with
   * the current deps, then announces tools/list_changed so runtimes re-discover.
   * Pair/unpair alone should NOT call this — tools stay listed when tabTools is on.
   */
  forceToolListRefresh(): void {
    const sessions = [...this.sessions.entries()];
    for (const [id, session] of sessions) {
      void this.closeSession(id, session);
    }
    bridgeToolState.signature = undefined;
    this.announceToolListChanged();
  }

  /**
   * Binds the preferred port when given; falls back to an ephemeral one if it is taken.
   * @param preferredPort preferred TCP port
   * @param opts.host listen host — default `127.0.0.1`; use `0.0.0.0` when
   *   `settings.companion.lanAccess` is true (SDD 422). Companion and MCP share this listener;
   *   MCP still requires agent/bridge auth.
   */
  async start(preferredPort?: number, opts?: { host?: string }): Promise<number> {
    if (this.server) throw new Error("Bridge already started");
    this._usedFallback = false;
    this._listenHost = opts?.host ?? "127.0.0.1";
    const host = this._listenHost;
    const server = http.createServer((req, res) => {
      void this.handle(req, res);
    });
    this.server = server;

    const listen = (port: number) =>
      new Promise<void>((resolve, reject) => {
        const onError = (err: NodeJS.ErrnoException) => reject(err);
        server.once("error", onError);
        server.listen(port, host, () => {
          server.removeListener("error", onError);
          resolve();
        });
      });

    try {
      await listen(preferredPort ?? 0);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (preferredPort !== undefined && (code === "EADDRINUSE" || code === "EACCES")) {
        this._usedFallback = true;
        await listen(0);
      } else {
        throw err;
      }
    }

    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Bridge failed to bind");
    this._port = address.port;
    return this._port;
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const startedAt = Date.now();
    let caller: BridgeDeps["caller"];
    let toolCall: BridgeToolCallInfo | undefined;
    const done = () => {
      const durationMs = Date.now() - startedAt;
      const slow = durationMs >= (this.options.slowRequestMs ?? 10_000);
      this.metrics = {
        requests: this.metrics.requests + 1,
        slowRequests: this.metrics.slowRequests + (slow ? 1 : 0),
        lastRequestMs: durationMs,
        maxRequestMs: Math.max(this.metrics.maxRequestMs, durationMs),
        lastRequestAt: Date.now(),
      };
      this.options.onRequestComplete?.({
        durationMs,
        slow,
        tool: toolCall?.tool,
        claimedIdentity: toolCall?.claimedIdentity,
        caller,
      });
    };
    res.once("finish", done);
    res.once("close", () => {
      if (!res.writableEnded) done();
    });
    const url = (req.url ?? "").split("?")[0] ?? "";
    // SDD 422 — when listening on all interfaces, only /companion/v1 is allowed from
    // non-loopback peers. MCP and other routes stay loopback-only even though the socket
    // is shared (companion-only second port deferred).
    if (shouldRejectLanNonCompanion(this._listenHost, req.socket.remoteAddress, url)) {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error:
            "LAN clients may only use /companion/v1/* when settings.companion.lanAccess is enabled. MCP remains loopback-only.",
        }),
      );
      return;
    }
    // SDD 414 — companion shell uses companion-scoped tokens, not Bridge agent auth.
    if (this.options.companion && isCompanionPath(url)) {
      await handleCompanionHttp(req, res, this.options.companion);
      return;
    }
    if (url !== BRIDGE_PATH) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: `not found — Bridge MCP is ${BRIDGE_PATH}; companion is /companion/v1/*`,
        }),
      );
      return;
    }
    // spec 351 — the caller is resolved EXACTLY ONCE here, at auth time; the resulting immutable snapshot
    // is threaded into this one request's registerTools deps and never re-resolved, so an in-flight
    // request completes on its snapshot even if the underlying token is invalidated mid-request.
    if (this.options.token !== undefined) {
      const auth = req.headers.authorization;
      const bearer = auth?.startsWith("Bearer ") ? auth.slice(7) : undefined;
      const result = resolveCaller({
        bearer,
        registry: this.options.getRegistry?.(),
        scope: this.options.scope ?? { workspaceId: "", instanceId: "" },
        masterToken: this.options.token,
        externalToken: this.options.externalToken,
        legacyCompatEnabled: this.options.legacyCompatEnabled ?? true,
      });
      if (!result.ok) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            error:
              "unauthorized — the Bridge requires 'Authorization: Bearer <token>'. " +
              "Agents spawned by Tachyon get TACHYON_AGENT_BRIDGE_TOKEN injected automatically; " +
              "for external clients use the 'Tachyon: Copy Bridge Token' command.",
            reason: result.reason,
          }),
        );
        return;
      }
      caller = result.snapshot;
    } else {
      // settings.auth: false — the Bridge is fully open. Treated as kind "legacy" (bypass-verbatim): a
      // deliberately-open Bridge has no bearer to resolve identity from at all, so this must behave
      // EXACTLY like the pre-351 unauthenticated Bridge (parity — the main bridge.test.ts suite runs
      // this way).
      caller = { kind: "legacy" };
    }

    try {
      const sessionId = req.headers["mcp-session-id"];
      const existing = typeof sessionId === "string" ? this.sessions.get(sessionId) : undefined;
      if (req.method === "GET" || req.method === "DELETE") {
        if (!existing) {
          res.writeHead(404, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "MCP session not found" }));
          return;
        }
        await existing.transport.handleRequest(req, res);
        return;
      }
      if (req.method !== "POST") {
        res.writeHead(405, { "content-type": "application/json", allow: "GET, POST, DELETE" });
        res.end(JSON.stringify({ error: "method not allowed — Bridge MCP accepts GET, POST, and DELETE" }));
        return;
      }

      const body = await readJsonBody(req);
      toolCall = extractToolCall(body);
      if (caller.kind === "legacy" && this.options.onLegacyCall) {
        const call = toolCall;
        if (call) this.options.onLegacyCall(call);
      }
      if (existing) {
        await existing.transport.handleRequest(req, res, body);
        return;
      }

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        enableJsonResponse: true,
      });
      const { mcp, toolSignature } = this.createMcp(caller);
      this.announceIfToolSetChanged(toolSignature);
      transport.onclose = () => {
        const id = transport.sessionId;
        if (!id) return;
        this.sessions.delete(id);
        if (!this.closingSessions.has(id)) void this.closeSession(id, { transport, mcp });
      };
      await mcp.connect(transport);
      await transport.handleRequest(req, res, body);
      const id = transport.sessionId;
      if (id) {
        const session = { transport, mcp };
        this.sessions.set(id, session);
        bridgeToolState.sessions.add(session);
      }
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(
          JSON.stringify({ error: `bad request: ${err instanceof Error ? err.message : String(err)}` }),
        );
      } else {
        res.end();
      }
    }
  }

  async dispose(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    this._port = undefined;
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(sessions.map((session) => this.closeSession(session.transport.sessionId, session)));
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  private async closeSession(id: string | undefined, session: BridgeMcpSession): Promise<void> {
    if (id) {
      if (this.closingSessions.has(id)) return;
      this.closingSessions.add(id);
      this.sessions.delete(id);
    }
    bridgeToolState.sessions.delete(session);
    try {
      await session.mcp.close();
    } finally {
      if (id) this.closingSessions.delete(id);
    }
  }

  private createMcp(caller: BridgeDeps["caller"]): { mcp: McpServer; toolSignature: string } {
    const mcp = new McpServer({ name: "tachyon-bridge", version: "0.1.0" });
    const toolNames: string[] = [];
    const toolRecorder = mcp as unknown as { registerTool: (name: string, ...args: unknown[]) => unknown };
    const registerTool = toolRecorder.registerTool.bind(mcp);
    toolRecorder.registerTool = (name: string, ...args: unknown[]) => {
      toolNames.push(name);
      return registerTool(name, ...args);
    };
    registerTools(mcp, { ...this.deps, caller, callerRegistry: this.options.getRegistry?.(), callerScope: this.options.scope });
    return { mcp, toolSignature: toolNames.sort().join("\n") };
  }

  private announceIfToolSetChanged(toolSignature: string): void {
    if (bridgeToolState.signature !== undefined && bridgeToolState.signature !== toolSignature) {
      this.announceToolListChanged();
    }
    bridgeToolState.signature = toolSignature;
  }
}

function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (raw.length === 0) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("request body is not valid JSON"));
      }
    });
    req.on("error", reject);
  });
}

/** spec 351 (dueto F1) — best-effort peek at a parsed MCP JSON-RPC body for the legacy-call log: the tool
 *  name plus whichever KNOWN identity-bearing param (if any) the call declared. Never throws on a
 *  malformed/non-tool-call body — logging must not become a new way to break a request. */
const IDENTITY_PARAM_NAMES = ["agent", "parent", "sender", "producer", "caller"] as const;

function extractToolCall(body: unknown): BridgeToolCallInfo | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const b = body as Record<string, unknown>;
  if (b.method !== "tools/call") return undefined;
  const params = b.params as Record<string, unknown> | undefined;
  const name = params?.name;
  if (typeof name !== "string") return undefined;
  const args = params?.arguments as Record<string, unknown> | undefined;
  for (const key of IDENTITY_PARAM_NAMES) {
    const v = args?.[key];
    if (typeof v === "string" && v.length > 0) return { tool: name, claimedIdentity: v };
  }
  return { tool: name };
}
