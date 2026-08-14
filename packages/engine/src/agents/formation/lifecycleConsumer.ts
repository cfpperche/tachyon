/** Narrow lifecycle seam used to decide whether a canonical formation replaces runtime-native lanes. */
export interface FormationLifecyclePort {
  suppressionRequired(agentName: string): boolean;
}
