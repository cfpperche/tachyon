import type { AgentVM, AgentStatus, Verify } from "./types";

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
  /** monitor attention state: "working" | "idle" | "needs-input" (undefined when not monitored) */
  attention?: string;
  worktree?: string; // branch name
  harness?: boolean;
  fork?: boolean;
  resumable?: boolean;
  verify?: Verify;
  verifiable?: boolean;
  ai?: boolean;
  adhoc?: boolean;
}

/** The sidebar grouping bucket. NOTE: mixes lifecycle (running/stopped/crashed) with running-attention
 *  (needs/idle) — matches the approved prototype; the lifecycle-vs-attention split is a tracked follow-up. */
export function statusOf(a: AgentRaw, attention?: string): AgentStatus {
  if (a.dead) return a.crashed ? "crashed" : "stopped";
  if (!a.running) return "stopped";
  if (attention === "needs-input") return "needs";
  if (attention === "idle") return "idle";
  return "running";
}

export function toAgentVM(a: AgentRaw, x: AgentExtras = {}): AgentVM {
  const attention = x.attention === "needs-input" ? "needs input" : x.attention === "working" ? "working" : undefined;
  const sub = a.dead ? (a.crashed ? `exited (${a.exitCode ?? 1})` : "exited (0)") : undefined;
  return {
    name: a.name,
    status: statusOf(a, x.attention),
    ...(attention ? { attention } : {}),
    ...(a.parent ? { parent: a.parent } : {}),
    ...(sub ? { sub } : {}),
    ...(x.worktree ? { worktree: x.worktree } : {}),
    ...(x.verify ? { verify: x.verify } : {}),
    ...(x.harness ? { harness: true } : {}),
    ...(x.resumable ? { resumable: true } : {}),
    ...(x.fork ? { fork: true } : {}),
    ...(x.ai ? { ai: true } : {}),
    ...(x.adhoc ? { adhoc: true } : {}),
    ...(x.verifiable ? { verifiable: true } : {}),
  };
}
