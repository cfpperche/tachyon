import { describe, expect, it } from "vitest";
import fs from "node:fs";

const read = (file: string) => fs.readFileSync(file, "utf8");

describe("SDD 485 D12 — Task Studio is a task-document mode", () => {
  it("keeps studio-edit(task) as a redirect into edit mode and removes Control's Task Studio renderer", () => {
    expect(() => read("packages/webview-ui/src/webview/Cockpit.ts")).toThrow();
    expect(() => read("packages/webview-ui/src/webview/cockpit/App.tsx")).toThrow();
  });

  it("keeps the tachyonTaskStudio serializer as dispose plus redirect, never revive", () => {
    const extension = read("apps/vscode-extension/src/extension.ts");
    const at = extension.indexOf("registerTrustedPanelSerializer<TaskStudioPanelState>");
    const block = extension.slice(at, at + 900);
    expect(block).toContain("panel.dispose()");
    expect(block).toContain("taskDetailPanels.openEdit(");
    expect(block).not.toContain("taskDetailPanels.deserialize");
  });
});
