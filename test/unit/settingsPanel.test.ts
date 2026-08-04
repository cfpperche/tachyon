import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Uri } from "vscode";
import { __createdPanels, __resetVscodeMock } from "../mocks/vscode.js";
import { SETTINGS_VIEW_TYPE, SettingsPanelManager } from "../../src/webview/SettingsPanel.js";
import { readyMessage } from "../../src/webview/settings/messages.js";

describe("SDD 485 D10 — standalone Settings dashboard", () => {
  it("opens one immutable panel per project and reads the selected project", async () => {
    __resetVscodeMock();
    const needs: unknown[] = [];
    const noop = async () => undefined;
    const manager = new SettingsPanelManager(Uri.file("/ext"), {
      collect: async (value) => { needs.push(value); return []; }, openDoctor: () => undefined,
      openConfigFile: noop, setCompanionTabTools: noop, setIdleAfterMinutes: noop,
      setCompanionAllowedHosts: noop, unpairCompanionDevice: noop,
      issueCompanionPairCode: async () => ({ ok: false, reason: "test" }),
    });
    manager.open("project-a"); manager.open("project-b");
    for (const panel of __createdPanels) panel.webview.__receive(readyMessage());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(manager.openKeys).toEqual([`${SETTINGS_VIEW_TYPE}|project-a`, `${SETTINGS_VIEW_TYPE}|project-b`]);
    expect(needs).toHaveLength(2);
  });

  it("leaves no Settings renderer or unknown-section fallback in Control", () => {
    const app = readFileSync("src/webview/cockpit/App.tsx", "utf8");
    expect(app).not.toContain("control-settings");
    expect(app).not.toContain("unknown section fallback");
    expect(app).toContain("unknown sections never masquerade as Settings");
  });
});
