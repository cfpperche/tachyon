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
  PersistentBridgeUnavailableError,
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

  // t-88ef8c security review round 2 (j-2cf52fee3827, following j-d0f57760d567's adversarial re-review):
  // round 1's leaf-only permission check missed that the LEAF's *parent* was equally attacker-creatable
  // under the old os.tmpdir()/tachyon-<uid> fallback — an attacker who pre-creates the parent (not the
  // leaf) still gets a victim-owned "safe" leaf inside their own directory, and can delete/replace it at
  // any later time regardless of the leaf's own mode. Round 2 deletes the fallback outright: the runtime
  // dir now lives ONLY under $XDG_RUNTIME_DIR/tachyon (a pam_systemd-guaranteed 0700-per-uid tmpfs), so no
  // attacker-controllable parent can ever exist. Round 1's chmod-repair path is dropped too (it was its
  // own TOCTOU gap) — ensureSecureRuntimeDir now refuses outright instead of repairing.
  describe("runtime dir hardening (t-88ef8c security review round 2)", () => {
    const originalXdgRuntimeDir = process.env.XDG_RUNTIME_DIR;
    afterEach(() => {
      if (originalXdgRuntimeDir === undefined) delete process.env.XDG_RUNTIME_DIR;
      else process.env.XDG_RUNTIME_DIR = originalXdgRuntimeDir;
    });

    it("(a) refuses to derive any path — and never mkdirs the deleted os.tmpdir() fallback — when XDG_RUNTIME_DIR is unset", async () => {
      delete process.env.XDG_RUNTIME_DIR;
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-persistent-bridge-no-xdg-"));

      expect(() => persistentBridgeDir(root)).toThrow(PersistentBridgeUnavailableError);
      expect(() => persistentBridgeControlSocket(root)).toThrow(PersistentBridgeUnavailableError);

      // Fails closed all the way up through the real writer: ensureAndRegister rejects (Workspace's
      // caller degrades to in-process Bridge). Prove the deleted os.tmpdir()/tachyon-<uid> fallback dir
      // (the exact name the pre-round-2 code used to mkdir) is never mkdir'd by this call — spied rather
      // than existsSync-checked because a shared host may already have that dir from unrelated processes.
      const uid = typeof process.getuid === "function" ? process.getuid() : 0;
      const deletedFallbackDir = path.join(os.tmpdir(), `tachyon-${uid}`);
      const realMkdirSync = fs.mkdirSync.bind(fs);
      const mkdirTargets: unknown[] = [];
      const mkdirSpy = vi.spyOn(fs, "mkdirSync").mockImplementation((target, opts) => {
        mkdirTargets.push(target);
        return realMkdirSync(target as fs.PathLike, opts as fs.MakeDirectoryOptions);
      });
      try {
        const service = new PersistentBridgeService(root, "noxdg001", "/unused");
        await expect(service.ensureAndRegister(0, 12_345)).rejects.toThrow(PersistentBridgeUnavailableError);
      } finally {
        mkdirSpy.mockRestore();
      }
      expect(mkdirTargets).not.toContain(deletedFallbackDir);
    });

    it("(b) refuses a leaf that is a symlink, even to an otherwise-valid same-uid 0700 directory", async () => {
      const xdgBase = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-persistent-bridge-xdg-"));
      process.env.XDG_RUNTIME_DIR = xdgBase;
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-persistent-bridge-symlink-"));

      const realTarget = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-persistent-bridge-symlink-target-"));
      fs.chmodSync(realTarget, 0o700);
      const leaf = persistentBridgeDir(root);
      fs.mkdirSync(path.dirname(leaf), { recursive: true, mode: 0o700 });
      fs.symlinkSync(realTarget, leaf, "dir");

      expect(() => ensureSecureRuntimeDir(leaf)).toThrow(PersistentBridgeUnsafeRuntimeDirError);

      const service = new PersistentBridgeService(root, "symlink1", "/unused");
      await expect(service.ensureAndRegister(0, 12_345)).rejects.toThrow(PersistentBridgeUnsafeRuntimeDirError);
      expect(fs.existsSync(persistentBridgeControlSocket(root))).toBe(false);
    });

    it("(c) binds a real proxy under $XDG_RUNTIME_DIR/tachyon on the normal (XDG-present) path", async () => {
      const xdgBase = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-persistent-bridge-xdg-normal-"));
      process.env.XDG_RUNTIME_DIR = xdgBase;
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-persistent-bridge-xdg-normal-root-"));

      const socket = persistentBridgeControlSocket(root);
      expect(socket.startsWith(path.join(xdgBase, "tachyon"))).toBe(true);
      const proxy = await startPersistentProxy({
        workspaceRoot: root,
        workspaceHash: "xdgnorm1",
        preferredPort: 0,
        controlSocket: socket,
        descriptorPath: persistentBridgeDescriptorPath(root),
      });
      running.push(proxy);
      expect(fs.statSync(socket).mode & 0o777).toBe(0o600);
      expect(fs.statSync(path.dirname(socket)).mode & 0o777).toBe(0o700);
      expect(fs.statSync(path.join(xdgBase, "tachyon")).mode & 0o777).toBe(0o700);
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
