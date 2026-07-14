import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { startPersistentProxy, type RunningPersistentProxy } from "../../src/bridge/persistentProxyDaemon.js";
import {
  buildPersistentBridgeSystemdRunArgs,
  encodeDaemonOptions,
  PersistentBridgeService,
  persistentBridgeSystemdLaunchError,
} from "../../src/bridge/PersistentBridgeService.js";
import {
  persistentBridgeControlSocket,
  persistentBridgeDescriptorPath,
  type PersistentBridgeControlRequest,
  type PersistentBridgeControlResponse,
} from "../../src/bridge/persistentProxyProtocol.js";

describe("persistent Bridge proxy", () => {
  const running: RunningPersistentProxy[] = [];
  const servers: http.Server[] = [];

  afterEach(async () => {
    await Promise.all(running.splice(0).map((proxy) => proxy.close()));
    await Promise.all(servers.splice(0).map(closeServer));
  });

  it("delivers Streamable HTTP SSE headers immediately and keeps the stream open (Grok/rmcp)", async () => {
    // Regression: hop-by-hop header passthrough + socket idle timeout made GET /mcp hang
    // until the client cancelled (minutes), while POST tools/call still returned JSON.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-persistent-bridge-sse-"));
    const socket = persistentBridgeControlSocket(root);
    const proxy = await startPersistentProxy({
      workspaceRoot: root,
      workspaceHash: "sse00001",
      preferredPort: 0,
      controlSocket: socket,
      descriptorPath: persistentBridgeDescriptorPath(root),
    });
    running.push(proxy);

    const backend = http.createServer((req, res) => {
      if (req.method === "GET") {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
          "mcp-session-id": "sess-sse-test",
          "transfer-encoding": "chunked",
        });
        res.flushHeaders();
        // Stay open like a real MCP SSE stream (no body chunks yet).
        const keepAlive = setInterval(() => {
          /* idle stream — must not be destroyed by the proxy at 15s */
        }, 60_000);
        req.on("close", () => clearInterval(keepAlive));
        res.on("close", () => clearInterval(keepAlive));
        return;
      }
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk: string) => {
        body += chunk;
      });
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "sess-sse-test" });
        res.end(JSON.stringify({ ok: true, body }));
      });
    });
    await new Promise<void>((resolve) => backend.listen(0, "127.0.0.1", resolve));
    servers.push(backend);
    const backendPort = (backend.address() as net.AddressInfo).port;
    await control(socket, { op: "register", workspaceHash: "sse00001", backendPort });

    const t0 = Date.now();
    const sse = await openSse(proxy.descriptor.port, "/mcp", { accept: "text/event-stream" });
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(sse.status).toBe(200);
    expect(sse.headers["content-type"]).toMatch(/text\/event-stream/);
    expect(sse.headers["mcp-session-id"]).toBe("sess-sse-test");
    // Hop-by-hop must not be re-emitted (Node may manage transfer-encoding itself).
    expect(sse.headers.connection === undefined || sse.headers.connection === "keep-alive").toBe(true);

    const post = await request(proxy.descriptor.port, "/mcp", `{"jsonrpc":"2.0"}`, {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    });
    expect(post.status).toBe(200);
    expect(JSON.parse(post.body)).toEqual({ ok: true, body: `{"jsonrpc":"2.0"}` });

    sse.destroy();
  });

  it("keeps one public endpoint while the Extension Host backend detaches and reattaches", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-persistent-bridge-"));
    const socket = persistentBridgeControlSocket(root);
    const descriptorPath = persistentBridgeDescriptorPath(root);
    const proxy = await startPersistentProxy({ workspaceRoot: root, workspaceHash: "abc12345", preferredPort: 0, controlSocket: socket, descriptorPath });
    running.push(proxy);

    const before = await request(proxy.descriptor.port, "/mcp");
    expect(before.status).toBe(503);
    expect(JSON.parse(before.body)).toMatchObject({ error: "HOST_UNAVAILABLE" });

    const backend1 = await backendServer("one", servers);
    const registered1 = await control(socket, { op: "register", workspaceHash: "abc12345", backendPort: backend1 });
    expect(registered1).toMatchObject({ ok: true, backendPort: backend1 });
    const first = await request(proxy.descriptor.port, "/mcp", "payload", { authorization: "Bearer secret" });
    expect(first).toEqual({ status: 201, body: "one:payload:Bearer secret" });

    await control(socket, { op: "detach", workspaceHash: "abc12345", backendPort: backend1 });
    expect((await request(proxy.descriptor.port, "/mcp")).status).toBe(503);

    const backend2 = await backendServer("two", servers);
    await control(socket, { op: "register", workspaceHash: "abc12345", backendPort: backend2 });
    const second = await request(proxy.descriptor.port, "/mcp", "again");
    expect(second).toEqual({ status: 201, body: "two:again:" });
    expect(proxy.descriptor.port).toBe(JSON.parse(fs.readFileSync(descriptorPath, "utf8")).port);
    expect(fs.statSync(descriptorPath).mode & 0o777).toBe(0o600);
    expect(fs.statSync(socket).mode & 0o777).toBe(0o600);
  });

  it("refuses a control client from another workspace", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-persistent-bridge-scope-"));
    const socket = persistentBridgeControlSocket(root);
    const proxy = await startPersistentProxy({ workspaceRoot: root, workspaceHash: "right", preferredPort: 0, controlSocket: socket, descriptorPath: persistentBridgeDescriptorPath(root) });
    running.push(proxy);
    expect(await control(socket, { op: "health", workspaceHash: "wrong" })).toEqual({
      ok: false,
      code: "WRONG_WORKSPACE",
      message: "workspace identity mismatch",
    });
  });

  it("lets concurrent Extension Host clients converge on the existing proxy identity", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-persistent-bridge-clients-"));
    const socket = persistentBridgeControlSocket(root);
    const proxy = await startPersistentProxy({ workspaceRoot: root, workspaceHash: "same", preferredPort: 0, controlSocket: socket, descriptorPath: persistentBridgeDescriptorPath(root) });
    running.push(proxy);
    const backendPort = await backendServer("shared", servers);
    const a = new PersistentBridgeService(root, "same", "/unused");
    const b = new PersistentBridgeService(root, "same", "/unused");
    const [first, second] = await Promise.all([
      a.ensureAndRegister(42_897, backendPort),
      b.ensureAndRegister(42_897, backendPort),
    ]);
    expect(first.instanceId).toBe(proxy.descriptor.instanceId);
    expect(second.instanceId).toBe(proxy.descriptor.instanceId);
    expect(first.port).toBe(second.port);
    await a.stop();
    expect(fs.existsSync(socket)).toBe(false);
  });

  it("starts a missing proxy through the injectable launcher before registering the backend", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-persistent-bridge-launch-"));
    const backendPort = await backendServer("launched", servers);
    const launches: unknown[] = [];
    const service = new PersistentBridgeService(root, "launch", "/daemon.cjs", (input) => {
      launches.push(input);
      void startPersistentProxy(input.options).then((proxy) => running.push(proxy));
    });

    const descriptor = await service.ensureAndRegister(0, backendPort);
    expect(launches).toHaveLength(1);
    expect(descriptor.workspaceHash).toBe("launch");
    expect((await request(descriptor.port, "/mcp", "body")).body).toBe("launched:body:");
    await service.stop();
  });

  it("builds a Linux user-systemd launch instead of a child of the Extension Host", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-persistent-bridge-systemd-"));
    const options = {
      workspaceRoot: root,
      workspaceHash: "abc12345",
      preferredPort: 42_897,
      controlSocket: persistentBridgeControlSocket(root),
      descriptorPath: persistentBridgeDescriptorPath(root),
    };
    const input = { options, daemonModule: "/ext/dist/persistent-bridge-daemon.cjs", encodedOptions: encodeDaemonOptions(options) };
    expect(buildPersistentBridgeSystemdRunArgs(input, "tachyon-bridge-abc.service")).toEqual([
      "--user",
      "--quiet",
      "--collect",
      "--unit=tachyon-bridge-abc.service",
      `--working-directory=${root}`,
      "--setenv=ELECTRON_RUN_AS_NODE=1",
      "--",
      process.execPath,
      "/ext/dist/persistent-bridge-daemon.cjs",
      input.encodedOptions,
    ]);
  });

  it("explains a missing systemd-run command with a platform-specific recovery path", () => {
    const error = persistentBridgeSystemdLaunchError({
      spawnError: Object.assign(new Error("spawn systemd-run ENOENT"), { code: "ENOENT" }),
      isWsl: true,
    });

    expect(error).toMatchObject({
      code: "SYSTEMD_RUN_MISSING",
      technicalDetail: "spawn systemd-run ENOENT",
    });
    expect(error.message).toContain("inside WSL");
    expect(error.message).toContain("retry the Bridge");
  });

  it("turns a missing user bus into WSL remediation and keeps bounded diagnostics", () => {
    const error = persistentBridgeSystemdLaunchError({
      exitCode: 1,
      output: `Failed to connect to bus: No medium found ${"x".repeat(2_000)}`,
      isWsl: true,
    });

    expect(error.code).toBe("SYSTEMD_USER_UNAVAILABLE");
    expect(error.message).toContain("/etc/wsl.conf");
    expect(error.message).toContain("wsl --shutdown");
    expect(error.technicalDetail.length).toBeLessThan(900);
    expect(error.technicalDetail.endsWith("…")).toBe(true);
  });

  it("routes unexpected systemd-run failures through Doctor instead of raw launcher output", () => {
    const error = persistentBridgeSystemdLaunchError({ exitCode: 5, output: "unexpected unit failure", isWsl: false });

    expect(error.code).toBe("SYSTEMD_RUN_FAILED");
    expect(error.message).toContain("Tachyon: Doctor");
    expect(error.message).not.toContain("unexpected unit failure");
    expect(error.technicalDetail).toContain("unexpected unit failure");
  });
});

async function backendServer(label: string, servers: http.Server[]): Promise<number> {
  const server = http.createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => { body += chunk; });
    req.on("end", () => {
      res.writeHead(201, { "content-type": "text/plain" });
      res.end(`${label}:${body}:${req.headers.authorization ?? ""}`);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("backend did not bind");
  return address.port;
}

function request(port: number, pathname: string, body = "", headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port, path: pathname, method: "POST", headers }, (res) => {
      let output = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => { output += chunk; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: output }));
    });
    req.once("error", reject);
    req.end(body);
  });
}

/** Resolve as soon as response *headers* arrive (SSE stays open). */
function openSse(
  port: number,
  pathname: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; headers: http.IncomingHttpHeaders; destroy: () => void }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port, path: pathname, method: "GET", headers }, (res) => {
      resolve({
        status: res.statusCode ?? 0,
        headers: res.headers,
        destroy: () => {
          res.destroy();
          req.destroy();
        },
      });
    });
    req.setTimeout(3_000, () => {
      req.destroy(new Error("SSE headers not received within 3s"));
    });
    req.once("error", reject);
    req.end();
  });
}

function control(socketPath: string, request: PersistentBridgeControlRequest): Promise<PersistentBridgeControlResponse> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let data = "";
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk: string) => { data += chunk; });
    socket.once("error", reject);
    socket.once("end", () => resolve(JSON.parse(data) as PersistentBridgeControlResponse));
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}
