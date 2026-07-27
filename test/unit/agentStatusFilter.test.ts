import { describe, it, expect } from "vitest";
import {
  AGENT_STATUS_FILTERS,
  agentIsLive,
  agentIsStopped,
  agentNeedsYou,
  agentMatchesStatusFilter,
  countAgentStatusFilters,
  filterAgentsByStatus,
  asAgentStatusFilter,
  type AgentStatusFilter,
} from "../../src/webview/sidebar/agentStatusFilter";
import type { AgentVM } from "../../src/sidebar/types";

const a = (partial: Partial<AgentVM> & Pick<AgentVM, "name" | "status">): AgentVM => ({
  ...partial,
  name: partial.name,
  status: partial.status,
});

/** Fleet shaped like the 2026-07-15 dogfood screenshot. */
const FLEET: AgentVM[] = [
  a({ name: "claude", status: "idle" }),
  a({ name: "codex", status: "running", attention: "working" }),
  a({ name: "codex-budget", status: "stopped", resumable: true }),
  a({ name: "codex-regression", status: "stop-failed", attention: "working" }),
  a({ name: "codex-soul", status: "stopped", resumable: true }),
  a({ name: "grok", status: "idle" }),
  a({ name: "grok-claudex", status: "stopped", resumable: true }),
  a({ name: "grok-hermes", status: "stopped" }),
];

const names = (xs: { name: string }[]) => xs.map((x) => x.name);

describe("agentStatusFilter (t-eddf90)", () => {
  it("classifies live vs stopped statuses", () => {
    expect(agentIsLive({ status: "running" })).toBe(true);
    expect(agentIsLive({ status: "idle" })).toBe(true);
    expect(agentIsLive({ status: "stop-failed" })).toBe(true);
    expect(agentIsLive({ status: "stopped" })).toBe(false);
    expect(agentIsStopped({ status: "stopped" })).toBe(true);
    expect(agentIsStopped({ status: "crashed" })).toBe(true);
    expect(agentIsStopped({ status: "idle" })).toBe(false);
  });

  it("Needs you includes stop-failed / needs / throttled / awaitingHuman, not mere 'working'", () => {
    expect(agentNeedsYou({ status: "stop-failed" })).toBe(true);
    expect(agentNeedsYou({ status: "needs" })).toBe(true);
    expect(agentNeedsYou({ status: "throttled" })).toBe(true);
    expect(agentNeedsYou({ status: "running", awaitingHuman: { reason: "approve deploy" } })).toBe(true);
    expect(agentNeedsYou({ status: "running", attention: "needs input" })).toBe(true);
    expect(agentNeedsYou({ status: "running", attention: "working" })).toBe(false);
    expect(agentNeedsYou({ status: "idle" })).toBe(false);
    expect(agentNeedsYou({ status: "stopped" })).toBe(false);
  });

  it("SDD 477: an auth-required row needs you even though its status is plain idle", () => {
    expect(agentNeedsYou({ status: "idle" })).toBe(false);
    expect(agentNeedsYou({ status: "idle", authRequired: { runtime: "claude", action: "run /login" } })).toBe(true);
  });

  it("screenshot fleet counts: All 8 · Live 4 · Needs you 1 · Stopped 4 (focus chips 0 without focus)", () => {
    expect(countAgentStatusFilters(FLEET)).toEqual({
      all: 8, live: 4, attention: 1, stopped: 4, ontask: 0, hasfocus: 0,
    });
  });

  it("On task / Has focus filters use projected focus", () => {
    const withFocus: AgentVM[] = [
      a({ name: "a", status: "running", focus: { text: "t1", source: "task", taskId: "t-aaaaaa", full: "t-aaaaaa t1" } }),
      a({ name: "b", status: "running", focus: { text: "goal", source: "continuity", full: "goal" } }),
      a({ name: "c", status: "idle" }),
    ];
    expect(countAgentStatusFilters(withFocus)).toMatchObject({ ontask: 1, hasfocus: 2 });
    expect(names(filterAgentsByStatus(withFocus, "ontask"))).toEqual(["a"]);
    expect(names(filterAgentsByStatus(withFocus, "hasfocus"))).toEqual(["a", "b"]);
  });

  it("Live filter keeps process-alive rows only", () => {
    expect(names(filterAgentsByStatus(FLEET, "live"))).toEqual([
      "claude",
      "codex",
      "codex-regression",
      "grok",
    ]);
  });

  it("Stopped filter keeps hollow-dot cemetery", () => {
    expect(names(filterAgentsByStatus(FLEET, "stopped"))).toEqual([
      "codex-budget",
      "codex-soul",
      "grok-claudex",
      "grok-hermes",
    ]);
  });

  it("Needs you isolates stop-failed (and not progress-only working)", () => {
    expect(names(filterAgentsByStatus(FLEET, "attention"))).toEqual(["codex-regression"]);
  });

  it("all is identity copy (does not mutate input)", () => {
    const before = names(FLEET);
    const out = filterAgentsByStatus(FLEET, "all");
    expect(names(out)).toEqual(before);
    out.pop();
    expect(names(FLEET)).toEqual(before);
  });

  it("match helper is exclusive for stopped vs live", () => {
    const stopped = a({ name: "x", status: "stopped" });
    expect(agentMatchesStatusFilter(stopped, "live")).toBe(false);
    expect(agentMatchesStatusFilter(stopped, "stopped")).toBe(true);
    expect(agentMatchesStatusFilter(stopped, "attention")).toBe(false);
  });

  it("asAgentStatusFilter coerces unknown to all", () => {
    expect(asAgentStatusFilter("live")).toBe("live");
    expect(asAgentStatusFilter("garbage")).toBe("all");
    expect(asAgentStatusFilter(undefined)).toBe("all");
  });

  it("every filter mode is a valid AgentStatusFilter key", () => {
    const modes: readonly AgentStatusFilter[] = AGENT_STATUS_FILTERS;
    for (const m of modes) {
      expect(typeof agentMatchesStatusFilter(FLEET[0]!, m)).toBe("boolean");
    }
  });
});
