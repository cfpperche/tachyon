import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ProbeService, ProbeRejectedError, type ProbeRequest } from "../../src/probe/ProbeService.js";
import { ProbeStore } from "../../src/probe/ProbeStore.js";
import type { HeadlessCaptureAdapter, ProbeSpec, RawOutcome } from "../../src/probe/adapters/types.js";
import type { ProbeResult } from "../../src/probe/taxonomy.js";

let root: string;
let store: ProbeStore;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "probe-svc-"));
  store = new ProbeStore(root);
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

function fakeAdapter(available = true): HeadlessCaptureAdapter {
  return {
    runtime: "claude",
    adapterVersion: "1",
    buildInvocation: (spec: ProbeSpec) => ({ cmd: "claude", args: [], cwd: spec.cwd }),
    interpret: (_raw: RawOutcome): ProbeResult => ({ reason: "ok", lastMessage: "", exitCode: 0, timedOut: false, native: { runtime: "claude" } }),
    detectCapability: async () => (available ? { available: true, binaryVersion: "1.2.3" } : { available: false, reason: "not installed" }),
  };
}

const VALID_REVIEW = '{"findings":[{"title":"t","severity":"major","problem":"p"}],"mostImportant":"t"}';
function okResult(lastMessage: string): ProbeResult {
  return { reason: "ok", lastMessage, exitCode: 0, timedOut: false, native: { runtime: "claude" } };
}
function svc(over: Partial<ConstructorParameters<typeof ProbeService>[0]> = {}) {
  return new ProbeService({ adapters: new Map([["claude", fakeAdapter()]]), store, runFn: async () => okResult(VALID_REVIEW), ...over });
}
const req: ProbeRequest = { runtime: "claude", archetype: "adversarial-review", brief: { task: "review" }, cwd: "/repo" };

describe("ProbeService — happy path + storage", () => {
  it("launches, resolves a completed envelope, and persists it", async () => {
    const service = svc();
    const { runId, done } = await service.launch(req);
    const env = await done;
    expect(env).toEqual({ runId, status: "completed", result: expect.objectContaining({ reason: "ok" }) });
    expect(service.active()).toBe(0);
    const stored = await service.read(runId);
    expect(stored?.status).toBe("completed");
  });

  it("non-compliant archetype output downgrades ok → parse_error (OQ5)", async () => {
    const service = svc({ runFn: async () => okResult("this looks great, ship it") });
    const { done } = await service.launch(req);
    expect((await done).result?.reason).toBe("parse_error");
  });

  it("freeform accepts any prose", async () => {
    const service = svc({ runFn: async () => okResult("anything") });
    const { done } = await service.launch({ ...req, archetype: "freeform" });
    expect((await done).result?.reason).toBe("ok");
  });
});

describe("ProbeService — launch gates (D8/OQ3/D5)", () => {
  it("rejects an unauthorized caller", async () => {
    const service = svc({ authorize: () => ({ ok: false, reason: "not allowed" }) });
    await expect(service.launch(req)).rejects.toBeInstanceOf(ProbeRejectedError);
  });

  it("rejects past the concurrency cap", async () => {
    let release!: () => void;
    const blocking = new Promise<void>((r) => (release = r));
    const service = svc({ maxConcurrent: 1, runFn: async () => { await blocking; return okResult(VALID_REVIEW); } });
    const first = await service.launch(req);
    await expect(service.launch(req)).rejects.toThrow(/concurrency cap/);
    release();
    await first.done;
  });

  it("rejects an unknown runtime", async () => {
    await expect(svc().launch({ ...req, runtime: "gemini" })).rejects.toThrow(/unknown runtime/);
  });

  it("rejects an unavailable runtime (honest capability gate)", async () => {
    const service = new ProbeService({ adapters: new Map([["claude", fakeAdapter(false)]]), store, runFn: async () => okResult(VALID_REVIEW) });
    await expect(service.launch(req)).rejects.toThrow(/unavailable/);
  });
});

describe("ProbeService — cancel + reap (OQ3)", () => {
  it("cancel aborts the in-flight run → killed_signal", async () => {
    const killed: ProbeResult = { reason: "killed_signal", lastMessage: "", exitCode: null, signal: "SIGTERM", timedOut: false, native: { runtime: "claude" } };
    const service = svc({
      runFn: (_a, _s, o) =>
        new Promise<ProbeResult>((res) => {
          // mirror runProbe: handle an already-aborted signal (cancel can win the race before this runs)
          if (o.signal!.aborted) res(killed);
          else o.signal!.addEventListener("abort", () => res(killed), { once: true });
        }),
    });
    const { runId, done } = await service.launch(req);
    expect(service.cancel(runId)).toBe(true);
    expect((await done).result?.reason).toBe("killed_signal");
    expect(service.cancel("probe-unknown")).toBe(false);
  });

  it("reap marks an incomplete (metadata-only) run failed", async () => {
    await store.writeMeta({ runId: "probe-orphan", runtime: "claude", adapterVersion: "1", createdAt: new Date(0).toISOString() });
    const service = svc();
    const { reaped } = await service.reap();
    expect(reaped).toContain("probe-orphan");
    const env = await service.read("probe-orphan");
    expect(env?.status).toBe("failed");
    expect(env?.result?.reason).toBe("killed_signal");
  });
});
