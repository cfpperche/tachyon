/**
 * t-9552f3 — in-memory latch: agent has rung a completion doorbell (`notify_agent`)
 * this session. Used to reconcile "turn done, pane still open" with attention/backstop
 * without inventing a first-class done(unseen) product state (t-a39c7d).
 *
 * Cleared on spawn/restart/kill boundaries and when new pane output appears after the mark
 * (a genuine new working turn). Session-local only (reload loses the latch — acceptable v1).
 */
export class CompletionHintStore {
  /** agent → epoch ms when notify_agent latched completion */
  private readonly agents = new Map<string, number>();

  mark(agent: string, atMs = Date.now()): void {
    if (agent) this.agents.set(agent, atMs);
  }

  clear(agent: string): void {
    this.agents.delete(agent);
  }

  has(agent: string): boolean {
    return this.agents.has(agent);
  }

  markedAt(agent: string): number | undefined {
    return this.agents.get(agent);
  }

  /**
   * Drop the latch when the pane produced new output after the doorbell (new turn).
   * Do NOT clear merely because AttentionMonitor still classifies as working with
   * the same frozen content (the bug we're fixing).
   */
  clearIfNewOutput(agent: string, contentSinceMs: number): void {
    const marked = this.agents.get(agent);
    if (marked === undefined) return;
    if (contentSinceMs > marked) this.agents.delete(agent);
  }

  /** For tests. */
  clearAll(): void {
    this.agents.clear();
  }
}

/**
 * When a completion doorbell was rung and the pane is not in needs-input/throttled
 * and the composer is empty, present as idle for consumers (sidebar, backstop) even if
 * the raw AttentionMonitor still says working (missed prompt-idle classification).
 */
export function applyCompletionHint(
  attention: import("./AttentionMonitor.js").AgentAttention | undefined,
  hinted: boolean,
): import("./AttentionMonitor.js").AgentAttention | undefined {
  if (!attention || !hinted) return attention;
  if (attention.state === "needs-input" || attention.state === "throttled") return attention;
  if (attention.composerOccupied) return attention;
  if (attention.state === "idle") return attention;
  if (attention.state !== "working") return attention;
  return { ...attention, state: "idle" };
}
