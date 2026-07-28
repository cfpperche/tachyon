/**
 * t-c46aad — Codex CLI's native memory, measured rather than declared.
 *
 * The Codex sibling of `claudeMemory.ts`, and it lands in a much better place: Codex reports its own
 * effective memory state for free, so the CONTROL surface is observable end to end. What it still does
 * not give away is the CONSEQUENCE — whether memory reaches the model — and this module is careful to
 * keep those two apart, because conflating them is how a registry full of `verified` stops meaning
 * anything.
 *
 * ## What was measured (2026-07-28, Codex CLI 0.145.0, sandboxed CODEX_HOME)
 *
 * 1. **The runtime self-reports effective memory state.** `codex features list` prints one row per
 *    feature with its stage and effective value, and at 0.145.0 the row reads:
 *
 *        memories                             stable             false
 *
 *    Stable, and OFF by default. That is the measured default the whole canonical policy rests on, and
 *    it is now a fact with a version attached rather than a claim inherited from a README.
 *
 * 2. **Both control paths actually move it, observably.** `codex --enable memories features list`
 *    flips the row to `true`, and so does `[features]\nmemories = true` written into the PRIVATE
 *    `CODEX_HOME/config.toml`. So Tachyon's control is verifiable without a model call: materialize the
 *    canonical config into a private home, ask Codex what it thinks, and read the answer back.
 *
 * 3. **`CODEX_HOME` really is the boundary.** With it pointed at a temp dir, Codex resolved config from
 *    there and created its state (`config.toml`, `skills/`, `shell_snapshots/`, `installation_id`)
 *    there rather than in the real home.
 *
 * ## What could NOT be measured, and the near-miss worth naming
 *
 * `codex debug prompt-input` renders the model-visible prompt list as JSON with no model call, which
 * looked like the injection oracle Claude Code never had. It is not. With a synthetic memory planted in
 * `<CODEX_HOME>/memories/`, the render was **byte-identical** with the feature off and on — while
 * `features list` proved the flag had genuinely flipped underneath. So `prompt-input` renders the
 * static session context and is blind to memory; its silence is a fact about the tool, not about the
 * feature.
 *
 * That cuts both ways, and honesty requires saying so: the same measurement that fails to prove
 * injection also fails to prove its absence. Memory injection runs as an asynchronous pipeline on
 * eligible threads, so `disable`, `enable`, `injection` and `mutation` all still need a live session,
 * exactly as they did for Claude. They stay `declared`, canonical policy stays `disabled`, and
 * `runtime-managed` stays blocked.
 *
 * What genuinely improves over Claude is `control.detect`, promoted from `config` to `runtime-status`:
 * for Claude nothing but a billable turn could report memory state, whereas Codex answers for free.
 * That is a real capability gain, recorded where it belongs instead of being laundered into an
 * evidence axis it does not support.
 *
 * ## Fork
 *
 * The registry says fork is `unavailable`. `codex fork` DOES exist at 0.145.0 — but it forks a
 * conversation, and memory is `CODEX_HOME`-global. A forked session therefore inherits the same store
 * rather than a copy, so fork is not a memory-isolation boundary. `unavailable` stays the right value
 * for the lifecycle field; `CODEX_FORK_NOTE` records why, so nobody re-derives it from the subcommand
 * list and reaches the opposite conclusion.
 */
import path from "node:path";
import type { RuntimeNativeMemoryCapabilityV1 } from "../nativeMemory.js";
import type { MemoryLifecycleOperation } from "../nativeMemory.js";

/** The exact runtime this evidence describes. A different build is unmeasured until someone measures it. */
export const CODEX_MEMORY_MEASURED_VERSION = "0.145.0";

/** The feature flag that gates the whole memories pipeline. */
export const CODEX_MEMORIES_FEATURE = "memories";

/** Why `lifecycle.fork` stays `unavailable` even though a `codex fork` subcommand exists. */
export const CODEX_FORK_NOTE =
  "`codex fork` forks a conversation, not memory: the store is CODEX_HOME-global, so a forked session "
  + "inherits the same memories rather than a copy. Fork is not a memory-isolation boundary.";

/** The non-billable state readout this adapter relies on, as an argv a caller can run verbatim. */
export function codexFeaturesListArgv(): string[] {
  return ["features", "list"];
}

/** Where the memories store lives for one private home. Enumerable without reading any entry. */
export function codexMemoryStorePath(codexHome: string): string {
  return path.join(codexHome, "memories");
}

export interface CodexFeatureRow {
  readonly name: string;
  /** `stable`, `under development`, `removed` — a removed feature that reads `true` is still worth seeing. */
  readonly stage: string;
  readonly enabled: boolean;
}

/**
 * Parse `codex features list`. Whitespace-column output, so this splits on runs of 2+ spaces rather
 * than single ones — `under development` is a stage containing a space, and a naive split would tear
 * it in half and misread the column that carries the answer.
 */
export function parseCodexFeatures(stdout: string): CodexFeatureRow[] {
  const rows: CodexFeatureRow[] = [];
  for (const line of stdout.split("\n")) {
    const match = /^(\S+)\s{2,}(\S.*?)\s{2,}(true|false)\s*$/.exec(line);
    if (match) rows.push({ name: match[1], stage: match[2].trim(), enabled: match[3] === "true" });
  }
  return rows;
}

/**
 * The effective memory state Codex reports about itself. `unknown` when the row is absent, which is
 * the fail-closed answer: a build that stopped naming the feature has not thereby disabled it.
 */
export function codexMemoryEffectiveState(stdout: string): "enabled" | "disabled" | "unknown" {
  const row = parseCodexFeatures(stdout).find((entry) => entry.name === CODEX_MEMORIES_FEATURE);
  if (!row) return "unknown";
  return row.enabled ? "enabled" : "disabled";
}

/**
 * Keys that would turn Codex memory on if Tachyon ever projected one into a private home.
 *
 * This is the drift guard the parity research asked for, in its checkable form: the canonical Codex
 * config is a closed allowlist that happens not to contain a memory key, and "happens not to" is
 * exactly the property that erodes when someone widens the list for an unrelated reason. Matching is
 * substring-based on purpose — `features.memories`, `memories.enabled` and a bare `memories` table all
 * have to trip it, and a guard that enumerated today's spellings would miss tomorrow's.
 */
export function memoryEnablingKeys(keys: Iterable<string>): string[] {
  return [...keys].filter((key) => /memor/i.test(key));
}

export interface CodexVerificationPlan {
  /** axes a non-billable run can answer today */
  readonly withoutModelCall: readonly string[];
  /** axes that need one authorized session, with what each would prove */
  readonly needsAuthorization: ReadonlyArray<{ readonly axis: string; readonly proves: string }>;
  /** the lifecycle operations the task asks about, and how each would be exercised */
  readonly lifecycle: ReadonlyArray<{ readonly operation: MemoryLifecycleOperation; readonly method: string }>;
}

/**
 * What a full Codex verification would take — stated so a human can decide whether to authorize it,
 * rather than discovering the cost when a bill arrives.
 */
export function codexMemoryVerificationPlan(): CodexVerificationPlan {
  return {
    withoutModelCall: [
      "measured default — `codex features list` reports `memories stable false` at 0.145.0",
      "control reachability — `--enable memories` and `[features] memories = true` in the private CODEX_HOME both flip the reported state to true",
      "Tachyon's emitted config — the canonical projection is a closed allowlist containing no memory key, asserted against live source",
      "store path — <CODEX_HOME>/memories is enumerable without reading any entry",
      "home binding — with a sandbox CODEX_HOME, config and state resolve there rather than in the real home",
    ],
    needsAuthorization: [
      { axis: "disable", proves: "that with memories off, a planted store contributes nothing to a live thread's model input" },
      { axis: "enable", proves: "that the same store IS consulted once the feature is on, which `prompt-input` cannot show" },
      { axis: "injection", proves: "what the asynchronous extraction/consolidation pipeline actually places in a thread, and how large it gets" },
      { axis: "mutation", proves: "whether a finished session writes new memories back into <CODEX_HOME>/memories and the state DB" },
    ],
    lifecycle: [
      { operation: "fresh", method: "new private CODEX_HOME; observe whether a planted marker reaches the first thread" },
      { operation: "restart", method: "same home, second session; the store should persist (research says retain)" },
      { operation: "resume", method: "`codex resume` into the same home; retain expected" },
      { operation: "fork", method: `not a memory boundary — ${CODEX_FORK_NOTE}` },
    ],
  };
}

/**
 * Codex's capability with the axes this task actually verified.
 *
 * `inventory` is promoted because the store is a known directory that can be listed without opening an
 * entry. `control.detect` is promoted from `config` to `runtime-status` because the runtime answers for
 * itself — the one place Codex genuinely beats Claude, recorded as the control capability it is.
 *
 * Every evidence axis that describes what reaches the model stays `declared`. `prompt-input` being
 * memory-blind means it can neither confirm injection nor rule it out, and `verified` has to mean
 * observed — the same rule that kept `isolation` unpromoted for Claude, applied here even though the
 * measurement got closer.
 */
export function codexMemoryCapability(base: RuntimeNativeMemoryCapabilityV1): RuntimeNativeMemoryCapabilityV1 {
  return {
    ...base,
    runtimeVersion: CODEX_MEMORY_MEASURED_VERSION,
    evidence: { ...base.evidence, inventory: "verified" },
    control: { ...base.control, detect: "runtime-status" },
    sources: [
      ...base.sources,
      { kind: "behavioral-test", ref: "test/unit/codexMemoryAdapter.test.ts" },
      { kind: "behavioral-test", ref: "docs/research/runtime-native-memory-parity-t-d4c42e.md#codex-2026-07-28" },
    ],
  };
}
