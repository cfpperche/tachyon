/**
 * t-eddf90 — quick agent-status filter buckets for the Agents sidebar tab.
 * Pure helpers (no preact/vscode). Filter Hides rows; it does NOT re-group by status
 * (spec 242 sort stability still applies after filtering).
 */
import type { AgentStatus, AgentVM } from "../../sidebar/types";

/** Single-select filter mode. `all` shows every agent. */
export type AgentStatusFilter = "all" | "live" | "attention" | "stopped" | "ontask" | "hasfocus";

export const AGENT_STATUS_FILTERS: readonly AgentStatusFilter[] = [
  "all", "live", "attention", "stopped", "ontask", "hasfocus",
] as const;

export const AGENT_STATUS_FILTER_LABEL: Record<AgentStatusFilter, string> = {
  all: "All",
  live: "Live",
  attention: "Needs you",
  stopped: "Stopped",
  ontask: "On task",
  hasfocus: "Has focus",
};

const LIVE: ReadonlySet<AgentStatus> = new Set([
  "running",
  "needs",
  "throttled",
  "done",
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
export function agentNeedsYou(a: Pick<AgentVM, "status" | "attention" | "awaitingHuman" | "authRequired">): boolean {
  if (a.status === "needs" || a.status === "throttled" || a.status === "stop-failed" || a.status === "done") return true;
  if (a.awaitingHuman) return true;
  // SDD 477 / t-5bfb72 — a lost login reads as plain "idle", which is the whole defect. Only a human
  // can clear it, so it belongs in the attention filter even though the row keeps its idle status.
  if (a.authRequired) return true;
  if (a.attention) {
    const key = a.attention.trim().toLowerCase();
    if (key && !PROGRESS_ATTENTION.has(key)) return true;
  }
  return false;
}

export function agentMatchesStatusFilter(
  a: Pick<AgentVM, "status" | "attention" | "awaitingHuman" | "authRequired" | "focus">,
  filter: AgentStatusFilter,
): boolean {
  if (filter === "all") return true;
  if (filter === "live") return agentIsLive(a);
  if (filter === "attention") return agentNeedsYou(a);
  if (filter === "stopped") return agentIsStopped(a);
  if (filter === "ontask") return a.focus?.source === "task";
  if (filter === "hasfocus") return !!a.focus?.text;
  return true;
}

export interface AgentStatusFilterCounts {
  all: number;
  live: number;
  attention: number;
  stopped: number;
  ontask: number;
  hasfocus: number;
}

/** Counts over the full fleet (not the filtered subset) — dropdown anchors stay stable. */
export function countAgentStatusFilters(
  agents: readonly Pick<AgentVM, "status" | "attention" | "awaitingHuman" | "authRequired" | "focus">[],
): AgentStatusFilterCounts {
  const c: AgentStatusFilterCounts = { all: agents.length, live: 0, attention: 0, stopped: 0, ontask: 0, hasfocus: 0 };
  for (const a of agents) {
    if (agentIsLive(a)) c.live++;
    if (agentNeedsYou(a)) c.attention++;
    if (agentIsStopped(a)) c.stopped++;
    if (a.focus?.source === "task") c.ontask++;
    if (a.focus?.text) c.hasfocus++;
  }
  return c;
}

export function filterAgentsByStatus<T extends Pick<AgentVM, "status" | "attention" | "awaitingHuman" | "authRequired" | "focus">>(
  agents: readonly T[],
  filter: AgentStatusFilter,
): T[] {
  if (filter === "all") return agents.slice();
  return agents.filter((a) => agentMatchesStatusFilter(a, filter));
}

export function asAgentStatusFilter(v: unknown): AgentStatusFilter {
  if (v === "live" || v === "attention" || v === "stopped" || v === "ontask" || v === "hasfocus" || v === "all") return v;
  return "all";
}
