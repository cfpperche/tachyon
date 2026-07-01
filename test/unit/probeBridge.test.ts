import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { registerTools, type BridgeDeps } from "../../src/bridge/tools.js";
import { DEFAULT_PROBE_TIMEOUT_MS, ProbeService } from "../../src/probe/ProbeService.js";
import { ProbeStore } from "../../src/probe/ProbeStore.js";
import type { HeadlessCaptureAdapter, ProbeSpec, RawOutcome } from "../../src/probe/adapters/types.js";
import type { ProbeResult } from "../../src/probe/taxonomy.js";

/** A fake MCP server that just captures tool handlers. */
class FakeMcp {
  handlers = new Map<string, (args: Record<string, unknown>) => Promise<{ content: { text: string }[]; isError?: boolean }>>();
  registerTool(name: string, _def: unknown, handler: (args: Record<string, unknown>) => Promise<{ content: { text: string }[]; isError?: boolean }>) {
    this.handlers.set(name, handler);
  }
}

const VALID = '{"findings":[{"title":"t","severity":"major","problem":"p"}]}';
function adapter(): HeadlessCaptureAdapter {
  return {
    runtime: "claude",
    adapterVersion: "1",
    buildInvocation: (s: ProbeSpec) => ({ cmd: "claude", args: [], cwd: s.cwd }),
    interpret: (_r: RawOutcome): ProbeResult => ({ reason: "ok", lastMessage: "", exitCode: 0, timedOut: false, native: { runtime: "claude" } }),
    detectCapability: async () => ({ available: true, binaryVersion: "1.2.3" }),
  };
}

let root: string;
let mcp: FakeMcp;
function wire(over: Partial<ProbeServiceWiring> = {}) {
  const service = new ProbeService({
    adapters: new Map([["claude", adapter()]]),
    store: new ProbeStore(root),
    runFn: over.runFn ?? (async () => ({ reason: "ok", lastMessage: VALID, exitCode: 0, timedOut: false, native: { runtime: "claude" } })),
  });
  mcp = new FakeMcp();
  const deps = {
    manager: undefined as never,
    tmux: undefined as never,
    pins: undefined as never,
    notify: () => {},
    probe: service,
    probeCwd: () => "/repo",
    probeSyncCapMs: over.probeSyncCapMs ?? 120_000,
  } satisfies Partial<BridgeDeps> as unknown as BridgeDeps;
  registerTools(mcp as never, deps);
  return service;
}
interface ProbeServiceWiring {
  runFn: ConstructorParameters<typeof ProbeService>[0]["runFn"];
  probeSyncCapMs: number;
}

async function call(name: string, args: Record<string, unknown>) {
  const handler = mcp.handlers.get(name);
  if (!handler) throw new Error(`tool not registered: ${name}`);
  const res = await handler(args);
  return JSON.parse(res.content[0]!.text) as { runId: string; status: string; result?: { reason: string; lastMessage: string } };
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "probe-bridge-"));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("probe_agent Bridge tool (D2/D3/OQ1)", () => {
  it("registers probe_agent + read_probe_result only when a ProbeService is present", () => {
    wire();
    expect(mcp.handlers.has("probe_agent")).toBe(true);
    expect(mcp.handlers.has("read_probe_result")).toBe(true);
  });

  it("sync: returns a completed envelope inline", async () => {
    wire();
    const env = await call("probe_agent", { runtime: "claude", archetype: "adversarial-review", task: "review", wait: "sync" });
    expect(env.status).toBe("completed");
    expect(env.result?.reason).toBe("ok");
    expect(env.runId).toMatch(/^probe-/);
  });

  it("async: returns status running + a runId immediately, readable later", async () => {
    wire();
    const started = await call("probe_agent", { runtime: "claude", archetype: "adversarial-review", task: "review", wait: "async" });
    expect(started.status).toBe("running");
    // the run completes in the background; poll read_probe_result until it lands
    let env = started;
    for (let i = 0; i < 50 && env.status === "running"; i++) {
      await new Promise((r) => setTimeout(r, 5));
      env = await call("read_probe_result", { runId: started.runId });
    }
    expect(env.status).toBe("completed");
  });

  it("sync cap overflow → status running + runId (never a hung call), OQ1", async () => {
    // a runFn that never resolves + a tiny sync cap forces the overflow path
    wire({ runFn: () => new Promise<ProbeResult>(() => {}), probeSyncCapMs: 20 });
    const env = await call("probe_agent", { runtime: "claude", archetype: "adversarial-review", task: "slow review", wait: "sync" });
    expect(env.status).toBe("running");
    expect(env.runId).toMatch(/^probe-/);
  });

  it("sync cap is shorter than the default subprocess timeout", async () => {
    let seenTimeoutMs = 0;
    wire({
      runFn: async (_adapter, spec) => {
        seenTimeoutMs = spec.timeoutMs;
        return new Promise<ProbeResult>(() => {});
      },
      probeSyncCapMs: 20,
    });
    const env = await call("probe_agent", { runtime: "claude", archetype: "adversarial-review", task: "slow review", wait: "sync" });
    expect(env.status).toBe("running");
    expect(seenTimeoutMs).toBe(DEFAULT_PROBE_TIMEOUT_MS);
    expect(seenTimeoutMs).toBeGreaterThan(20);
  });

  it("explicit timeoutSec remains authoritative", async () => {
    let seenTimeoutMs = 0;
    wire({
      runFn: async (_adapter, spec) => {
        seenTimeoutMs = spec.timeoutMs;
        return { reason: "timeout", lastMessage: "timed out", exitCode: null, timedOut: true, native: { runtime: "claude" } };
      },
    });
    await call("probe_agent", { runtime: "claude", archetype: "adversarial-review", task: "slow review", wait: "sync", timeoutSec: 7 });
    expect(seenTimeoutMs).toBe(7_000);
  });

  it("read_probe_result on a bogus runId is a not-found error, NOT an eternal running (codex review #2)", async () => {
    wire();
    const handler = mcp.handlers.get("read_probe_result")!;
    const res = await handler({ runId: "probe-does-not-exist" });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/no probe with runId/);
  });
});
