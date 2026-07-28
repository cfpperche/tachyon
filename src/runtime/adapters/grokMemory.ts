/**
 * t-c46c35 — Grok's native memory, and the one place in this lane where measurement leads to an
 * actual product change rather than to a careful "not proven".
 *
 * Claude gave no free way to see memory state; Codex gave a free readout but no way to see what
 * reaches the model. Grok gives something more useful than either: a control with **absolute
 * precedence**. `--no-memory` always disables, above the env var and above config, so pinning it makes
 * the canonical answer independent of whatever the ambient environment says.
 *
 * ## What was measured (2026-07-28, Grok 0.2.112, installed CLI and shipped docs)
 *
 * `grok --help` exposes both `--no-memory` ("Disable cross-session memory for this session") and
 * `--experimental-memory`, and the shipped user guide states the precedence outright:
 *
 *     1. `--no-memory` CLI flag (always disables)
 *     2. `--experimental-memory` CLI flag (enables)
 *     3. `GROK_MEMORY` env var: `1`/`true` enables, `0`/`false` disables
 *     4. `[memory]` section in config.toml
 *     5. Default: disabled
 *
 * That ordering is the whole reason this task is worth doing. Tachyon's canonical Grok launches were
 * relying on rule 5 — the default — while rules 3 and 4 sit above it and are writable by anyone with
 * an environment or a config file. Pinning rule 1 replaces "we inherit a default that happens to be
 * off" with "we state it, and nothing below can outrank us".
 *
 * ## What this module does NOT claim
 *
 * Pinning the flag is a real change with a real guarantee attached, and it is still not a behavioral
 * proof that memory is absent. Grok 0.2.112's `memory` subcommand exposes only `clear` — there is no
 * status or stats readout, so nothing non-billable reports effective memory state, and nothing renders
 * what reaches the model. `disable`, `enable`, `injection` and `mutation` therefore stay `declared`
 * exactly as they did for Claude and Codex, and the fresh/restart/resume/fork absence proof the task
 * asks for still needs an authorized session.
 *
 * The honest summary: this task closes the CONTROL gap, which was the part that could be closed
 * without spending anything, and leaves the EVIDENCE gap open and named.
 */
import type { MemoryPolicyRequest, RuntimeNativeMemoryCapabilityV1 } from "../nativeMemory.js";
import type { MemoryLifecycleOperation } from "../nativeMemory.js";

/** The exact runtime this evidence describes. A different build is unmeasured until someone measures it. */
export const GROK_MEMORY_MEASURED_VERSION = "0.2.112";

/** The flag with absolute precedence — rule 1 of the documented order. */
export const GROK_NO_MEMORY_FLAG = "--no-memory";

/**
 * The documented precedence, highest first, recorded so the reason for pinning survives the decision.
 * Anyone tempted to drop the flag because "the default is already disabled" is looking at rule 5 and
 * missing rules 3 and 4 sitting above it.
 */
export const GROK_MEMORY_PRECEDENCE = [
  "--no-memory CLI flag (always disables)",
  "--experimental-memory CLI flag (enables)",
  "GROK_MEMORY env var: 1/true enables, 0/false disables",
  "[memory] section in config.toml",
  "default: disabled",
] as const;

/**
 * The argv a canonical Grok launch contributes for a given memory policy.
 *
 * Deliberately keyed on the policy rather than hardcoded at the call site: `runtime-managed` is
 * blocked today, but when evidence eventually admits it, the launch path should stop pinning the flag
 * because the policy changed — not because someone edited a harness branch and hoped that was the only
 * one. Returning a fresh array each call keeps callers from mutating a shared constant into a
 * different launch.
 */
export function grokMemoryArgs(policy: MemoryPolicyRequest): string[] {
  return policy === "disabled" ? [GROK_NO_MEMORY_FLAG] : [];
}

/**
 * The canonical policy for Grok today. Named rather than inlined so the launch path reads as a policy
 * decision, and so the single place to revisit is obvious when evidence changes.
 */
export const GROK_CANONICAL_MEMORY_POLICY: MemoryPolicyRequest = "disabled";

export interface GrokVerificationPlan {
  readonly withoutModelCall: readonly string[];
  readonly needsAuthorization: ReadonlyArray<{ readonly axis: string; readonly proves: string }>;
  readonly lifecycle: ReadonlyArray<{ readonly operation: MemoryLifecycleOperation; readonly method: string }>;
}

/**
 * What a full Grok verification would take — stated so a human can decide whether to authorize it,
 * rather than discovering the cost when a bill arrives.
 */
export function grokMemoryVerificationPlan(): GrokVerificationPlan {
  return {
    withoutModelCall: [
      "control precedence — `--no-memory` is documented to outrank GROK_MEMORY and config.toml, and canonical launches now pin it",
      "flag reachability — `grok --help` at 0.2.112 exposes --no-memory and --experimental-memory",
      "purge surface — `grok memory clear` exists; note the installed CLI exposes ONLY clear, no status/stats",
      "store path — $GROK_HOME/memory/MEMORY.md plus a repository-identity workspace directory",
    ],
    needsAuthorization: [
      { axis: "disable", proves: "that a session launched with --no-memory neither reads a planted store nor writes one, even with GROK_MEMORY=1 set" },
      { axis: "enable", proves: "that the same store IS consulted under --experimental-memory, which fixes the flag as the real control" },
      { axis: "injection", proves: "what first-turn search injection actually places in context, and how large it gets" },
      { axis: "mutation", proves: "whether session-end metadata, LLM flushes or dream consolidation write back" },
    ],
    lifecycle: [
      { operation: "fresh", method: "new private GROK_HOME with GROK_MEMORY=1 set in the environment; a planted marker must not reach the model, which is the drift case the pin exists for" },
      { operation: "restart", method: "same home, second session; store persists (research says retain) while the pin keeps it unread" },
      { operation: "resume", method: "`--resume` into the same home; retain expected" },
      { operation: "fork", method: "`--fork-session` mints a new session id in the SAME home, and the store is repository-keyed — so a fork shares memory rather than copying it. Registry says `unknown`; this is what would settle it" },
    ],
  };
}

/**
 * Grok's capability with what this task actually changed.
 *
 * No evidence axis is promoted: pinning a flag is a control improvement, not an observation of
 * behavior, and this lane's whole value is that those two never get conflated. What changes is that
 * the disable control is now exercised by canonical launches rather than only by probes — recorded in
 * `sources` as the behavioral test that proves the launch path emits it.
 */
export function grokMemoryCapability(base: RuntimeNativeMemoryCapabilityV1): RuntimeNativeMemoryCapabilityV1 {
  return {
    ...base,
    runtimeVersion: GROK_MEMORY_MEASURED_VERSION,
    sources: [
      ...base.sources,
      { kind: "behavioral-test", ref: "test/unit/grokMemoryAdapter.test.ts" },
      { kind: "behavioral-test", ref: "docs/research/runtime-native-memory-parity-t-d4c42e.md#grok-2026-07-28" },
    ],
  };
}
