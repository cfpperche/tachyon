import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TMUX_CONTROL_CONCURRENCY,
  TmuxQueueError,
  TmuxService,
  type ExecResult,
  type TmuxExecutor,
} from "../../src/tmux/TmuxService.js";

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
});
