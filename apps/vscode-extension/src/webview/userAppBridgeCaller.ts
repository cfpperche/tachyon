/**
 * 514 — the one call an installed app can make, and the client that makes it.
 *
 * ## Why a client at all
 *
 * The Bridge does not run in the extension host, and `WorkspaceClient` exposes engine operations but
 * no `callTool`. So the host needs a thin MCP client of its own, authenticating with the workspace's
 * `external` token — the same token the engine already hands out through `bridge.token`.
 *
 * ## What "external" means, said where the app author reads it
 *
 * An app is NOT an agent. Twelve Bridge tools require `caller.kind === "agent"` because they act as
 * one — claiming a task, answering a doorbell, writing into a pane. Those refuse an app by name, and
 * that refusal is the design, not a gap: an app is a screen the human opened, not a participant in
 * the fleet. Everything else — listing agents, reading the board, spawning and killing — is open,
 * with no allowlist and no per-action consent.
 *
 * ## One connection per workspace, and it is disposable
 *
 * The client is created on the first call and kept. A failure drops it, so the next call reconnects
 * rather than inheriting a dead transport — the same self-healing shape the Bridge URL and token
 * already have everywhere else in this extension.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export interface UserAppBridgeTarget {
  bridgeUrl: string;
  /** the workspace's external caller token, or undefined when auth is off. */
  token: string | undefined;
}

interface Connection {
  client: Client;
  url: string;
  token: string | undefined;
}

export class UserAppBridgeCaller {
  private connections = new Map<string, Connection>();

  /** Call one Bridge tool for an app. Errors come back as values — the page renders them. */
  async call(
    key: string,
    target: UserAppBridgeTarget,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<{ ok: true; result: unknown } | { ok: false; error: string }> {
    let connection: Connection;
    try {
      connection = await this.connect(key, target);
    } catch (error) {
      return { ok: false, error: `bridge is not reachable: ${message(error)}` };
    }
    try {
      const result = await connection.client.callTool({ name: tool, arguments: args }, undefined, { timeout: 120_000 });
      return { ok: true, result };
    } catch (error) {
      // A dead transport must not outlive the call that found it dead.
      this.drop(key);
      return { ok: false, error: message(error) };
    }
  }

  dispose(): void {
    for (const key of [...this.connections.keys()]) this.drop(key);
  }

  private drop(key: string): void {
    const connection = this.connections.get(key);
    this.connections.delete(key);
    void connection?.client.close().catch(() => undefined);
  }

  private async connect(key: string, target: UserAppBridgeTarget): Promise<Connection> {
    const existing = this.connections.get(key);
    // A workspace that re-bound its port or re-minted its token is a DIFFERENT connection, not a
    // stale one to reuse: comparing both is cheaper than discovering it on a failed call.
    if (existing && existing.url === target.bridgeUrl && existing.token === target.token) return existing;
    if (existing) this.drop(key);
    const transport = new StreamableHTTPClientTransport(new URL(target.bridgeUrl), {
      requestInit: target.token ? { headers: { Authorization: `Bearer ${target.token}` } } : {},
    });
    const client = new Client({ name: "tachyon-user-app", version: "1.0.0" });
    await client.connect(transport, { timeout: 5_000 });
    const connection: Connection = { client, url: target.bridgeUrl, token: target.token };
    this.connections.set(key, connection);
    return connection;
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
