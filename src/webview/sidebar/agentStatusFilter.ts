/**
 * t-eddf90 — quick agent-status filter buckets for the Agents sidebar tab.
 * Pure helpers (no preact/vscode). Filter Hides rows; it does NOT re-group by status
 * (spec 242 sort stability still applies after filtering).
 */
import type { AgentStatus, AgentVM } from "../../sidebar/types";

/** Single-select filter mode. `all` shows every agent. */
export type AgentStatusFilter = "all" | "live" | "attention" | "stopped";

export const AGENT_STATUS_FILTERS: readonly AgentStatusFilter[] = ["all", "live", "attention", "stopped"] as const;

export const AGENT_STATUS_FILTER_LABEL: Record<AgentStatusFilter, string> = {
  all: "All",
  live: "Live",
  attention: "Needs you",
  stopped: "Stopped",
};

export const AGENT_STATUS_FILTER_TITLE: Record<AgentStatusFilter, string> = {
  all: "All agents",
  live: "Live session — process still present (running, needs, throttled, idle, stopping, stop-failed)",
  attention: "Needs you — needs input, throttled, stop-failed, awaiting human, or non-progress attention",
  stopped: "Stopped — no live session (stopped, crashed)",
};

const LIVE: ReadonlySet<AgentStatus> = new Set([
  "running",
  "needs",
  "throttled",
  "idle",
  "stopping",
  "stop-failed",
]);

const STOPPED: ReadonlySet<AgentStatus> = new Set(["stopped", "crashed"]);

/** Progress-only attention strings that are NOT "needs you" (agent is busy, not blocked on a human). */
const PROGRESS_ATTENTION = new Set(["working", "running", "thinking", "tool"]);

export function agentIsLive(a: Pick<AgentVM, "status">): boolean {
  return LIVE.has(a.status);
}

export function agentIsStopped(a: Pick<AgentVM, "status">): boolean {
  return STOPPED.has(a.status);
}

/**
 * Operational "needs you" signal — statuses that require intervention, plus
 * awaitingHuman / attention that is not mere progress ("working").
 * Includes stop-failed (not in grouping.agentNeedsAttention).
 */
export function agentNeedsYou(a: Pick<AgentVM, "status" | "attention" | "awaitingHuman">): boolean {
  if (a.status === "needs" || a.status === "throttled" || a.status === "stop-failed") return true;
  if (a.awaitingHuman) return true;
  if (a.attention) {
    const key = a.attention.trim().toLowerCase();
    if (key && !PROGRESS_ATTENTION.has(key)) return true;
  }
  return false;
}

export function agentMatchesStatusFilter(
  a: Pick<AgentVM, "status" | "attention" | "awaitingHuman">,
  filter: AgentStatusFilter,
): boolean {
  if (filter === "all") return true;
  if (filter === "live") return agentIsLive(a);
  if (filter === "attention") return agentNeedsYou(a);
  if (filter === "stopped") return agentIsStopped(a);
  return true;
}

export interface AgentStatusFilterCounts {
  all: number;
  live: number;
  attention: number;
  stopped: number;
}

/** Counts over the full fleet (not the filtered subset) — chip anchors stay stable. */
export function countAgentStatusFilters(
  agents: readonly Pick<AgentVM, "status" | "attention" | "awaitingHuman">[],
): AgentStatusFilterCounts {
  const c: AgentStatusFilterCounts = { all: agents.length, live: 0, attention: 0, stopped: 0 };
  for (const a of agents) {
    if (agentIsLive(a)) c.live++;
    if (agentNeedsYou(a)) c.attention++;
    if (agentIsStopped(a)) c.stopped++;
  }
  return c;
}

export function filterAgentsByStatus<T extends Pick<AgentVM, "status" | "attention" | "awaitingHuman">>(
  agents: readonly T[],
  filter: AgentStatusFilter,
): T[] {
  if (filter === "all") return agents.slice();
  return agents.filter((a) => agentMatchesStatusFilter(a, filter));
}

export function asAgentStatusFilter(v: unknown): AgentStatusFilter {
  if (v === "live" || v === "attention" || v === "stopped" || v === "all") return v;
  return "all";
}
