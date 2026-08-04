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
      openSection: () => undefined });
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
    expect(host.match(/routes\.section\("overview"\)/g)).toHaveLength(23);
    expect(host).toMatch(/section === "overview"[\s\S]*openOverviewApp\?\.\(\);[\s\S]*routes\.section\("approvals"\)/);
  });

  it("ships the stylesheet the standalone panel links", () => {
    const build = readFileSync("esbuild.mjs", "utf8");
    expect(build).toContain('copyFileSync("src/webview/overview/overview.css", "dist/webview/overview.css")');
  });

  // t-3bcd57 — JUMP card removed; prove no dead nav and no orphan protocol.
  it("t-3bcd57: JUMP card is gone; openSection stays for inbox; Doctor/handoff keep other doors", () => {
    const app = readFileSync("src/webview/overview/App.tsx", "utf8");
    const messages = readFileSync("src/webview/overview/messages.ts", "utf8");
    const panel = readFileSync("src/webview/OverviewPanel.ts", "utf8");
    const css = readFileSync("src/webview/overview/overview.css", "utf8");
    const ext = readFileSync("src/extension.ts", "utf8");
    const pkg = readFileSync("package.json", "utf8");
    expect(app).not.toMatch(/Jump|ck-jump|openDoctor/);
    expect(app).toContain('type: "openSection", section: "inbox"');
    expect(messages).toContain("openSection");
    expect(messages).not.toContain("openDoctor");
    expect(panel).not.toContain("openDoctor");
    expect(css).not.toContain("ck-jump");
    expect(css).toContain("ck-overview-actions");
    expect(ext).not.toMatch(/section === ["']handoff["']/);
    expect(pkg).toContain('"command": "tachyon.doctor"');
    expect(pkg).toContain('"command": "tachyon.openProjectHandoff"');
    expect(ext).toMatch(/registerCommand\("tachyon\.doctor"/);
    expect(ext).toMatch(/registerCommand\("tachyon\.openProjectHandoff"/);
  });
});
