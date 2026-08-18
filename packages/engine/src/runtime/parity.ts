/** The runtime-only product decision used after Workspace has checked agent/session eligibility. */
export function runtimeUsesSilentPersistenceHooks(runtime: string): boolean {
  return runtime === "claude" || runtime === "codex" || runtime === "grok";
}
