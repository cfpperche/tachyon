import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Workspace } from "../../src/workspace/Workspace.js";
import type { EngineHost, NoticeAction, ViewKind } from "../../src/workspace/EngineHost.js";
import { TmuxService, type ExecResult } from "../../src/tmux/TmuxService.js";
import type { NotifyLevel } from "../../src/bridge/tools.js";
import { CallerIdentityRegistry } from "../../src/bridge/callerIdentity.js";
import { writeCanonicalAgent, canonicalAgentSecrets, canonicalAgentsYaml } from "../helpers/canonicalAgentFixture.js";

/**
 * spec 351 T6 — the resume-env integration proof. Two scenarios:
 *  1. An explicit resume/restart mints a FRESH per-agent token and the recreated session's env carries it
 *     (new-session `-e` on first spawn; respawn-pane + set-environment on restart — t-4d2630 — captured
 *     from the fake exec's argv).
 *  2. The stale-pane case: a tmux session SURVIVING an extension-host reload (Tachyon's core "sessions
 *     outlive the editor" promise) must not be silently stranded on a pre-reload token. Proven by
 *     constructing a SECOND Workspace over the SAME shared host storage + the SAME surviving tmux session
 *     state, and confirming the pre-reload token still authenticates (the workspaceState registry-reload +
 *     persisted-instanceId fix this spec's T6 pass added).
 */

/** A host whose state/secrets are backed by INJECTED shared maps, so two instances can simulate
 *  "same machine, same workspace, reloaded window" by sharing the same backing storage. */
class SharedHost implements EngineHost {
  constructor(
    private readonly storageDir: string,
    private readonly stateMap: Map<string, unknown>,
    private readonly secretsMap: Map<string, string>,
  ) {}
  t(message: string, ...args: (string | number | boolean)[]): string {
    return message.replace(/\{(\d+)\}/g, (_m, i) => String(args[Number(i)] ?? ""));
  }
  notify(_message: string, _level: NotifyLevel = "info", _actions?: NoticeAction[]): void {}
  focusPrimaryView(): void {}
  openTask(): void {}
  executeCommand(command: string): Promise<unknown> {
    return Promise.reject(new Error(`unexpected host command in headless test: ${command}`));
  }
  watch(): { dispose(): void } {
    return { dispose() {} };
  }
  gitExtensionPath(): string | string[] | undefined { return undefined; }
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
    return Promise.resolve(this.secretsMap.get(key));
  }
  setSecret(key: string, value: string): Promise<void> {
    this.secretsMap.set(key, value);
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
}

/** fake-exec tmux that survives across two Workspace instances (module-level session state) and captures
 *  every start (new-session / respawn-pane) argv so injected env is directly inspectable. */
function survivingTmux() {
  const sessions = new Set<string>();
  const newSessionCalls: string[][] = [];
  const startCalls: string[][] = []; // new-session OR respawn-pane (chronological)
  const exec = async (args: string[]): Promise<ExecResult> => {
    if (args.includes("new-session")) {
      sessions.add(args[args.indexOf("-s") + 1]);
      newSessionCalls.push(args);
      startCalls.push(args);
      return { stdout: "", stderr: "" };
    }
    if (args.includes("respawn-pane")) {
      const t = args[args.indexOf("-t") + 1]?.replace(/^=/, "").replace(/:$/, "");
      if (!t || !sessions.has(t)) throw new Error("can't find session");
      startCalls.push(args);
      return { stdout: "", stderr: "" };
    }
    const target = () => args[args.indexOf("-t") + 1]?.replace(/^=/, "").replace(/:$/, "");
    switch (args[2]) {
      case "has-session":
        if (!sessions.has(target())) throw new Error("can't find session");
        return { stdout: "", stderr: "" };
      case "show-environment":
        // t-4d2630: respawnPane reads session env before unset/set; empty is fine for token proofs.
        if (!sessions.has(target())) throw new Error("can't find session");
        return { stdout: "", stderr: "" };
      case "kill-session":
        sessions.delete(target());
        return { stdout: "", stderr: "" };
      case "list-sessions":
        if (sessions.size === 0) throw new Error("no server");
        return { stdout: [...sessions].join("\n"), stderr: "" };
      case "list-panes":
        if (sessions.size === 0) throw new Error("no server");
        return { stdout: [...sessions].map((s) => `${s}\t0\t`).join("\n"), stderr: "" };
      default:
        return { stdout: "", stderr: "" };
    }
  };
  return { sessions, newSessionCalls, startCalls, tmux: new TmuxService(exec) };
}

/** Read env from new-session `-e KEY=value` or respawn `set-environment -t … KEY value` (t-4d2630). */
function envValue(argv: string[], varName: string): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "-e" && argv[i + 1]?.startsWith(`${varName}=`)) return argv[i + 1].slice(varName.length + 1);
    if (argv[i] === "set-environment") {
      let j = i + 1;
      let unset = false;
      while (argv[j] === "-u" || argv[j] === "-r" || argv[j] === "-h" || argv[j] === "-g" || argv[j] === "-F") {
        if (argv[j] === "-u" || argv[j] === "-r") unset = true;
        j++;
      }
      if (argv[j] === "-t") j += 2;
      if (unset) continue; // -u NAME has no value
      if (argv[j] === varName) return argv[j + 1];
    }
  }
  return undefined;
}

describe("resume env integration proof (spec 351 T6)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  function mkdir(): string {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-resume-proof-"));
    dirs.push(d);
    return d;
  }

  it("restart (a session-recreation event, same env-injection path as resume) mints a FRESH token — the old one is revoked, the new one is in the recreated session's argv", async () => {
    const root = mkdir();
    // SDD 478 M7 — the token under proof is an AGENT's, so the agent is declared as one: a
    // canonical profile plus the host-custodied authority that attests it.
    const canonical = [writeCanonicalAgent(root, "claude", { runtime: "claude" })];
    fs.writeFileSync(path.join(root, "tachyon.yml"), canonicalAgentsYaml(canonical), "utf8");
    const stateMap = new Map<string, unknown>();
    const secretsMap = new Map<string, string>(canonicalAgentSecrets(root, canonical));
    const host = new SharedHost(mkdir(), stateMap, secretsMap);
    const { startCalls, tmux } = survivingTmux();
    const ws = await Workspace.createForTest(root, { host, onViewsChanged: () => {} }, { tmux, startBridge: false });
    try {
      await ws.manager.spawn("claude");
      const firstToken = envValue(startCalls.at(-1)!, "TACHYON_AGENT_BRIDGE_TOKEN");
      expect(firstToken).toBeTruthy();

      await ws.manager.restart("claude", { stop: "force", session: "new" });
      // t-4d2630: restart respawns in place; env arrives via set-environment, not a second new-session
      expect(startCalls.at(-1)).toContain("respawn-pane");
      const secondToken = envValue(startCalls.at(-1)!, "TACHYON_AGENT_BRIDGE_TOKEN");
      expect(secondToken).toBeTruthy();
      expect(secondToken).not.toBe(firstToken);

      // Resolve both against the SAME registry state persisted by this workspace (mirrors what Bridge.ts
      // would do): the pre-restart token is now token_revoked; the post-restart one resolves as "claude".
      const key = await secretHmacKey(secretsMap);
      const persisted = stateMap.get(`tachyon.callerIdentity.registry.${ws.wsHash}`) as never;
      const registry = new CallerIdentityRegistry(key, persisted);
      const scope = { workspaceId: ws.wsHash, instanceId: ws.bridgeInstanceId };
      expect(registry.resolve(firstToken!, scope)).toEqual({ ok: false, reason: "token_revoked" });
      expect(registry.resolve(secondToken!, scope)).toEqual({ ok: true, snapshot: { kind: "agent", name: "claude" } });
    } finally {
      ws.dispose();
    }
  });

  it("stale-pane case: a tmux session surviving an extension-host reload keeps its PRE-reload token valid (does not silently strand)", async () => {
    const root = mkdir();
    const canonical = [writeCanonicalAgent(root, "claude", { runtime: "claude" })];
    fs.writeFileSync(path.join(root, "tachyon.yml"), canonicalAgentsYaml(canonical), "utf8");
    const stateMap = new Map<string, unknown>(); // shared across "reload" — simulates the SAME machine's workspaceState
    // shared across "reload" — simulates the SAME machine's SecretStorage, including the agent authority
    const secretsMap = new Map<string, string>(canonicalAgentSecrets(root, canonical));
    const { sessions, newSessionCalls, tmux } = survivingTmux(); // shared — the tmux SERVER survives the reload

    const host1 = new SharedHost(mkdir(), stateMap, secretsMap);
    const ws1 = await Workspace.createForTest(root, { host: host1, onViewsChanged: () => {} }, { tmux, startBridge: false });
    await ws1.manager.spawn("claude");
    const preReloadToken = envValue(newSessionCalls.at(-1)!, "TACHYON_AGENT_BRIDGE_TOKEN");
    expect(preReloadToken).toBeTruthy();
    const instanceIdBefore = ws1.bridgeInstanceId;
    // Simulate a reload: dispose the EXTENSION HOST side (Workspace #1) but NOT the tmux session — it's a
    // real OS process tmux owns independently, exactly the scenario this proof targets.
    await ws1.dispose();
    expect(sessions.size).toBe(1); // the pane is still alive — nobody killed it

    // A brand-new Workspace instance (a fresh `new Workspace(...)` — the reload), same shared host storage.
    const host2 = new SharedHost(mkdir(), stateMap, secretsMap);
    const ws2 = await Workspace.createForTest(root, { host: host2, onViewsChanged: () => {} }, { tmux, startBridge: false });
    try {
      // The instance id and the registry state both carried over via the shared host storage.
      expect(ws2.bridgeInstanceId).toBe(instanceIdBefore);
      const key = await secretHmacKey(secretsMap);
      const persisted = stateMap.get(`tachyon.callerIdentity.registry.${ws2.wsHash}`) as never;
      const registry = new CallerIdentityRegistry(key, persisted);
      const scope = { workspaceId: ws2.wsHash, instanceId: ws2.bridgeInstanceId };
      // THE PROOF: the surviving pane's env still holds `preReloadToken` — Bridge.ts on ws2 must still
      // resolve it, or every surviving agent would be silently stranded on every reload.
      expect(registry.resolve(preReloadToken!, scope)).toEqual({ ok: true, snapshot: { kind: "agent", name: "claude" } });
    } finally {
      ws2.dispose();
    }
  });
});

/** Re-derive the HMAC key the way Workspace._create does, from the SAME shared SecretStorage map. */
async function secretHmacKey(secretsMap: Map<string, string>): Promise<Buffer> {
  const { loadOrCreateHmacKey } = await import("../../src/bridge/callerIdentity.js");
  return loadOrCreateHmacKey({
    getSecret: (k) => Promise.resolve(secretsMap.get(k)),
    setSecret: (k, v) => {
      secretsMap.set(k, v);
      return Promise.resolve();
    },
  });
}
