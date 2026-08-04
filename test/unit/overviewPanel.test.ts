import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Uri } from "vscode";
import { __createdPanels, __resetVscodeMock } from "../mocks/vscode.js";
import { OVERVIEW_VIEW_TYPE, OverviewPanelManager } from "../../src/webview/OverviewPanel.js";
import { readyMessage } from "../../src/webview/overview/messages.js";

describe("SDD 485 D11 — standalone Overview dashboard", () => {
  it("opens one immutable panel per project and reads each project", async () => {
    __resetVscodeMock(); const needs: unknown[] = [];
    const manager = new OverviewPanelManager(Uri.file("/ext"), { collect: async (n) => { needs.push(n); return []; },
      openSection: () => undefined, openDoctor: () => undefined });
    manager.open("project-a"); manager.open("project-b");
    for (const panel of __createdPanels) panel.webview.__receive(readyMessage());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(manager.openKeys).toEqual([`${OVERVIEW_VIEW_TYPE}|project-a`, `${OVERVIEW_VIEW_TYPE}|project-b`]);
    expect(needs).toHaveLength(2);
  });

  it("leaves no Overview renderer in Control", () => {
    const app = readFileSync("src/webview/cockpit/App.tsx", "utf8");
    const host = readFileSync("src/webview/Cockpit.ts", "utf8");
    expect(app).not.toContain('section === "overview"');
    expect(app).not.toContain("ck-overview-actions");
    expect(host.match(/routes\.section\("overview"\)/g)).toHaveLength(21);
    expect(host).toMatch(/section === "overview"[\s\S]*openOverviewApp\?\.\(\);[\s\S]*routes\.section\("approvals"\)/);
  });

  it("ships the stylesheet the standalone panel links", () => {
    const build = readFileSync("esbuild.mjs", "utf8");
    expect(build).toContain('copyFileSync("src/webview/overview/overview.css", "dist/webview/overview.css")');
  });
});
