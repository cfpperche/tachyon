/** Narrow lifecycle seam used to decide whether a canonical formation replaces runtime-native lanes. */
export interface FormationLifecyclePort {
  suppressionRequired(agentName: string): boolean;
  /**
   * Combined Fatia C gate. True only when the production registry marks this adapter `verified`.
   * Unregistered adapters stay false (fail closed).
   */
  nativeSuppressionConfirmed(adapter: string): boolean;
}
