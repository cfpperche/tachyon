import { afterEach, describe, expect, it, vi } from "vitest";
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
  ensureSecureRuntimeDir,
  legacyPersistentBridgeControlSocket,
  MAX_CONTROL_SOCKET_PATH_BYTES,
  persistentBridgeControlSocket,
  persistentBridgeDescriptorPath,
  persistentBridgeDir,
  PersistentBridgeSocketPathError,
  PersistentBridgeUnsafeRuntimeDirError,
  resolvePersistentBridgeControlSocket,
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

  describe("control socket path derivation (t-88ef8c)", () => {
    const originalXdgRuntimeDir = process.env.XDG_RUNTIME_DIR;
    afterEach(() => {
      if (originalXdgRuntimeDir === undefined) delete process.env.XDG_RUNTIME_DIR;
      else process.env.XDG_RUNTIME_DIR = originalXdgRuntimeDir;
    });

    it("relocates the control socket outside a long workspace root, staying under the sun_path budget", () => {
      // A checkout under ~/.cache/tachyon/worktrees/... is already 122+ bytes on its own — this goes
      // further to prove the derivation never re-embeds the workspace path at all.
      const longRoot = path.join(os.tmpdir(), "a".repeat(200), "b".repeat(200));
      const socket = persistentBridgeControlSocket(longRoot);
      expect(Buffer.byteLength(socket, "utf8")).toBeLessThanOrEqual(MAX_CONTROL_SOCKET_PATH_BYTES);
      expect(socket).not.toContain(longRoot);
      expect(socket.endsWith("control.sock")).toBe(true);
    });

    it("derives the same path twice for the same root — one deterministic derivation, not a copy per caller", () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-persistent-bridge-derive-"));
      expect(persistentBridgeControlSocket(root)).toBe(persistentBridgeControlSocket(root));
      expect(persistentBridgeDir(root)).toBe(path.dirname(persistentBridgeControlSocket(root)));
    });

    it("throws a structured error instead of a raw EINVAL when the runtime dir itself is too long", () => {
      process.env.XDG_RUNTIME_DIR = `/run/user/${"1".repeat(120)}`;
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-persistent-bridge-guard-"));
      let caught: unknown;
      try {
        persistentBridgeControlSocket(root);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(PersistentBridgeSocketPathError);
      const pathError = caught as InstanceType<typeof PersistentBridgeSocketPathError>;
      expect(pathError.byteLength).toBeGreaterThan(MAX_CONTROL_SOCKET_PATH_BYTES);
      expect(pathError.socketPath).toContain("control.sock");
    });

    it("resolves to a pre-upgrade daemon's legacy in-workspace socket when only that one exists", () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-persistent-bridge-legacy-"));
      const legacy = legacyPersistentBridgeControlSocket(root);
      fs.mkdirSync(path.dirname(legacy), { recursive: true });
      fs.writeFileSync(legacy, "");
      expect(resolvePersistentBridgeControlSocket(root)).toBe(legacy);
    });

    it("prefers the new socket over a stale legacy one once a current daemon exists", () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-persistent-bridge-preferred-"));
      const legacy = legacyPersistentBridgeControlSocket(root);
      fs.mkdirSync(path.dirname(legacy), { recursive: true });
      fs.writeFileSync(legacy, "");
      const primary = persistentBridgeControlSocket(root);
      fs.mkdirSync(path.dirname(primary), { recursive: true });
      fs.writeFileSync(primary, "");
      expect(resolvePersistentBridgeControlSocket(root)).toBe(primary);
    });
  });

  // t-88ef8c security review (j-58f2753edbf2 finding #1, BLOCKER): with XDG_RUNTIME_DIR absent, the
  // runtime dir falls back under os.tmpdir() (a world-writable sticky dir, e.g. /tmp). fs.mkdirSync's
  // `mode` option is silently ignored for a directory that already exists, so a same-uid-namespace
  // attacker who pre-creates the deterministic leaf dir before this process runs can defeat the intended
  // 0700 and later hijack control.sock. ensureSecureRuntimeDir must repair a same-uid lax mode, and must
  // fail closed — never bind — when the directory cannot be made safe.
  describe("runtime dir hardening (t-88ef8c security review)", () => {
    const originalXdgRuntimeDir = process.env.XDG_RUNTIME_DIR;
    afterEach(() => {
      if (originalXdgRuntimeDir === undefined) delete process.env.XDG_RUNTIME_DIR;
      else process.env.XDG_RUNTIME_DIR = originalXdgRuntimeDir;
      vi.restoreAllMocks();
    });

    it("repairs a pre-existing world-writable runtime dir it owns back to 0700, then a real proxy can bind inside it", async () => {
      delete process.env.XDG_RUNTIME_DIR;
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-persistent-bridge-hijack-mode-"));
      const dir = persistentBridgeDir(root);
      fs.mkdirSync(dir, { recursive: true });
      fs.chmodSync(dir, 0o777); // simulates an attacker pre-creating the leaf dir wide open
      expect(fs.statSync(dir).mode & 0o777).toBe(0o777);

      ensureSecureRuntimeDir(dir);
      expect(fs.statSync(dir).mode & 0o777).toBe(0o700);

      // Proves the repair is real, not just cosmetic: a proxy actually binds inside the now-safe dir.
      const socket = persistentBridgeControlSocket(root);
      const proxy = await startPersistentProxy({
        workspaceRoot: root,
        workspaceHash: "hijckmod",
        preferredPort: 0,
        controlSocket: socket,
        descriptorPath: persistentBridgeDescriptorPath(root),
      });
      running.push(proxy);
      expect(fs.statSync(socket).mode & 0o777).toBe(0o600);
    });

    it("fails closed and never binds when the runtime dir is owned by a different uid", async () => {
      delete process.env.XDG_RUNTIME_DIR;
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-persistent-bridge-hijack-uid-"));
      const dir = persistentBridgeDir(root);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const realStatSync = fs.statSync.bind(fs);
      vi.spyOn(fs, "statSync").mockImplementation((target, opts) => {
        const stat = realStatSync(target as fs.PathLike, opts as fs.StatSyncOptions);
        if (target === dir) return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { uid: stat.uid + 1 });
        return stat;
      });

      expect(() => ensureSecureRuntimeDir(dir)).toThrow(PersistentBridgeUnsafeRuntimeDirError);

      // Fails closed all the way up through the real writer: ensureAndRegister rejects and never binds
      // a socket in the unsafe dir (the caller — Workspace.startBridgeListener — degrades to in-process).
      const socket = persistentBridgeControlSocket(root);
      const service = new PersistentBridgeService(root, "hijckuid", "/unused");
      await expect(service.ensureAndRegister(0, 12_345)).rejects.toThrow(PersistentBridgeUnsafeRuntimeDirError);
      expect(fs.existsSync(socket)).toBe(false);
    });
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
