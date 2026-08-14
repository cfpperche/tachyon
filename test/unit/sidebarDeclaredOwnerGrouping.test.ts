import { describe, expect, it } from "vitest";
import { agentAncestorNames, agentGroupParent, agentHierarchyRows, agentIsNested } from "../../src/webview/sidebar/grouping";
import { groupByParent, sortRows } from "../../src/sidebar/sortRows";
import type { AgentVM } from "@tachyon/shared/sidebar/types";

const agent = (name: string, extra: Partial<AgentVM> = {}): AgentVM => ({ name, status: "running", kind: "agent", ...extra });

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

  it("gated delegations nest under their delegator", () => {
    const agents = [
      agent("reviewer", { delegator: "codex", declaredOwner: "claude" }),
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

describe("sidebar agent hierarchy collapse (t-bf49a3)", () => {
  const groupedRows = (agents: AgentVM[]): AgentVM[] => {
    const sorted = sortRows(agents, "name-asc", (a) => a.name);
    return groupByParent(sorted, (a) => a.name, agentGroupParent);
  };

  it("marks parents with children while defaulting expanded", () => {
    const rows = agentHierarchyRows(groupedRows([
      agent("child", { parent: "parent" }),
      agent("parent"),
      agent("sibling"),
    ]), new Set());

    expect(rows.map((r) => [r.agent.name, r.hasChildren, r.nested, r.collapsed])).toEqual([
      ["parent", true, false, false],
      ["child", false, true, false],
      ["sibling", false, false, false],
    ]);
  });

  it("hides collapsed descendants and reports hidden attention", () => {
    const rows = agentHierarchyRows(groupedRows([
      agent("grandchild", { parent: "child", attention: "needs input" }),
      agent("child", { parent: "parent" }),
      agent("parent"),
      agent("sibling"),
    ]), new Set(["parent"]));

    expect(rows.map((r) => r.agent.name)).toEqual(["parent", "sibling"]);
    expect(rows[0]).toMatchObject({
      hasChildren: true,
      collapsed: true,
      hiddenCount: 2,
      hiddenNeedsAttention: true,
    });
  });

  it("returns existing ancestors so search can expand a hidden child", () => {
    const agents = [
      agent("grandchild", { parent: "child" }),
      agent("child", { parent: "parent" }),
      agent("parent"),
    ];

    expect(agentAncestorNames(agents, "grandchild")).toEqual(["child", "parent"]);
    expect(agentAncestorNames(agents, "parent")).toEqual([]);
  });
});
