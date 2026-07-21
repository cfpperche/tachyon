import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { __createdPanels, __resetVscodeMock, __getShownDocuments } from "../mocks/vscode.js";
import { openCockpit, type CockpitMissionBoard, type CockpitActivity } from "../../src/webview/Cockpit.js";
import type { WorkspaceActivityTarget } from "../../src/shell/ActivityTarget.js";
import { makeFakeCockpitDeps } from "../mocks/cockpitDeps.js";
import { ActivityLog } from "../../src/activity/logStore.js";
import { normalizeClaude } from "../../src/activity/claudeNormalizer.js";
import type { Workspace } from "../../src/workspace/Workspace.js";

/**
 * t-610705 (SDD 410 Phase C.2) — Activity ROUTING coverage for Control → fleet/agent/<name>/activity.
 * Control hosts AT MOST ONE active feed at a time (unlike the retired ActivityPanelManager's
 * one-watcher-per-open-panel Map), so the load-bearing behavior here is the hardening dueto's core
 * finding: a late async continuation from a TORN-DOWN binding must never post into whatever feed
 * replaced it. `depsFor` mirrors cockpitTaskDetail.test.ts's pattern.
 */

const dirs: string[] = [];
const mkroot = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-activity-"));
  dirs.push(dir);
  return dir;
};

beforeEach(() => __resetVscodeMock());
afterEach(() => {
  for (const p of __createdPanels) if (!p.disposed) p.dispose();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** Write ONE real record into the durable per-agent log the host tails — the same shape a live
 *  writer produces, just constructed directly (bypasses ActivityLogWriter's session-file plumbing). */
function seedActivityLog(root: string, agent: string, text: string): void {
  const dir = path.join(root, ".tachyon", "activity");
  const log = new ActivityLog(dir, agent);
  const base = { sessionId: "s1", cwd: root, timestamp: "2026-06-20T00:00:00Z", version: "2.1.183" };
  const line = JSON.stringify({ ...base, type: "assistant", message: { content: [{ type: "text", text }] } });
  const events = normalizeClaude([line], "/x/sess.jsonl");
  log.appendRecord(events, { runtime: "claude", sessionId: "s1", sourcePath: "/x/sess.jsonl" }, base.timestamp);
}

function fakeWorkspace(root = mkroot(), opts: { hash?: string } = {}): Workspace {
  return { wsHash: opts.hash ?? "ws-1", folderName: "Project", workspaceRoot: root } as unknown as Workspace;
}

/** Deterministic, no `activityContext`/`sendAgentInput` network — override per test as needed. */
function activityTarget(ws: Workspace, overrides: Partial<WorkspaceActivityTarget> = {}): WorkspaceActivityTarget {
  return {
    workspaceRoot: ws.workspaceRoot,
    wsHash: ws.wsHash,
    folderName: ws.folderName,
    activityAttention: () => undefined,
    activityContext: async () => ({ sharedCwd: false, targets: { items: [] } }) as never,
    sendAgentInput: async () => {},
    ...overrides,
  };
}

function depsFor(activity: CockpitActivity, hooks: Partial<CockpitMissionBoard> = {}) {
  const missionBoard: CockpitMissionBoard = { getWorkspaces: () => [], openTaskStudio: () => {}, onTasksChanged: () => {}, ...hooks };
  return makeFakeCockpitDeps(missionBoard, { activity });
}

const activityMessages = () => __createdPanels[0].webview.posted.filter((m) => (m as { type?: string }).type === "activity") as Array<{ wsHash: string; agent: string; vm: { items: unknown[]; summary: { messages: number } } }>;

/**
 * Fresh-panel creation only renders the shell HTML — content pushes wait for the client's "ready"
 * handshake (cockpit/main.tsx's Root posts it once on mount), same as the real host. A SUBSEQUENT
 * openCockpit() call on an already-open panel takes the reveal branch, which DOES push immediately
 * (sendModel+sendSectionModule) — no extra "ready" needed for in-test re-navigation.
 */
async function openActivity(deps: ReturnType<typeof depsFor>, route: { kind: "agent-activity"; wsHash: string; agent: string }): Promise<void> {
  await openCockpit(deps, { route });
  __createdPanels[0].webview.__receive({ type: "ready" });
  await flush();
}

describe("Control → Activity routing", () => {
  it("opens the agent-activity route and posts the durable log's current feed", async () => {
    const ws = fakeWorkspace();
    seedActivityLog(ws.workspaceRoot, "claude", "hello there");
    const deps = depsFor({ getWorkspaces: () => [activityTarget(ws)] });
    await openActivity(deps, { kind: "agent-activity", wsHash: ws.wsHash, agent: "claude" });

    const msg = activityMessages().at(-1);
    expect(msg?.wsHash).toBe(ws.wsHash);
    expect(msg?.agent).toBe("claude");
    expect(msg?.vm.summary.messages).toBe(1);
  });

  it("a same-identity re-navigate does not restart the feed — no duplicate initial post", async () => {
    const ws = fakeWorkspace();
    seedActivityLog(ws.workspaceRoot, "claude", "one");
    const deps = depsFor({ getWorkspaces: () => [activityTarget(ws)] });
    await openActivity(deps, { kind: "agent-activity", wsHash: ws.wsHash, agent: "claude" });
    const before = activityMessages().length;

    // re-entering the SAME identity (e.g. clicking the same Fleet row's Activity action again)
    await openCockpit(deps, { route: { kind: "agent-activity", wsHash: ws.wsHash, agent: "claude" } });
    await flush();

    expect(activityMessages().length).toBe(before);
  });

  it("navigating to a different agent tears down the old binding and starts fresh for the new one", async () => {
    const ws = fakeWorkspace();
    seedActivityLog(ws.workspaceRoot, "claude", "from claude");
    seedActivityLog(ws.workspaceRoot, "codex", "from codex");
    const deps = depsFor({ getWorkspaces: () => [activityTarget(ws)] });
    await openActivity(deps, { kind: "agent-activity", wsHash: ws.wsHash, agent: "claude" });

    await openCockpit(deps, { route: { kind: "agent-activity", wsHash: ws.wsHash, agent: "codex" } });
    await flush();

    const latest = activityMessages().at(-1);
    expect(latest?.agent).toBe("codex");
  });

  it("a late async continuation from a torn-down binding never posts (hardening dueto probe-2d90286d)", async () => {
    const ws = fakeWorkspace();
    seedActivityLog(ws.workspaceRoot, "claude", "hi");
    let resolveContext!: (v: { sharedCwd: boolean; targets: { items: never[] } }) => void;
    const wedged = new Promise<{ sharedCwd: boolean; targets: { items: never[] } }>((res) => { resolveContext = res; });
    const deps = depsFor({ getWorkspaces: () => [activityTarget(ws, { activityContext: () => wedged as never })] });
    await openActivity(deps, { kind: "agent-activity", wsHash: ws.wsHash, agent: "claude" });
    const before = activityMessages().length;

    // navigate away BEFORE the wedged sharedCwd resolution settles
    await openCockpit(deps, { section: "fleet" });
    await flush();

    resolveContext({ sharedCwd: true, targets: { items: [] } });
    await flush();
    await flush();

    // the resolution fired after teardown — it must never reach the (now-Fleet) webview
    expect(activityMessages().length).toBe(before);
  });

  it("leaving the route unbinds — a log change after navigating away posts nothing further", async () => {
    const ws = fakeWorkspace();
    seedActivityLog(ws.workspaceRoot, "claude", "first");
    const deps = depsFor({ getWorkspaces: () => [activityTarget(ws)] });
    await openActivity(deps, { kind: "agent-activity", wsHash: ws.wsHash, agent: "claude" });
    const before = activityMessages().length;

    await openCockpit(deps, { section: "fleet" });
    await flush();
    seedActivityLog(ws.workspaceRoot, "claude", "second, after leaving");
    await flush();

    expect(activityMessages().length).toBe(before);
  });

  it("a stale revive/deep-link with no matching workspace leaves the route open but empty (no throw)", async () => {
    const deps = depsFor({ getWorkspaces: () => [] });
    await expect(openCockpit(deps, { route: { kind: "agent-activity", wsHash: "gone", agent: "claude" } })).resolves.not.toThrow();
    __createdPanels[0].webview.__receive({ type: "ready" });
    await flush();
    expect(activityMessages()).toHaveLength(0);
  });

  it("openFile only opens a path the host has actually surfaced (knownPaths allow-list)", async () => {
    const ws = fakeWorkspace();
    const dir = path.join(ws.workspaceRoot, ".tachyon", "activity");
    const log = new ActivityLog(dir, "claude");
    const base = { sessionId: "s1", cwd: ws.workspaceRoot, timestamp: "2026-06-20T00:00:00Z", version: "2.1.183" };
    const lines = [
      JSON.stringify({ ...base, type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Write", input: { file_path: "/repo/a.ts" } }] } }),
      JSON.stringify({ ...base, type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1" }] } }),
    ];
    log.appendRecord(normalizeClaude(lines, "/x/sess.jsonl"), { runtime: "claude", sessionId: "s1", sourcePath: "/x/sess.jsonl" }, base.timestamp);
    const deps = depsFor({ getWorkspaces: () => [activityTarget(ws)] });
    await openActivity(deps, { kind: "agent-activity", wsHash: ws.wsHash, agent: "claude" });

    __createdPanels[0].webview.__receive({ type: "openFile", path: "/etc/passwd" });
    await flush();
    expect(__getShownDocuments()).toHaveLength(0);

    __createdPanels[0].webview.__receive({ type: "openFile", path: "/repo/a.ts" });
    await flush();
    expect(__getShownDocuments()).toHaveLength(1);
    expect(__getShownDocuments()[0]?.uri.fsPath ?? __getShownDocuments()[0]?.uri).toContain("a.ts");
  });
});
