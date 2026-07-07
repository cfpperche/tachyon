import { describe, expect, it } from "vitest";
import { agentGroupParent, agentIsNested } from "../../src/webview/sidebar/grouping";
import { groupByParent, sortRows } from "../../src/sidebar/sortRows";
import type { AgentVM } from "../../src/sidebar/types";

const agent = (name: string, extra: Partial<AgentVM> = {}): AgentVM => ({ name, status: "running", ai: true, ...extra });

const renderOrder = (agents: AgentVM[]): string[] => {
  const sorted = sortRows(agents, "name-asc", (a) => a.name);
  return groupByParent(sorted, (a) => a.name, agentGroupParent).map((a) => a.name);
};

describe("sidebar declaredOwner grouping (t-4eb8bf)", () => {
  it("nests a declared-owned agent under its owner while preserving owned metadata", () => {
    const agents = [agent("reviewer", { declaredOwner: "claude" }), agent("alpha"), agent("claude")];
    const names = new Set(agents.map((a) => a.name));
    const reviewer = agents[0];

    expect(renderOrder(agents)).toEqual(["alpha", "claude", "reviewer"]);
    expect(agentIsNested(reviewer, names)).toBe(true);
    expect(reviewer.parent).toBeUndefined();
    expect(reviewer.declaredOwner).toBe("claude");
  });

  it("uses runtime parent before declaredOwner when both are present", () => {
    const agents = [
      agent("reviewer", { parent: "codex", declaredOwner: "claude" }),
      agent("claude"),
      agent("codex"),
    ];
    const names = new Set(agents.map((a) => a.name));

    expect(renderOrder(agents)).toEqual(["claude", "codex", "reviewer"]);
    expect(agentGroupParent(agents[0])).toBe("codex");
    expect(agentIsNested(agents[0], names)).toBe(true);
  });

  it("keeps a declared-owned row top-level when the owner is absent from the fleet", () => {
    const agents = [agent("reviewer", { declaredOwner: "claude" }), agent("alpha")];
    const names = new Set(agents.map((a) => a.name));

    expect(renderOrder(agents)).toEqual(["alpha", "reviewer"]);
    expect(agentIsNested(agents[0], names)).toBe(false);
  });
});
