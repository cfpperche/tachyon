import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { toAgentVM } from "@tachyon/engine/sidebar/agentModel.js";
import { DEFAULT_CARD_TEMPLATE } from "@tachyon/shared/sidebar/cardTemplate.js";

const appTsx = readFileSync(path.join(__dirname, "../../packages/webview-ui/src/webview/sidebar/App.tsx"), "utf8");
const css = readFileSync(path.join(__dirname, "../../packages/webview-ui/src/webview/sidebar/sidebar.css"), "utf8");

describe("spec 386 — agent live resource metrics", () => {
  it("maps resources onto AgentVM", () => {
    const vm = toAgentVM(
      { name: "codex", running: true, dead: false, crashed: false },
      { resources: { cpuPct: 42.2, memMb: 512 }, kind: "agent" },
    );
    expect(vm.resources).toEqual({ cpuPct: 42.2, memMb: 512 });
  });

  it("omits resources when not provided", () => {
    const vm = toAgentVM({ name: "x", running: false, dead: false, crashed: false }, {});
    expect(vm.resources).toBeUndefined();
  });

  it("keeps hierarchy chevron separate; metrics use peek pill only (no ▤ before name)", () => {
    expect(appTsx).toMatch(/class=\{`agent-toggle/);
    expect(appTsx).toMatch(/children of \$\{a\.name\}/);
    expect(appTsx).not.toMatch(/metrics-toggle/);
    expect(appTsx).toMatch(/class=\{`peek/);
    expect(appTsx).toMatch(/metricsOpen/);
    expect(appTsx).toMatch(/onToggleMetrics/);
    // all-metrics is one icon act (graph) in sec-actions, not a text button pair
    expect(appTsx).toMatch(/name="graph"/);
    expect(appTsx).not.toMatch(/sec-metrics-btn/);
    expect(appTsx).not.toMatch(/>Expand metrics</);
    expect(appTsx).not.toMatch(/>Collapse metrics</);
  });

  it("reserves action gutter and defines detail lanes", () => {
    expect(css).toMatch(/--action-gutter/);
    expect(css).toMatch(/\.row-detail\b/);
    expect(css).toMatch(/\.peek\b/);
    expect(css).not.toMatch(/\.metrics-toggle\b/);
  });

  it("branch badge still first in the meta region", () => {
    // SDD 479 phase 1 — the meta order is the default template's array now (see sidebarCardCatalog.test.ts);
    // the metrics pill's own position is likewise a header-region fact, not a source-position one.
    const meta = DEFAULT_CARD_TEMPLATE.meta;
    expect(meta.indexOf("branch")).toBeGreaterThan(-1);
    expect(meta.indexOf("branch")).toBeLessThan(meta.indexOf("attention"));
    expect(DEFAULT_CARD_TEMPLATE.header).toContain("metrics-pill");
    expect(DEFAULT_CARD_TEMPLATE.footer).toContain("metrics-lanes");
  });
});
