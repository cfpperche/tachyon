import { describe, expect, it } from "vitest";
import { continueTaskCandidates } from "../../src/webview/shared/agents/continueTaskCandidates";
import type { AgentVM } from "../../src/sidebar/types";

const A = (o: Partial<AgentVM> & { name: string; status: AgentVM["status"] }): AgentVM => ({
  kind: "agent",
  ...o,
});

describe("t-41117e continueTaskCandidates", () => {
  it("excludes self, terminals, and temporary agents", () => {
    const agents: AgentVM[] = [
      A({ name: "source", status: "running" }),
      A({ name: "saved-stopped", status: "stopped" }),
      A({ name: "saved-running", status: "running" }),
      A({ name: "temp", status: "stopped", adhoc: true }),
      A({ name: "term", status: "stopped", kind: "terminal" }),
    ];
    const names = continueTaskCandidates(agents, "source").map((a) => a.name);
    expect(names).toEqual(["saved-stopped", "saved-running"]);
  });

  it("lists stopped destinations before busy ones", () => {
    const agents: AgentVM[] = [
      A({ name: "a", status: "running" }),
      A({ name: "busy", status: "needs" }),
      A({ name: "free", status: "stopped" }),
    ];
    expect(continueTaskCandidates(agents, "a").map((r) => r.name)).toEqual(["free", "busy"]);
  });
});
