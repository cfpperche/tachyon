import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import {
  BrowserSessionController,
  classifyIdeBrowserSessionEnd,
} from "../../src/webview/ide-browser-bridge/browserSession.js";
import { IdeBrowserCdpSession } from "../../src/webview/ide-browser-bridge/cdpSession.js";

type FakeSession = vscode.DebugSession & { parentSession?: FakeSession };

function session(partial: {
  id: string;
  name?: string;
  type?: string;
  parentSession?: FakeSession;
}): FakeSession {
  return {
    id: partial.id,
    name: partial.name ?? "Tachyon IDE Browser",
    type: partial.type ?? "pwa-editor-browser",
    parentSession: partial.parentSession,
    workspaceFolder: undefined,
    configuration: { type: partial.type ?? "pwa-editor-browser", request: "launch", name: "Tachyon IDE Browser" },
    customRequest: async () => ({}),
    getDebugProtocolBreakpoint: async () => undefined,
  } as unknown as FakeSession;
}

describe("classifyIdeBrowserSessionEnd (t-1c8195)", () => {
  const base = {
    endedName: "Tachyon IDE Browser",
    endedType: "pwa-editor-browser",
    endedParentId: "parent",
    trackedChildId: "child",
    trackedParentId: "parent",
    resetReason: null as string | null,
    activeName: "Tachyon IDE Browser",
    lastTransportEvent: "reattach-closed" as string | null,
  };

  it("labels our reset distinctly from an external child death", () => {
    expect(classifyIdeBrowserSessionEnd({
      ...base,
      endedId: "child",
      resetInFlight: true,
      resetReason: "manager-stop",
      activeId: "parent",
    })).toEqual({
      tracked: "child",
      actor: "controller-reset",
      trigger: "controller-reset",
    });
  });

  it("labels child death while parent is active (Stop on the child toolbar)", () => {
    expect(classifyIdeBrowserSessionEnd({
      ...base,
      endedId: "child",
      resetInFlight: false,
      activeId: "parent",
    })).toEqual({
      tracked: "child",
      actor: "external",
      trigger: "child-ended-parent-active",
    });
  });

  it("labels child death when parent activity is unknown (tab close or cascade)", () => {
    expect(classifyIdeBrowserSessionEnd({
      ...base,
      endedId: "child",
      resetInFlight: false,
      activeId: undefined,
    })).toEqual({
      tracked: "child",
      actor: "external",
      trigger: "child-ended-parent-unknown",
    });
  });

  it("labels parent termination separately", () => {
    expect(classifyIdeBrowserSessionEnd({
      ...base,
      endedId: "parent",
      endedParentId: undefined,
      resetInFlight: false,
      activeId: undefined,
    })).toEqual({
      tracked: "parent",
      actor: "external",
      trigger: "parent-ended",
    });
  });

  it("ignores a session this controller never tracked", () => {
    expect(classifyIdeBrowserSessionEnd({
      ...base,
      endedId: "other",
      resetInFlight: false,
      activeId: undefined,
    })).toEqual({
      tracked: "none",
      actor: "external",
      trigger: "untracked",
    });
  });
});

describe("BrowserSessionController terminate log (t-1c8195)", () => {
  const startListeners = new Set<(s: vscode.DebugSession) => void>();
  const endListeners = new Set<(s: vscode.DebugSession) => void>();
  let active: FakeSession | undefined;
  let parent: FakeSession;
  let child: FakeSession;
  let connectSpy: { mockRestore(): void };
  const stopped: string[] = [];

  beforeEach(() => {
    startListeners.clear();
    endListeners.clear();
    parent = session({ id: "parent", type: "editor-browser" });
    child = session({ id: "child", parentSession: parent });
    active = undefined;
    stopped.length = 0;
    (vscode as unknown as { debug: unknown }).debug = {
      onDidStartDebugSession: (cb: (s: vscode.DebugSession) => void) => {
        startListeners.add(cb);
        return { dispose() { startListeners.delete(cb); } };
      },
      onDidTerminateDebugSession: (cb: (s: vscode.DebugSession) => void) => {
        endListeners.add(cb);
        return { dispose() { endListeners.delete(cb); } };
      },
      get activeDebugSession() {
        return active;
      },
      startDebugging: async (_folder: unknown, configuration: vscode.DebugConfiguration) => {
        (parent as unknown as { configuration: vscode.DebugConfiguration }).configuration = configuration;
        for (const cb of startListeners) cb(parent);
        active = child;
        for (const cb of startListeners) cb(child);
        return true;
      },
      stopDebugging: async (target?: vscode.DebugSession) => {
        const ended = target ?? active;
        if (!ended) return;
        stopped.push(ended.id);
        if (active?.id === ended.id) active = ended.parentSession as FakeSession | undefined;
        for (const cb of endListeners) cb(ended);
      },
    };
    connectSpy = vi.spyOn(IdeBrowserCdpSession.prototype, "connectToDebugSession")
      .mockImplementation(async function (this: IdeBrowserCdpSession, s: vscode.DebugSession) {
        (this as unknown as { debugSession: vscode.DebugSession }).debugSession = s;
        (this as unknown as { state: string }).state = "connected";
      });
  });

  afterEach(() => {
    connectSpy.mockRestore();
  });

  function controller() {
    const lines: string[] = [];
    const ctl = new BrowserSessionController({ appendLine: (line) => lines.push(line) });
    return { ctl, lines };
  }

  it("rejects a disallowed scheme by name before command or agent navigation", async () => {
    const { ctl } = controller();
    vi.spyOn(ctl, "withCdpRecovery").mockImplementation(async (_url, fn) => fn());
    vi.spyOn(ctl, "ensureBrowser").mockResolvedValue(undefined);
    const navigate = vi.spyOn(ctl.cdp, "navigate").mockResolvedValue(undefined);

    await expect(ctl.navigate("file:///tmp/report.html")).rejects.toThrow(/scheme 'file:'/);

    expect(navigate).not.toHaveBeenCalled();
  });

  it("keeps the home policy of interpreting a bare host as HTTPS", async () => {
    const { ctl } = controller();
    vi.spyOn(ctl, "withCdpRecovery").mockImplementation(async (_url, fn) => fn());
    vi.spyOn(ctl, "ensureBrowser").mockResolvedValue(undefined);
    const navigate = vi.spyOn(ctl.cdp, "navigate").mockResolvedValue(undefined);

    await ctl.navigate("localhost:3000");

    expect(navigate).toHaveBeenCalledWith("https://localhost:3000/");
  });

  it("logs child-ended-parent-active when the child dies and the parent becomes active", async () => {
    const { ctl, lines } = controller();
    await ctl.launchBrowser("about:blank");
    active = parent;
    for (const cb of endListeners) cb(child);

    const ended = lines.filter((line) => line.includes("debug session ended"));
    expect(ended).toHaveLength(1);
    expect(ended[0]).toContain("actor=external");
    expect(ended[0]).toContain("trigger=child-ended-parent-active");
    expect(ended[0]).toContain("tracked=child");
    expect(ended[0]).not.toContain("tab closed?");
  });

  it("logs controller-reset when we stop the session ourselves", async () => {
    const { ctl, lines } = controller();
    await ctl.launchBrowser("about:blank");
    await ctl.resetBrowserSession("manager-stop");

    const reset = lines.find((line) => line.includes("resetBrowserSession reason=manager-stop"));
    expect(reset).toBeDefined();
    const ended = lines.filter((line) => line.includes("debug session ended"));
    expect(ended.some((line) => line.includes("actor=controller-reset"))).toBe(true);
    expect(ended.some((line) => line.includes("actor=external"))).toBe(false);
  });

  it("logs parent-survived when only the child ends", async () => {
    const { ctl, lines } = controller();
    await ctl.launchBrowser("about:blank");
    active = parent;
    for (const cb of endListeners) cb(child);
    await new Promise((r) => setTimeout(r, 200));
    expect(lines.some((line) => line.includes("child ended and parent survived"))).toBe(true);
  });

  it("does not claim parent survived when parent ends in the same burst", async () => {
    const { ctl, lines } = controller();
    await ctl.launchBrowser("about:blank");
    for (const cb of endListeners) cb(child);
    for (const cb of endListeners) cb(parent);
    await new Promise((r) => setTimeout(r, 200));
    expect(lines.some((line) => line.includes("child ended and parent survived"))).toBe(false);
  });

  it("logs a replacement child under the tracked parent without attaching", async () => {
    const { ctl, lines } = controller();
    await ctl.launchBrowser("about:blank");
    const replacement = session({ id: "child-2", parentSession: parent });
    for (const cb of startListeners) cb(replacement);

    expect(lines.some((line) =>
      line.includes("replacement child under tracked parent") && line.includes("new=child-2"),
    )).toBe(true);
    expect(ctl.cdp.session?.id).toBe("child");
  });

  it("does not adopt a browser child started by another controller", async () => {
    const { ctl } = controller();
    const foreignParent = session({ id: "foreign-parent", type: "editor-browser" });
    const foreignChild = session({ id: "foreign-child", parentSession: foreignParent });
    (vscode.debug.startDebugging as unknown as ReturnType<typeof vi.fn>) = vi.fn(
      async (_folder: unknown, configuration: vscode.DebugConfiguration) => {
        for (const cb of startListeners) cb(foreignParent);
        for (const cb of startListeners) cb(foreignChild);
        (parent as unknown as { configuration: vscode.DebugConfiguration }).configuration = configuration;
        for (const cb of startListeners) cb(parent);
        active = child;
        for (const cb of startListeners) cb(child);
        return true;
      },
    );

    await ctl.launchBrowser("about:blank");

    expect(ctl.cdp.session?.id).toBe("child");
  });

  it("resetting one controller does not stop another controller's active session", async () => {
    const { ctl } = controller();
    const foreignParent = session({ id: "foreign-parent", type: "editor-browser" });
    const foreignChild = session({ id: "foreign-child", parentSession: foreignParent });
    await ctl.launchBrowser("about:blank");
    active = foreignChild;

    await ctl.resetBrowserSession("manager-stop");

    expect(stopped).toEqual(["child", "parent"]);
    expect(stopped).not.toContain("foreign-child");
  });
});
