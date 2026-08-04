import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Uri } from "vscode";
import {
  __createdPanels,
  __registeredWebviewPanelSerializers,
  __resetVscodeMock,
  __getShownDocuments,
} from "../mocks/vscode.js";
import {
  ACTIVITY_VIEW_TYPE,
  ActivityPanelManager,
  type ActivityPanelState,
} from "../../src/webview/ActivityPanel.js";
import { registerTrustedPanelSerializer } from "../../src/webview/shared/panelSerializer.js";
import type { SectionPanelState } from "../../src/webview/shared/SectionPanelManager.js";
import type { WorkspaceActivityTarget } from "../../src/shell/ActivityTarget.js";

const roots: string[] = [];
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => __resetVscodeMock());
afterEach(() => {
  for (const panel of __createdPanels) if (!panel.disposed) panel.dispose();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function target(wsHash: string): WorkspaceActivityTarget {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "activity-app-"));
  roots.push(workspaceRoot);
  return {
    wsHash,
    workspaceRoot,
    folderName: wsHash,
    activityAttention: () => undefined,
    activityContext: async () => ({ sharedCwd: false, targets: { items: [] } }) as never,
    sendAgentInput: async () => {},
  };
}

function harness() {
  const workspaces = [target("ws-a"), target("ws-b")];
  return new ActivityPanelManager(Uri.file("/ext"), () => workspaces);
}

describe("SDD 485 D17 — standalone Agent Activity document", () => {
  it("keys panels by the measured (workspace, agent) pair and reveals only the same pair", () => {
    const manager = harness();
    manager.open("ws-a", "claude");
    manager.open("ws-a", "codex");
    manager.open("ws-b", "claude");
    expect(manager.openKeys).toEqual([
      `${ACTIVITY_VIEW_TYPE}|ws-a|claude`,
      `${ACTIVITY_VIEW_TYPE}|ws-a|codex`,
      `${ACTIVITY_VIEW_TYPE}|ws-b|claude`,
    ]);
    manager.open("ws-a", "claude");
    expect(__createdPanels).toHaveLength(3);
    expect(__createdPanels[0].revealCount).toBe(1);
  });

  it("the legacy serializer revives through the standalone manager on the same pair", async () => {
    const manager = harness();
    const context = { subscriptions: [] as Array<{ dispose(): void }> };
    registerTrustedPanelSerializer<ActivityPanelState | SectionPanelState>(
      context as never,
      ACTIVITY_VIEW_TYPE,
      (panel, state) => manager.deserialize(panel, state),
    );
    const panel = __createdPanels[0] ?? makeRestoredPanel();
    const registration = __registeredWebviewPanelSerializers.find((entry) => entry.viewType === ACTIVITY_VIEW_TYPE)!;
    await registration.serializer.deserializeWebviewPanel(panel as never, {
      schemaVersion: 1,
      view: ACTIVITY_VIEW_TYPE,
      wsHash: "ws-a",
      agent: "claude",
    });
    await flush();
    expect(panel.disposed).toBe(false);
    expect(manager.openKeys).toEqual([`${ACTIVITY_VIEW_TYPE}|ws-a|claude`]);
    expect(panel.webview.html).toContain("activity.js");
  });
});

function makeRestoredPanel(): typeof __createdPanels[number] {
  const manager = harness();
  manager.open("ws-a", "temporary");
  const panel = __createdPanels.pop()!;
  panel.dispose = (() => { panel.disposed = true; }) as never;
  panel.disposed = false;
  return panel;
}

describe("Open Raw Transcript names ONE agent among several open tabs (t-ede83c review)", () => {
  /**
   * The regression this guards: `openTranscript` filtered on `session.visible`, and two panels in two
   * editor groups are both visible at once — so it took whichever was opened FIRST and offered the
   * wrong agent's transcript. What it superseded never had to choose (Control was a singleton) and
   * deliberately refused to guess off an activity route; becoming multi-instance had to re-earn that
   * refusal rather than inherit it.
   *
   * The observable is the DOCUMENT that opens, not a message: which file lands in the editor is the
   * thing a human would get wrong.
   */
  function transcript(name: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "activity-transcript-"));
    roots.push(dir);
    const file = path.join(dir, `${name}.jsonl`);
    fs.writeFileSync(file, "{}\n");
    return file;
  }

  function twoOpenPanels() {
    const manager = harness();
    manager.open("ws-a", "first");
    manager.open("ws-a", "second");
    const bindings = [...(manager as unknown as {
      bindings: Map<string, { agent: string; transcriptPath?: string }>;
    }).bindings.values()];
    for (const binding of bindings) binding.transcriptPath = transcript(binding.agent);
    return { manager, first: __createdPanels[0], second: __createdPanels[1], bindings };
  }

  it("opens the FOCUSED panel's transcript, not the first one opened", () => {
    const { manager, first, second, bindings } = twoOpenPanels();
    first.visible = true; first.active = false;    // both on screen, focus on the second
    second.visible = true; second.active = true;

    manager.openTranscript();

    const opened = __getShownDocuments().at(-1);
    expect(opened?.uri.fsPath, "it opened the first-created panel's transcript")
      .toBe(bindings.find((b) => b.agent === "second")?.transcriptPath);
  });

  it("opens nothing when several are visible and none is focused", () => {
    const { manager, first, second } = twoOpenPanels();
    first.visible = true; first.active = false;
    second.visible = true; second.active = false;

    manager.openTranscript();

    expect(__getShownDocuments(), "it guessed an agent instead of asking").toHaveLength(0);
  });

  it("still answers when only one panel is open and focus sits elsewhere", () => {
    const manager = harness();
    manager.open("ws-a", "only");
    const binding = [...(manager as unknown as {
      bindings: Map<string, { agent: string; transcriptPath?: string }>;
    }).bindings.values()][0];
    binding.transcriptPath = transcript("only");
    const panel = __createdPanels[0];
    panel.visible = true; panel.active = false;   // focus is in the palette's caller, not the panel

    manager.openTranscript();

    // One open panel is not ambiguous: refusing here would make the command unusable in its common case.
    expect(__getShownDocuments().at(-1)?.uri.fsPath).toBe(binding.transcriptPath);
  });
});
