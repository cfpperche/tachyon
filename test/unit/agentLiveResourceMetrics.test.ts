import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { toAgentVM } from "../../src/sidebar/agentModel.js";

const appTsx = readFileSync(path.join(__dirname, "../../src/webview/sidebar/App.tsx"), "utf8");
const css = readFileSync(path.join(__dirname, "../../src/webview/sidebar/sidebar.css"), "utf8");

describe("spec 386 — agent live resource metrics", () => {
  it("maps resources onto AgentVM", () => {
    const vm = toAgentVM(
      { name: "codex", running: true, dead: false, crashed: false },
      { resources: { cpuPct: 42.2, memMb: 512 }, ai: true },
    );
    expect(vm.resources).toEqual({ cpuPct: 42.2, memMb: 512 });
  });

  it("omits resources when not provided", () => {
    const vm = toAgentVM({ name: "x", running: false, dead: false, crashed: false }, {});
    expect(vm.resources).toBeUndefined();
  });

  it("keeps hierarchy toggle and metrics toggle as separate controls", () => {
    expect(appTsx).toMatch(/class=\{`agent-toggle/);
    expect(appTsx).toMatch(/metrics-toggle/);
    expect(appTsx).toMatch(/children of \$\{a\.name\}/);
    expect(appTsx).toMatch(/Expand metrics/);
    // metrics detail is independent of hierarchy collapsed prop
    expect(appTsx).toMatch(/metricsOpen/);
    expect(appTsx).toMatch(/onToggleMetrics/);
  });

  it("reserves action gutter and defines detail lanes", () => {
    expect(css).toMatch(/--action-gutter/);
    expect(css).toMatch(/\.row-detail\b/);
    expect(css).toMatch(/\.metrics-toggle\b/);
    expect(css).toMatch(/\.peek\b/);
  });

  it("branch badge still first in AgentBadges", () => {
    const start = appTsx.indexOf("function AgentBadges");
    const end = appTsx.indexOf("function fmtCpu", start);
    const body = appTsx.slice(start, end > 0 ? end : start + 800);
    const branchPos = body.indexOf("<BranchBadge");
    const attnPos = body.indexOf("a.attention");
    expect(branchPos).toBeGreaterThan(-1);
    expect(branchPos).toBeLessThan(attnPos);
  });
});
