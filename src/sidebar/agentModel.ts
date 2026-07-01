import type { AgentVM, AgentStatus, Verify, ContinuityBadge, EvidenceBadge } from "./types";

/**
 * spec 237 — pure agent-model mapper (no vscode, no preact). The provider gathers raw fleet state from
 * the managers and calls this to produce the typed `AgentVM` the Preact UI renders. Unit-tested.
 */
export interface AgentRaw {
  name: string;
  running: boolean;
  dead: boolean;
  crashed: boolean;
  exitCode?: number;
  parent?: string;
}
export interface AgentExtras {
  /** monitor attention state: "working" | "idle" | "needs-input" | "throttled" (undefined when not monitored) */
  attention?: string;
  worktree?: string; // branch name
  harness?: boolean;
  /** this agent IS a forked sibling (spec 225 def.fork) → ⑂ badge. */
  forked?: boolean;
  /** this agent CAN be forked (running claude) → offers the Fork action. */
  forkable?: boolean;
  resumable?: boolean;
  freshStart?: boolean;
  verify?: Verify;
  verifiable?: boolean;
  ai?: boolean;
  adhoc?: boolean;
  continuity?: ContinuityBadge;
  evidence?: EvidenceBadge;
}

/** The sidebar grouping bucket. NOTE: mixes lifecycle (running/stopped/crashed) with running-attention
 *  (needs/idle) — matches the approved prototype; the lifecycle-vs-attention split is a tracked follow-up. */
export function statusOf(a: AgentRaw, attention?: string): AgentStatus {
  if (a.dead) return a.crashed ? "crashed" : "stopped";
  if (!a.running) return "stopped";
  if (attention === "needs-input") return "needs";
  if (attention === "throttled") return "throttled";
  if (attention === "idle") return "idle";
  return "running";
}

export function toAgentVM(a: AgentRaw, x: AgentExtras = {}): AgentVM {
  const attention = x.attention === "needs-input" ? "needs input" : x.attention === "throttled" ? "throttled" : x.attention === "working" ? "working" : undefined;
  const sub = a.dead ? (a.crashed ? `exited (${a.exitCode ?? 1})` : "exited (0)") : undefined;
  return {
    name: a.name,
    status: statusOf(a, x.attention),
    ...(attention ? { attention } : {}),
    ...(a.parent ? { parent: a.parent } : {}),
    ...(sub ? { sub } : {}),
    ...(a.dead && !a.crashed ? { exited: true } : {}),
    ...(x.worktree ? { worktree: x.worktree } : {}),
    ...(x.verify ? { verify: x.verify } : {}),
    ...(x.harness ? { harness: true } : {}),
    ...(x.resumable ? { resumable: true } : {}),
    ...(x.freshStart ? { freshStart: true } : {}),
    ...(x.forked ? { forked: true } : {}),
    ...(x.forkable ? { forkable: true } : {}),
    ...(x.ai ? { ai: true } : {}),
    ...(x.adhoc ? { adhoc: true } : {}),
    ...(x.verifiable ? { verifiable: true } : {}),
    ...(x.continuity ? { continuity: x.continuity } : {}),
    ...(x.evidence ? { evidence: x.evidence } : {}),
  };
}
