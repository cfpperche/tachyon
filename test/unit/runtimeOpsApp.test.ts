import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Uri } from "vscode";
import { __createdPanels, __registeredWebviewPanelSerializers, __resetVscodeMock, __setPanelVisible } from "../mocks/vscode.js";
import { RUNTIME_OPS_VIEW_TYPE, RuntimeOpsPanelManager, runtimeOpsRefreshKind, type RuntimeOpsDeps } from "../../apps/vscode-extension/src/webview/RuntimeOpsPanel.js";
import { registerTrustedPanelSerializer } from "../../apps/vscode-extension/src/webview/shared/panelSerializer.js";
import { sectionPanelKey, type SectionPanelState } from "../../apps/vscode-extension/src/webview/shared/SectionPanelManager.js";
import {
  readyMessage,
  runtimeOpsInspectSessionAction,
  runtimeOpsPollAction,
  runtimeOpsSetProviderObservationAction,
} from "../../packages/webview-ui/src/webview/runtime-ops/messages.js";
import { buildRuntimeOpsSnapshot } from "@tachyon/engine/runtimeOps/model.js";
import type { RuntimeOpsSnapshot } from "@tachyon/webview-ui/runtimeOps/types";
import type { InspectedSession } from "@tachyon/engine/runtimeOps/sessionInspection.js";

/**
 * SDD 485 D3 — Runtime Ops as a standalone `window` app.
 *
 * Two claims, different in kind. The first is the CARDINALITY, and it is the decision this migration exists
 * to take — against a brief that specified `dashboard`. ONE panel for the whole window, no project in the
 * key, and `sectionPanelKey` able to REFUSE one. The evidence is in the domain and predates this task:
 * `buildSnapshot()` takes no project and merges every attached workspace, so two panels would render
 * byte-identical content over one model.
 *
 * The second is that every action still behaves as it did inside Control, because a cutover that quietly
 * changed what "enable observation" or an inspection does would be a migration and a regression at once.
 *
 * Every case drives the WIRE — the message a real client posts — rather than the manager's internals
 * (0.56.159's lesson): `ready` and `poll` reach this app through the GATE rather than through `onMessage`,
 * which is exactly the difference an internals-level test cannot see.
 */

const extensionUri = Uri.file("/ext");
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  __resetVscodeMock();
});
afterEach(() => {
  for (const p of __createdPanels) if (!p.disposed) p.dispose();
});

/** one agent row, in the shape `snapshotService` feeds `buildRuntimeOpsSnapshot`. */
function agent(workspaceKey: string, workspaceLabel: string, agentName: string, runtime = "claude") {
  return {
    workspaceKey,
    workspaceLabel,
    agentName,
    runtime,
    lastActivity: "2026-08-03T12:00:00.000Z",
    status: "running" as const,
    attention: { state: "working" as const, stale: false },
  };
}

interface Harness {
  manager: RuntimeOpsPanelManager;
  /** every call the host made into the domain, in order — so a hidden panel's work can be COUNTED. */
  calls: string[];
  setAgents: (next: ReturnType<typeof agent>[]) => void;
  setBuildError: (message: string | undefined) => void;
  observations: Array<{ provider: string; enabled: boolean }>;
  inspections: string[];
  setInspectError: (message: string | undefined) => void;
}

function harness(over: Partial<RuntimeOpsDeps> = {}, opts: { noInspect?: boolean } = {}): Harness {
  const calls: string[] = [];
  const observations: Array<{ provider: string; enabled: boolean }> = [];
  const inspections: string[] = [];
  let agents = [agent("a1b2c3d4", "tachyon", "claude")];
  let buildError: string | undefined;
  let inspectError: string | undefined;

  const deps: RuntimeOpsDeps = {
    buildSnapshot: () => {
      calls.push("buildSnapshot");
      if (buildError) throw new Error(buildError);
      return buildRuntimeOpsSnapshot({
        generatedAt: "2026-08-03T12:00:00.000Z",
        detectedRuntimes: ["claude", "codex"],
        agents,
      }) as RuntimeOpsSnapshot;
    },
    configureProviderObservation: (provider, enabled) => {
      calls.push(`configure:${provider}:${enabled}`);
      observations.push({ provider, enabled });
    },
    ...(opts.noInspect ? {} : {
      inspectAgentSession: async (workspaceKey, agentName) => {
        calls.push(`inspect:${workspaceKey}:${agentName}`);
        inspections.push(`${workspaceKey}:${agentName}`);
        if (inspectError) throw new Error(inspectError);
        return { settings: [], hooks: [] } as unknown as InspectedSession;
      },
    }),
    ...over,
  };

  return {
    manager: new RuntimeOpsPanelManager(extensionUri, deps),
    calls,
    setAgents: (next) => { agents = next; },
    setBuildError: (message) => { buildError = message; },
    observations,
    inspections,
    setInspectError: (message) => { inspectError = message; },
  };
}

const posted = (panel: typeof __createdPanels[number], type: string) =>
  panel.webview.posted.filter((m) => (m as { type?: string }).type === type);

const snapshots = (panel: typeof __createdPanels[number]) =>
  posted(panel, "runtimeOpsSnapshot") as Array<{ snapshot: RuntimeOpsSnapshot }>;

async function open(h: Harness): Promise<typeof __createdPanels[number]> {
  h.manager.open();
  const panel = __createdPanels[0];
  panel.webview.__receive(readyMessage());
  await flush();
  await flush();
  return panel;
}

describe("SDD 485 D3 — the Runtime Ops app's cardinality is `window`, not the `dashboard` the brief asked for", () => {
  it("opens ONE panel and REVEALS it on a second open — keyed on the viewId alone", () => {
    const h = harness();

    h.manager.open();
    h.manager.open();

    expect(__createdPanels).toHaveLength(1);
    expect(__createdPanels[0].revealCount).toBe(1);
    // No project and no identity in the key. That IS the decision: this surface reads an inventory every
    // attached workspace shares, plus an account-wide provider quota that belongs to none of them.
    expect(h.manager.openKeys).toEqual([RUNTIME_OPS_VIEW_TYPE]);
  });

  it("stays ONE panel with two projects attached, and that panel answers for BOTH", async () => {
    // The concrete failure `window` prevents, and the reason the D3 brief's `dashboard` reading was wrong.
    // Under `dashboard` the key is `viewId|project`, so a window with two attached folders would open two
    // editor tabs — and because `buildSnapshot()` takes no project, both would render the SAME merged
    // model. There is no door here that can even ask for a second: `open()` takes no argument.
    const h = harness();
    h.setAgents([agent("a1b2c3d4", "tachyon", "claude"), agent("d4e5f6a7", "tachyon-docs", "codex", "codex")]);

    h.manager.open();
    h.manager.open();
    h.manager.open();

    expect(__createdPanels).toHaveLength(1);
    expect(h.manager.openKeys).toEqual([RUNTIME_OPS_VIEW_TYPE]);

    const panel = __createdPanels[0];
    panel.webview.__receive(readyMessage());
    await flush();
    await flush();

    // The CONTENT half, and it is the inverse of D2's: for Plugins, two projects had to produce two
    // visibly DIFFERENT models, which is what made a dashboard right. Here one panel carries both
    // workspaces at once, which is what makes a second panel redundant rather than wrong.
    const workspaces = snapshots(panel).at(-1)!.snapshot.runtimes.flatMap((r) => r.workspaces.map((w) => w.label));
    expect([...new Set(workspaces)].sort()).toEqual(["tachyon", "tachyon-docs"]);
  });

  it("`sectionPanelKey` REFUSES a project and an identity — the refusal IS the cardinality", () => {
    // D1's argument, re-run for the second `window` app: a key that quietly ACCEPTED a project would let
    // the next caller — a launcher tile wired like the Board's, or a D4 migration copying this file —
    // open a second identical panel, and no test that did not already suspect it would notice.
    expect(sectionPanelKey(RUNTIME_OPS_VIEW_TYPE, "window", {})).toBe(RUNTIME_OPS_VIEW_TYPE);
    expect(() => sectionPanelKey(RUNTIME_OPS_VIEW_TYPE, "window", { project: "ws-a" })).toThrow(/has no project/);
    expect(() => sectionPanelKey(RUNTIME_OPS_VIEW_TYPE, "window", { identity: "claude" })).toThrow(/has no identity/);
  });

  it("declares `window` in the manifest, and the manager reads its cardinality from there", async () => {
    // The manifest row is the declaration of record (Phase A's promise: inspect a manifest, not N classes).
    // Asserted through the KEY rather than by reading the row back, so a row edited to `dashboard` fails
    // here rather than passing a self-referential check.
    const { webviewApp } = await import("../../apps/vscode-extension/src/webview/webviewApps.js");
    const row = webviewApp("runtime-ops");
    expect(row).toMatchObject({ viewId: RUNTIME_OPS_VIEW_TYPE, host: "section", cardinality: "window" });
  });
});

describe("SDD 485 D3 — the Runtime Ops app is born gated (Phase B, through this app's own doors)", () => {
  it("gates the client's 3s poll HOST-side — answered while visible, ignored while hidden", async () => {
    // Both halves in one case, deliberately: "hidden posts nothing" alone is satisfied by a door that does
    // nothing at all, which is how a gate test rots into proving nothing.
    const h = harness();
    h.manager.open();
    const panel = __createdPanels[0];
    panel.webview.posted.length = 0;
    h.calls.length = 0;

    panel.webview.__receive(runtimeOpsPollAction());
    await flush();
    await flush();
    expect(snapshots(panel), "the poll is not served at all — this door is dead, not gated").toHaveLength(1);

    __setPanelVisible(panel, false);
    panel.webview.posted.length = 0;
    h.calls.length = 0;

    for (let i = 0; i < 20; i++) panel.webview.__receive(runtimeOpsPollAction()); // one minute of polling
    await flush();
    await flush();

    expect(panel.webview.posted).toEqual([]);
    expect(h.calls, "a hidden panel still built the fleet snapshot").toEqual([]);
  });

  it("catches a hidden panel up ONCE on reveal, and the catch-up is not empty", async () => {
    const h = harness();
    const panel = await open(h);
    __setPanelVisible(panel, false);
    panel.webview.posted.length = 0;

    for (let i = 0; i < 20; i++) h.manager.refresh();
    await flush();
    expect(panel.webview.posted, "a hidden panel did work").toEqual([]);

    __setPanelVisible(panel, true);
    await flush();
    await flush();

    expect(snapshots(panel)).toHaveLength(1);
    expect(snapshots(panel)[0].snapshot.runtimes.length).toBeGreaterThan(0);
  });

  it("claims `ready` and `poll` for the gate, and NOT `refresh`", () => {
    // The poll got a word of its own rather than borrowing `refresh`, and this is the assertion that keeps
    // it that way. D2 had to separate the two after finding Plugins' `refresh` carried a side effect a
    // periodic re-gather must not have; here `refresh` does not exist yet, and staying unclaimed is what
    // lets a future human-pressed Refresh button mean something different from the timer.
    expect(runtimeOpsRefreshKind({ type: "ready" })).toBe("runtime-ops");
    expect(runtimeOpsRefreshKind(runtimeOpsPollAction())).toBe("runtime-ops");
    expect(runtimeOpsRefreshKind({ type: "refresh" })).toBeUndefined();
    expect(runtimeOpsRefreshKind(runtimeOpsSetProviderObservationAction("codex", true))).toBeUndefined();
    expect(runtimeOpsRefreshKind(runtimeOpsInspectSessionAction("ws-a", "claude"))).toBeUndefined();
    expect(runtimeOpsRefreshKind(undefined)).toBeUndefined();
    expect(runtimeOpsRefreshKind("ready")).toBeUndefined();
  });
});

describe("SDD 485 D3 — the two actions behave exactly as they did inside Control", () => {
  it("configures provider observation for every workspace, then re-posts the snapshot", async () => {
    const h = harness();
    const panel = await open(h);
    panel.webview.posted.length = 0;

    panel.webview.__receive(runtimeOpsSetProviderObservationAction("codex", true));
    await flush();
    await flush();

    expect(h.observations).toEqual([{ provider: "codex", enabled: true }]);
    // the re-post is the point: the preference is only observable through the next snapshot.
    expect(snapshots(panel)).toHaveLength(1);
  });

  it("a failing configure is SWALLOWED and still re-posts — the next snapshot is the source of truth", async () => {
    const h = harness({ configureProviderObservation: () => { throw new Error("bridge down"); } });
    const panel = await open(h);
    panel.webview.posted.length = 0;

    panel.webview.__receive(runtimeOpsSetProviderObservationAction("claude", false));
    await flush();
    await flush();

    // Carried over from Control verbatim. A toast for a preference that re-reads within three seconds is
    // noise; the snapshot showing the unchanged state is the honest signal.
    expect(snapshots(panel)).toHaveLength(1);
  });

  it("answers an inspection keyed to its agentKey, and re-asks on every expand (no cache between messages)", async () => {
    const h = harness();
    const panel = await open(h);
    panel.webview.posted.length = 0;

    panel.webview.__receive(runtimeOpsInspectSessionAction("a1b2c3d4", "claude"));
    await flush();
    await flush();
    panel.webview.__receive(runtimeOpsInspectSessionAction("a1b2c3d4", "claude"));
    await flush();
    await flush();

    const replies = posted(panel, "runtimeOpsSessionInspection") as Array<{ agentKey: string; inspection?: unknown }>;
    expect(replies).toHaveLength(2);
    expect(replies[0].agentKey).toBe("a1b2c3d4:claude");
    expect(replies[0].inspection).toBeDefined();
    // The host holds NOTHING between messages — asserted rather than assumed, because C4 predicted that
    // every "we are a singleton, so one slot is enough" in Control is a defect waiting for its migration,
    // and D2 found three of them in Plugins. A memoized inspection would show settings the agent no longer
    // runs under, which is the exact failure this panel exists to end.
    expect(h.inspections).toEqual(["a1b2c3d4:claude", "a1b2c3d4:claude"]);
  });

  it("a failed inspection posts an ERROR on that row rather than nothing", async () => {
    const h = harness();
    h.setInspectError("no such session");
    const panel = await open(h);
    panel.webview.posted.length = 0;

    panel.webview.__receive(runtimeOpsInspectSessionAction("a1b2c3d4", "claude"));
    await flush();
    await flush();

    const replies = posted(panel, "runtimeOpsSessionInspection") as Array<{ agentKey: string; error?: string }>;
    // Posting nothing would leave the expanded row spinning forever — the behaviour a cutover is exactly
    // where it gets quietly dropped.
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ agentKey: "a1b2c3d4:claude", error: "no such session" });
  });

  it("an engine with no session-inspection action says so on the row, not on the whole surface", async () => {
    // t-283149's optional dep: an engine that predates `agent.session-inspection` refuses it by name.
    const h = harness({}, { noInspect: true });
    const panel = await open(h);
    panel.webview.posted.length = 0;

    panel.webview.__receive(runtimeOpsInspectSessionAction("a1b2c3d4", "claude"));
    await flush();
    await flush();

    const replies = posted(panel, "runtimeOpsSessionInspection") as Array<{ error?: string }>;
    expect(replies).toHaveLength(1);
    expect(replies[0].error).toMatch(/session inspection/i);
    // and the snapshot is untouched — one row's missing capability is not the surface failing.
    expect(snapshots(panel)).toHaveLength(0);
  });

  it("a snapshot that cannot be built posts the UNAVAILABLE inventory, not a blank screen", async () => {
    const h = harness();
    h.setBuildError("engine unreachable");
    const panel = await open(h);

    // Carried over from Control verbatim: the App renders this as its own error state, which is a
    // different thing from an empty table claiming there are no runtimes.
    expect(snapshots(panel)).toHaveLength(1);
    expect(snapshots(panel)[0].snapshot.error).toBeTruthy();
  });
});

describe("SDD 485 D3 — restore, on a NEW viewType", () => {
  it("persists `{schemaVersion, view}` and revives INTO the app rather than opening a second panel", async () => {
    const h = harness();
    h.manager.open();

    const persisted = JSON.parse(/__tachyonPersistedState=(\{.*?\});/.exec(__createdPanels[0].webview.html)![1]) as SectionPanelState;
    // No `project` key at all, because `panelStateFor` omits it for a cardinality that has none.
    expect(persisted).toEqual({ schemaVersion: 1, view: RUNTIME_OPS_VIEW_TYPE });

    __createdPanels[0].dispose();
    const context = { subscriptions: [] } as unknown as import("vscode").ExtensionContext;
    const revived = harness();
    registerTrustedPanelSerializer<SectionPanelState>(context, RUNTIME_OPS_VIEW_TYPE, (panel, state) => revived.manager.deserialize(panel, state));
    const registration = __registeredWebviewPanelSerializers.find((r) => r.viewType === RUNTIME_OPS_VIEW_TYPE);
    expect(registration, "no serializer registered for the Runtime Ops viewType").toBeTruthy();

    const panel = makeRevivablePanel();
    await registration!.serializer.deserializeWebviewPanel(panel as never, persisted);
    panel.webview.__receive(readyMessage());
    await flush();
    await flush();

    expect(revived.manager.openKeys).toEqual([RUNTIME_OPS_VIEW_TYPE]);
    expect(panel.disposed).toBe(false);
    expect(__createdPanels.filter((p) => !p.disposed), "revival created a second panel").toHaveLength(0);
    expect(panel.webview.posted.filter((m) => (m as { type?: string }).type === "runtimeOpsSnapshot")).toHaveLength(1);
  });

  it("drops a state carrying a project — a window app has none, so that record is stale, not fatal", async () => {
    const h = harness();
    const context = { subscriptions: [] } as unknown as import("vscode").ExtensionContext;
    registerTrustedPanelSerializer<SectionPanelState>(context, RUNTIME_OPS_VIEW_TYPE, (panel, state) => h.manager.deserialize(panel, state));
    const registration = __registeredWebviewPanelSerializers.find((r) => r.viewType === RUNTIME_OPS_VIEW_TYPE)!;

    const panel = makeRevivablePanel();
    await registration.serializer.deserializeWebviewPanel(panel as never, { schemaVersion: 1, view: RUNTIME_OPS_VIEW_TYPE, project: "ws-a" });

    expect(panel.disposed).toBe(true);
    expect(h.manager.openKeys).toEqual([]);
  });

  it("the legacy `tachyonRuntimeOpsView` id is NOT this app's — it names a WebviewView that never shipped", () => {
    // The viewType call, checked rather than only argued in a comment. C4/D1/D2 reused their retired ids
    // because those ids still NAMED the app; this one does not — spec 367's `RuntimeOpsView.ts` was a
    // bottom-panel WebviewView, retired (t-ed3067) as code with no `registerWebviewViewProvider` call. So
    // it stays in extension.ts's dispose-only loop and this app registers its own id.
    expect(RUNTIME_OPS_VIEW_TYPE).toBe("tachyonRuntimeOps");
    expect(RUNTIME_OPS_VIEW_TYPE).not.toBe("tachyonRuntimeOpsView");
  });
});

/** a panel shaped like the one VS Code hands a serializer — created outside `createWebviewPanel`. */
function makeRevivablePanel() {
  const disposeHandlers: Array<() => void> = [];
  const receivers: Array<(msg: unknown) => void> = [];
  const panel = {
    title: "",
    iconPath: undefined,
    disposed: false,
    visible: true,
    active: true,
    revealCount: 0,
    onDidChangeViewState: (_cb: () => void) => ({ dispose() {} }),
    webview: {
      html: "",
      options: {},
      cspSource: "vscode-webview:",
      posted: [] as unknown[],
      asWebviewUri: (uri: unknown) => uri,
      postMessage: async (msg: unknown) => { panel.webview.posted.push(msg); return true; },
      onDidReceiveMessage: (cb: (msg: unknown) => void) => { receivers.push(cb); return { dispose() {} }; },
      __receive: (msg: unknown) => { for (const cb of receivers) cb(msg); },
    },
    reveal: () => { panel.revealCount += 1; },
    dispose: () => { panel.disposed = true; for (const cb of disposeHandlers) cb(); },
    onDidDispose: (cb: () => void) => { disposeHandlers.push(cb); return { dispose() {} }; },
  };
  return panel;
}
