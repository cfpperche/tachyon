import http from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { registerTools, type BridgeDeps } from "./tools.js";
import { tokenMatches } from "./token.js";

export const BRIDGE_PATH = "/mcp";

export const DERIVED_PORT_BASE = 41000;
export const DERIVED_PORT_SPAN = 2000;

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
 * The Bridge — Tachyon's embedded MCP server. Listens on a free loopback port for
 * the lifetime of the extension host. Stateless streamable-HTTP: each POST gets a
 * fresh transport + McpServer pair, so no session bookkeeping; durable state lives
 * in tmux, not here.
 */
export class Bridge {
  private server?: http.Server;
  private _port?: number;
  private _usedFallback = false;

  constructor(
    private readonly deps: BridgeDeps,
    private readonly options: { token?: string } = {},
  ) {}

  get port(): number | undefined {
    return this._port;
  }

  /** True when the preferred port was busy and an ephemeral one was used instead. */
  get usedFallback(): boolean {
    return this._usedFallback;
  }

  get url(): string | undefined {
    return this._port === undefined ? undefined : `http://127.0.0.1:${this._port}${BRIDGE_PATH}`;
  }

  /** Binds the preferred port when given; falls back to an ephemeral one if it is taken. */
  async start(preferredPort?: number): Promise<number> {
    if (this.server) throw new Error("Bridge already started");
    const server = http.createServer((req, res) => {
      void this.handle(req, res);
    });
    this.server = server;

    const listen = (port: number) =>
      new Promise<void>((resolve, reject) => {
        const onError = (err: NodeJS.ErrnoException) => reject(err);
        server.once("error", onError);
        server.listen(port, "127.0.0.1", () => {
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
    const url = (req.url ?? "").split("?")[0];
    if (url !== BRIDGE_PATH) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: `not found — the Bridge endpoint is ${BRIDGE_PATH}` }));
      return;
    }
    if (req.method !== "POST") {
      // Stateless JSON mode: no server-initiated SSE stream, no sessions to delete.
      res.writeHead(405, { "content-type": "application/json", allow: "POST" });
      res.end(JSON.stringify({ error: "method not allowed — stateless Bridge accepts POST only" }));
      return;
    }
    if (this.options.token !== undefined) {
      const auth = req.headers.authorization;
      const bearer = auth?.startsWith("Bearer ") ? auth.slice(7) : undefined;
      if (!tokenMatches(bearer, this.options.token)) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            error:
              "unauthorized — the Bridge requires 'Authorization: Bearer <token>'. " +
              "Agents spawned by Tachyon get TACHYON_BRIDGE_TOKEN injected automatically; " +
              "for external clients use the 'Tachyon: Copy Bridge Token' command.",
          }),
        );
        return;
      }
    }

    try {
      const body = await readJsonBody(req);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      const mcp = new McpServer({ name: "tachyon-bridge", version: "0.1.0" });
      registerTools(mcp, this.deps);
      res.on("close", () => {
        void transport.close();
        void mcp.close();
      });
      await mcp.connect(transport);
      await transport.handleRequest(req, res, body);
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
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
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
