import { describe, expect, it } from "vitest";
import fs from "node:fs";

const read = (file: string) => fs.readFileSync(file, "utf8");

describe("SDD 485 D20 — Pin Studio only renders in the Pins document", () => {
  it("keeps studio-new(pin) as a redirect into create mode and removes Control's renderer", () => {
    expect(() => read("src/webview/Cockpit.ts")).toThrow();
    expect(() => read("src/webview/cockpit/App.tsx")).toThrow();
  });

  it("reopens a persisted tachyonPinStudio panel in the Pins document create or edit mode", () => {
    const extension = read("src/extension.ts");
    const at = extension.indexOf("registerTrustedPanelSerializer<PinStudioPanelState>");
    const block = extension.slice(at, at + 900);
    expect(at).toBeGreaterThan(-1);
    expect(block).toContain("panel.dispose()");
    expect(block).toContain("pinDetailPanels.openEdit(");
    expect(block).toContain("pinDetailPanels.openCreate(");
    expect(block).not.toContain("openCockpit(");
  });
});
