import { beforeEach, describe, expect, it } from "vitest";
import * as vscode from "vscode";
import {
  SectionPanelManager,
  sectionPanelKey,
  type SectionAppConfig,
  type SectionPanelBinding,
  type SectionPanelSession,
  type SectionPanelState,
} from "../../apps/vscode-extension/src/webview/shared/SectionPanelManager.js";
import { registerTrustedPanelSerializer } from "../../apps/vscode-extension/src/webview/shared/panelSerializer.js";
import { webviewApp, type WebviewAppEntry } from "../../apps/vscode-extension/src/webview/webviewApps.js";
import { SectionAppFixturePanelManager } from "../../apps/vscode-extension/src/webview/SectionAppFixturePanel.js";
import { sectionFixtureReadyMessage } from "../../packages/webview-ui/src/webview/section-app-fixture/protocol.js";

const {
  __resetVscodeMock,
  __createdPanels,
  __registeredWebviewPanelSerializers,
  __setPanelVisible,
} = vscode as unknown as {
  __resetVscodeMock(): void;
  __createdPanels: Array<{ title: string; disposed: boolean; visible: boolean; revealCount: number; webview: { html: string; posted: unknown[]; __receive(msg: unknown): void }; dispose(): void }>;
  __registeredWebviewPanelSerializers: Array<{ viewType: string; serializer: { deserializeWebviewPanel(panel: unknown, state: unknown): Promise<void> } }>;
  __setPanelVisible(panel: unknown, visible: boolean): void;
};

/**
 * SDD 485 C1 — ONE manager, cardinality as a PARAMETER.
 *
 * The claim under test is not "a manager works": it is that a dashboard and a document are the SAME CODE
 * with a different row in the manifest. So the two modes below are built from the SAME real manifest entry
 * with only `cardinality` overridden — not from two hand-written configs that could quietly diverge into the
 * twelve managers `spec.md` closed the question against.
 */

const FIXTURE_APP = webviewApp("section-app-fixture");
const extensionUri = vscode.Uri.file("/ext");

function appWith(cardinality: "dashboard" | "document"): WebviewAppEntry {
  return { ...FIXTURE_APP, host: "section", cardinality };
}

interface Recorder {
  manager: SectionPanelManager<"model">;
  replayed: string[];
  resyncs: string[];
  posts: number;
  messages: unknown[];
}

function harness(cardinality: "dashboard" | "document", overrides: Partial<SectionAppConfig<"model">> = {}): Recorder {
  const rec = { replayed: [] as string[], resyncs: [] as string[], posts: 0, messages: [] as unknown[] };
  const config: SectionAppConfig<"model"> = {
    app: appWith(cardinality),
    styleFiles: ["codicon.css", "design-system.css", "section-app-fixture.css"],
    title: (target) => (target.identity ? `Section app · ${target.identity}` : "Section app"),
    refreshKindFor: (message) => ((message as { type?: string })?.type === "poll" ? "model" : undefined),
    bind: (session: SectionPanelSession<"model">): SectionPanelBinding<"model"> => ({
      replay: () => {
        rec.replayed.push(session.key);
        if (session.post({ type: "model", key: session.key })) rec.posts += 1;
      },
      resync: () => {
        rec.resyncs.push(session.key);
        if (session.post({ type: "model", key: session.key, resync: true })) rec.posts += 1;
      },
      onMessage: (message) => { rec.messages.push(message); },
    }),
    ...overrides,
  };
  return { manager: new SectionPanelManager<"model">(extensionUri, config), ...rec } as unknown as Recorder;
}

beforeEach(() => {
  __resetVscodeMock();
});

describe("sectionPanelKey — the cardinality rule, with no panel in sight", () => {
  it("keys a dashboard by app + project: one panel per section per project", () => {
    expect(sectionPanelKey("tachyonBoard", "dashboard", { project: "ws-a" })).toBe("tachyonBoard|ws-a");
    expect(sectionPanelKey("tachyonBoard", "dashboard", { project: "ws-b" })).not.toBe(sectionPanelKey("tachyonBoard", "dashboard", { project: "ws-a" }));
  });

  it("keys a document by app + project + identity: one panel per identity", () => {
    expect(sectionPanelKey("tachyonTask", "document", { project: "ws-a", identity: "t-1" })).toBe("tachyonTask|ws-a|t-1");
    expect(sectionPanelKey("tachyonTask", "document", { project: "ws-a", identity: "t-2" }))
      .not.toBe(sectionPanelKey("tachyonTask", "document", { project: "ws-a", identity: "t-1" }));
  });

  it("refuses a document with no identity, and a dashboard with one", () => {
    // Both directions matter. A document defaulting to "no identity" collapses two task details into one
    // panel — the exact capability this spec exists to buy — and a dashboard silently accepting one would
    // let a section fork into per-identity copies nobody declared.
    expect(() => sectionPanelKey("tachyonTask", "document", { project: "ws-a" })).toThrow(/opens against an identity/);
    expect(() => sectionPanelKey("tachyonBoard", "dashboard", { project: "ws-a", identity: "t-1" })).toThrow(/no identity/);
  });
});

describe("SectionPanelManager — the two cardinalities are one code path", () => {
  it("document: two identities open TWO panels, and each keeps its own identity", () => {
    const h = harness("document");

    h.manager.open({ project: "ws-a", identity: "t-1" });
    h.manager.open({ project: "ws-a", identity: "t-2" });

    expect(__createdPanels).toHaveLength(2);
    expect(h.manager.openKeys).toEqual(["tachyonSectionAppFixture|ws-a|t-1", "tachyonSectionAppFixture|ws-a|t-2"]);
    expect(__createdPanels.map((p) => p.title)).toEqual(["Section app · t-1", "Section app · t-2"]);
    expect(__createdPanels.every((p) => !p.disposed)).toBe(true);
  });

  it("document: the same identity twice REVEALS, it does not duplicate", () => {
    const h = harness("document");

    h.manager.open({ project: "ws-a", identity: "t-1" });
    h.manager.open({ project: "ws-a", identity: "t-1" });

    expect(__createdPanels).toHaveLength(1);
    expect(__createdPanels[0].revealCount).toBe(1);
  });

  it("dashboard: the same section twice REVEALS instead of duplicating", () => {
    const h = harness("dashboard");

    h.manager.open({ project: "ws-a" });
    h.manager.open({ project: "ws-a" });

    expect(__createdPanels).toHaveLength(1);
    expect(__createdPanels[0].revealCount).toBe(1);
    expect(h.manager.openKeys).toEqual(["tachyonSectionAppFixture|ws-a"]);
  });

  it("dashboard: a second PROJECT is a second panel — one per section per project", () => {
    const h = harness("dashboard");

    h.manager.open({ project: "ws-a" });
    h.manager.open({ project: "ws-b" });

    expect(__createdPanels).toHaveLength(2);
    expect(h.manager.openKeys).toEqual(["tachyonSectionAppFixture|ws-a", "tachyonSectionAppFixture|ws-b"]);
  });

});

describe("SectionPanelManager — it mounts through the shared shell", () => {
  it("renders the shared shell page, as an ES module, carrying its own conformance claim", () => {
    const h = harness("document");
    h.manager.open({ project: "ws-a", identity: "t-1" });

    const html = __createdPanels[0].webview.html;
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    // The apps are entries of one splitting invocation: a classic <script> dies on the first `import`.
    expect(html).toContain('type="module"');
    expect(html).toContain("section-app-fixture.js");
    expect(html).toContain('data-shell-surface="tachyonSectionAppFixture"');
    expect(html).toContain("design-system.css");
    // conform ⇒ no extension-point claim on the page (A2's `data-shell-extends`).
    expect(html).not.toContain("data-shell-extends");
  });
});

describe("SectionPanelManager — it is born gated (SDD 485 Phase B)", () => {
  it("does no work for a HIDDEN panel on the fan-out door, and does it for the visible one", () => {
    const h = harness("document");
    h.manager.open({ project: "ws-a", identity: "t-1" });
    h.manager.open({ project: "ws-a", identity: "t-2" });
    __setPanelVisible(__createdPanels[0], false);
    h.replayed.length = 0;

    const ran = h.manager.refresh("model");

    expect(ran).toBe(1);
    expect(h.replayed).toEqual(["tachyonSectionAppFixture|ws-a|t-2"]);
  });

  it("gates the CLIENT's own poll host-side — the loudest door Phase B found", () => {
    // `retainContextWhenHidden: true` keeps a webview's setInterval alive behind another tab. Control ran
    // a full collect twenty times a minute that way. Here the door is closed where the gate lives, so no
    // client version can reopen it: the poll message is claimed by `refreshKindFor` and runs through the
    // gate rather than reaching the binding.
    const h = harness("document");
    h.manager.open({ project: "ws-a", identity: "t-1" });
    __setPanelVisible(__createdPanels[0], false);
    h.replayed.length = 0;

    __createdPanels[0].webview.__receive({ type: "poll" });

    expect(h.replayed).toEqual([]);
    expect(h.messages).toEqual([]); // not merely re-routed to onMessage either
  });

  it("catches up on reveal rather than coming back stale", () => {
    const h = harness("document");
    h.manager.open({ project: "ws-a", identity: "t-1" });
    __setPanelVisible(__createdPanels[0], false);
    h.manager.refresh("model");
    h.replayed.length = 0;

    __setPanelVisible(__createdPanels[0], true);

    expect(h.replayed).toEqual(["tachyonSectionAppFixture|ws-a|t-1"]);
  });

  it("DROPS a post to a hidden panel and rebuilds on reveal — a bypass cannot reach the webview", () => {
    // The structural half of "born gated": a future app that posts outside gated work still cannot push
    // into a hidden webview, and still cannot leave it stale. This is why the manager does not rely on a
    // static guard alone to keep new doors honest.
    const resyncs: string[] = [];
    let escaped: SectionPanelSession<"model"> | undefined;
    // Hold the session the way a careless binding would — an async load that resolves after the tab went
    // behind another one is the ordinary way this happens, not an act of sabotage.
    const h = harness("document", {
      bind: (session) => {
        escaped = session;
        return { replay: () => {}, resync: () => { resyncs.push(session.key); } };
      },
    });
    h.manager.open({ project: "ws-a", identity: "t-1" });
    const panel = __createdPanels[0];
    __setPanelVisible(panel, false);
    panel.webview.posted.length = 0;

    const posted = escaped!.post({ type: "sneaky" });

    expect(posted).toBe(false);
    expect(panel.webview.posted).toEqual([]);

    __setPanelVisible(panel, true);
    expect(resyncs).toEqual(["tachyonSectionAppFixture|ws-a|t-1"]); // the drop armed a rebuild, not a hole
  });

  it("passes an unclaimed message through to the binding", () => {
    const h = harness("document");
    h.manager.open({ project: "ws-a", identity: "t-1" });

    __createdPanels[0].webview.__receive({ type: "something-domain-shaped" });

    expect(h.messages).toEqual([{ type: "something-domain-shaped" }]);
  });

  it("stops gating and stops holding panels once disposed", () => {
    const h = harness("dashboard");
    h.manager.open({ project: "ws-a" });

    h.manager.dispose();

    expect(__createdPanels[0].disposed).toBe(true);
    expect(h.manager.openKeys).toEqual([]);
  });
});

describe("SectionPanelManager — reload restores what was open (registerTrustedPanelSerializer)", () => {
  it("persists the MINIMUM a revive needs, and revives onto the same key", async () => {
    const h = harness("document");
    h.manager.open({ project: "ws-a", identity: "t-1" });
    // the persisted state is the one the shell embedded — read it back out of the rendered page rather
    // than re-deriving it, so this proves what a real reload would actually be handed.
    const persisted = JSON.parse(/__tachyonPersistedState=(\{.*?\});/.exec(__createdPanels[0].webview.html)![1]) as SectionPanelState;
    expect(persisted).toEqual({ schemaVersion: 1, view: "tachyonSectionAppFixture", project: "ws-a", identity: "t-1" });

    // a real window reload: the panel is gone, VS Code hands a fresh one back through the serializer.
    __createdPanels[0].dispose();
    const context = { subscriptions: [] } as unknown as import("vscode").ExtensionContext;
    const revived = harness("document");
    registerTrustedPanelSerializer<SectionPanelState>(context, "tachyonSectionAppFixture", (panel, state) => revived.manager.deserialize(panel, state));
    const registration = __registeredWebviewPanelSerializers.find((r) => r.viewType === "tachyonSectionAppFixture");
    expect(registration, "no serializer registered for the app's viewType").toBeTruthy();

    const panel = makeRevivablePanel();
    await registration!.serializer.deserializeWebviewPanel(panel, persisted);

    expect(revived.manager.openKeys).toEqual(["tachyonSectionAppFixture|ws-a|t-1"]);
    expect(panel.disposed).toBe(false);
    // and it reuses the panel VS Code handed back rather than creating a second one.
    expect(__createdPanels.filter((p) => !p.disposed)).toHaveLength(0);
  });

  it("drops a revived panel whose state no longer fits the app's cardinality", async () => {
    // A manifest edit between two window sessions (document → dashboard) leaves a persisted identity that
    // can no longer be keyed. That is a stale panel, not a crash.
    const dashboard = harness("dashboard");
    const panel = makeRevivablePanel();

    dashboard.manager.deserialize(panel as unknown as import("vscode").WebviewPanel, {
      schemaVersion: 1, view: "tachyonSectionAppFixture", project: "ws-a", identity: "t-1",
    });

    expect(panel.disposed).toBe(true);
    expect(dashboard.manager.openKeys).toEqual([]);
    await Promise.resolve();
  });
});

describe("SectionAppFixturePanelManager — the mechanism wired end to end", () => {
  it("counts a model only when it REACHED the webview", () => {
    const fixture = new SectionAppFixturePanelManager(extensionUri);
    fixture.open({ project: "ws-a", identity: "t-1" });
    const key = "tachyonSectionAppFixture|ws-a|t-1";
    // the app's `ready` handshake is claimed by refreshKindFor, so the first model is the replay path.
    // Built from the surface's own constructor, never a hand-typed literal: the harness/host handshake
    // drift this file's sibling commit fixed is exactly what a literal here would have hidden.
    __createdPanels[0].webview.__receive(sectionFixtureReadyMessage());
    expect(fixture.revisionOf(key)).toBe(1);

    __setPanelVisible(__createdPanels[0], false);
    fixture.refresh();
    fixture.refresh();

    expect(fixture.revisionOf(key), "a hidden panel's model count must not move").toBe(1);

    __setPanelVisible(__createdPanels[0], true);
    expect(fixture.revisionOf(key)).toBe(2); // one catch-up, not two replays
    fixture.dispose();
  });
});

/** a panel shaped like the one VS Code hands a serializer — created outside `createWebviewPanel`. */
function makeRevivablePanel() {
  const viewStateHandlers: Array<() => void> = [];
  const disposeHandlers: Array<() => void> = [];
  const panel = {
    title: "",
    iconPath: undefined,
    disposed: false,
    visible: true,
    active: true,
    revealCount: 0,
    onDidChangeViewState: (cb: () => void) => { viewStateHandlers.push(cb); return { dispose() {} }; },
    webview: {
      html: "",
      options: {},
      cspSource: "vscode-webview:",
      posted: [] as unknown[],
      asWebviewUri: (uri: unknown) => uri,
      postMessage: async (msg: unknown) => { panel.webview.posted.push(msg); return true; },
      onDidReceiveMessage: (_cb: (msg: unknown) => void) => ({ dispose() {} }),
    },
    reveal: () => { panel.revealCount += 1; },
    dispose: () => { panel.disposed = true; for (const cb of disposeHandlers) cb(); },
    onDidDispose: (cb: () => void) => { disposeHandlers.push(cb); return { dispose() {} }; },
  };
  return panel;
}
