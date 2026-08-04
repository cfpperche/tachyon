import fs from "node:fs";
import { describe, expect, it } from "vitest";

const read = (file: string): string => fs.readFileSync(file, "utf8");

describe("SDD 485 D18 — Probes cutover doors and renderer inventory", () => {
  it("tachyon.openProbes opens the standalone app with and without an agent", () => {
    const extension = read("src/extension.ts");
    const start = extension.indexOf('registerCommand("tachyon.openProbes"');
    const block = extension.slice(start, start + 450);
    expect(block).toContain("probesPanels.open(ws.wsHash, agent)");
    expect(block).not.toContain("openCockpit(");
  });

  it("the legacy serializer revives both persisted variants through the manager", () => {
    const extension = read("src/extension.ts");
    const start = extension.indexOf("registerTrustedPanelSerializer<ProbesPanelState | SectionPanelState>");
    const block = extension.slice(start, start + 350);
    expect(block).toContain("probesPanels.deserialize(panel, state)");
    expect(block).not.toContain("panel.dispose()");
    expect(block).not.toContain("openCockpit(");
  });

  it("Control has no Probes renderer, lazy import, client state, or host sender", () => {
    expect(fs.existsSync("src/webview/cockpit/App.tsx")).toBe(false);
    expect(fs.existsSync("src/webview/cockpit/main.tsx")).toBe(false);
    expect(fs.existsSync("src/webview/Cockpit.ts")).toBe(false);
  });

  it("the standalone root consumes shared page chrome", () => {
    expect(read("src/webview/probes/main.tsx")).toContain('class="ds-page"');
    expect(read("src/webview/ProbeResultPanel.ts")).toContain('"design-system.css"');
  });
});
