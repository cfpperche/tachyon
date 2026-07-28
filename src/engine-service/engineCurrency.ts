import type { EngineServiceIdentityV1 } from "./protocol.js";

/**
 * t-f54b62 — is the engine serving this workspace the one the extension would launch today?
 *
 * The daemon is persistent and survives installations: while its systemd unit is active nothing
 * relaunches it, so the running process can be arbitrarily older than the installed code. Measured
 * 2026-07-28: the fleet's engine had been up since 26/07 13:32, running a bundle from before the
 * execution ledger was wired, and Control's Execution section rendered `no-telemetry` — an honest
 * answer that nonetheless meant two different things at once, "this workspace records nothing" and
 * "the daemon here is too old to record". Telling them apart took `ls` on the state directory and
 * `systemctl show`. No human is going to do that.
 *
 * Nothing here is new information. The daemon already reports its `bundleId` and `startedAt` in
 * `EngineServiceIdentityV1`, and the host already knows which bundle it would stage — the supervisor
 * even compares them, keeps the verdict as `disposition: "reused-compatible"`, and then nobody reads
 * it. This turns that dropped fact into something a surface can say.
 */
export type EngineCurrency =
  /** The running engine IS the installed bundle. Nothing to explain. */
  | { kind: "current"; bundleId: string; startedAt: string }
  /**
   * The running engine is a DIFFERENT bundle from the installed one. It is not broken — the
   * supervisor attached to it deliberately, because it is protocol-compatible — but it predates
   * whatever the installed bundle added, which is exactly the state that reads as a silent absence.
   */
  | { kind: "outdated"; runningBundleId: string; expectedBundleId: string; startedAt: string }
  /**
   * One of the two identities is not available, so no comparison happened.
   *
   * Deliberately distinct from `current`: a wrong "up to date" is a lie, and a wrong "outdated"
   * sends someone to restart production for no reason. If we did not compare, we say so.
   */
  | { kind: "unknown" };

/**
 * Compare what is running against what is installed.
 *
 * This is a comparison of two content hashes, not a second opinion about what the supervisor should
 * DO — that policy (`exact` / `compatible` / `upgrade`, and every refusal around channels and
 * protocol ranges) stays where it is. Currency asks the narrower question a surface needs: are these
 * the same bytes, and since when has this one been serving?
 */
export function classifyEngineCurrency(input: {
  running: Pick<EngineServiceIdentityV1, "bundleId" | "startedAt"> | undefined;
  expectedBundleId: string | undefined;
}): EngineCurrency {
  const running = input.running;
  const expected = input.expectedBundleId?.trim();
  if (!running?.bundleId || !running.startedAt || !expected) return { kind: "unknown" };
  if (running.bundleId === expected) {
    return { kind: "current", bundleId: running.bundleId, startedAt: running.startedAt };
  }
  return {
    kind: "outdated",
    runningBundleId: running.bundleId,
    expectedBundleId: expected,
    startedAt: running.startedAt,
  };
}

/**
 * The sentence a surface shows when a section is empty and the engine is stale.
 *
 * Returns undefined when there is nothing to add, so a caller cannot accidentally render a reassuring
 * line it did not earn: `current` needs no explanation and `unknown` has none to give. Callers keep
 * their existing empty state in both cases — absent stays absent.
 */
export function engineCurrencyNote(currency: EngineCurrency): string | undefined {
  if (currency.kind !== "outdated") return undefined;
  return `The engine serving this workspace has been running since ${currency.startedAt} and is not the installed build, so anything added since it started is not recorded yet. It updates on the next engine restart.`;
}
