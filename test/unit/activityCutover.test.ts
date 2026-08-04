import { describe, expect, it } from "vitest";
import fs from "node:fs";

const read = (file: string): string => fs.readFileSync(file, "utf8");

describe("SDD 485 D17 — Activity cutover doors and renderer inventory", () => {
  it("the command door opens the standalone document with the measured pair", () => {
    const extension = read("src/extension.ts");
    const start = extension.indexOf('registerCommand("tachyon.openAgentActivity"');
    expect(start).toBeGreaterThan(0);
    const block = extension.slice(start, start + 500);
    expect(block).toContain("activityPanels.open(ws.wsHash, agent)");
    expect(block).not.toContain("openCockpit(");
  });

  it("the legacy serializer door revives through the same standalone manager", () => {
    const extension = read("src/extension.ts");
    const start = extension.indexOf("registerTrustedPanelSerializer<ActivityPanelState | SectionPanelState>");
    expect(start).toBeGreaterThan(0);
    const block = extension.slice(start, extension.indexOf("registerTrustedPanelSerializer<HandoffPanelState>", start));
    expect(block).toContain("activityPanels.deserialize(panel, state)");
    expect(block).not.toContain("panel.dispose()");
    expect(block).not.toContain("openCockpit(");
  });

  it("Control has no Activity renderer, lazy import, or Activity client state", () => {
    const app = read("src/webview/cockpit/App.tsx");
    const client = read("src/webview/cockpit/main.tsx");
    expect(app).not.toMatch(/const ActivityApp|import\(["']\.\.\/activity\/App["']\)/);
    expect(app).not.toContain('activeRoute?.kind === "agent-activity"');
    expect(client).not.toMatch(/activityVm|activityImages|SHARE_AGENT_TARGETS|type === ACTIVITY/);
  });

  it("the standalone root consumes shared page chrome", () => {
    expect(read("src/webview/activity/main.tsx")).toContain('class="ds-page activity-page"');
    expect(read("src/webview/ActivityPanel.ts")).toContain('"design-system.css"');
  });
});
