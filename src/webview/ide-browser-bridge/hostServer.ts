/**
 * IDE Browser HTTP host + instance-file discovery (t-47503a / AR-02 transport seam).
 *
 * Owns: bind loopback server, token auth, instance heartbeat files, route dispatch.
 * Does not own CDP, Design Mode chat, or pick state — those stay on the controller/manager.
 * Route bodies are decoded via the shared protocol module (engine + shell same contract).
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import type { IdeBrowserEnvelope, IdeBrowserInstanceFile, IdeBrowserStatus } from "../../ide-browser/protocol.js";
import {
  IDE_BROWSER_INSTANCE_HEADER,
  IDE_BROWSER_INSTANCE_HEARTBEAT_MS,
  IDE_BROWSER_INSTANCES_DIR_NAME,
  IDE_BROWSER_ROUTES,
  IDE_BROWSER_TOKEN_HEADER,
  decodeIdeBrowserHttpRequest,
} from "../../ide-browser/protocol.js";
import { sweepDeadIdeBrowserInstances } from "../../ide-browser/client.js";

export type IdeBrowserHostRouteHandlers = {
  getStatus: () => IdeBrowserStatus;
  navigate: (url: string) => Promise<{ url: string }>;
  eval: (expression: string) => Promise<{ value: unknown }>;
  screenshot: () => Promise<{ mime: "image/png"; base64: string; url: string }>;
  snapshot: () => Promise<{ text: string; url: string }>;
  currentUrl: () => Promise<{ url: string }>;
  click: (selector: string) => Promise<{ clicked: string }>;
};

export type IdeBrowserHostServerDeps = {
  workspaceRoot: string;
  log: { appendLine: (line: string) => void };
  handlers: IdeBrowserHostRouteHandlers;
};

/**
 * Loopback HTTP server that publishes an instance file for engine discovery.
 * One instance per manager/workspace binding (cardinality is outside this type).
 */
export class IdeBrowserHostServer {
  private server: http.Server | null = null;
  private port = 0;
  private token = "";
  private instanceId = "";
  private instancePath: string | null = null;
  private instanceHeartbeat: ReturnType<typeof setInterval> | null = null;
  private readonly workspaceRoot: string;
  private readonly log: { appendLine: (line: string) => void };
  private handlers: IdeBrowserHostRouteHandlers;

  constructor(deps: IdeBrowserHostServerDeps) {
    this.workspaceRoot = path.resolve(deps.workspaceRoot);
    this.log = deps.log;
    this.handlers = deps.handlers;
  }

  /** Replace handlers after construction (manager wires late-bound methods). */
  setHandlers(handlers: IdeBrowserHostRouteHandlers): void {
    this.handlers = handlers;
  }

  get running(): boolean {
    return this.server !== null;
  }

  get endpoint(): string {
    return this.port ? `http://127.0.0.1:${this.port}` : "";
  }

  get boundPort(): number {
    return this.port;
  }

  get currentInstanceId(): string {
    return this.instanceId;
  }

  async start(): Promise<void> {
    if (this.server) return;
    this.token = crypto.randomBytes(16).toString("hex");
    this.instanceId = crypto.randomUUID();
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
  }

  async stop(): Promise<void> {
    if (this.instanceHeartbeat) {
      clearInterval(this.instanceHeartbeat);
      this.instanceHeartbeat = null;
    }
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
  }

  private authOk(req: http.IncomingMessage): boolean {
    return req.headers[IDE_BROWSER_TOKEN_HEADER] === this.token;
  }

  private async handleHttp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    const json = (status: number, body: IdeBrowserEnvelope): void => {
      res.writeHead(status, {
        "content-type": "application/json",
        [IDE_BROWSER_INSTANCE_HEADER]: this.instanceId,
      });
      res.end(JSON.stringify(body));
    };
    try {
      // Token required for every route (including /status) — same as historical host.
      if (!this.authOk(req)) {
        json(401, { ok: false, error: "unauthorized" });
        return;
      }

      const needsBody = (req.method || "GET").toUpperCase() === "POST";
      const rawBody = needsBody ? await readJson(req) : undefined;
      const decoded = decodeIdeBrowserHttpRequest(req.method || "GET", url.pathname, rawBody);
      if (!decoded.ok) {
        json(decoded.status, { ok: false, error: decoded.error });
        return;
      }

      switch (decoded.path) {
        case IDE_BROWSER_ROUTES.status:
          json(200, { ok: true, data: this.handlers.getStatus() });
          return;
        case IDE_BROWSER_ROUTES.navigate: {
          const data = await this.handlers.navigate(decoded.body.url);
          json(200, { ok: true, data });
          return;
        }
        case IDE_BROWSER_ROUTES.eval: {
          const data = await this.handlers.eval(decoded.body.expression);
          json(200, { ok: true, data });
          return;
        }
        case IDE_BROWSER_ROUTES.screenshot: {
          const data = await this.handlers.screenshot();
          json(200, { ok: true, data });
          return;
        }
        case IDE_BROWSER_ROUTES.snapshot: {
          const data = await this.handlers.snapshot();
          json(200, { ok: true, data });
          return;
        }
        case IDE_BROWSER_ROUTES.url: {
          const data = await this.handlers.currentUrl();
          json(200, { ok: true, data });
          return;
        }
        case IDE_BROWSER_ROUTES.click: {
          const data = await this.handlers.click(decoded.body.selector);
          json(200, { ok: true, data });
          return;
        }
        default: {
          const _never: never = decoded;
          void _never;
          json(404, { ok: false, error: `unknown route ${url.pathname}` });
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.appendLine(`[ide-browser] error: ${message}`);
      json(500, { ok: false, error: message });
    }
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
    const workspaceId = crypto.createHash("sha256").update(this.workspaceRoot).digest("hex").slice(0, 12);
    this.instancePath = path.join(dir, `${workspaceId}-${this.instanceId}.json`);
    const startedAt = new Date().toISOString();
    const body: IdeBrowserInstanceFile = {
      schemaVersion: 2,
      kind: "tachyon-ide-browser",
      instanceId: this.instanceId,
      workspaceRoot: this.workspaceRoot,
      port: this.port,
      token: this.token,
      pid: process.pid,
      startedAt,
      heartbeatAt: startedAt,
    };
    this.persistInstanceFile(body);
    this.instanceHeartbeat = setInterval(() => {
      if (!this.instancePath || !this.server) return;
      body.heartbeatAt = new Date().toISOString();
      try {
        this.persistInstanceFile(body);
      } catch (error) {
        this.log.appendLine(`[ide-browser] instance heartbeat failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }, IDE_BROWSER_INSTANCE_HEARTBEAT_MS);
    this.instanceHeartbeat.unref?.();
  }

  private persistInstanceFile(body: IdeBrowserInstanceFile): void {
    if (!this.instancePath) return;
    const temporary = `${this.instancePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, this.instancePath);
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
