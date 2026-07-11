export type ProcessFenceEmptyProof =
  | { state: "proven_empty" }
  | { state: "survivors"; pids: number[] }
  | { state: "unknown"; reason: string };

export type ProcessFenceCapability =
  | { supported: true; domain: string }
  | { supported: false; reason: string };

/**
 * Soundness boundary for sequential Delivery handoff. Implementations own the complete
 * containment group and an independent canonical-worktree binding audit; pane-root or
 * process-group death alone can never produce `proven_empty`.
 */
export interface ProcessFencePort {
  capability(): ProcessFenceCapability;
  freeze(executionNonce: string): Promise<void>;
  terminate(executionNonce: string): Promise<void>;
  proveEmpty(executionNonce: string, canonicalWorktree: string): Promise<ProcessFenceEmptyProof>;
}

/** Current supported-host result from the T0.2 spike: fail closed until the independent
 * same-UID worktree-binding audit can prove absence for every process. */
export class UnavailableProcessFence implements ProcessFencePort {
  private readonly reason = "independent canonical-worktree process absence cannot be proven on this host";

  capability(): ProcessFenceCapability {
    return {
      supported: false,
      reason: this.reason,
    };
  }

  async freeze(): Promise<void> { throw this.unavailable(); }
  async terminate(): Promise<void> { throw this.unavailable(); }
  async proveEmpty(): Promise<ProcessFenceEmptyProof> {
    return { state: "unknown", reason: this.reason };
  }

  private unavailable(): Error {
    return new Error(`PROCESS_FENCE_UNAVAILABLE: ${this.reason}`);
  }
}
