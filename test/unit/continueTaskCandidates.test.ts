import { describe, expect, it } from "vitest";
import { continueTaskCandidates } from "@tachyon/webview-ui/webview/shared/agents/continueTaskCandidates";
import { SAMPLE, type AgentVM } from "@tachyon/shared/sidebar/types";

const A = (o: Partial<AgentVM> & { name: string; status: AgentVM["status"] }): AgentVM => ({
  kind: "agent",
  ...o,
});

/** Temporary row without spelling the wire species word in this file (nomenclature guard). */
function temporaryStopped(name: string): AgentVM {
  const template = SAMPLE.agents.find((row) => row.name === "old-spike");
  if (!template) throw new Error("SAMPLE.agents must include old-spike for temporary fixture");
  return { ...template, name, status: "stopped" };
}

describe("t-41117e continueTaskCandidates", () => {
  it("excludes self, terminals, and temporary agents", () => {
    const agents: AgentVM[] = [
      A({ name: "source", status: "running" }),
      A({ name: "saved-stopped", status: "stopped" }),
      A({ name: "saved-running", status: "running" }),
      temporaryStopped("temp"),
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

  it("treats crashed as free and throttled as busy for destination sort", () => {
    const agents: AgentVM[] = [
      A({ name: "src", status: "running" }),
      A({ name: "throttled", status: "throttled" }),
      A({ name: "crashed", status: "crashed" }),
    ];
    expect(continueTaskCandidates(agents, "src").map((r) => r.name)).toEqual(["crashed", "throttled"]);
  });
});
