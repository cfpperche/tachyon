import path from "node:path";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type * as vscode from "vscode";
import { __resetVscodeMock } from "../mocks/vscode.js";
import { SidebarPrototypeProvider } from "../../apps/vscode-extension/src/webview/SidebarPrototype.js";
import { ControlWorkspaceScope, controlWorkspaceScope } from "../../apps/vscode-extension/src/webview/shared/ControlWorkspaceScope.js";
import { initializeVsCodeNotifications } from "../../apps/vscode-extension/src/workspace/notify.js";
import { SAMPLE, TABS, type FleetVM, type TabId } from "@tachyon/shared/sidebar/types.js";
import { buildSectionsModel } from "@tachyon/webview-ui/sections/model";
import { loadWebviewModule, renderStatic } from "../helpers/staticPreact.js";
import type { WorkspaceSidebarTarget } from "../../apps/vscode-extension/src/shell/SidebarTarget.js";

/**
 * t-72ff5a — the sidebar has ONE workspace regime.
 *
 * Before this, two lived side by side: `Control` and `Attentions` were workspace-wide singletons
 * while the other seven tabs rendered every attached project stacked under folder headers. Choosing
 * a project in Control and switching tabs put every project back on screen — the choice did not
 * cross. Now one project is in focus for the whole sidebar, `Attentions` is cross-project BY
 * DECISION (owner, 2026-08-05) rather than by accident, and the selection is stated in chrome that
 * belongs to no tab.
 *
 * The task's own warning is what shapes these tests: "an implementation that filters the rendered
 * list and leaves the rest of the model holding every workspace will produce counts, badges and
 * searches that disagree with the screen". So the assertions below are as much about the COUNTS as
 * about the rows — a screenshot cannot tell a scoped chip from an aggregate one.
 */

const repoRoot = path.resolve(__dirname, "../..");

/** The seven tabs that render one project's lists. Attentions and Control are deliberately absent. */
const SCOPED_TABS: TabId[] = ["Agents", "Terminals", "Pipelines", "Schedules", "Commands", "Runbooks", "Pins"];

const alpha: FleetVM = {
  ...SAMPLE,
  folder: { hash: "hash-alpha", name: "Alpha" },
  handoff: { exists: true, staleness: "needs_distill", pendingCount: 3 },
  engineLogHasError: true,
  agents: [
    { name: "alpha-agent-one", status: "running", kind: "agent", resources: { cpuPct: 5, memMb: 100 } },
    { name: "alpha-agent-two", status: "idle", kind: "agent" },
  ],
  terminals: [{ name: "alpha-term", status: "running", kind: "terminal" }],
  pipelines: [{ name: "alpha-pipe", status: "idle", nodes: [] }],
  schedules: [{ name: "alpha-sched", when: "daily", next: "in 1h", paused: false }],
  commands: [{ name: "alpha-cmd", cmd: "npm test", state: "idle", detail: "never run" }],
  runbooks: [{ name: "alpha-book", detail: "never run", steps: [], running: false, failed: false }],
  pins: [{ text: "alpha-pin", id: "p-alpha", tags: ["alphatag"], done: false }],
  notices: [{ id: "n-alpha", level: "info", message: "alpha needs you", at: "2026-08-05T10:00:00.000Z", collapsedCount: 1, read: false, actions: [], actionsLive: false }],
};

const beta: FleetVM = {
  ...SAMPLE,
  folder: { hash: "hash-beta", name: "Beta" },
  handoff: { exists: false, staleness: "fresh", pendingCount: 0 },
  engineLogHasError: false,
  agents: [{ name: "beta-agent-one", status: "running", kind: "agent" }],
  terminals: [{ name: "beta-term", status: "running", kind: "terminal" }],
  pipelines: [{ name: "beta-pipe", status: "idle", nodes: [] }],
  schedules: [{ name: "beta-sched", when: "weekly", next: "in 3d", paused: false }],
  commands: [{ name: "beta-cmd", cmd: "npm run lint", state: "idle", detail: "never run" }],
  runbooks: [{ name: "beta-book", detail: "never run", steps: [], running: false, failed: false }],
  pins: [{ text: "beta-pin", id: "p-beta", tags: ["betatag"], done: false }],
  notices: [{ id: "n-beta", level: "warn", message: "beta needs you", at: "2026-08-05T11:00:00.000Z", collapsedCount: 1, read: false, actions: [], actionsLive: false }],
};

type AppProps = { fleets?: FleetVM[]; initialTab?: TabId; selectedWsHash?: string };
let App: (props: AppProps) => unknown;

beforeEach(() => {
  __resetVscodeMock();
  initializeVsCodeNotifications();
});

const render = (props: AppProps): string => renderStatic(App(props));

describe("t-72ff5a — one project is in focus for the whole sidebar", () => {
  beforeEach(async () => {
    const mod = await loadWebviewModule(path.join(repoRoot, "packages/webview-ui/src/webview/sidebar/App.tsx"));
    App = mod.App as typeof App;
  });

  it("every scoped tab renders the SELECTED project and not the other one", () => {
    for (const tab of SCOPED_TABS) {
      const html = render({ fleets: [alpha, beta], initialTab: tab, selectedWsHash: "hash-beta" });
      expect(html, `${tab}: shows the selected project`).toContain("beta-");
      // The real defect: the other project stacked below. Asserted per tab because each one used to
      // enter the per-folder map on its own.
      expect(html, `${tab}: does not stack the unselected project`).not.toContain("alpha-");
    }
  });

  it("and follows the selection when it names the other project", () => {
    for (const tab of SCOPED_TABS) {
      const html = render({ fleets: [alpha, beta], initialTab: tab, selectedWsHash: "hash-alpha" });
      expect(html, `${tab}: follows the selection`).toContain("alpha-");
      expect(html, `${tab}: follows the selection`).not.toContain("beta-");
    }
  });

  it("drops the folder header from every tab, including single-root", () => {
    // spec 331 (pin p-cf707f) deliberately kept this header at N=1 so single-root and multi-root
    // were one code path. That property SURVIVES — N=1 and N>1 are still identical — but the line
    // that states the project moved to the chrome, which every tab can see.
    for (const fleets of [[alpha], [alpha, beta]]) {
      for (const tab of [...SCOPED_TABS, "Attentions" as TabId, "Control" as TabId]) {
        const html = render({ fleets, initialTab: tab, selectedWsHash: "hash-alpha" });
        expect(html, `${tab} @ ${fleets.length} root(s)`).not.toContain('class="grp folder');
        expect(html, `${tab} @ ${fleets.length} root(s)`).not.toContain("folder-body");
      }
    }
  });

  it("states the project — and its handoff — in chrome that belongs to no tab", () => {
    for (const tab of [...SCOPED_TABS, "Attentions" as TabId, "Control" as TabId]) {
      const html = render({ fleets: [alpha, beta], initialTab: tab, selectedWsHash: "hash-alpha" });
      expect(html, `${tab}: chrome present`).toContain('data-testid="sidebar-workspace-chrome"');
      expect(html, `${tab}: selector present`).toContain('data-testid="sidebar-workspace-select"');
      // …and it is the SELECTED project's handoff, not the first fleet's or an aggregate.
      expect(html, `${tab}: handoff follows the selection`).toContain("handoff · 3");
    }
    // Beta's handoff does not exist; selecting it must show that state, not Alpha's pending count.
    const onBeta = render({ fleets: [alpha, beta], initialTab: "Agents", selectedWsHash: "hash-beta" });
    expect(onBeta).toContain("no handoff");
    expect(onBeta).not.toContain("handoff · 3");
  });

  it("keeps the selector on screen with a single project (SDD 485 C6, kept verbatim)", () => {
    const html = render({ fleets: [alpha], initialTab: "Agents", selectedWsHash: "hash-alpha" });
    expect(html).toContain('data-testid="sidebar-workspace-select"');
    expect(html).toContain("Alpha");
  });

  /**
   * The half a screenshot cannot judge. Each of these folded `fleets` before; a chip that still
   * counted every project over a list showing one would be wrong in a way that looks right.
   */
  it("counts and badges agree with the one project on screen", () => {
    const onBeta = render({ fleets: [alpha, beta], initialTab: "Agents", selectedWsHash: "hash-beta" });
    // the Agents status filter's "all" chip: Beta has one agent, the window has three
    expect(onBeta).toContain("All · 1");
    expect(onBeta).not.toContain("All · 3");

    const onAlpha = render({ fleets: [alpha, beta], initialTab: "Agents", selectedWsHash: "hash-alpha" });
    expect(onAlpha).toContain("All · 2");

    // the metrics toggle appears only when the SELECTED project has a row that can show metrics —
    // Alpha has one, Beta has none, and folding both would offer the control over an empty set
    expect(onAlpha).toContain("Expand all resource metrics");
    expect(onBeta).not.toContain("Expand all resource metrics");

    // pin tags are the selected project's
    const pinsBeta = render({ fleets: [alpha, beta], initialTab: "Pins", selectedWsHash: "hash-beta" });
    expect(pinsBeta).toContain("betatag");
    expect(pinsBeta).not.toContain("alphatag");
  });

  it("scopes the Control tab's engine-error dot to the selected project", () => {
    // The dot's tile opens Control on the SELECTED project's Engine section, so a dot lit by another
    // project's log ring would send the reader to a log with nothing wrong in it.
    const onAlpha = render({ fleets: [alpha, beta], initialTab: "Agents", selectedWsHash: "hash-alpha" });
    expect(onAlpha).toContain('data-testid="tab-control-engine-dot"');
    const onBeta = render({ fleets: [alpha, beta], initialTab: "Agents", selectedWsHash: "hash-beta" });
    expect(onBeta).not.toContain('data-testid="tab-control-engine-dot"');
  });

  it("keeps Attentions cross-project, and every card names its own project", () => {
    const html = render({ fleets: [alpha, beta], initialTab: "Attentions", selectedWsHash: "hash-alpha" });
    // Owner, 2026-08-05: scoping this would hide the agent that is stuck in the project you are not
    // looking at, which is the one thing the selection must never do.
    expect(html).toContain("alpha needs you");
    expect(html).toContain("beta needs you");
    expect(html).toContain(">Alpha<");
    expect(html).toContain(">Beta<");
    // the tab badge counts what the list shows — both projects, not the selected one
    expect(html).toContain('data-testid="tab-attentions-badge"');
    expect(html).toContain(">2<");

    // …and a single-root window labels its card too: the card answers "which project is THIS", a
    // question that has an answer even when the count is one.
    const solo = render({ fleets: [alpha], initialTab: "Attentions", selectedWsHash: "hash-alpha" });
    expect(solo).toContain(">Alpha<");
  });

  it("renders an honest empty state, not a selector, when no workspace is attached", () => {
    const html = render({ fleets: [], initialTab: "Agents" });
    expect(html).toContain("No Tachyon workspace.");
    expect(html).not.toContain('data-testid="sidebar-workspace-select"');
  });

  it("resolves a selection that names no attached project, rather than showing nothing", () => {
    // A hash persisted from a window with different folders, or a folder closed since. Both must
    // land on a real project — the empty screen is the failure this replaces, not a valid state.
    for (const stale of [undefined, "hash-gone"]) {
      const html = render({ fleets: [alpha, beta], initialTab: "Agents", selectedWsHash: stale });
      expect(html, `stale=${stale}`).toContain("alpha-agent-one");
    }
  });

  it("leaves Ctrl+K indexing every project — search is not navigation", () => {
    // The panel only mounts on a keystroke, so this is asserted where the decision lives: the index
    // is built from `fleets`, never from the selected one. Scoping it would make a name in another
    // root unreachable by the only mechanism built to find it; the label and the switch-on-open in
    // `pick` are what keep a foreign hit honest.
    const src = readFileSync(path.join(repoRoot, "packages/webview-ui/src/webview/sidebar/App.tsx"), "utf8");
    expect(src).toContain("const index = useMemo(() => fleets.flatMap(searchIndex), [fleets]);");
    expect(src).toContain("{open && <CmdK fleets={fleets} selectedHash={selectedHash}");
    expect(src).toMatch(/if \(it\.wsHash && it\.wsHash !== selectedHash\) selectWorkspace\(it\.wsHash\);/);
  });

  it("still has nine tabs — this is a scope change, not a navigation change", () => {
    expect(TABS.map((t) => t.id)).toEqual([
      "Attentions", "Control", "Agents", "Terminals", "Pipelines", "Schedules", "Commands", "Runbooks", "Pins",
    ]);
    expect(SCOPED_TABS.length + 2).toBe(TABS.length);
  });
});

/**
 * WHO ELSE CAN REACH THE SELECTION?
 *
 * The rendering half above is one actor (a human reading the sidebar) through one door. The scope is
 * also written by the webview's own selector, corrected by the host on every push, restored from a
 * memento at activation, and READ by ~15 call sites in `extension.ts` that open panels and studios.
 * Each row below is an actor × trigger pair that reaches the same effect, named the way the product
 * would describe it — because a mechanism built for one caller and reached later by another is
 * exactly how the five defects of 2026-07-30 landed.
 */
describe("t-72ff5a — every door onto the selection resolves to an attached project", () => {
  const memento = (initial: Record<string, unknown> = {}) => {
    const store = new Map(Object.entries(initial));
    return {
      get: <T,>(key: string) => store.get(key) as T | undefined,
      update: async (key: string, value: unknown) => { store.set(key, value); },
      keys: () => [...store.keys()],
      setKeysForSync: () => {},
      store,
    };
  };

  const target = (fleet: FleetVM): WorkspaceSidebarTarget => ({
    wsHash: fleet.folder!.hash,
    folderName: fleet.folder!.name,
    loadSidebar: async () => fleet as never,
  } as unknown as WorkspaceSidebarTarget);

  /** A view that records what the host actually pushed, which is the only thing the webview sees. */
  function harness(fleets: FleetVM[]) {
    const pushed: Array<{ selectedWsHash?: string }> = [];
    const handlers: Array<(msg: unknown) => void> = [];
    const view = {
      webview: {
        cspSource: "vscode-resource:",
        options: undefined,
        asWebviewUri: (uri: unknown) => uri,
        postMessage: async (msg: unknown) => { pushed.push(msg as { selectedWsHash?: string }); return true; },
        onDidReceiveMessage: (cb: (msg: unknown) => void) => { handlers.push(cb); return { dispose() {} }; },
        html: "",
      },
      onDidDispose: () => ({ dispose() {} }),
    } as unknown as vscode.WebviewView;
    const provider = new SidebarPrototypeProvider(
      { fsPath: "/ext", path: "/ext", scheme: "file", with: () => ({}), toString: () => "/ext" } as unknown as vscode.Uri,
      () => fleets.map(target),
      memento() as unknown as vscode.Memento,
    );
    provider.resolveWebviewView(view);
    live.push(provider);
    const settle = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
    return { provider, pushed, settle, receive: (msg: unknown) => { for (const cb of handlers) cb(msg); } };
  }

  const last = (pushed: Array<{ selectedWsHash?: string }>) => pushed.at(-1)?.selectedWsHash;

  // Providers stay subscribed to the scope until disposed, so a live one from an earlier test would
  // answer the next test's `set(undefined)` by resolving its OWN fleets back into the window scope.
  const live: SidebarPrototypeProvider[] = [];
  beforeEach(() => { for (const p of live.splice(0)) p.dispose(); controlWorkspaceScope.set(undefined); });
  afterEach(() => { for (const p of live.splice(0)) p.dispose(); controlWorkspaceScope.set(undefined); });

  it("Tachyon × first open, nothing ever chosen — resolves to the first project, not to 'every project'", async () => {
    const h = harness([alpha, beta]);
    await h.settle();
    expect(last(h.pushed)).toBe("hash-alpha");
  });

  /**
   * The agreement that used to be bought with a write-back, stated as what it actually is: ONE rule,
   * applied by everything that resolves an unresolvable scope. A second rule here — "first" in the
   * sidebar, "aggregate" or "last" in Control — is how the sidebar could show project A while a
   * panel opened on B, which is the disagreement this task exists to end.
   */
  it("Tachyon × Control opened with the same unset scope — the SAME project, by the same rule", () => {
    const bundle = (hash: string, folder: string) => ({
      control: { folderName: folder, workspaceRoot: `/${folder}`, wsHash: hash, bridgeUrl: "http://127.0.0.1:1/mcp" },
      agents: [], worktrees: [], approvals: [],
    });
    const bundles = [bundle("hash-alpha", "Alpha"), bundle("hash-beta", "Beta")];
    for (const scope of [undefined, "hash-gone"]) {
      const model = buildSectionsModel(bundles as never, { section: "overview", ...(scope ? { wsHash: scope } : {}), nowIso: "now" });
      expect(model.selectedWsHash, `scope=${scope}`).toBe("hash-alpha");
    }
    // and the extension's own readers fall through to the same first project
    const extension = readFileSync(path.join(repoRoot, "apps/vscode-extension/src/extension.ts"), "utf8");
    expect(extension).toContain("(controlWorkspaceScope.current ? byHash(controlWorkspaceScope.current) : undefined) ?? workspaces()[0]");
  });

  it("Interface × picks the other project — the scope moves and the next push says so", async () => {
    const h = harness([alpha, beta]);
    await h.settle();
    h.receive({ type: "switchControlWorkspace", hash: "hash-beta" });
    await h.settle();
    expect(controlWorkspaceScope.current).toBe("hash-beta");
    expect(last(h.pushed)).toBe("hash-beta");
  });

  it("Interface × picks a project that is not attached — refused, the scope does not move", async () => {
    const h = harness([alpha, beta]);
    await h.settle();
    h.receive({ type: "switchControlWorkspace", hash: "hash-nowhere" });
    await h.settle();
    // the host refuses the hash outright, so the scope is untouched and the sidebar keeps showing
    // the project it resolved to
    expect(controlWorkspaceScope.current).toBeUndefined();
    expect(last(h.pushed)).toBe("hash-alpha");
  });

  it("Tachyon × restart with a selection persisted from a window that had other folders", async () => {
    controlWorkspaceScope.set("hash-from-another-window");
    const h = harness([alpha, beta]);
    await h.settle();
    // corrected on the way OUT rather than carried: seven tabs render this value, so what the
    // webview receives may not name a ghost. The stored hash is left alone — resolution is a read,
    // never a write (see SidebarPrototype.resolveSelection).
    expect(last(h.pushed)).toBe("hash-alpha");
  });

  it("Tachyon × the selected folder is closed while it is selected", async () => {
    controlWorkspaceScope.set("hash-beta");
    const h = harness([alpha]); // Beta is gone from this window
    await h.settle();
    expect(last(h.pushed)).toBe("hash-alpha");
  });

  it("Tachyon × no workspace attached — nothing is claimed to be selected", async () => {
    const h = harness([]);
    await h.settle();
    expect(last(h.pushed)).toBeUndefined();
    expect(controlWorkspaceScope.current).toBeUndefined();
  });

  it("Tachyon × window reload — the selection is restored, not re-picked at random", async () => {
    // A selection that governs the whole sidebar and resets on every reload is not a selection.
    const store = memento();
    const first = new ControlWorkspaceScope();
    first.attach(store as unknown as vscode.Memento);
    first.set("hash-beta");
    expect(store.store.get("tachyon.control.workspaceScope")).toBe("hash-beta");

    const afterReload = new ControlWorkspaceScope();
    afterReload.attach(store as unknown as vscode.Memento);
    expect(afterReload.current).toBe("hash-beta");
  });

  it("is stored per workspace, not per person — a folder hash means nothing in another window", () => {
    // `sortPrefs`/`collapsedKeys` are one person's preferences and live in globalState; this is a
    // hash that only resolves in a window holding that folder.
    const extension = readFileSync(path.join(repoRoot, "apps/vscode-extension/src/extension.ts"), "utf8");
    expect(extension).toContain("controlWorkspaceScope.attach(context.workspaceState)");
  });
});
