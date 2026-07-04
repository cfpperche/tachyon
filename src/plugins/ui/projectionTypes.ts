/**
 * spec 349 — the plugin-facing fleet projection contract.
 *
 * This file is intentionally pure and purpose-built for untrusted UI plugins. Do not import host fleet types and
 * do not add host routing fields such as names, workspace hashes, paths, command lines, ports, pins, proposals,
 * handoff state, or topology. Additions must be explicit allowlist fields and keep the projection canary green.
 */

export type PluginAgentStatusV1 = "running" | "needs" | "throttled" | "idle" | "stopped" | "crashed";
export type PluginAgentAttentionV1 = "working" | "needs-input" | "throttled";
export type PluginAgentBadgeV1 =
  | "verify-pass"
  | "verify-fail"
  | "verify-stale"
  | "continuity-fresh"
  | "continuity-stale"
  | "continuity-missing"
  | "persistence-active"
  | "persistence-skipped"
  | "persistence-failed"
  | "evidence-warn"
  | "evidence-error"
  | "resumable"
  | "fresh-start";

export interface PluginAgentProjectionV1 {
  /** Opaque, session-scoped routing token. Plugins must never infer authority from its contents. */
  handle: string;
  /** Stable per plugin session pseudonym, not the Tachyon agent name. */
  label: string;
  status: PluginAgentStatusV1;
  attention?: PluginAgentAttentionV1;
  badges: PluginAgentBadgeV1[];
}

export interface PluginFleetProjectionCountsV1 {
  agents: number;
  running: number;
  needs: number;
  throttled: number;
  idle: number;
  stopped: number;
  crashed: number;
}

export interface PluginFleetProjectionV1 {
  v: 1;
  generation: number;
  agents: PluginAgentProjectionV1[];
  counts: PluginFleetProjectionCountsV1;
}
