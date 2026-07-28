/**
 * t-0e88f3 — Grok's native memory, and the one place in this lane where a guarantee had to be
 * withdrawn after measurement contradicted it.
 *
 * ## The correction, first, because the previous version of this file asserted the opposite
 *
 * t-c46c35 pinned `--no-memory` on canonical Grok launches and justified it with the shipped guide's
 * precedence table, which ranks the flag ABOVE the `GROK_MEMORY` environment variable. The stated
 * point was immunity to a hostile environment. **That immunity does not exist in Grok 0.2.112.**
 *
 * Measured 2026-07-28 (approval a-b4b050, effective model grok-4.5-build, private GROK_HOME projected
 * by `materializeBridgeMcpGrok`), two arms over a synthetic marker planted in the private store:
 *
 *  - **hostile** — `--no-memory` AND `GROK_MEMORY=1`: the model answered with the exact marker. The
 *    debug log shows MEMORY_INIT (watcher_config_enabled=true), MEMORY_INJECT_SEARCH results=1 and a
 *    first-turn injection, and the store was written during the run.
 *  - **default** — clean environment, no flag: no MEMORY_INIT, no MEMORY_INJECT, the marker never
 *    reached the model, nothing written.
 *
 * The default arm is what makes this a finding rather than a puzzle. Reading the hostile arm alone
 * could not separate "the flag is inert" from "the env var outranks the flag"; the default arm shows
 * the default really is off, so memory became active *because* `GROK_MEMORY` turned it on, and
 * `--no-memory` failed to outrank it.
 *
 * ## What Tachyon does about it
 *
 * Precedence Tachyon cannot verify is not a control Tachyon can offer, so the guarantee moved to the
 * channel Tachyon actually owns: **the spawn environment**. `grokMemoryEnv` pins `GROK_MEMORY=0` on
 * canonical launches, and the same measurement that refuted the flag is what recommends the variable —
 * it was decisive enough to overrule the flag, so setting it uses the control the runtime honors
 * rather than the one it documents.
 *
 * Why set `0` rather than remove the variable: removal returns the launch to rule 5, the bare default,
 * which is exactly the position t-c46c35 set out to improve on. It is also not expressible — the spawn
 * env is assembled as a `Record<string, string>` and delivered through `tmux new-session -e`, a channel
 * that can set a variable but not unset one. `0` is an assertion in a channel Tachyon controls end to
 * end; absence is an assumption about everyone else's environment.
 *
 * The flag stays pinned. It is free, it is the documented control, and the measurement showed it to be
 * inert rather than harmful — it simply may no longer be described as immunity.
 *
 * ## What this module does NOT claim
 *
 * `enable`, `injection` and `mutation` stay `declared`. Grok 0.2.112's `memory` subcommand exposes only
 * `clear` — no status or stats readout — so nothing non-billable reports effective memory state, and
 * nothing renders what reaches the model.
 *
 * The `disable` axis is `refuted` rather than `declared`: it was measured and the shipped control
 * failed. That distinction is why `refuted` was added to the evidence vocabulary — see
 * `MemoryEvidence` in `../nativeMemory.js`.
 */
import type { MemoryPolicyRequest, RuntimeNativeMemoryCapabilityV1 } from "../nativeMemory.js";
import type { MemoryLifecycleOperation } from "../nativeMemory.js";

/** The exact runtime this evidence describes. A different build is unmeasured until someone measures it. */
export const GROK_MEMORY_MEASURED_VERSION = "0.2.112";

/**
 * The documented disable flag. Retained on canonical launches, and no longer load-bearing: measurement
 * put `GROK_MEMORY` above it, so this is the belt and `grokMemoryEnv` is the braces.
 */
export const GROK_NO_MEMORY_FLAG = "--no-memory";

/** The environment variable that measurement showed actually decides the outcome. */
export const GROK_MEMORY_ENV_VAR = "GROK_MEMORY";

/** The value the shipped guide assigns to "disabled" for {@link GROK_MEMORY_ENV_VAR}. */
export const GROK_MEMORY_DISABLED_VALUE = "0";

/**
 * The MEASURED precedence, highest first — deliberately not the documented one.
 *
 * The shipped guide ranks `--no-memory` first and `GROK_MEMORY` third. At 0.2.112 that is false in the
 * only case where the ordering matters: with both set, memory ran. This constant records what the
 * runtime does, so that the next person to reason about Grok's controls reasons from the measurement
 * rather than from the table that has already misled once.
 */
export const GROK_MEMORY_PRECEDENCE = [
  "GROK_MEMORY env var: 1/true enables — MEASURED to outrank --no-memory at 0.2.112, contradicting the shipped guide",
  "--experimental-memory CLI flag (enables) — documented, not measured against the env var",
  "--no-memory CLI flag — documented as 'always disables'; MEASURED to be outranked by GROK_MEMORY=1",
  "[memory] section in config.toml — documented; Tachyon owns this file inside the private GROK_HOME",
  "default: disabled — MEASURED, on a clean environment with no flag",
] as const;

/**
 * The precedence the shipped user guide claims, kept verbatim so the contradiction stays legible.
 * Reading this next to {@link GROK_MEMORY_PRECEDENCE} is the whole finding in ten lines.
 */
export const GROK_MEMORY_DOCUMENTED_PRECEDENCE = [
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
 * The env a canonical Grok launch contributes for a given memory policy — the control that survived
 * measurement, and therefore the one carrying the guarantee.
 *
 * Same policy keying and same fresh-object discipline as {@link grokMemoryArgs}, for the same reason:
 * when evidence eventually admits `runtime-managed`, the pin must disappear because the policy
 * changed, not because someone remembered to edit three launch sites.
 */
export function grokMemoryEnv(policy: MemoryPolicyRequest): Record<string, string> {
  return policy === "disabled" ? { [GROK_MEMORY_ENV_VAR]: GROK_MEMORY_DISABLED_VALUE } : {};
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
      "control precedence — MEASURED: GROK_MEMORY=1 outranks `--no-memory` at 0.2.112, so canonical launches pin the env var and keep the flag only as a documented no-op",
      "flag reachability — `grok --help` at 0.2.112 exposes --no-memory and --experimental-memory",
      "purge surface — `grok memory clear` exists; note the installed CLI exposes ONLY clear, no status/stats",
      "store path — $GROK_HOME/memory/MEMORY.md plus a repository-identity workspace directory",
    ],
    needsAuthorization: [
      { axis: "disable", proves: "that a session launched with the canonical env neither reads a planted store nor writes one, even with a hostile GROK_MEMORY=1 in the ambient environment" },
      { axis: "enable", proves: "that the same store IS consulted under --experimental-memory, which would fix the flag as a real control in the enabling direction" },
      { axis: "injection", proves: "what first-turn search injection actually places in context, and how large it gets" },
      { axis: "mutation", proves: "whether session-end metadata, LLM flushes or dream consolidation write back" },
    ],
    lifecycle: [
      { operation: "fresh", method: "new private GROK_HOME with a hostile GROK_MEMORY=1 in the ambient env; a planted marker must not reach the model, which is the drift case the canonical env pin exists for" },
      { operation: "restart", method: "same home, second session; store persists (research says retain) while the pin keeps it unread" },
      { operation: "resume", method: "`--resume` into the same home; retain expected" },
      { operation: "fork", method: "`--fork-session` mints a new session id in the SAME home, and the store is repository-keyed — so a fork shares memory rather than copying it. Registry says `unknown`; this is what would settle it" },
    ],
  };
}

/**
 * Grok's capability with what this task actually changed.
 *
 * No axis is promoted to `verified`: the canonical env pin is a control change, and this lane's whole
 * value is that a control and an observation never get conflated. What DID change is that `disable`
 * moved off `declared` in the other direction — to `refuted`, because the previously shipped control
 * was measured and failed.
 */
export function grokMemoryCapability(base: RuntimeNativeMemoryCapabilityV1): RuntimeNativeMemoryCapabilityV1 {
  return {
    ...base,
    runtimeVersion: GROK_MEMORY_MEASURED_VERSION,
    sources: [
      ...base.sources,
      { kind: "behavioral-test", ref: "test/unit/grokMemoryAdapter.test.ts" },
      { kind: "behavioral-test", ref: "docs/research/runtime-native-memory-parity-t-d4c42e.md#grok-2026-07-28-refuted" },
    ],
  };
}
