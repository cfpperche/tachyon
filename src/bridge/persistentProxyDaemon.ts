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

export async function startPersistentProxy(options: PersistentProxyDaemonOptions): Promise<RunningPersistentProxy> {
  const canonicalRoot = fs.realpathSync(options.workspaceRoot);
  fs.mkdirSync(path.dirname(options.controlSocket), { recursive: true, mode: 0o700 });
  let backendPort: number | undefined;
  let closing = false;

  const proxy = http.createServer((req, res) => {
    const target = backendPort;
    if (!target) return hostUnavailable(res);
    const upstream = http.request({
      hostname: "127.0.0.1",
      port: target,
      method: req.method,
      path: req.url,
      headers: { ...req.headers, host: `127.0.0.1:${target}` },
    }, (upstreamResponse) => {
      res.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
      upstreamResponse.pipe(res);
    });
    upstream.setTimeout(15_000, () => upstream.destroy(new Error("Bridge backend timed out")));
    upstream.on("error", () => {
      if (!res.headersSent) hostUnavailable(res);
      else res.destroy();
    });
    req.pipe(upstream);
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
