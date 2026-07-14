import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  PERSISTENT_BRIDGE_PROTOCOL,
  type PersistentBridgeControlRequest,
  type PersistentBridgeControlResponse,
  type PersistentBridgeDescriptor,
} from "./persistentProxyProtocol.js";
// Re-exported so scripts/dogfood/persistent-bridge.mjs (a plain .mjs, run outside the TS build) can
// `require()` the ONE shared path derivation off this bundle instead of keeping a second copy (t-88ef8c).
export {
  persistentBridgeControlSocket,
  persistentBridgeDescriptorPath,
  persistentBridgeDir,
} from "./persistentProxyProtocol.js";

export interface PersistentProxyDaemonOptions {
  workspaceRoot: string;
  workspaceHash: string;
  preferredPort: number;
  controlSocket: string;
  descriptorPath: string;
}

export interface RunningPersistentProxy {
  descriptor: PersistentBridgeDescriptor;
  close(): Promise<void>;
}

/**
 * Hop-by-hop headers must not be re-emitted by a reverse proxy (RFC 7230 §6.1).
 * Copying `transfer-encoding` / `connection` into `writeHead` breaks Streamable HTTP
 * SSE (`GET /mcp`): clients never see response headers, so MCP clients that open an
 * event stream (Grok/rmcp `client_side_sse`, etc.) hang until cancel — while short
 * `POST tools/call` still appears fine via `enableJsonResponse`.
 */
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
]);

/** How long to wait for the backend to *start* responding (headers). Not a stream idle cap. */
export const PROXY_HEADER_TIMEOUT_MS = 15_000;

export function stripHopByHopHeaders(headers: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
  const out: http.OutgoingHttpHeaders = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (HOP_BY_HOP_HEADERS.has(key.toLowerCase())) continue;
    out[key] = value;
  }
  return out;
}

export async function startPersistentProxy(options: PersistentProxyDaemonOptions): Promise<RunningPersistentProxy> {
  const canonicalRoot = fs.realpathSync(options.workspaceRoot);
  fs.mkdirSync(path.dirname(options.controlSocket), { recursive: true, mode: 0o700 });
  let backendPort: number | undefined;
  let closing = false;

  const proxy = http.createServer((req, res) => {
    const target = backendPort;
    if (!target) return hostUnavailable(res);
    const method = (req.method ?? "GET").toUpperCase();
    const requestHeaders = stripHopByHopHeaders(req.headers);
    requestHeaders.host = `127.0.0.1:${target}`;
    // Body-less methods: never forward a content-length that would make the backend wait for bytes.
    if (method === "GET" || method === "HEAD" || method === "DELETE") {
      delete requestHeaders["content-length"];
    }

    const upstream = http.request({
      hostname: "127.0.0.1",
      port: target,
      method,
      path: req.url,
      headers: requestHeaders,
    }, (upstreamResponse) => {
      clearTimeout(headerTimer);
      // Streaming MCP SSE and long-lived tools must not inherit a socket idle timeout.
      upstream.setTimeout(0);
      res.writeHead(upstreamResponse.statusCode ?? 502, stripHopByHopHeaders(upstreamResponse.headers));
      res.flushHeaders();
      upstreamResponse.pipe(res);
    });

    // Only bound *time-to-first-byte* (headers). A flat 15s socket timeout killed idle SSE
    // streams and, combined with hop-by-hop header passthrough, left clients without any
    // response line for the entire wait.
    const headerTimer = setTimeout(() => {
      if (!res.headersSent) upstream.destroy(new Error("Bridge backend header timeout"));
    }, PROXY_HEADER_TIMEOUT_MS);
    headerTimer.unref?.();

    upstream.on("error", () => {
      clearTimeout(headerTimer);
      if (!res.headersSent) hostUnavailable(res);
      else res.destroy();
    });
    res.on("close", () => {
      clearTimeout(headerTimer);
      if (!upstream.destroyed) upstream.destroy();
    });

    if (method === "GET" || method === "HEAD" || method === "DELETE") {
      upstream.end();
    } else {
      req.pipe(upstream);
    }
  });

  await listenHttp(proxy, options.preferredPort);
  const address = proxy.address();
  if (!address || typeof address === "string") throw new Error("persistent Bridge proxy failed to bind");

  const descriptor: PersistentBridgeDescriptor = {
    protocol: PERSISTENT_BRIDGE_PROTOCOL,
    workspaceHash: options.workspaceHash,
    workspaceRoot: canonicalRoot,
    instanceId: randomUUID(),
    pid: process.pid,
    port: address.port,
    controlSocket: options.controlSocket,
    startedAt: new Date().toISOString(),
  };

  const control = net.createServer((socket) => {
    socket.setEncoding("utf8");
    let input = "";
    socket.on("data", (chunk: string) => {
      input += chunk;
      if (input.length > 16_384) return socket.destroy();
      const newline = input.indexOf("\n");
      if (newline < 0) return;
      const raw = input.slice(0, newline);
      let request: PersistentBridgeControlRequest;
      try {
        request = JSON.parse(raw) as PersistentBridgeControlRequest;
      } catch {
        return respond(socket, { ok: false, code: "BAD_REQUEST", message: "control request is not JSON" });
      }
      if (request.workspaceHash !== options.workspaceHash) {
        return respond(socket, { ok: false, code: "WRONG_WORKSPACE", message: "workspace identity mismatch" });
      }
      if (request.op === "health") return respond(socket, { ok: true, descriptor, backendPort });
      if (request.op === "register") {
        if (!validPort(request.backendPort)) return respond(socket, { ok: false, code: "BAD_PORT", message: "invalid backend port" });
        backendPort = request.backendPort;
        return respond(socket, { ok: true, descriptor, backendPort });
      }
      if (request.op === "detach") {
        if (backendPort === request.backendPort) backendPort = undefined;
        return respond(socket, { ok: true, descriptor, backendPort });
      }
      if (request.op === "stop") {
        respond(socket, { ok: true, descriptor, backendPort });
        setImmediate(() => void close());
        return;
      }
      return respond(socket, { ok: false, code: "BAD_REQUEST", message: "unknown control operation" });
    });
  });

  const close = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    await Promise.all([closeServer(control), closeServer(proxy)]);
    try { fs.unlinkSync(options.controlSocket); } catch { /* already gone */ }
    try {
      const current = JSON.parse(fs.readFileSync(options.descriptorPath, "utf8")) as Partial<PersistentBridgeDescriptor>;
      if (current.instanceId === descriptor.instanceId) fs.unlinkSync(options.descriptorPath);
    } catch { /* stale/missing descriptor */ }
  };

  try {
    await listenControl(control, options.controlSocket);
    fs.chmodSync(options.controlSocket, 0o600);
    writeDescriptor(options.descriptorPath, descriptor);
  } catch (error) {
    await Promise.all([closeServer(control), closeServer(proxy)]);
    throw error;
  }

  process.once("SIGTERM", () => void close().finally(() => process.exit(0)));
  process.once("SIGINT", () => void close().finally(() => process.exit(0)));
  return { descriptor, close };
}

function validPort(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && value <= 65_535;
}

function hostUnavailable(res: http.ServerResponse): void {
  res.writeHead(503, { "content-type": "application/json", "retry-after": "1" });
  res.end(JSON.stringify({ error: "HOST_UNAVAILABLE", message: "Tachyon Extension Host is not connected; retry after it activates" }));
}

function respond(socket: net.Socket, response: PersistentBridgeControlResponse): void {
  socket.end(`${JSON.stringify(response)}\n`);
}

function listenHttp(server: http.Server, preferredPort: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      server.removeListener("listening", onListening);
      if (error.code === "EADDRINUSE" || error.code === "EACCES") {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      } else reject(error);
    };
    const onListening = () => { server.removeListener("error", onError); resolve(); };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(preferredPort, "127.0.0.1");
  });
}

function listenControl(server: net.Server, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => { server.removeListener("error", reject); resolve(); });
  });
}

function closeServer(server: net.Server | http.Server): Promise<void> {
  return new Promise((resolve) => {
    if (!server.listening) return resolve();
    server.close(() => resolve());
  });
}

function writeDescriptor(file: string, descriptor: PersistentBridgeDescriptor): void {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(descriptor, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
}

async function main(): Promise<void> {
  const raw = process.argv[2];
  if (!raw) throw new Error("missing persistent Bridge daemon options");
  const options = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as PersistentProxyDaemonOptions;
  await startPersistentProxy(options);
}

if (require.main === module) {
  void main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
