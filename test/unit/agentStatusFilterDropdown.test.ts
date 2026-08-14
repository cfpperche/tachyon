import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const app = readFileSync(path.join(__dirname, "../../packages/webview-ui/src/webview/sidebar/App.tsx"), "utf8");
const css = readFileSync(path.join(__dirname, "../../packages/webview-ui/src/webview/sidebar/sidebar.css"), "utf8");

describe("Agents header dropdown (t-a9d1f2)", () => {
  it("renders every counted status option in the Agents section action toolbar", () => {
    const headerStart = app.indexOf('<div class="sec">');
    const panelStart = app.indexOf('<div class="panel active"', headerStart);
    const header = app.slice(headerStart, panelStart);

    expect(header).toContain('class={`agent-filter-select');
    expect(header).toContain("AGENT_STATUS_FILTERS.map");
    expect(header).toContain("AGENT_STATUS_FILTER_LABEL[filter]");
    expect(header).toContain("agentFilterCounts[filter]");
    expect(header).toContain('disabled={filter !== "all" && count === 0}');
    expect(header).toContain("setAgentFilter(asAgentStatusFilter");
    expect(header.indexOf("agent-filter-select")).toBeLessThan(header.indexOf('name="graph"'));
  });

  it("keeps the native select accessible and absent for an empty fleet", () => {
    expect(app).toContain('totalAgents > 0');
    expect(app).toContain('aria-label={`Filter agents by status; selected');
    expect(app).toContain('title={`Filter agents —');
    expect(app).toContain("<option");
  });

  it("removes the second-row pill markup and pill-only styles", () => {
    expect(app).not.toContain("agent-filters");
    expect(app).not.toContain("agent-filter-control");
    expect(app).not.toContain("pickAgentFilter");
    expect(css).not.toContain(".agent-filters");
    expect(css).not.toContain(".agent-filter-control");
    expect(css).not.toContain(".af-dot");
  });

  it("uses VS Code dropdown tokens and can shrink inside a narrow title row", () => {
    const start = css.indexOf(".sec .agent-filter-select");
    const block = css.slice(start, css.indexOf("}", start) + 1);
    expect(block).toContain("flex: 1 1 92px");
    expect(block).toContain("min-width: 0");
    expect(block).toContain("width: clamp(58px, 31vw, 108px)");
    expect(block).toContain("--vscode-dropdown-background");
    expect(block).toContain("--vscode-dropdown-foreground");
  });
});
