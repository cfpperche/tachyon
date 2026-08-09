import hostResourceSizing from "../../shared/host-resource-sizing.cjs";

/**
 * t-019dac — host memory awareness for heavy gates (verify:full / verify_task full).
 * Auto-size vitest workers from free RAM; fail-closed under pressure.
 *
 * t-da6b78 — the algorithm itself no longer lives here. It lives in
 * `shared/host-resource-sizing.cjs`, which `scripts/verify-full.mjs` imports directly; this module
 * is the typed door for extension-host source and nothing else. Until now there were two copies of
 * the sizing rules — this file and a hand-kept ESM twin at `scripts/host-resources.mjs` — and the
 * twin got no type protection at all because `scripts/` is outside tsconfig's include. That is how
 * t-0b7aa7 happened. Add nothing here that a script would also need; add it to the shared module.
 *
 * Env overrides are documented on the shared module.
 */

export type HostMemorySnapshot = hostResourceSizing.HostMemorySnapshot;
export type HeavyGateDecision = hostResourceSizing.HeavyGateDecision;

export const { parseMeminfo, readHostMemory, recommendVitestMaxWorkers, decideHeavyGate, formatHeavyGateRefusal } =
  hostResourceSizing;
