/**
 * Companion live state fan-out (SDD 414).
 * SSE clients on GET /companion/v1/events receive full state snapshots
 * when agents/attention change — no UI polling.
 */

import type http from "node:http";
import type { CompanionAgentRow, CompanionLiveState, ConnectionStatus } from "./protocol.js";

export type { CompanionLiveState };
export interface CompanionLiveSyncOptions {
  /** Status for the requesting session token. */
  statusOf: (sessionToken: string) => ConnectionStatus;
  /** Current running-agent rows for the companion UI. */
  listAgents: () => Promise<CompanionAgentRow[]>;
  /** Heartbeat interval (ms). Default 20s. */
  heartbeatMs?: number;
  /** Debounce coalescing for rapid attention churn (ms). Default 75. */
  debounceMs?: number;
  now?: () => number;
}

interface Client {
  res: http.ServerResponse;
  token: string;
  /** Last seq successfully written to this client. */
  lastSeq: number;
}

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, content-type",
};

function writeSse(res: http.ServerResponse, event: string, data: unknown): boolean {
  if (res.writableEnded || res.destroyed) return false;
  try {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    return true;
  } catch {
    return false;
  }
}

export class CompanionLiveSync {
  private readonly clients = new Set<Client>();
  private seq = 0;
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private readonly heartbeatMs: number;
  private readonly debounceMs: number;
  private readonly now: () => number;

  constructor(private readonly options: CompanionLiveSyncOptions) {
    this.heartbeatMs = options.heartbeatMs ?? 20_000;
    this.debounceMs = options.debounceMs ?? 75;
    this.now = options.now ?? Date.now;
  }

  /** Number of open SSE clients (tests / diagnostics). */
  get clientCount(): number {
    return this.clients.size;
  }

  /** True when at least one SSE subscriber is attached for this session token. */
  hasLiveClient(sessionToken: string): boolean {
    for (const c of this.clients) {
      if (c.token === sessionToken) return true;
    }
    return false;
  }

  /**
   * Attach an authenticated HTTP response as an SSE subscriber.
   * Sends an immediate snapshot, then keeps the connection open.
   */
  async attach(req: http.IncomingMessage, res: http.ServerResponse, sessionToken: string): Promise<void> {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      ...CORS,
    });
    // Encourage proxies / runtimes to flush headers.
    res.write(": companion-live\n\n");

    const client: Client = { res, token: sessionToken, lastSeq: 0 };
    this.clients.add(client);
    this.ensureHeartbeat();

    const drop = () => {
      this.clients.delete(client);
      if (this.clients.size === 0) this.stopHeartbeat();
    };
    req.on("close", drop);
    res.on("close", drop);
    res.on("error", drop);

    const snap = await this.buildSnapshot(sessionToken);
    if (writeSse(res, "snapshot", snap)) {
      client.lastSeq = snap.seq;
    } else {
      drop();
    }
  }

  /**
   * Engine-side signal: agents or attention may have changed.
   * Debounced; fans out a fresh full snapshot to all live clients.
   */
  notifyChanged(): void {
    if (this.clients.size === 0) return;
    if (this.debounceTimer) return;
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      void this.flushAll().catch(() => {
        /* best-effort */
      });
    }, this.debounceMs);
  }

  /** Drop clients for a session (unpair / replace). */
  dropSession(sessionToken: string): void {
    for (const c of [...this.clients]) {
      if (c.token !== sessionToken) continue;
      this.clients.delete(c);
      try {
        writeSse(c.res, "session", {
          seq: ++this.seq,
          at: new Date(this.now()).toISOString(),
          reason: "unpaired",
        });
        c.res.end();
      } catch {
        /* ignore */
      }
    }
    if (this.clients.size === 0) this.stopHeartbeat();
  }

  /** Close every client (engine teardown). */
  closeAll(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }
    this.stopHeartbeat();
    for (const c of [...this.clients]) {
      this.clients.delete(c);
      try {
        c.res.end();
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * Push an out-of-band SSE event to all live clients (e.g. tab.command).
   * Does not advance agent-list snapshots.
   */
  pushEvent(event: string, data: unknown): void {
    const at = new Date(this.now()).toISOString();
    const payload =
      data && typeof data === "object" && !Array.isArray(data)
        ? { ...(data as Record<string, unknown>), seq: ++this.seq, at }
        : { data, seq: ++this.seq, at };
    for (const c of [...this.clients]) {
      if (!writeSse(c.res, event, payload)) {
        this.clients.delete(c);
      }
    }
    if (this.clients.size === 0) this.stopHeartbeat();
  }

  private async flushAll(): Promise<void> {
    if (this.clients.size === 0) return;
    // One agent list for all clients; connection status is per-token.
    let agents: CompanionAgentRow[];
    try {
      agents = await this.options.listAgents();
    } catch {
      return;
    }
    const at = new Date(this.now()).toISOString();
    const seq = ++this.seq;

    for (const c of [...this.clients]) {
      const connection = this.options.statusOf(c.token);
      if (connection.status !== "connected") {
        this.clients.delete(c);
        try {
          writeSse(c.res, "session", { seq, at, reason: connection.status });
          c.res.end();
        } catch {
          /* ignore */
        }
        continue;
      }
      const payload: CompanionLiveState = { seq, at, connection, agents };
      if (!writeSse(c.res, "snapshot", payload)) {
        this.clients.delete(c);
      } else {
        c.lastSeq = seq;
      }
    }
    if (this.clients.size === 0) this.stopHeartbeat();
  }

  private async buildSnapshot(sessionToken: string): Promise<CompanionLiveState> {
    const connection = this.options.statusOf(sessionToken);
    let agents: CompanionAgentRow[] = [];
    if (connection.status === "connected") {
      try {
        agents = await this.options.listAgents();
      } catch {
        agents = [];
      }
    }
    return {
      seq: ++this.seq,
      at: new Date(this.now()).toISOString(),
      connection,
      agents,
    };
  }

  private ensureHeartbeat(): void {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => {
      const at = new Date(this.now()).toISOString();
      for (const c of [...this.clients]) {
        if (!writeSse(c.res, "heartbeat", { seq: this.seq, at })) {
          this.clients.delete(c);
        }
      }
      if (this.clients.size === 0) this.stopHeartbeat();
    }, this.heartbeatMs);
    // Don't keep the process alive solely for heartbeats in tests.
    this.heartbeatTimer.unref?.();
  }

  private stopHeartbeat(): void {
    if (!this.heartbeatTimer) return;
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
  }
}
