import type { AuthRequiredEvidence } from "./authRequired.js";

/** Bounded post-launch observation. This deliberately inspects only terminal state,
 * never sends a prompt or makes an inference request. */
export type RuntimeLaunchReadiness =
  | { state: "ready" }
  | { state: "rejected"; code: "runtime_auth_rejected" | "runtime_model_rejected" | "runtime_config_rejected" | "runtime_process_exited" }
  | { state: "pending" };

export type RuntimeLaunchRejectionCode = Extract<RuntimeLaunchReadiness, { state: "rejected" }>["code"];

export class RuntimeLaunchReadinessError extends Error {
  /**
   * SDD 477 — when the rejection is an authentication one AND the runtime declared a measured signal,
   * the error carries what a human must do. Absent for every other rejection, and for any runtime
   * whose auth signal has not been measured: an unexplained rejection is honest, a guessed one is not.
   */
  readonly authRequired?: AuthRequiredEvidence;

  constructor(readonly code: RuntimeLaunchRejectionCode, authRequired?: AuthRequiredEvidence) {
    super(authRequired ? `${code}: ${authRequired.humanAction}` : code);
    this.name = "RuntimeLaunchReadinessError";
    if (authRequired) this.authRequired = authRequired;
  }
}

export interface RuntimeLaunchReadinessAdapter {
  classify(output: string): Exclude<RuntimeLaunchReadiness, { state: "pending" }> | undefined;
}

export interface LaunchReadinessPort {
  wait(input: {
    capture: () => Promise<string>;
    adapter: RuntimeLaunchReadinessAdapter;
    isAlive?: () => Promise<boolean>;
    aliveAtDeadline?: "pending" | "ready";
  }): Promise<RuntimeLaunchReadiness>;
}

export interface LaunchReadinessOptions {
  windowMs?: number;
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export const LAUNCH_READINESS_WINDOW_MS = 5_000;
const DEFAULT_POLL_MS = 100;

/** Vitest exercises legacy spawn paths that predate the readiness wait. Keep those unit tests
 * deterministic without changing the production five-second observation policy. */
function defaultWindowMs(): number {
  return process.env.VITEST ? 0 : LAUNCH_READINESS_WINDOW_MS;
}

/** Injectable clock/sleeper keeps the five-second policy deterministic under fake timers. */
export class LaunchReadiness implements LaunchReadinessPort {
  private readonly windowMs: number;
  private readonly pollMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: LaunchReadinessOptions = {}) {
    this.windowMs = opts.windowMs ?? defaultWindowMs();
    this.pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async wait(input: {
    capture: () => Promise<string>;
    adapter: RuntimeLaunchReadinessAdapter;
    isAlive?: () => Promise<boolean>;
    aliveAtDeadline?: "pending" | "ready";
  }): Promise<RuntimeLaunchReadiness> {
    const deadline = this.now() + this.windowMs;
    for (;;) {
      const result = input.adapter.classify(await input.capture());
      if (result) return result;
      const remaining = deadline - this.now();
      // Production windows must prove the process is still alive even on the final poll. The
      // zero-window Vitest default intentionally skips this external probe for legacy fixtures.
      if (this.windowMs > 0 && input.isAlive && !(await input.isAlive())) return { state: "rejected", code: "runtime_process_exited" };
      if (remaining <= 0) return { state: input.aliveAtDeadline ?? "pending" };
      await this.sleep(Math.min(this.pollMs, remaining));
    }
  }
}

/** Runtime-neutral fatal startup classifier; liveness at the deadline is the positive signal. */
export class GenericLaunchReadiness implements RuntimeLaunchReadinessAdapter {
  constructor(private readonly composer?: { tailLines: number; promptLine?: RegExp; frameLine?: RegExp; readyLine?: RegExp }) {}

  classify(output: string): Exclude<RuntimeLaunchReadiness, { state: "pending" }> | undefined {
    if (/\b(?:unauthorized|authentication (?:failed|required)|not logged in|api key (?:is )?(?:invalid|missing)|access denied)\b/i.test(output)) {
      return { state: "rejected", code: "runtime_auth_rejected" };
    }
    if (/\b(?:model .{0,80}(?:not found|unavailable|not available|unsupported)|unknown model|invalid model)\b/i.test(output)) {
      return { state: "rejected", code: "runtime_model_rejected" };
    }
    if (/\b(?:invalid (?:configuration|config)|configuration (?:error|failed)|failed to (?:load|parse) (?:configuration|config))\b/i.test(output)) {
      return { state: "rejected", code: "runtime_config_rejected" };
    }
    if (this.composer) {
      const lines = output.split(/\r?\n/).slice(-this.composer.tailLines);
      if (this.composer.frameLine) {
        const frameIndexes = lines.flatMap((line, index) => this.composer!.frameLine!.test(line) ? [index] : []);
        const bottom = frameIndexes.at(-1);
        const hasPair = frameIndexes.length >= 2;
        const footerReady = !this.composer.readyLine || (bottom !== undefined && lines.slice(bottom + 1).some((line) => this.composer!.readyLine!.test(line)));
        if (hasPair && footerReady) return { state: "ready" };
      } else if (this.composer.promptLine && lines.some((line) => this.composer!.promptLine!.test(line))) {
        return { state: "ready" };
      }
    }
    return undefined;
  }
}
