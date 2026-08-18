import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Uri } from "vscode";
import { __createdPanels, __resetVscodeMock } from "../mocks/vscode.js";
import { REVIEW_VIEW_TYPE, ReviewPanelManager, reviewRefreshKind, type ReviewOpenArgs, type ReviewPanelHost } from "../../apps/vscode-extension/src/webview/ReviewPanel.js";
import { readyMessage } from "@tachyon/webview-ui/webview/shared/ready.js";
import type { ReviewDiffFileV1 } from "@tachyon/engine/runtime-api/reviewProjection.js";

/**
 * SDD 513 fatia 3 — the review tab. Cardinality and "nothing reveals itself" are the
 * claims; the screen itself is already covered by reviewDiffRender.test.ts.
 */

const extensionUri = Uri.file("/ext");
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

beforeEach(() => __resetVscodeMock());
afterEach(() => {
  for (const panel of __createdPanels) if (!panel.disposed) panel.dispose();
});

const args = (over: Partial<ReviewOpenArgs> = {}): ReviewOpenArgs => ({
  workspaceHash: "ws-1",
  worktree: "reviewgrok",
  cwd: "/wt",
  baseRef: "abc1234",
  currentLabel: "worktree",
  files: [{ status: "M", path: "src/a.ts" }],
  selectedPath: "src/a.ts",
  ...over,
});

function emptyDiff(path: string): ReviewDiffFileV1 {
  return {
    schemaVersion: 1,
    format: "unified",
    worktree: "reviewgrok",
    path,
    status: "M",
    baseRef: "abc1234",
    currentLabel: "worktree",
    binary: false,
    hunks: [],
  };
}

function host(over: Partial<ReviewPanelHost> = {}): ReviewPanelHost & { diffs: string[]; upserts: number } {
  const recorded: ReviewPanelHost & { diffs: string[]; upserts: number } = {
    diffs: [],
    upserts: 0,
    loadSession: async () => args(),
    viewNotes: async () => [],
    viewDiff: async (input) => {
      recorded.diffs.push(input.path);
      return emptyDiff(input.path);
    },
    upsert: async () => { recorded.upserts += 1; },
    listAgents: async () => [{ name: "reviewgrok" }],
    sendPrompt: async () => {},
    attachEvidence: async () => {},
    resolveHead: async () => "a".repeat(40),
    notify: () => {},
    ...over,
  };
  return recorded;
}

describe("SDD 513 fatia 3 — ReviewPanel cardinality", () => {
  it("opens ONE panel per worktree and REVEALS it on a second open", () => {
    const manager = new ReviewPanelManager(extensionUri, host());
    manager.open(args());
    manager.open(args());
    expect(__createdPanels).toHaveLength(1);
    expect(__createdPanels[0].revealCount).toBe(1);
    expect(manager.openKeys).toEqual([`${REVIEW_VIEW_TYPE}|ws-1|reviewgrok`]);
  });

  it("gives two worktrees a panel each", () => {
    const manager = new ReviewPanelManager(extensionUri, host());
    manager.open(args({ worktree: "a" }));
    manager.open(args({ worktree: "b" }));
    expect(__createdPanels).toHaveLength(2);
    expect(manager.openKeys).toEqual([
      `${REVIEW_VIEW_TYPE}|ws-1|a`,
      `${REVIEW_VIEW_TYPE}|ws-1|b`,
    ]);
  });
});

describe("SDD 513 fatia 3 — the command is the only reveal", () => {
  it("posts the review VM on ready and fetches one path of hunks", async () => {
    const h = host();
    const manager = new ReviewPanelManager(extensionUri, h);
    manager.open(args());
    const panel = __createdPanels[0];
    panel.webview.__receive(readyMessage());
    await flush();
    const posted = panel.webview.posted.filter((m) => (m as { type?: string }).type === "review") as Array<{ vm: { selectedPath: string | null; files: Array<{ path: string }> } }>;
    expect(posted.at(-1)?.vm.selectedPath).toBe("src/a.ts");
    expect(posted.at(-1)?.vm.files).toEqual([{ status: "M", path: "src/a.ts" }]);
    expect(h.diffs).toEqual(["src/a.ts"]);
  });

  it("selecting a file posts review.diff for that path only — never a files array", async () => {
    const h = host();
    const manager = new ReviewPanelManager(extensionUri, h);
    manager.open(args({ files: [{ status: "M", path: "src/a.ts" }, { status: "D", path: "gone.ts" }] }));
    const panel = __createdPanels[0];
    panel.webview.__receive({ type: "review.diff", path: "gone.ts" });
    await flush();
    expect(h.diffs.at(-1)).toBe("gone.ts");
    const last = [...panel.webview.posted].reverse().find((m) => (m as { type?: string }).type === "review") as { vm: { selectedPath: string } };
    expect(last.vm.selectedPath).toBe("gone.ts");
  });

  it("writing a note does not execute vscode.diff and does not create a CommentController", async () => {
    const h = host();
    const manager = new ReviewPanelManager(extensionUri, h);
    manager.open(args());
    const panel = __createdPanels[0];
    panel.webview.__receive({ type: "review.upsertNote", path: "src/a.ts", line: 2, body: "check the caller" });
    await flush();
    expect(h.upserts).toBe(1);
    const html = panel.webview.html;
    expect(html).not.toMatch(/CommentController/);
    expect(html).not.toMatch(/vscode\.diff/);
  });
});

describe("reviewRefreshKind", () => {
  it("claims the shared ready handshake and nothing else", () => {
    expect(reviewRefreshKind(readyMessage())).toBe("review");
    expect(reviewRefreshKind({ type: "review.diff", path: "src/a.ts" })).toBeUndefined();
    expect(reviewRefreshKind({ type: "review.upsertNote" })).toBeUndefined();
  });
});
