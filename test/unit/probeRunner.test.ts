import { describe, it, expect } from "vitest";
import { runProbe, type ProbeChild, type ProbeExit, type ReadFileFn, type SpawnFn } from "../../src/probe/ProbeRunner.js";
import type { HeadlessCaptureAdapter, ProbeSpec, RawOutcome } from "../../src/probe/adapters/types.js";
import type { ProbeResult } from "../../src/probe/taxonomy.js";

function mk(reason: ProbeResult["reason"], lastMessage: string, raw: RawOutcome): ProbeResult {
  return { reason, lastMessage, exitCode: raw.exitCode, timedOut: raw.timedOut, native: { runtime: "fake" } };
}

/** A fake adapter: exit 0 + artifact → ok; exit 0 + no artifact → empty_output; nonzero → process_error. */
const adapter: HeadlessCaptureAdapter = {
  runtime: "fake",
  adapterVersion: "test-1",
  buildInvocation: (spec, dir) => ({ cmd: "fake", args: [], cwd: spec.cwd, resultArtifact: `${dir}/result.txt` }),
  interpret: (raw) => {
    if (raw.exitCode === 0) return raw.resultArtifactText ? mk("ok", raw.resultArtifactText, raw) : mk("empty_output", "", raw);
    return mk("process_error", raw.stderr.trim(), raw);
  },
  detectCapability: async () => ({ available: true }),
};

const spec: ProbeSpec = { runtime: "fake", prompt: "hi", cwd: "/x", timeoutMs: 50 };

/** Resolves `exit` immediately with `finishWith`, or only when killed (timeout/cancel paths). */
function fakeSpawn(finishWith?: ProbeExit): SpawnFn {
  return (): ProbeChild => {
    let resolve!: (e: ProbeExit) => void;
    const exit = new Promise<ProbeExit>((r) => (resolve = r));
    if (finishWith) resolve(finishWith);
    return { pid: 1, kill: (s) => resolve({ code: null, signal: s ?? "SIGTERM", stdout: "", stderr: "" }), exit };
  };
}

const readReturning = (content?: string): ReadFileFn => async () => {
  if (content === undefined) throw new Error("ENOENT");
  return content;
};

describe("runProbe — content outcomes delegate to the adapter", () => {
  it("ok: exit 0 + a result artifact", async () => {
    const r = await runProbe(adapter, spec, {
      scratchDir: "/scratch",
      spawn: fakeSpawn({ code: 0, signal: null, stdout: "noise: logged in\n", stderr: "" }),
      readFile: readReturning("THE ANSWER"),
    });
    expect(r.reason).toBe("ok");
    expect(r.lastMessage).toBe("THE ANSWER"); // from the artifact, NOT the noisy stdout
    expect(r.exitCode).toBe(0);
  });

  it("empty_output: exit 0 but no artifact", async () => {
    const r = await runProbe(adapter, spec, {
      scratchDir: "/scratch",
      spawn: fakeSpawn({ code: 0, signal: null, stdout: "", stderr: "" }),
      readFile: readReturning(undefined),
    });
    expect(r.reason).toBe("empty_output");
  });

  it("process_error: nonzero exit", async () => {
    const r = await runProbe(adapter, spec, {
      scratchDir: "/scratch",
      spawn: fakeSpawn({ code: 1, signal: null, stdout: "", stderr: "boom" }),
      readFile: readReturning(undefined),
    });
    expect(r.reason).toBe("process_error");
    expect(r.lastMessage).toBe("boom");
  });
});

describe("runProbe — run-level failures owned by the runner (not the adapter)", () => {
  it("timeout: the wall-clock cap fires → reason timeout, exitCode null", async () => {
    const r = await runProbe(adapter, { ...spec, timeoutMs: 5 }, {
      scratchDir: "/scratch",
      spawn: fakeSpawn(), // never finishes on its own; only the timeout-kill resolves it
      readFile: readReturning(undefined),
      killGraceMs: 5,
    });
    expect(r.reason).toBe("timeout");
    expect(r.timedOut).toBe(true);
    expect(r.exitCode).toBeNull();
  });

  it("cancel: aborting mid-run → reason killed_signal", async () => {
    const controller = new AbortController();
    const p = runProbe(adapter, { ...spec, timeoutMs: 5000 }, {
      scratchDir: "/scratch",
      spawn: fakeSpawn(),
      readFile: readReturning(undefined),
      killGraceMs: 5,
      signal: controller.signal,
    });
    controller.abort(); // listener was registered synchronously before the first await
    const r = await p;
    expect(r.reason).toBe("killed_signal");
    expect(r.exitCode).toBeNull();
  });
});
