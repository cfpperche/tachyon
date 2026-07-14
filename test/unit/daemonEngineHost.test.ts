import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DaemonEngineHost, EngineUiUnavailableError, type DaemonHostEvent } from "../../src/workspace/DaemonEngineHost.js";
import { Workspace } from "../../src/workspace/Workspace.js";
import { TmuxService } from "../../src/tmux/TmuxService.js";

const roots: string[] = [];
const hosts: DaemonEngineHost[] = [];

afterEach(() => {
  for (const host of hosts.splice(0)) host.dispose();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
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
    f.host.notify("ready", "info", [{ label: "Open", run: () => { invoked++; } }]);
    expect(f.events[0]).toMatchObject({ kind: "views-changed", view: "agents" });
    const notice = f.events[1];
    expect(notice).toMatchObject({ kind: "notice", message: "ready", actions: [{ label: "Open" }] });
    if (notice.kind !== "notice") throw new Error("expected notice event");
    await f.host.invokeNoticeAction(notice.id, notice.actions[0].id);
    expect(invoked).toBe(1);
    await expect(f.host.invokeNoticeAction(notice.id, notice.actions[0].id)).rejects.toThrow(/consumed/);
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
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("host condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
