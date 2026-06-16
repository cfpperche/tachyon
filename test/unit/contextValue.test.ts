import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { agentContextValue, isAdhocItem, type AgentContextParts, type AgentItemStateName } from "../../src/presentation/contextValue.js";

const repoRoot = path.resolve(__dirname, "../..");

/** Every combination the builder can emit (3 states × 2^6 boolean segments = 192). */
function allParts(): AgentContextParts[] {
  const states: AgentItemStateName[] = ["running", "stopped", "crashed"];
  const out: AgentContextParts[] = [];
  for (const state of states)
    for (const ai of [false, true])
      for (const adhoc of [false, true])
        for (const worktree of [false, true])
          for (const verifiable of [false, true])
            for (const forkable of [false, true])
              for (const harness of [false, true]) out.push({ state, ai, adhoc, worktree, verifiable, forkable, harness });
  return out;
}

describe("agentContextValue / isAdhocItem", () => {
  it("isAdhocItem round-trips the builder for EVERY combination (no segment-position drift)", () => {
    for (const p of allParts()) {
      const cv = agentContextValue(p);
      expect(isAdhocItem(cv)).toBe(p.adhoc); // the exact bug: -adhoc mid-string (e.g. with -worktree) still detected
    }
  });

  it("emits the expected segments in a fixed order", () => {
    expect(agentContextValue({ state: "stopped", ai: true, adhoc: true, worktree: true, verifiable: false, forkable: false, harness: false })).toBe("agent-stopped-ai-adhoc-worktree");
    expect(agentContextValue({ state: "running", ai: true, adhoc: false, worktree: false, verifiable: false, forkable: true, harness: false })).toBe("agent-running-ai-forkable");
    expect(agentContextValue({ state: "running", ai: true, adhoc: false, worktree: false, verifiable: false, forkable: true, harness: true })).toBe("agent-running-ai-forkable-harness");
    expect(agentContextValue({ state: "crashed", ai: false, adhoc: false, worktree: false, verifiable: false, forkable: false, harness: false })).toBe("agent-crashed");
  });

  it("does NOT match a declared agent (no -adhoc segment)", () => {
    expect(isAdhocItem("agent-stopped-ai")).toBe(false);
    expect(isAdhocItem("agent-running-ai-worktree-forkable")).toBe(false);
    expect(isAdhocItem(undefined)).toBe(false);
    expect(isAdhocItem("")).toBe(false);
  });
});

/**
 * MENU CONTRACT GUARD — the package.json `view/item/context` `when` regexes are a parallel, declarative
 * consumer of the contextValue contract that can't import the helpers. Pin each segment-gated agent
 * action's regex to the builder's outputs, so a future segment / a `$`-anchored regex (the `/-adhoc$/`
 * class) can't silently mis-gate an action. Each command must show on EXACTLY the items its segment is on.
 */
describe("package.json agent menu `when` regexes match the builder contract", () => {
  const menus = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")).contributes.menus["view/item/context"] as Array<{ command: string; when?: string }>;
  const combos = allParts();

  // command → the part it is supposed to gate on
  const gated: Record<string, (p: AgentContextParts) => boolean> = {
    "tachyon.forkAgentItem": (p) => p.forkable,
    "tachyon.promoteAgentItem": (p) => p.adhoc,
    "tachyon.verifyAgentItem": (p) => p.verifiable,
    "tachyon.removeWorktreeItem": (p) => p.worktree,
    "tachyon.reviewWorktreeItem": (p) => p.worktree,
    "tachyon.createWorktreePrItem": (p) => p.worktree,
  };

  for (const [command, intended] of Object.entries(gated)) {
    it(`${command} gates exactly on its segment`, () => {
      const entry = menus.find((m) => m.command === command && (m.when ?? "").includes("viewItem =~"));
      expect(entry, `no view/item/context entry with a viewItem regex for ${command}`).toBeTruthy();
      const m = (entry!.when as string).match(/viewItem =~ \/(.+)\//);
      expect(m, `couldn't extract a regex from: ${entry!.when}`).toBeTruthy();
      const re = new RegExp(m![1]);
      for (const p of combos) {
        const cv = agentContextValue(p);
        expect(re.test(cv), `${command} regex /${m![1]}/ vs ${cv} (intended ${intended(p)})`).toBe(intended(p));
      }
    });
  }
});
