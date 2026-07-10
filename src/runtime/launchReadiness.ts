/** Bounded post-launch observation. This deliberately inspects only terminal state,
 * never sends a prompt or makes an inference request. */
export type RuntimeLaunchReadiness =
  | { state: "ready" }
  | { state: "rejected"; code: "runtime_auth_rejected" | "runtime_model_rejected" | "runtime_config_rejected" }
  | { state: "pending" };

export interface RuntimeLaunchReadinessAdapter {
  classify(output: string): Exclude<RuntimeLaunchReadiness, { state: "pending" }> | undefined;
}

export interface LaunchReadinessPort {
  wait(input: { capture: () => Promise<string>; adapter: RuntimeLaunchReadinessAdapter }): Promise<RuntimeLaunchReadiness>;
}

export interface LaunchReadinessOptions {
  windowMs?: number;
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export const LAUNCH_READINESS_WINDOW_MS = 5_000;
const DEFAULT_POLL_MS = 100;

/** Injectable clock/sleeper keeps the five-second policy deterministic under fake timers. */
export class LaunchReadiness implements LaunchReadinessPort {
  private readonly windowMs: number;
  private readonly pollMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: LaunchReadinessOptions = {}) {
    this.windowMs = opts.windowMs ?? LAUNCH_READINESS_WINDOW_MS;
    this.pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async wait(input: { capture: () => Promise<string>; adapter: RuntimeLaunchReadinessAdapter }): Promise<RuntimeLaunchReadiness> {
    const deadline = this.now() + this.windowMs;
    for (;;) {
      const result = input.adapter.classify(await input.capture());
      if (result) return result;
      const remaining = deadline - this.now();
      if (remaining <= 0) return { state: "pending" };
      await this.sleep(Math.min(this.pollMs, remaining));
    }
  }
}
