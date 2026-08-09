/**
 * Product fact appended to a Bridge-spawned child's instructions. Tachyon cannot observe a CLI's
 * native sub-agent tools, so the child must know that work delegated through them is invisible to
 * the fleet.
 */
export function bridgeGuidanceTail(): string {
  return [
    "[Tachyon] You are part of a Tachyon team. Your CLI's built-in sub-agents (Task/Explore/…) run work",
    "Tachyon cannot see (no tab, no lineage, no attention).",
  ].join(" ");
}

/** Apply the Bridge guidance to a (possibly empty) instruction body, when enabled. */
export function withBridgeGuidance(
  instructions: string | undefined,
  enabled: boolean,
): string | undefined {
  if (!enabled) return instructions;
  const tail = bridgeGuidanceTail();
  const body = instructions?.trim();
  return body ? `${body}\n\n${tail}` : tail;
}
