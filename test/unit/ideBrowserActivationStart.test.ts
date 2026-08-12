import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExtensionMode } from "vscode";
import { __resetVscodeMock } from "../mocks/vscode.js";

const { FakeManager, managerInstances } = vi.hoisted(() => {
  const instances: Array<{
    status: { workspaceRoot: string; running: boolean; endpoint: string; cdp: string; url: string };
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
  }> = [];
  class Manager {
    readonly status: { workspaceRoot: string; running: boolean; endpoint: string; cdp: string; url: string };
    readonly start = vi.fn(async () => {
      this.status.running = true;
      return this.status;
    });
    readonly stop = vi.fn(async () => {
      this.status.running = false;
    });
    readonly designMode = { on: false, agent: "grok", lastPick: null };

    constructor(workspaceRoot: string) {
      this.status = {
        workspaceRoot,
        running: false,
        endpoint: "http://127.0.0.1:43123",
        cdp: "disconnected",
        url: "",
      };
      instances.push(this);
    }

    setWorkspaceResolver(): void {}
    setDesignModeChangedHandler(): void {}
  }
  return { FakeManager: Manager, managerInstances: instances };
});

vi.mock("../../src/webview/ide-browser-bridge/manager.js", () => ({
  IdeBrowserBridgeManager: FakeManager,
}));
vi.mock("../../src/webview/ide-browser-bridge/themeTokens.js", () => ({
  invalidateDmThemeTokenCache: () => {},
  seedDmThemeTokensFromKind: () => {},
  warmDmThemeTokensInBackground: () => {},
}));

import { registerIdeBrowserBridge } from "../../src/webview/ide-browser-bridge/register.js";

type Settings = { ideBrowser?: { enabled?: boolean } } | undefined;

function context() {
  return {
    subscriptions: [] as Array<{ dispose(): void }>,
    extensionMode: ExtensionMode.Test,
  };
}

async function register(settings: Settings) {
  const ctx = context();
  await registerIdeBrowserBridge(ctx as never, {
    getWorkspace: () => ({
      workspaceRoot: "/tmp/tachyon-ide-browser-activation",
      config: { settings },
    }) as never,
  });
  return ctx;
}

describe("t-7a4c36 — IDE Browser host activation gate", () => {
  beforeEach(() => {
    __resetVscodeMock();
    managerInstances.splice(0);
  });

  afterEach(async () => {
    const active = managerInstances.at(-1);
    await active?.stop();
  });

  it("starts the host during activation when the workspace explicitly opts in", async () => {
    await register({ ideBrowser: { enabled: true } });

    expect(managerInstances).toHaveLength(1);
    expect(managerInstances[0]!.start).toHaveBeenCalledOnce();
    expect(managerInstances[0]!.status.running).toBe(true);
    expect(managerInstances[0]!.status.cdp).toBe("disconnected");
  });

  it.each([
    ["absent", undefined],
    ["false", { ideBrowser: { enabled: false } }],
  ] as const)("does not create or start a host when the gate is %s", async (_label, settings) => {
    await register(settings);
    expect(managerInstances).toHaveLength(0);
  });
});
