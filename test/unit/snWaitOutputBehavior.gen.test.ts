import { describe, it, expect, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Bridge } from "../../src/bridge/Bridge.js";
import { CallerIdentityRegistry } from "../../src/bridge/callerIdentity.js";
import { AgentManager } from "../../src/agents/AgentManager.js";
import { TmuxService, workspaceHash, type ExecResult } from "../../src/tmux/TmuxService.js";
import { parseConfig } from "../../src/config/loadConfig.js";
import { PinStore } from "../../src/pins/PinStore.js";
import { TaskStore } from "../../src/tasks/TaskStore.js";
import { ValidationStore } from "../../src/validations/ValidationStore.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * t-fe5dbe — wait_for_output over a REAL Bridge + per-agent token registry, with tmux entirely faked
 * (staged pane content the test controls directly). Covers the 4 required behaviors: a match arriving
 * after the call started resolves met:true with a bounded excerpt; a match that never arrives times out
 * with a bounded tail; a caller outside the lineage-scope policy is refused, not hung; and content that
 * was already on screen before the call started (baseline) does NOT count as a match.
 */

const WS = "/repo-wait-output";
const HASH = workspaceHash(WS);
const MASTER = "e".repeat(64);
const SCOPE = { workspaceId: "ws-wait-output", instanceId: "inst-wait-output" };

function fakeTmuxExec() {
  const sessions = new Set<string>();
  const panes = new Map<string, string>();
  const exec = async (args: string[]): Promise<ExecResult> => {
    const target = () => args[args.indexOf("-t") + 1].replace(/^=/, "").replace(/:$/, "");
    if (args.includes("new-session")) {
      sessions.add(args[args.indexOf("-s") + 1]);
      return { stdout: "", stderr: "" };
    }
    switch (args[2]) {
      case "has-session":
        if (!sessions.has(target())) throw new Error("can't find session");
        return { stdout: "", stderr: "" };
      case "kill-session":
        if (!sessions.delete(target())) throw new Error("can't find session");
        panes.delete(target());
        return { stdout: "", stderr: "" };
      case "list-sessions":
        if (sessions.size === 0) throw new Error("no server");
        return { stdout: [...sessions].join("\n"), stderr: "" };
      case "list-panes":
        if (sessions.size === 0) throw new Error("no server");
        return { stdout: [...sessions].map((s) => `${s}\t0\t`).join("\n"), stderr: "" };
      case "capture-pane": {
        if (!sessions.has(target())) throw new Error("can't find session");
        const raw = panes.get(target()) ?? "";
        const start = args.indexOf("-S");
        if (start >= 0) {
          const n = Math.abs(Number(args[start + 1]));
          return { stdout: raw.split("\n").slice(-n).join("\n"), stderr: "" };
        }
        return { stdout: raw, stderr: "" };
      }
      default:
        return { stdout: "", stderr: "" };
    }
  };
  return { sessions, panes, exec };
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("container-generated delegation behavior", () => {
  it("wait_for_output blocks until pane output matches and refuses out-of-scope callers", async () => {
    const { panes, exec } = fakeTmuxExec();
    const config = parseConfig("agents:\n  watcher:\n    cmd: sh\n  stranger:\n    cmd: sh\n").config;
    const tmux = new TmuxService(exec);
    const manager = new AgentManager({ tmux, wsHash: HASH, workspaceRoot: WS, getConfig: () => config });
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-wait-output-"));
    dirs.push(root);
    const pins = new PinStore(root);
    const tasks = new TaskStore(root);
    const validations = new ValidationStore(root);
    const registry = new CallerIdentityRegistry(Buffer.from("f".repeat(64), "hex"));
    const watcherToken = registry.mint("watcher", SCOPE);

    const bridge = new Bridge(
      { workspaceRoot: root, manager, tmux, pins, tasks, validations, notify: () => {} },
      { token: MASTER, getRegistry: () => registry, scope: SCOPE, legacyCompatEnabled: true },
    );
    await bridge.start();
    await manager.spawn("watcher");
    await manager.spawn("stranger");

    const watcherClient = new Client({ name: "watcher", version: "0.0.1" });
    await watcherClient.connect(
      new StreamableHTTPClientTransport(new URL(bridge.url!), { requestInit: { headers: { Authorization: `Bearer ${watcherToken}` } } }),
    );

    try {
      const session = manager.session("watcher");

      // (c) out-of-scope caller: 'watcher' never spawned 'stranger' and shares no parent with it —
      // refused with a structured error naming the policy, not a hang.
      const scoped = await watcherClient.callTool({
        name: "wait_for_output",
        arguments: { name: "stranger", match: "anything", timeoutSec: 1, agent: "watcher" },
      });
      expect(scoped.isError).toBe(true);
      expect(JSON.stringify(scoped.content)).toContain("out of scope");
      expect(JSON.stringify(scoped.content)).toContain("wait_for_output refused");

      // (d) baseline semantics: the match text is ALREADY on screen before the call starts — it must
      // NOT count, since only output beyond the call-start baseline is eligible.
      panes.set(session, "boot line\nalready ready marker\n");
      const baselineResult = await watcherClient.callTool({
        name: "wait_for_output",
        arguments: { name: "watcher", match: "already ready marker", timeoutSec: 1, agent: "watcher" },
      });
      const baseline = JSON.parse((baselineResult.content as Array<{ text: string }>)[0].text);
      expect(baseline.met).toBe(false);
      expect(baseline.state).toBe("timeout");

      // (b) timeout: a match that never arrives at all resolves met:false with a bounded current tail.
      panes.set(session, "steady state, nothing new here\n");
      const timeoutResult = await watcherClient.callTool({
        name: "wait_for_output",
        arguments: { name: "watcher", match: "never-appears-token", timeoutSec: 1, agent: "watcher" },
      });
      const timedOut = JSON.parse((timeoutResult.content as Array<{ text: string }>)[0].text);
      expect(timedOut.met).toBe(false);
      expect(timedOut.state).toBe("timeout");
      expect(typeof timedOut.tail).toBe("string");
      expect(timedOut.tail).toContain("steady state, nothing new here");
      expect(timedOut.waitedMs).toBeGreaterThanOrEqual(900);

      // (a) match arrives after the call started: resolves met:true with a bounded excerpt (matching
      // line ± a few lines of context) that includes neither the old baseline nor lines far outside
      // that context window.
      panes.set(session, "old baseline line\n");
      const matchPromise = watcherClient.callTool({
        name: "wait_for_output",
        arguments: { name: "watcher", match: "service ready on port 3000", timeoutSec: 3, agent: "watcher" },
      });
      await sleep(150);
      panes.set(
        session,
        ["old baseline line", "AAA-far-above", "BBB", "CCC", "DDD", "service ready on port 3000", "EEE", "FFF", "GGG", "HHH-far-below", "III-far-below"].join(
          "\n",
        ),
      );
      const matchResult = await matchPromise;
      const matched = JSON.parse((matchResult.content as Array<{ text: string }>)[0].text);
      expect(matched.met).toBe(true);
      expect(matched.excerpt).toContain("service ready on port 3000");
      expect(matched.excerpt).not.toContain("old baseline line");
      expect(matched.excerpt).not.toContain("AAA-far-above");
      expect(matched.excerpt).not.toContain("HHH-far-below");
      expect(matched.excerpt).not.toContain("III-far-below");
      expect(matched.excerpt).toContain("CCC");
      expect(matched.excerpt).toContain("FFF");
    } finally {
      await watcherClient.close();
      await bridge.dispose();
    }
  });

  it("redacts known secrets from a matched excerpt and from a timeout tail", async () => {
    const { panes, exec } = fakeTmuxExec();
    const config = parseConfig("agents:\n  watcher:\n    cmd: sh\n").config;
    const tmux = new TmuxService(exec);
    const manager = new AgentManager({ tmux, wsHash: HASH, workspaceRoot: WS, getConfig: () => config });
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-wait-output-"));
    dirs.push(root);
    const pins = new PinStore(root);
    const tasks = new TaskStore(root);
    const validations = new ValidationStore(root);
    const registry = new CallerIdentityRegistry(Buffer.from("f".repeat(64), "hex"));
    const watcherToken = registry.mint("watcher", SCOPE);

    const bridge = new Bridge(
      { workspaceRoot: root, manager, tmux, pins, tasks, validations, notify: () => {} },
      { token: MASTER, getRegistry: () => registry, scope: SCOPE, legacyCompatEnabled: true },
    );
    await bridge.start();
    await manager.spawn("watcher");

    const watcherClient = new Client({ name: "watcher", version: "0.0.1" });
    await watcherClient.connect(
      new StreamableHTTPClientTransport(new URL(bridge.url!), { requestInit: { headers: { Authorization: `Bearer ${watcherToken}` } } }),
    );

    try {
      const session = manager.session("watcher");

      // Matched excerpt: the matching line carries a bare env-var-shaped secret. read_output would
      // redact this (tools.ts:1179); wait_for_output must apply the same redactSecrets pass.
      panes.set(session, "boot line\n");
      const matchPromise = watcherClient.callTool({
        name: "wait_for_output",
        arguments: { name: "watcher", match: "TACHYON_BRIDGE_TOKEN", timeoutSec: 3, agent: "watcher" },
      });
      await sleep(150);
      panes.set(session, "boot line\nTACHYON_BRIDGE_TOKEN=supersecret leaked here\n");
      const matchResult = await matchPromise;
      const matched = JSON.parse((matchResult.content as Array<{ text: string }>)[0].text);
      expect(matched.met).toBe(true);
      expect(matched.excerpt).toContain("[redacted]");
      expect(matched.excerpt).not.toContain("supersecret");

      // Timeout tail: same secret shape, but reached only via the no-match tail path.
      panes.set(session, "TACHYON_BRIDGE_TOKEN=supersecret leaked here\n");
      const timeoutResult = await watcherClient.callTool({
        name: "wait_for_output",
        arguments: { name: "watcher", match: "never-appears-token", timeoutSec: 1, agent: "watcher" },
      });
      const timedOut = JSON.parse((timeoutResult.content as Array<{ text: string }>)[0].text);
      expect(timedOut.met).toBe(false);
      expect(timedOut.tail).toContain("[redacted]");
      expect(timedOut.tail).not.toContain("supersecret");
    } finally {
      await watcherClient.close();
      await bridge.dispose();
    }
  });

  it("rejects a `regex` param instead of silently ignoring it (regex support was removed for ReDoS safety)", async () => {
    const { exec } = fakeTmuxExec();
    const config = parseConfig("agents:\n  watcher:\n    cmd: sh\n").config;
    const tmux = new TmuxService(exec);
    const manager = new AgentManager({ tmux, wsHash: HASH, workspaceRoot: WS, getConfig: () => config });
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-wait-output-"));
    dirs.push(root);
    const pins = new PinStore(root);
    const tasks = new TaskStore(root);
    const validations = new ValidationStore(root);
    const registry = new CallerIdentityRegistry(Buffer.from("f".repeat(64), "hex"));
    const watcherToken = registry.mint("watcher", SCOPE);

    const bridge = new Bridge(
      { workspaceRoot: root, manager, tmux, pins, tasks, validations, notify: () => {} },
      { token: MASTER, getRegistry: () => registry, scope: SCOPE, legacyCompatEnabled: true },
    );
    await bridge.start();
    await manager.spawn("watcher");

    const watcherClient = new Client({ name: "watcher", version: "0.0.1" });
    await watcherClient.connect(
      new StreamableHTTPClientTransport(new URL(bridge.url!), { requestInit: { headers: { Authorization: `Bearer ${watcherToken}` } } }),
    );

    try {
      const rejected = await watcherClient.callTool({
        name: "wait_for_output",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        arguments: { name: "watcher", match: "x", regex: true, timeoutSec: 1, agent: "watcher" } as any,
      });
      expect(rejected.isError).toBe(true);
      expect(JSON.stringify(rejected.content).toLowerCase()).toContain("regex");
    } finally {
      await watcherClient.close();
      await bridge.dispose();
    }
  });
});
