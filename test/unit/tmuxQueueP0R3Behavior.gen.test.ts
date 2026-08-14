import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import {
  TMUX_CAPTURE_TIMEOUT_MS,
  TMUX_CONTROL_CONCURRENCY,
  TmuxQueueError,
  TmuxService,
  type ExecResult,
  type TmuxExecutor,
} from "@tachyon/engine/tmux/TmuxService.js";
import { ControlModeClient } from "@tachyon/engine/tmux/ControlModeClient.js";

function deferredExecutor(): {
  exec: TmuxExecutor;
  pending: Array<() => void>;
} {
  const pending: Array<() => void> = [];
  return {
    exec: () =>
      new Promise<ExecResult>((resolve) => {
        pending.push(() => resolve({ stdout: "pane", stderr: "" }));
      }),
    pending,
  };
}

describe("container-generated delegation behavior", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("queued tmux operations time out without leaking concurrency slots", async () => {
    vi.useFakeTimers();
    const executor = deferredExecutor();
    const tmux = new TmuxService(executor.exec, "queue-p0", { queueWaitTimeoutMs: 100 });

    const blocked = Array.from({ length: TMUX_CONTROL_CONCURRENCY }, (_, i) => tmux.capturePane(`blocked-${i}`));
    await vi.advanceTimersByTimeAsync(0);
    expect(executor.pending).toHaveLength(TMUX_CONTROL_CONCURRENCY);

    const timedOut = tmux.capturePane("bounded-waiter").catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(100);
    const error = await timedOut;
    expect(error).toBeInstanceOf(TmuxQueueError);
    expect(error).toMatchObject({
      code: "TMUX_QUEUE_TIMEOUT",
      op: "capture-pane",
      queueWaitTimeoutMs: 100,
    });
    expect((error as Error).message).toContain("Retry after active operations finish or reload Tachyon");
    expect(executor.pending).toHaveLength(TMUX_CONTROL_CONCURRENCY);

    // Releasing one original operation must not resurrect the removed waiter.
    executor.pending[0]();
    await blocked[0];
    expect(executor.pending).toHaveLength(TMUX_CONTROL_CONCURRENCY);

    // A later operation acquires that exact slot, proving the timeout did not leak it.
    const recovered = tmux.capturePane("recovered");
    await vi.advanceTimersByTimeAsync(0);
    expect(executor.pending).toHaveLength(TMUX_CONTROL_CONCURRENCY + 1);
    executor.pending[TMUX_CONTROL_CONCURRENCY]();
    await expect(recovered).resolves.toBe("pane");

    for (const release of executor.pending.slice(1, TMUX_CONTROL_CONCURRENCY)) release();
    await expect(Promise.all(blocked.slice(1))).resolves.toEqual(["pane", "pane", "pane"]);
  });

  it("dispose cancels queued operations safely and rejects future work", async () => {
    vi.useFakeTimers();
    const executor = deferredExecutor();
    const tmux = new TmuxService(executor.exec, "queue-p0", { queueWaitTimeoutMs: 100 });
    const blocked = Array.from({ length: TMUX_CONTROL_CONCURRENCY }, (_, i) => tmux.capturePane(`blocked-${i}`));
    await vi.advanceTimersByTimeAsync(0);

    const queued = tmux.capturePane("cancel-me").catch((error: unknown) => error);
    tmux.dispose();
    tmux.dispose();

    await expect(queued).resolves.toMatchObject({
      code: "TMUX_SERVICE_DISPOSED",
      op: "capture-pane",
    });
    await expect(tmux.capturePane("after-dispose")).rejects.toMatchObject({ code: "TMUX_SERVICE_DISPOSED" });
    expect(executor.pending).toHaveLength(TMUX_CONTROL_CONCURRENCY);

    for (const release of executor.pending) release();
    await expect(Promise.all(blocked)).resolves.toEqual(["pane", "pane", "pane", "pane"]);
    await vi.advanceTimersByTimeAsync(100);
    expect(executor.pending).toHaveLength(TMUX_CONTROL_CONCURRENCY);
  });
  it("active tmux control operations time out and restore control-plane capacity", async () => {
    vi.useFakeTimers();
    const proc = new EventEmitter() as ChildProcessWithoutNullStreams & EventEmitter;
    const stdout = new PassThrough();
    const stdin = new PassThrough();
    Object.assign(proc, {
      stdout,
      stdin,
      stderr: new PassThrough(),
      kill: vi.fn(() => proc.emit("exit", 0)),
    });
    const fallback = vi.fn(async (_args: string[]): Promise<ExecResult> => ({ stdout: "fallback\n", stderr: "" }));
    const control = new ControlModeClient({
      wsHash: "queue-r2",
      socket: "tachyon",
      spawnClient: () => proc,
      fallbackExec: fallback,
      backoffMs: [1_000],
    });
    await control.start();
    stdout.write("%begin 100 1 0\n%end 100 1 0\n");
    await vi.advanceTimersByTimeAsync(0);
    stdout.write("%begin 100 2 0\n%end 100 2 0\n%begin 100 3 0\n%end 100 3 0\n");
    await vi.advanceTimersByTimeAsync(0);

    const tmux = new TmuxService(control.makeExecutor());
    const stalled = Array.from({ length: TMUX_CONTROL_CONCURRENCY }, (_, i) => tmux.capturePane(`stalled-${i}`));
    const queued = tmux.capturePane("queued-behind-stalled");
    await vi.advanceTimersByTimeAsync(TMUX_CAPTURE_TIMEOUT_MS);

    await expect(Promise.all([...stalled, queued])).resolves.toEqual(
      Array.from({ length: TMUX_CONTROL_CONCURRENCY + 1 }, () => "fallback"),
    );
    await expect(tmux.capturePane("capacity-recovered")).resolves.toBe("fallback");
    expect(proc.kill).toHaveBeenCalledOnce();
    await control.dispose();
  });

  it("disposing active tmux control operations settles them without fallback or leaked slots", async () => {
    vi.useFakeTimers();
    const proc = new EventEmitter() as ChildProcessWithoutNullStreams & EventEmitter;
    const stdout = new PassThrough();
    Object.assign(proc, {
      stdout,
      stdin: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(() => proc.emit("exit", 0)),
    });
    const fallback = vi.fn(async (_args: string[]): Promise<ExecResult> => ({ stdout: "fallback\n", stderr: "" }));
    const control = new ControlModeClient({
      wsHash: "dispose-r3",
      socket: "tachyon",
      spawnClient: () => proc,
      fallbackExec: fallback,
      backoffMs: [1_000],
    });
    await control.start();
    stdout.write("%begin 100 1 0\n%end 100 1 0\n");
    await vi.advanceTimersByTimeAsync(0);
    stdout.write("%begin 100 2 0\n%end 100 2 0\n%begin 100 3 0\n%end 100 3 0\n");
    await vi.advanceTimersByTimeAsync(0);

    const tmux = new TmuxService(control.makeExecutor());
    const active = Array.from({ length: TMUX_CONTROL_CONCURRENCY }, (_, i) =>
      tmux.capturePane(`active-${i}`).catch((error: unknown) => error),
    );
    const queued = tmux.capturePane("queued").catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    tmux.dispose();
    await control.dispose();

    expect(await Promise.all(active)).toEqual(
      Array.from({ length: TMUX_CONTROL_CONCURRENCY }, () => expect.objectContaining({ name: "ControlModeDisposedError" })),
    );
    await expect(queued).resolves.toMatchObject({ code: "TMUX_SERVICE_DISPOSED" });
    expect(fallback.mock.calls.filter(([args]) => (args as string[]).includes("capture-pane"))).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
