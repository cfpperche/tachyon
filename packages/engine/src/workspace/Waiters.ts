/**
 * Event-driven waiter registry behind the wait_for_agent tool (the MCP-shaped
 * answer to "websocket push": the HTTP tool call is held open until a monitor
 * transition wakes it — no extra polling; reuses the monitors' existing tick).
 * Detection-engine agnostic by design: a future tmux control-mode source (F20)
 * makes these resolve faster without touching this file.
 */

export type WaitCondition = "idle" | "needs-input" | "dead" | "change";

export interface WaitResult {
  /** the awaited condition was reached (terminal events satisfy until=dead and until=change) */
  met: boolean;
  /** state at resolution: working | idle | needs-input | dead | gone | timeout */
  state: string;
  exitCode?: number;
  waitedMs: number;
}

interface Pending {
  agent: string;
  until: WaitCondition;
  startedAt: number;
  resolve: (result: WaitResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class Waiters {
  private pending = new Set<Pending>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Resolves when the condition is met, any transition lands for until=change, or the timeout fires. */
  wait(agent: string, until: WaitCondition, timeoutMs: number): Promise<WaitResult> {
    return new Promise((resolve) => {
      const entry: Pending = {
        agent,
        until,
        startedAt: this.now(),
        resolve,
        timer: setTimeout(() => {
          this.pending.delete(entry);
          resolve({ met: false, state: "timeout", waitedMs: this.now() - entry.startedAt });
        }, timeoutMs),
      };
      this.pending.add(entry);
    });
  }

  /** Attention transition (working|idle|needs-input) observed for an agent. */
  notifyAttention(agent: string, state: string): void {
    for (const entry of [...this.pending]) {
      if (entry.agent !== agent) continue;
      if (entry.until === "change" || entry.until === state) {
        this.settle(entry, { met: true, state, waitedMs: this.now() - entry.startedAt });
      }
    }
  }

  /** Terminal: the agent's process died (dead pane). Resolves every waiter for it. */
  notifyDead(agent: string, exitCode?: number): void {
    for (const entry of [...this.pending]) {
      if (entry.agent !== agent) continue;
      this.settle(entry, {
        met: entry.until === "dead" || entry.until === "change",
        state: "dead",
        exitCode,
        waitedMs: this.now() - entry.startedAt,
      });
    }
  }

  /** Terminal: the agent's session vanished (killed). Resolves every waiter for it. */
  notifyGone(agent: string): void {
    for (const entry of [...this.pending]) {
      if (entry.agent !== agent) continue;
      this.settle(entry, { met: entry.until === "dead" || entry.until === "change", state: "gone", waitedMs: this.now() - entry.startedAt });
    }
  }

  pendingCount(): number {
    return this.pending.size;
  }

  dispose(): void {
    for (const entry of [...this.pending]) {
      this.settle(entry, { met: false, state: "timeout", waitedMs: this.now() - entry.startedAt });
    }
  }

  private settle(entry: Pending, result: WaitResult): void {
    clearTimeout(entry.timer);
    this.pending.delete(entry);
    entry.resolve(result);
  }
}

/** Waiter key namespace for command completions (no clash with agent names). */
export const CMD_WAIT_PREFIX = "cmd:";

/** Shared by the MCP tool and the extension's internal command — one wait semantics. */
export async function executeWait(
  deps: {
    manager: { agentStates(): Promise<Map<string, { dead: boolean; exitCode?: number }>> };
    attentionOf?: (agent: string) => string | undefined;
    waiters?: Waiters;
  },
  name: string,
  until: WaitCondition,
  timeoutSec: number,
): Promise<{ met: boolean; state: string; exitCode?: number; waitedMs: number }> {
  const states = await deps.manager.agentStates();
  const current = states.get(name);
  if (!current) return { met: until === "dead", state: "gone", waitedMs: 0 };
  if (current.dead) return { met: until === "dead", state: "dead", exitCode: current.exitCode, waitedMs: 0 };
  const attention = deps.attentionOf?.(name);
  if (attention === until) return { met: true, state: attention, waitedMs: 0 };
  if (!deps.waiters) throw new Error("waiting is not available on this Bridge");
  const result = await deps.waiters.wait(name, until, timeoutSec * 1000);
  if (result.state === "timeout") {
    // report the live state at timeout so the caller can decide (and call again)
    return { ...result, state: deps.attentionOf?.(name) ?? "working" };
  }
  return result;
}
