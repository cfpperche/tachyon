import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Workspace } from "../../src/workspace/Workspace.js";
import type { EngineHost, NoticeAction, ViewKind, WatchEvents } from "../../src/workspace/EngineHost.js";
import { TmuxService, workspaceHash, type ExecResult } from "../../src/tmux/TmuxService.js";
import { derivePort } from "../../src/bridge/Bridge.js";
import { PersistentBridgeService } from "../../src/bridge/PersistentBridgeService.js";
import type { NotifyLevel } from "../../src/bridge/tools.js";
import {
  legacyPersistentBridgeControlSocket,
  MAX_CONTROL_SOCKET_PATH_BYTES,
  persistentBridgeControlSocket,
} from "../../src/bridge/persistentProxyProtocol.js";

/**
 * spec 375 follow-up, t-88ef8c — two sub-fixes to the persistent workspace bridge:
 *  (1) the control socket used to live under the workspace root (`.tachyon/bridge-service/control.sock`),
 *      which overflows the AF_UNIX `sun_path` limit (~108 bytes) for any long checkout — e.g. a worktree
 *      under `~/.cache/tachyon/worktrees/<id>/<name>` — producing a raw, undiagnosable connect() EINVAL.
 *  (2) that EINVAL (or any other persistent-proxy start failure) left the workspace with no ctl anchor, no
 *      spawns, and dead pins instead of degrading to the in-process Bridge — workspace activation must
 *      never abort just because the persistent proxy is unavailable.
 */
describe("container-generated delegation behavior", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  function longWorkspaceRoot(): string {
    // Mirrors the real-world trigger: a worktree checkout nested several long segments deep, e.g.
    // ~/.cache/tachyon/worktrees/<32-char-id>/<agent-name>. Padded well past 108 bytes so the legacy
    // in-workspace derivation would have overflowed sun_path on ANY platform (Linux 108 / macOS 104).
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-sockfix-longpath-"));
    const root = path.join(base, "worktrees", "b349073a-1111-2222-3333-444455556666", "sockfix-agent-checkout");
    fs.mkdirSync(root, { recursive: true });
    dirs.push(base);
    return root;
  }

  /** In-memory EngineHost — every host touchpoint is a no-op/recorder (same shape as the spec-235 harness). */
  class FakeHost implements EngineHost {
    readonly notices: { message: string; level: NotifyLevel; actions: NoticeAction[] }[] = [];
    private readonly stateMap = new Map<string, unknown>();
    private readonly secrets = new Map<string, string>();
    t = (message: string, ...args: (string | number | boolean)[]): string =>
      message.replace(/\{(\d+)\}/g, (_m, i) => String(args[Number(i)] ?? ""));
    notify(message: string, level: NotifyLevel = "info", actions: NoticeAction[] = []): void {
      this.notices.push({ message, level, actions: [...actions] });
    }
    focusPrimaryView(): void {}
    executeCommand(command: string): Promise<unknown> {
      return Promise.reject(new Error(`unexpected host command in headless test: ${command}`));
    }
    watch(root: string, glob: string, events: WatchEvents, onEvent: () => void): { dispose(): void } {
      void root; void glob; void events; void onEvent;
      return { dispose() {} };
    }
    getSetting<T>(_section: string, _key: string, dflt: T): T {
      return dflt;
    }
    globalStoragePath(): string {
      return this.storageDir;
    }
    getState<T>(key: string): T | undefined {
      return this.stateMap.get(key) as T | undefined;
    }
    setState(key: string, value: unknown): void {
      this.stateMap.set(key, value);
    }
    getSecret(key: string): Promise<string | undefined> {
      return Promise.resolve(this.secrets.get(key));
    }
    setSecret(key: string, value: string): Promise<void> {
      this.secrets.set(key, value);
      return Promise.resolve();
    }
    appVersion(): string {
      return "0.0.0-test";
    }
    mediaPath(...segments: string[]): string {
      return path.join(this.storageDir, ...segments);
    }
    webviewRoot(): unknown {
      return undefined;
    }
    onViewsChanged(_view: ViewKind): void {}
    constructor(private readonly storageDir: string) {}
  }

  /** fake-exec tmux — just enough for Workspace.createForTest to boot without a real tmux server. */
  function fakeTmux() {
    const sessions = new Set<string>();
    const exec = async (args: string[]): Promise<ExecResult> => {
      if (args.includes("new-session")) {
        sessions.add(args[args.indexOf("-s") + 1]);
        return { stdout: "", stderr: "" };
      }
      if (args[2] === "has-session") throw new Error("can't find session");
      if (args[2] === "list-panes" || args[2] === "list-sessions") {
        if (sessions.size === 0) throw new Error("no server running");
        return { stdout: "", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    };
    return new TmuxService(exec);
  }

  // PROTOCOL IDENTIFIER — verify_task checks this exact test name; never rename or remove it. The body is
  // the flagship t-88ef8c acceptance scenario (both sub-fixes together, end to end, through the REAL
  // Workspace activation path) — the remaining scenarios live in the describe block below.
  it("sockfix4Behavior", async () => {
    const root = longWorkspaceRoot();
    fs.writeFileSync(path.join(root, "tachyon.yml"), "agents:\n  idle:\n    cmd: sh\n", "utf8");
    const host = new FakeHost(fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-sockfix-storage-")));
    dirs.push(host.globalStoragePath());
    const tmux = fakeTmux();

    // Simulates ANY persistent-proxy start failure (connect EINVAL, systemd unavailable, ...) — the
    // regression this test exists for is the *degrade*, not the specific error shape.
    const ensure = vi
      .spyOn(PersistentBridgeService.prototype, "ensureAndRegister")
      .mockRejectedValue(Object.assign(new Error("connect EINVAL"), { code: "EINVAL" }));

    let ws: Workspace | undefined;
    try {
      ws = await Workspace.createForTest(root, { host, onViewsChanged: () => {} }, { tmux, persistentBridge: true });

      // (1) activation completed — no ctl anchor left dead: a real in-process Bridge is listening.
      const port = ws.bridge.listenerPort;
      expect(port).toBeDefined();
      expect(port).toBe(derivePort(workspaceHash(root)));

      // (2) it is genuinely reachable — proves "serves in-process", not just an internal flag.
      await new Promise<void>((resolve, reject) => {
        const socket = net.createConnection({ host: "127.0.0.1", port: port! }, () => {
          socket.end();
          resolve();
        });
        socket.once("error", reject);
      });

      // (3) exactly one degrade warning, no fatal "Retry Bridge" abort prompt.
      expect(host.notices.filter((n) => n.level === "warn")).toHaveLength(1);
      expect(host.notices.some((n) => n.actions.some((a) => a.label === "Retry Bridge"))).toBe(false);
      expect(host.notices.filter((n) => n.level === "error")).toEqual([]);

      // (4) Doctor still has something to show for it.
      expect(ws.bridgeStartFailureInfo()?.code).toBe("BRIDGE_START_FAILED");
    } finally {
      await ws?.dispose();
      ensure.mockRestore();
    }
  });
});

describe("sockfix4Behavior — t-88ef8c control-socket path-length + degradation scenarios", () => {
  it("keeps the control socket short (sun_path-safe) for a workspace root long enough to have triggered raw EINVAL", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-sockfix-longpath-"));
    const root = path.join(base, "worktrees", "b349073a-1111-2222-3333-444455556666", "sockfix-agent-checkout");
    fs.mkdirSync(root, { recursive: true });
    try {
      const legacy = legacyPersistentBridgeControlSocket(root);
      // Confirms this test actually reproduces the historical bug shape before proving the fix.
      expect(Buffer.byteLength(legacy, "utf8")).toBeGreaterThan(MAX_CONTROL_SOCKET_PATH_BYTES);

      const socket = persistentBridgeControlSocket(root);
      expect(Buffer.byteLength(socket, "utf8")).toBeLessThanOrEqual(MAX_CONTROL_SOCKET_PATH_BYTES);
      expect(socket).not.toContain(root);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  // The classic AF_UNIX sun_path budget is 108 bytes on Linux (104 on macOS), NUL terminator included.
  // These cases walk the legacy (workspace-rooted) derivation across that boundary — just under, exactly
  // at, and just over — to prove two things: the historical bug shape really does start failing right at
  // the documented limit, and the new derivation is root-length-INVARIANT, so it never approaches the
  // limit regardless of where the legacy path landed relative to the boundary.
  const AF_UNIX_SUN_PATH_LIMIT = 108;
  it.each([
    { label: "just under the 108-byte sun_path limit", targetLegacyBytes: AF_UNIX_SUN_PATH_LIMIT - 1 },
    { label: "exactly at the 108-byte sun_path limit", targetLegacyBytes: AF_UNIX_SUN_PATH_LIMIT },
    { label: "just over the 108-byte sun_path limit", targetLegacyBytes: AF_UNIX_SUN_PATH_LIMIT + 1 },
    { label: "far over the 108-byte sun_path limit (real-world worktree depth)", targetLegacyBytes: 260 },
  ])("stays sun_path-safe at a workspace root sized $label", ({ targetLegacyBytes }) => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-sockfix-boundary-"));
    // legacyPersistentBridgeControlSocket appends "/.tachyon/bridge-service/control.sock" to the root;
    // pad the root itself so the resulting legacy byte length lands exactly on the target.
    const suffixBytes = Buffer.byteLength(legacyPersistentBridgeControlSocket(base), "utf8") - Buffer.byteLength(base, "utf8");
    const padTarget = Math.max(0, targetLegacyBytes - suffixBytes - Buffer.byteLength(base, "utf8") - 1);
    const root = path.join(base, "p".repeat(padTarget));
    fs.mkdirSync(root, { recursive: true });
    try {
      const legacy = legacyPersistentBridgeControlSocket(root);
      expect(Buffer.byteLength(legacy, "utf8")).toBe(targetLegacyBytes);

      const socket = persistentBridgeControlSocket(root);
      expect(Buffer.byteLength(socket, "utf8")).toBeLessThanOrEqual(MAX_CONTROL_SOCKET_PATH_BYTES);
      expect(Buffer.byteLength(socket, "utf8")).toBeLessThan(AF_UNIX_SUN_PATH_LIMIT);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it("derives an identical socket length no matter how deep the workspace root is nested — root-invariant, not root-truncated", () => {
    const shallow = path.join(os.tmpdir(), "short-root");
    const deep = path.join(os.tmpdir(), "d".repeat(50), "e".repeat(50), "f".repeat(50), "g".repeat(50));
    fs.mkdirSync(deep, { recursive: true });
    try {
      expect(Buffer.byteLength(persistentBridgeControlSocket(shallow), "utf8")).toBe(
        Buffer.byteLength(persistentBridgeControlSocket(deep), "utf8"),
      );
    } finally {
      fs.rmSync(deep, { recursive: true, force: true });
    }
  });
});
