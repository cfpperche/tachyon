import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DaemonEngineHost, EngineUiUnavailableError, type DaemonHostEvent, type DaemonUiRequest } from "../../src/workspace/DaemonEngineHost.js";
import { Workspace } from "../../src/workspace/Workspace.js";
import { TmuxService } from "../../src/tmux/TmuxService.js";
import { routeHumanApprovalRequest } from "../../src/engine-service/engineService.js";

const roots: string[] = [];
const hosts: DaemonEngineHost[] = [];

afterEach(() => {
  for (const host of hosts.splice(0)) host.dispose();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture(requestUi?: (request: DaemonUiRequest) => Promise<unknown>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-daemon-host-"));
  roots.push(root);
  const mediaRoot = path.join(root, "bundle");
  fs.mkdirSync(mediaRoot);
  const events: DaemonHostEvent[] = [];
  const host = new DaemonEngineHost({
    storageRoot: path.join(root, "state"),
    mediaRoot,
    appVersion: "0.57.0",
    settings: {
      global: { "tachyon.maxAgents": 8, "git.path": "global" },
      workspace: { "tachyon.maxAgents": 4, "git.path": null },
      workspaceFolder: { "tachyon.maxAgents": 2 },
    },
    emit: (event) => events.push(event),
    requestUi,
    watchIntervalMs: 15,
  });
  hosts.push(host);
  return { root, mediaRoot, events, host };
}

describe("DaemonEngineHost", () => {
  it("owns settings, state, secrets and headless UI failure semantics", async () => {
    const f = fixture();
    expect(f.host.getSetting("tachyon", "maxAgents", 1)).toBe(2);
    expect(f.host.getSetting("git", "path", "fallback")).toBeNull();
    expect(() => f.host.getSetting("tachyon", "missing", "fallback")).toThrow(/not allowlisted/);
    expect(f.host.getSettingInspect("tachyon", "maxAgents")).toEqual({
      globalValue: 8,
      workspaceValue: 4,
      workspaceFolderValue: 2,
    });
    f.host.setState("state-key", { value: 1 });
    await f.host.setSecret("secret-key", "secret");
    expect(f.host.getState("state-key")).toEqual({ value: 1 });
    expect(await f.host.getSecret("secret-key")).toBe("secret");
    expect(f.host.mediaPath("media", "helper.sh")).toBe(path.join(f.mediaRoot, "media", "helper.sh"));
    expect(() => f.host.mediaPath("..", "escape")).toThrow(/escapes/);

    f.host.focusPrimaryView();
    await expect(f.host.executeCommand("tachyon.doctor")).rejects.toBeInstanceOf(EngineUiUnavailableError);
    expect(f.events.filter((event) => event.kind === "ui-unavailable")).toHaveLength(2);
    expect(() => f.host.replaceSettings({ workspace: { "tachyon.unknown": true } })).toThrow(/not allowlisted/);
  });

  it("emits plain view/notice events and executes a notice action once", async () => {
    const f = fixture();
    let invoked = 0;
    f.host.onViewsChanged("agents");
    f.host.onActivityAppended("codex", 2);
    f.host.notify("ready", "info", [{ label: "Open", run: () => { invoked++; } }]);
    expect(f.events[0]).toMatchObject({ kind: "views-changed", view: "agents" });
    expect(f.events[1]).toMatchObject({ kind: "activity-appended", agent: "codex", count: 2 });
    const notice = f.events[2];
    expect(notice).toMatchObject({ kind: "notice", message: "ready", actions: [{ label: "Open" }] });
    if (notice.kind !== "notice") throw new Error("expected notice event");
    await f.host.invokeNoticeAction(notice.id, notice.actions[0].id);
    expect(invoked).toBe(1);
    await expect(f.host.invokeNoticeAction(notice.id, notice.actions[0].id)).rejects.toThrow(/consumed/);
  });

  it("retains an actionable notice without presenting shell UI and consumes its action exactly once", async () => {
    let invoked = 0;
    const requests: DaemonUiRequest[] = [];
    const f = fixture(async (request) => {
      requests.push(request);
      return null;
    });

    f.host.notify("ready", "info", [{ label: "Open", run: () => { invoked++; } }]);
    const row = f.host.listNoticeInbox()[0]!;
    expect(row).toMatchObject({ message: "ready", actionsLive: true, actions: [{ label: "Open" }] });
    expect(requests).toHaveLength(0);
    expect(invoked).toBe(0);
    await f.host.invokeNoticeAction(row.id, row.actions[0]!.id);
    expect(invoked).toBe(1);
    await expect(f.host.invokeNoticeAction(row.id, row.actions[0]!.id)).rejects.toThrow(/consumed/);
    expect(f.host.listNoticeInbox()).toHaveLength(0);
  });

  it("routes a retained human-approval Review action to the exact workspace once", async () => {
    const requests: DaemonUiRequest[] = [];
    const f = fixture(async (request) => {
      requests.push(request);
      return null;
    });

    routeHumanApprovalRequest(f.host, "workspace-b-hash", {
      id: "a-abc123",
      requester: "child-agent",
    });
    const row = f.host.listNoticeInbox()[0]!;
    expect(row).toMatchObject({
      message: "Approval request a-abc123 from 'child-agent'",
      level: "info",
      actions: [{ label: "Review" }],
    });
    expect(requests).toHaveLength(0);

    await f.host.invokeNoticeAction(row.id, row.actions[0]!.id);
    expect(requests.filter((request) => request.kind === "execute-command")).toMatchObject([{
      command: "tachyon.openApprovals",
      args: ["workspace-b-hash"],
    }]);

    await expect(f.host.invokeNoticeAction(row.id, row.actions[0]!.id)).rejects.toThrow(/consumed/);
    expect(requests.filter((request) => request.kind === "execute-command")).toHaveLength(1);
  });

  it("queues notices oldest-first without using the shell UI broker", () => {
    const requests: DaemonUiRequest[] = [];
    const f = fixture((request) => {
      requests.push(request);
      return Promise.resolve(null);
    });

    for (let index = 1; index <= 7; index++) f.host.notify(`notice ${index}`);
    expect(f.host.listNoticeInbox().map((row) => row.message)).toEqual([
      "notice 1", "notice 2", "notice 3", "notice 4", "notice 5", "notice 6", "notice 7",
    ]);
    expect(requests).toHaveLength(0);
  });

  it("persists terminal intents across a shell outage and replays exact present/close requests", async () => {
    let shellAvailable = false;
    let manifest: unknown = [];
    const requests: DaemonUiRequest[] = [];
    const f = fixture(async (request) => {
      requests.push(request);
      if (!shellAvailable) throw new Error("no shell");
      return null;
    });
    const terminals = f.host.createTerminalPresentation({
      manifest: {
        read: () => manifest,
        write: (entries) => { manifest = entries; },
      },
    });

    terminals.open("codex", "tachyon-workspace-codex", 2, "Codex");
    await waitFor(() => requests.length === 1);
    expect(manifest).toEqual([{
      schemaVersion: 1,
      agent: "codex",
      session: "tachyon-workspace-codex",
      viewColumn: 2,
      title: "Codex",
    }]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    shellAvailable = true;
    f.host.replayUiRequests();
    await waitFor(() => requests.length === 2);
    expect(requests[1]).toMatchObject({
      kind: "terminal.present",
      agent: "codex",
      session: "tachyon-workspace-codex",
    });
    terminals.close("codex", "tachyon-workspace-codex");
    await waitFor(() => requests.length === 3);
    expect(requests[2]).toMatchObject({
      kind: "terminal.close",
      agent: "codex",
      session: "tachyon-workspace-codex",
    });
    expect(manifest).toEqual([]);
  });

  it("serializes replacement presentation so an in-flight old tab cannot hide the new session", async () => {
    let releaseOld!: (value: null) => void;
    const requests: DaemonUiRequest[] = [];
    const f = fixture((request) => {
      requests.push(request);
      if (requests.length === 1) return new Promise<null>((resolve) => { releaseOld = resolve; });
      return Promise.resolve(null);
    });
    const terminals = f.host.createTerminalPresentation({});

    terminals.open("codex", "tachyon-workspace-codex-old");
    terminals.close("codex", "tachyon-workspace-codex-old");
    terminals.open("codex", "tachyon-workspace-codex-new");
    await waitFor(() => requests.length === 1);
    releaseOld(null);
    await waitFor(() => requests.length === 3);

    expect(requests.map((request) => ({ kind: request.kind, session: "session" in request ? request.session : undefined })))
      .toEqual([
        { kind: "terminal.present", session: "tachyon-workspace-codex-old" },
        { kind: "terminal.close", session: "tachyon-workspace-codex-old" },
        { kind: "terminal.present", session: "tachyon-workspace-codex-new" },
      ]);
  });

  it("retains a temporarily absent terminal intent without presenting a dead session", async () => {
    let manifest: unknown = [{
      schemaVersion: 1,
      agent: "codex",
      session: "tachyon-workspace-codex",
    }];
    const requests: DaemonUiRequest[] = [];
    const f = fixture(async (request) => { requests.push(request); return null; });
    const terminals = f.host.createTerminalPresentation({
      manifest: {
        read: () => manifest,
        write: (entries) => { manifest = entries; },
      },
    });

    await terminals.restoreOpen(async () => false);
    f.host.replayUiRequests();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(requests).toEqual([]);
    expect(manifest).toEqual([{
      schemaVersion: 1,
      agent: "codex",
      session: "tachyon-workspace-codex",
    }]);
  });

  it("routes typed editor-only operations through the attached-shell port", async () => {
    const requests: DaemonUiRequest[] = [];
    const f = fixture(async (request) => {
      requests.push(request);
      return request.kind === "execute-command" ? { accepted: request.command } : null;
    });
    f.host.focusPrimaryView();
    await waitFor(() => requests.length === 1);
    await expect(f.host.executeCommand("tachyon.doctor", "abc12345"))
      .resolves.toEqual({ accepted: "tachyon.doctor" });
    expect(requests).toMatchObject([
      { schemaVersion: 1, kind: "focus-primary", operationId: expect.any(String) },
      { schemaVersion: 1, kind: "execute-command", operationId: expect.any(String), command: "tachyon.doctor", args: ["abc12345"] },
    ]);
    expect(requests[0].operationId).not.toBe(requests[1].operationId);
    expect(f.events.filter((event) => event.kind === "ui-unavailable")).toHaveLength(0);
  });

  it("uses the Node watcher while the editor shell is absent", async () => {
    const f = fixture();
    let changes = 0;
    const watcher = f.host.watch(f.root, "watched/*.txt", { create: true, change: true, delete: true }, () => { changes++; });
    fs.mkdirSync(path.join(f.root, "watched"));
    const file = path.join(f.root, "watched", "one.txt");
    fs.writeFileSync(file, "one");
    await waitFor(() => changes === 1);
    fs.writeFileSync(file, "changed-value");
    await waitFor(() => changes === 2);
    fs.unlinkSync(file);
    await waitFor(() => changes === 3);
    watcher.dispose();
  });

  it("constructs the real Workspace composition without ExtensionContext or vscode", async () => {
    const f = fixture();
    fs.writeFileSync(path.join(f.root, "tachyon.yml"), "agents:\n  test:\n    cmd: sh\n", "utf8");
    const tmux = new TmuxService(async () => ({ stdout: "", stderr: "" }));
    const ws = await Workspace.createForTest(
      f.root,
      { host: f.host, onViewsChanged: (view) => f.host.onViewsChanged(view) },
      { tmux, startBridge: false },
    );
    try {
      expect(ws.config).toMatchObject({ agents: { test: { cmd: "sh" } } });
      expect(f.host.getState(`tachyon.version.${ws.wsHash}`)).toBe("0.57.0");
    } finally {
      await ws.dispose();
    }
  });

  it("spec 415: collapses exact duplicates without moving their FIFO position", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-daemon-host-"));
    roots.push(root);
    const mediaRoot = path.join(root, "bundle");
    fs.mkdirSync(mediaRoot);
    const host = new DaemonEngineHost({
      storageRoot: path.join(root, "state"),
      mediaRoot,
      appVersion: "0.57.0",
      noticeDedupeWindowMs: 5_000,
    });
    hosts.push(host);
    host.notify("hello world", "info");
    host.notify("hello world", "info");
    host.notify("hello   world", "info"); // whitespace-normalized same key
    host.notify("different", "warn");
    expect(host.listNoticeInbox().map((row) => [row.message, row.collapsedCount])).toEqual([
      ["hello world", 3],
      ["different", 1],
    ]);
  });

  it("spec 415: persists FIFO attention and restores callback actions as unavailable", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-daemon-host-"));
    roots.push(root);
    const mediaRoot = path.join(root, "bundle");
    fs.mkdirSync(mediaRoot);
    const storageRoot = path.join(root, "state");
    const host = new DaemonEngineHost({
      storageRoot,
      mediaRoot,
      appVersion: "0.57.0",
    });
    hosts.push(host);
    let invoked = 0;
    host.notify("first", "info", [{ label: "Open", run: () => { invoked++; } }]);
    host.notify("second", "warn");
    const liveFirst = host.listNoticeInbox()[0]!;
    expect(liveFirst.actionsLive).toBe(true);
    host.dispose();

    const restored = new DaemonEngineHost({
      storageRoot,
      mediaRoot,
      appVersion: "0.57.0",
    });
    hosts.push(restored);
    expect(restored.listNoticeInbox().map((row) => row.message)).toEqual(["first", "second"]);
    expect(restored.listNoticeInbox()[0]).toMatchObject({ actionsLive: false, actions: [{ label: "Open" }] });
    await expect(restored.invokeNoticeAction(liveFirst.id, liveFirst.actions[0]!.id)).rejects.toThrow(/missing|consumed/);
    expect(invoked).toBe(0);
  });

  it("spec 415: dismisses attention explicitly and promotes FIFO state", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-daemon-host-"));
    roots.push(root);
    const mediaRoot = path.join(root, "bundle");
    fs.mkdirSync(mediaRoot);
    const host = new DaemonEngineHost({
      storageRoot: path.join(root, "state"),
      mediaRoot,
      appVersion: "0.57.0",
      noticeDedupeWindowMs: 5_000,
    });
    hosts.push(host);
    host.notify("alpha", "info");
    host.notify("alpha", "info");
    host.notify("beta", "warn", [{ label: "Open", run: async () => undefined }]);
    const inbox = host.listNoticeInbox();
    expect(inbox[0]?.message).toBe("alpha");
    expect(inbox[1]?.message).toBe("beta");
    expect(inbox[0]?.collapsedCount).toBe(2);
    expect(inbox.every((e) => !e.read)).toBe(true);
    expect(host.markNoticeRead(inbox[0]!.id)).toBe(true);
    expect(host.listNoticeInbox().map((row) => row.message)).toEqual(["beta"]);
    expect(host.markAllNoticesRead()).toBe(true);
    expect(host.listNoticeInbox()).toHaveLength(0);
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("host condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
