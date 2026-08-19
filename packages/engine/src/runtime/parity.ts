export type SessionOwnerCoverage =
  | { covered: true }
  | { covered: false; reason: string };

/** Explicitly report the lifecycle-ledger boundary instead of treating an absent hook as no event. */
export function sessionOwnerCoverage(runtime: string): SessionOwnerCoverage {
  if (runtime === "claude" || runtime === "codex" || runtime === "grok") return { covered: true };
  return { covered: false, reason: `runtime '${runtime}' has no Tachyon session-owner recorder` };
}

/** The runtime-only product decision used after Workspace has checked agent/session eligibility. */
export function runtimeUsesSilentPersistenceHooks(runtime: string): boolean {
  return sessionOwnerCoverage(runtime).covered;
}
