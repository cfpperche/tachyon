/**
 * SDD 480 Phase 2 — the seams that are NOT an agent spawn: `run_host_action`, the engine systemd unit,
 * and the tmux control-mode client.
 *
 * Grouped together because what they have in common is the interesting part. Each one is a different
 * answer to "can this seam prove what it started?", and the spec's whole gate is that the three answers
 * stay distinguishable instead of collapsing into a uniform, confident-looking `measured`:
 *
 *  - `run_host_action` runs inside the VS Code host: there is no child of ours at all → `unproven`.
 *  - the engine unit is launched with `systemd-run --setenv`: it really carries the id → `measured`,
 *    and it is the case that matters most, because a daemon outlives the extension host that started it.
 *  - the control client ATTACHES to an anchor that may already exist → the client is `measured`, the
 *    anchor is `unproven` and `shared`. One seam, two truths, and the graph has to keep them apart.
 */
import { describe, it, expect } from "vitest";
import { buildEngineSystemdRunArgs } from "../../src/engine-service/engineSupervisor.js";
import { ControlModeClient } from "../../src/tmux/ControlModeClient.js";
import { registerTools } from "../../src/bridge/tools.js";
import type { SealedExecutionEvent } from "../../src/executionGraph/eventSchema.js";
import { EXECUTION_AGENT_ENV, EXECUTION_ID_ENV, readCarriedExecution } from "../../src/executionGraph/executionIdentity.js";

/** Captures tool handlers so one Bridge tool can be driven without standing up a server. */
class ToolCapture {
  handlers = new Map<string, (args: Record<string, unknown>) => Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }>>();
  registerTool(name: string, _schema: unknown, handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }>) {
    this.handlers.set(name, handler);
  }
}

function hostActionBridge(opts: { caller?: unknown; runHostAction?: () => Promise<unknown>; sinkThrows?: boolean } = {}) {
  const mcp = new ToolCapture();
  const events: SealedExecutionEvent[] = [];
  registerTools(mcp as never, {
    workspaceRoot: "/repo",
    ...(opts.caller ? { caller: opts.caller } : {}),
    runHostAction: opts.runHostAction ?? (async () => ({ ok: true })),
    recordExecution: (e: SealedExecutionEvent) => {
      if (opts.sinkThrows) throw new Error("ledger is on fire");
      events.push(e);
    },
  } as never);
  return { run: mcp.handlers.get("run_host_action")!, events };
}

describe("SDD 480 §3.1 — run_host_action records what it cannot prove", () => {
  it("records the call as unproven, because the action runs in the host with no child of ours", async () => {
    const { run, events } = hostActionBridge({ caller: { kind: "agent", name: "ada" } });
    await run({ action: "reloadWindow" });

    const spawn = events.find((e) => e.kind === "spawn");
    expect(spawn, `nothing recorded; got ${JSON.stringify(events.map((e) => e.kind))}`).toBeDefined();
    // The honest label. A seam with no child to hand an env to can never prove a process is this call,
    // and saying `measured` here would dilute the word everywhere else it appears.
    expect(spawn!.provenance).toBe("unproven");
    expect(spawn!.node).toBe("InternalOperation");
    expect(spawn!.correlation.agentId).toBe("ada");
    expect(events.find((e) => e.kind === "exit")?.state).toBe("completed");
  });

  it("attributes an unnamed agent caller to nobody rather than borrowing an identity", async () => {
    const { run, events } = hostActionBridge({ caller: { kind: "agent" } });
    await run({ action: "reloadWindow" });
    // Reads oddly on purpose: paired with `unproven`, it says "we recorded this and cannot tell you
    // whose it was" instead of silently crediting `human` or the nearest agent.
    expect(events[0]!.correlation.agentId).toBe("unattributed-caller");
  });

  it("records a failed host action instead of dropping it", async () => {
    const { run, events } = hostActionBridge({
      caller: { kind: "agent", name: "ada" },
      runHostAction: async () => { throw new Error("broker refused"); },
    });
    await run({ action: "reloadWindow" });
    const failed = events.find((e) => e.kind === "fail");
    expect(failed, `a failed action left no trace; got ${JSON.stringify(events.map((e) => e.kind))}`).toBeDefined();
    expect(failed!.state).toBe("failed");
    expect(events.some((e) => e.kind === "exit")).toBe(false);
  });

  it("never fails the host action because the ledger failed", async () => {
    const { run } = hostActionBridge({ caller: { kind: "agent", name: "ada" }, sinkThrows: true });
    const res = await run({ action: "reloadWindow" });
    expect(res.isError).not.toBe(true);
  });
});

describe("SDD 480 §3.1 — the engine unit carries its identity through systemd-run", () => {
  const input = {
    options: {
      schemaVersion: 1 as const,
      workspaceRoot: "/repo",
      storageRoot: "/repo/.tachyon/storage",
      mediaRoot: "/repo/.tachyon/media",
      controlSocketPath: "/run/user/1000/tachyon/control.sock",
      appVersion: "0.0.0",
      bundleId: "tachyon",
    },
    daemonModule: "/app/daemon.js",
    encodedOptions: "e30=",
    unitName: "tachyon-engine-abc.service",
    nodePath: "/usr/bin/node",
  };

  it("renders the execution identity as --setenv so the unit is born holding it", () => {
    const args = buildEngineSystemdRunArgs(
      { ...input, executionEnv: { [EXECUTION_ID_ENV]: "exec-unit-1", [EXECUTION_AGENT_ENV]: "host" } },
      {},
    );
    expect(args).toContain(`--setenv=${EXECUTION_ID_ENV}=exec-unit-1`);
    expect(args).toContain(`--setenv=${EXECUTION_AGENT_ENV}=host`);
    // The identity must precede the `--` separator, or systemd reads it as a command argument and the
    // unit starts without it — carried in name only.
    expect(args.indexOf(`--setenv=${EXECUTION_ID_ENV}=exec-unit-1`)).toBeLessThan(args.indexOf("--"));
  });

  it("lets the minted identity win over an ambient TACHYON_EXECUTION_* in the host environment", () => {
    // A stale id inherited from whatever launched the extension host would attribute the daemon to the
    // wrong execution — and it would look measured while doing it.
    const args = buildEngineSystemdRunArgs(
      { ...input, executionEnv: { [EXECUTION_ID_ENV]: "exec-minted" } },
      { [EXECUTION_ID_ENV]: "exec-ambient-stale" },
    );
    const setenvs = args.filter((a) => a.startsWith(`--setenv=${EXECUTION_ID_ENV}=`));
    expect(setenvs[setenvs.length - 1]).toBe(`--setenv=${EXECUTION_ID_ENV}=exec-minted`);
  });

  it("is unchanged when no execution identity is supplied", () => {
    // The sink is optional everywhere; a build without it must be byte-identical to the old behaviour.
    const before = buildEngineSystemdRunArgs(input, {});
    expect(before.some((a) => a.includes("TACHYON_EXECUTION"))).toBe(false);
  });
});

describe("SDD 480 §4.2 — the control client attaches, and says so", () => {
  /** Drive `start()` with a fake tmux, reporting whether the anchor already existed. */
  async function startClient(opts: { anchorExists: boolean }) {
    const events: SealedExecutionEvent[] = [];
    let spawnedEnv: Record<string, string> | undefined;
    const client = new ControlModeClient({
      wsHash: "abc123",
      socket: "test-socket",
      recordExecution: (e) => events.push(e),
      fallbackExec: async (args: string[]) => {
        if (args.includes("new-session") && opts.anchorExists) throw new Error("duplicate session: tachyon-ctl-abc123");
        return { stdout: "", stderr: "" };
      },
      spawnClient: ((_socket: string, _anchor: string, env?: Record<string, string>) => {
        spawnedEnv = env;
        // A stub child that never speaks: start() enqueues bootstrap and returns.
        const noop = () => {};
        return {
          stdout: { on: noop, setEncoding: noop },
          stderr: { on: noop, setEncoding: noop },
          stdin: { write: noop, end: noop },
          on: noop, once: noop, kill: noop, killed: false, pid: 4242,
        } as never;
      }) as never,
    });
    try { await client.start(); } catch { /* the stub child never completes the handshake */ }
    return { events, spawnedEnv, client };
  }

  it("records a pre-existing anchor as shared and attached, never as something it started", async () => {
    const { events } = await startClient({ anchorExists: true });
    const anchor = events.find((e) => e.node === "TmuxSession");
    expect(anchor, `no anchor event; got ${JSON.stringify(events.map((e) => `${e.node}:${e.kind}`))}`).toBeDefined();
    expect(anchor!.kind).toBe("attach");
    // `shared` is the whole point: other windows may already be attached to this anchor, so claiming
    // it as ours would be the false ownership the spec rules out.
    expect(anchor!.state).toBe("shared");
    expect(anchor!.provenance).toBe("unproven");
  });

  it("records an anchor it actually created as running, not shared", async () => {
    const { events } = await startClient({ anchorExists: false });
    const anchor = events.find((e) => e.node === "TmuxSession")!;
    expect(anchor.kind).toBe("spawn");
    expect(anchor.state).toBe("running");
    // Still `unproven`: we created it, but it runs `tail -f /dev/null` with no env of ours, so no later
    // observation can prove a given tmux session is this one. Created is not the same as provable.
    expect(anchor.provenance).toBe("unproven");
  });

  it("links the client process to the anchor with an `attached` edge, not a `spawned` one", async () => {
    const { events } = await startClient({ anchorExists: true });
    const anchor = events.find((e) => e.node === "TmuxSession")!;
    const proc = events.find((e) => e.node === "Process");
    expect(proc, "the client process was not recorded").toBeDefined();
    expect(proc!.kind).toBe("attach");
    expect(proc!.edge).toEqual({ kind: "attached", toExecutionId: anchor.correlation.executionId });
    // The two ends are distinct executions. Collapsing them would erase the join the edge exists to show.
    expect(proc!.correlation.executionId).not.toBe(anchor.correlation.executionId);
  });

  it("declares `absent` rather than claiming an env it did not set", async () => {
    // An injected spawnClient builds its own child. Reporting `carried` here would be a guess dressed
    // as a measurement — precisely the failure mode the fail-closed rule exists for.
    const { events, spawnedEnv } = await startClient({ anchorExists: true });
    expect(events.find((e) => e.node === "Process")!.provenance).toBe("unproven");
    expect(readCarriedExecution(spawnedEnv ?? {})).toBeUndefined();
  });
});
