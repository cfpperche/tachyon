import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Uri } from "vscode";
import fs from "node:fs";
import path from "node:path";
import { __createdPanels, __resetVscodeMock, __getShownDocuments, __setPanelVisible } from "../mocks/vscode.js";
import { HandoffPanelManager } from "../../apps/vscode-extension/src/webview/HandoffPanel.js";
import type { WorkspaceHandoffTarget } from "../../apps/vscode-extension/src/shell/HandoffTarget.js";
import type { HandoffProjectionV1 } from "@tachyon/engine/runtime-api/handoffProjection.js";

beforeEach(() => __resetVscodeMock());
afterEach(() => { for (const panel of __createdPanels) if (!panel.disposed) panel.dispose(); });
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function snapshot(overrides: Partial<HandoffProjectionV1> = {}): HandoffProjectionV1 {
  return { canonicalRelativePath: ".tachyon/HANDOFF.md", exists: true, body: "## Current State\n",
    staleness: "fresh", pendingCount: 0, updatedAt: "2026-07-21T00:00:00.000Z", updatedBy: "human",
    revision: "0123456789abcdef", notes: [], distillTargets: [], ...overrides };
}
function target(wsHash: string, overrides: Partial<WorkspaceHandoffTarget> = {}): WorkspaceHandoffTarget {
  return { workspaceRoot: `/repo/${wsHash}`, wsHash, folderName: wsHash, loadHandoff: async () => snapshot(),
    ensureHandoffFile: async () => `/repo/${wsHash}/.tachyon/HANDOFF.md`,
    startHandoffDistill: async (input) => ({ mode: input.mode, agent: input.mode === "existing" ? input.agent : "temporary" }),
    ...overrides } as WorkspaceHandoffTarget;
}
function manager(workspaces: WorkspaceHandoffTarget[]) {
  return new HandoffPanelManager(Uri.file("/ext"), { getWorkspaces: () => workspaces });
}
const messages = (index = 0) => __createdPanels[index].webview.posted.filter((message) => (message as { type?: string }).type === "handoff");

describe("Project Handoff standalone dashboard (SDD 485 D19)", () => {
  it("has no Handoff renderer or stylesheet path left in Control", () => {
    const root = process.cwd();
    expect(fs.existsSync(path.join(root, "packages/webview-ui/src/webview/cockpit/App.tsx"))).toBe(false);
    expect(fs.existsSync(path.join(root, "packages/webview-ui/src/webview/Cockpit.ts"))).toBe(false);
  });

  it("keeps command, legacy restore and fan-out wired to HandoffPanelManager", () => {
    const extension = fs.readFileSync(path.resolve(process.cwd(), "apps/vscode-extension/src/extension.ts"), "utf8");
    expect(extension).toMatch(/registerCommand\("tachyon\.openProjectHandoff"[\s\S]*?hash \? byHash\(hash\) : await pickWorkspace\(\)[\s\S]*?openHandoffTab\(ws\.wsHash\)/);
    expect(extension).toMatch(/registerTrustedPanelSerializer<SectionPanelState \| HandoffPanelState>[\s\S]*?handoffPanels\.deserialize\(panel, state\)/);
    expect(extension).toMatch(/view === "handoff"\) handoffPanels\.refresh\(\)/);
  });

  it("opens one panel per project and reveals rather than duplicates", () => {
    const panels = manager([target("a"), target("b")]);
    panels.open("a"); panels.open("b"); panels.open("a");
    expect(__createdPanels).toHaveLength(2);
    expect(panels.openKeys).toHaveLength(2);
  });

  it("loads each panel from the project in its key", async () => {
    const panels = manager([
      target("a", { loadHandoff: async () => snapshot({ body: "# A" }) }),
      target("b", { loadHandoff: async () => snapshot({ body: "# B" }) }),
    ]);
    panels.open("a"); panels.open("b");
    __createdPanels[0].webview.__receive({ type: "ready" });
    __createdPanels[1].webview.__receive({ type: "ready" });
    await flush();
    expect((messages(0).at(-1) as { vm: { body: string } }).vm.body).toBe("# A");
    expect((messages(1).at(-1) as { vm: { body: string } }).vm.body).toBe("# B");
  });

  it("keeps open and distill actions scoped to the panel project", async () => {
    let distilled: unknown;
    const panels = manager([target("a"), target("b", { startHandoffDistill: async (input) => {
      distilled = input; return { mode: input.mode, agent: input.mode === "existing" ? input.agent : "temporary" };
    } })]);
    panels.open("b");
    __createdPanels[0].webview.__receive({ type: "ready" }); await flush();
    __createdPanels[0].webview.__receive({ type: "openFile" }); await flush();
    expect(__getShownDocuments()[0]?.uri.fsPath).toContain("/b/");
    __createdPanels[0].webview.__receive({ type: "distill", mode: "existing", agent: " codex ", instructions: " concise " });
    await flush();
    expect(distilled).toEqual({ mode: "existing", agent: "codex", instructions: "concise" });
  });

  it("revives the legacy wsHash state into the same dashboard key", () => {
    const panels = manager([target("a")]);
    const restored = __createdPanels[0] ?? ({} as never);
    // The mock panel shape is easiest obtained through one open; dispose it, then hand its panel back as legacy state.
    panels.open("a");
    const panel = __createdPanels[0]; panel.dispose();
    panels.deserialize(panel as never, { schemaVersion: 1, view: "tachyonHandoff", wsHash: "a" });
    expect(panels.openKeys).toEqual(["tachyonHandoff|a"]);
    void restored;
  });

  it("fans out only to visible panels", async () => {
    let loads = 0;
    const panels = manager([target("a", { loadHandoff: async () => { loads += 1; return snapshot(); } })]);
    panels.open("a"); const panel = __createdPanels[0];
    __setPanelVisible(panel, false);
    expect(panels.refresh()).toBe(0);
    expect(loads).toBe(0);
    __setPanelVisible(panel, true); await flush();
    expect(loads).toBe(1);
  });
});
