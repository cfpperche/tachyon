import type { AuthRequiredEvidence } from "./authRequired.js";

/**
 * t-d501fc — each runtime refuses an unrecognized model in its OWN words; this is not one shared
 * phrase, it is every measured phrase OR'd together. Never validate against a Tachyon-held model
 * list here — the runtime's catalog changes without telling us and a stale copy errs in both
 * directions (refusing a new model, accepting a dead one). The signal has to come from the CLI's
 * own refusal text, so this pattern grows only from a phrase actually run and captured, never guessed:
 *  - Claude Code 2.1.223 (`claude --model sonnet-5`): "There's an issue with the selected model
 *    (sonnet-5). It may not exist or you may not have access to it." — matched by "issue with the
 *    selected model" alone; the rest of the sentence names the bad id and is not stable text.
 *  - Codex 0.146.0 (`codex exec --model bogus-model-xyz`): an `invalid_request_error` naming
 *    "'<model>' model is not supported when using Codex with a ChatGPT account." — matched by
 *    "model" followed within 80 chars by "not supported" (also covers the pre-existing "unsupported").
 *  - Grok 0.2.118 (`grok --model grok-bogus-9 -p hi`): `Couldn't set model '<model>': Invalid
 *    params: "unknown model id".` — already matched by the pre-existing "unknown model" alternative;
 *    kept here as the reason the other two additions were needed rather than a rewrite.
 * Before this fix, none of the first two matched: the CLI settles at its ordinary empty composer
 * right after printing the refusal, so the pane-readiness composer check won on both — the exact
 * defect measured in t-d501fc (`spawn_agent` answered "ready" for a runtime that had refused).
 */
export const MODEL_REJECTED_RE = /\b(?:issue with the selected model|model .{0,80}(?:not found|unavailable|not available|unsupported|not supported|does not exist)|unknown model|invalid model)\b/i;

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
    const lines = this.composer ? output.split(/\r?\n/).slice(-this.composer.tailLines) : [];
    const liveOutput = this.composer ? lines.join("\n") : output;
    if (/\b(?:unauthorized|authentication (?:failed|required)|not logged in|api key (?:is )?(?:invalid|missing)|access denied)\b/i.test(liveOutput)) {
      return { state: "rejected", code: "runtime_auth_rejected" };
    }
    if (MODEL_REJECTED_RE.test(liveOutput)) {
      return { state: "rejected", code: "runtime_model_rejected" };
    }
    if (/\b(?:invalid (?:configuration|config)|configuration (?:error|failed)|failed to (?:load|parse) (?:configuration|config))\b/i.test(liveOutput)) {
      return { state: "rejected", code: "runtime_config_rejected" };
    }
    if (this.composer) {
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
