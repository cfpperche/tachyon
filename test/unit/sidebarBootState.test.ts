import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type * as vscode from "vscode";
import { __resetVscodeMock } from "../mocks/vscode.js";
import { SidebarPrototypeProvider } from "../../apps/vscode-extension/src/webview/SidebarPrototype.js";
import { controlWorkspaceScope } from "../../apps/vscode-extension/src/webview/shared/ControlWorkspaceScope.js";
import { initializeVsCodeNotifications } from "../../apps/vscode-extension/src/workspace/notify.js";
import { SAMPLE, type FleetVM, type SidebarBootVM, type TabId } from "@tachyon/shared/sidebar/types.js";
import {
  DELAYED_AFTER_MS,
  bootNeedsTick,
  pendingBootFolders,
  resolveBootState,
} from "@tachyon/webview-ui/webview/sidebar/bootState";
import { loadWebviewModule, renderStatic } from "../helpers/staticPreact.js";
import type { WorkspaceSidebarTarget } from "../../apps/vscode-extension/src/shell/SidebarTarget.js";

/**
 * SDD 504 — the sidebar tells the truth about its own boot.
 *
 * The defect this closes was one expression: `if (!fleets.length)` rendered "No Tachyon workspace."
 * and an Initialize button. That predicate answered two different questions with one — "no Tachyon
 * workspace here" and "I have not heard from the engine yet" — and during boot the second was
 * rendered as the first, so a configured project was told it had none and offered a button that
 * would create a second `tachyon.yml` over the one already there.
 *
 * The plan's finding is what makes this a state problem rather than a spinner problem: absence is
 * knowable SYNCHRONOUSLY in the activation turn, from `workspaceFolders` + `hasConfig(folder)`. The
 * welcome was never waiting on slow information — it was the webview's DEFAULT, shown before anyone
 * asked.
 *
 * The trap is symmetric and these tests watch both walls: an eternal "starting…" in a window that
 * genuinely has no Tachyon is the same defect mirrored, so the honest empty state must stay
 * reachable and must be reached promptly.
 */

const repoRoot = path.resolve(__dirname, "../..");

const START = 1_000_000;
const folder = (over: Partial<SidebarBootVM["folders"][number]> = {}): SidebarBootVM["folders"][number] => ({
  hash: "hash-alpha",
  name: "Alpha",
  phase: "starting",
  startedAt: START,
  ...over,
});

describe("SDD 504 — the six boot states, resolved in one place", () => {
  it("unknown: nothing said yet is not the same as nothing here", () => {
    // The whole defect in one assertion. Both spellings of "the host has not answered" must land on
    // `unknown`: no projection at all (the first frame of every reload) and a projection still in
    // flight (a retained webview against a new host incarnation).
    expect(resolveBootState(undefined, [], START)).toBe("unknown");
    expect(resolveBootState({ discovered: false, folders: [] }, [], START)).toBe("unknown");
    // …and an undiscovered projection that happens to carry no folders is STILL unknown. Reading an
    // empty folder list as "none open" would reintroduce the substitution one layer down.
    expect(resolveBootState({ discovered: false, folders: [folder()] }, [], START)).toBe("unknown");
  });

  it("configured-and-starting: a folder is attaching and absence is never claimed", () => {
    expect(resolveBootState({ discovered: true, folders: [folder()] }, [], START)).toBe("configured-and-starting");
  });

  it("delayed: elapsed time changes the words, and only at the threshold", () => {
    const boot: SidebarBootVM = { discovered: true, folders: [folder()] };
    // One millisecond under is still ordinary — the boundary is asserted from both sides because an
    // off-by-one here silently means the delayed copy either never shows or shows immediately.
    expect(resolveBootState(boot, [], START + DELAYED_AFTER_MS - 1)).toBe("configured-and-starting");
    expect(resolveBootState(boot, [], START + DELAYED_AFTER_MS)).toBe("delayed");
    expect(resolveBootState(boot, [], START + 60_000)).toBe("delayed");
  });

  it("delayed is decided by the OLDEST pending folder, not the newest", () => {
    // A second folder added late must not reset the clock on the one the reader has been watching.
    const boot: SidebarBootVM = {
      discovered: true,
      folders: [folder({ hash: "h-old", name: "Old", startedAt: START }), folder({ hash: "h-new", name: "New", startedAt: START + 9_000 })],
    };
    expect(resolveBootState(boot, [], START + 10_000)).toBe("delayed");
  });

  it("failed: a rejected attach never falls back to the welcome", () => {
    // The regression this forbids is specific: before this change an attach failure propagated out
    // of activate(), so the sidebar showed the no-workspace welcome over a project whose startup had
    // just been REJECTED — offering to initialize what had failed to start.
    const boot: SidebarBootVM = { discovered: true, folders: [folder({ phase: "failed", detail: "engine refused" })] };
    expect(resolveBootState(boot, [], START)).toBe("failed");
  });

  it("failed outranks starting — the actionable folder wins the screen", () => {
    const boot: SidebarBootVM = {
      discovered: true,
      folders: [folder({ hash: "h-a", name: "A", phase: "starting" }), folder({ hash: "h-b", name: "B", phase: "failed" })],
    };
    expect(resolveBootState(boot, [], START)).toBe("failed");
  });

  it("confirmed-unconfigured: the honest empty state, and it survives", () => {
    // The mirrored defect's guard. This is the state that must remain reachable, or the fix has
    // simply replaced one lie with another.
    expect(resolveBootState({ discovered: true, folders: [folder({ phase: "unconfigured" })] }, [], START))
      .toBe("confirmed-unconfigured");
    // Zero open folders lands here too, and correctly: "open a folder, then generate a tachyon.yml"
    // is exactly right for an empty window — reached because discovery said so, not assumed.
    expect(resolveBootState({ discovered: true, folders: [] }, [], START)).toBe("confirmed-unconfigured");
  });

  it("ready: a fleet on screen outranks every notice, including a failure elsewhere", () => {
    // Multi-root safety, stated as a rule rather than left to the render: one folder still starting
    // or failed can never blank a folder whose fleet is already here.
    const boot: SidebarBootVM = { discovered: true, folders: [folder({ phase: "failed", detail: "x" })] };
    expect(resolveBootState(boot, [SAMPLE], START)).toBe("ready");
    expect(resolveBootState(undefined, [SAMPLE], START)).toBe("ready");
  });

  it("only a starting folder makes the screen depend on the clock", () => {
    // The tick exists solely to cross the delayed threshold, so it must not run in steady state.
    expect(bootNeedsTick({ discovered: true, folders: [folder()] })).toBe(true);
    expect(bootNeedsTick({ discovered: true, folders: [folder({ phase: "ready" })] })).toBe(false);
    expect(bootNeedsTick({ discovered: true, folders: [folder({ phase: "failed" })] })).toBe(false);
    expect(bootNeedsTick(undefined)).toBe(false);
  });

  it("the multi-root strip reports only folders that still owe the reader something", () => {
    const boot: SidebarBootVM = {
      discovered: true,
      folders: [
        folder({ hash: "h-r", name: "Ready", phase: "ready" }),
        folder({ hash: "h-u", name: "Unconfigured", phase: "unconfigured" }),
        folder({ hash: "h-s", name: "Starting", phase: "starting" }),
        folder({ hash: "h-f", name: "Failed", phase: "failed" }),
      ],
    };
    expect(pendingBootFolders(boot).map((f) => f.name)).toEqual(["Starting", "Failed"]);
    // Nothing at all in the single-root steady state, which is why the strip is additive.
    expect(pendingBootFolders({ discovered: true, folders: [folder({ phase: "ready" })] })).toEqual([]);
  });
});

type AppProps = { fleets?: FleetVM[]; initialTab?: TabId; selectedWsHash?: string; boot?: SidebarBootVM };

describe("SDD 504 — what each state actually puts on screen", () => {
  let App: (props: AppProps) => unknown;
  const render = (props: AppProps): string => renderStatic(App(props));

  beforeEach(async () => {
    __resetVscodeMock();
    initializeVsCodeNotifications();
    const mod = await loadWebviewModule(path.join(repoRoot, "packages/webview-ui/src/webview/sidebar/App.tsx"));
    App = mod.App as typeof App;
  });

  /**
   * The claim and the action are asserted SEPARATELY on purpose. Removing the sentence while leaving
   * the button would still invite someone to initialize a workspace that already exists, which is
   * the half of this defect that actually costs something.
   */
  const claimsAbsence = (html: string) => html.includes("No Tachyon workspace.");
  const offersInit = (html: string) => html.includes("Initialize Tachyon");

  it("says it is checking, and offers nothing, before discovery answers", () => {
    const html = render({ fleets: [], boot: { discovered: false, folders: [] } });
    expect(html).toContain('data-testid="sidebar-boot-unknown"');
    expect(claimsAbsence(html)).toBe(false);
    expect(offersInit(html)).toBe(false);
  });

  it("names the folder it is starting, and never offers to initialize it", () => {
    // Real clock here, unlike the pure tests above: the render derives "delayed" from `Date.now()`,
    // so a fixture stamped in 1970 would arrive already delayed and quietly assert the wrong state.
    const html = render({ fleets: [], boot: { discovered: true, folders: [folder({ name: "my-project", startedAt: Date.now() })] } });
    expect(html).toContain('data-testid="sidebar-boot-configured-and-starting"');
    expect(html).toContain("my-project");
    expect(claimsAbsence(html)).toBe(false);
    expect(offersInit(html)).toBe(false);
    // No invented progress. The plan rejected a percentage because the host cannot estimate
    // completion, and a bar that moves without measuring is worse than no bar.
    expect(html).not.toContain("%");
    expect(html).not.toContain("<progress");
  });

  it("changes the words past the envelope without claiming failure", () => {
    const boot: SidebarBootVM = { discovered: true, folders: [folder({ startedAt: Date.now() - DELAYED_AFTER_MS - 1_000 })] };
    const html = render({ fleets: [], boot });
    expect(html).toContain('data-testid="sidebar-boot-delayed"');
    expect(html).toContain("taking longer than usual");
    // Delayed is not failed: the diagnostic path appears, the verdict does not.
    expect(html).toContain("Show Output");
    expect(html).not.toContain("could not start");
    expect(offersInit(html)).toBe(false);
  });

  it("shows a failure as a failure, with a per-folder retry, and not as absence", () => {
    const html = render({
      fleets: [],
      boot: { discovered: true, folders: [folder({ name: "my-project", phase: "failed", detail: "engine refused" })] },
    });
    expect(html).toContain('data-testid="sidebar-boot-failed"');
    expect(html).toContain("could not start for my-project");
    expect(html).toContain("engine refused");
    expect(html).toContain("Retry my-project");
    expect(html).toContain("Show Output");
    expect(claimsAbsence(html)).toBe(false);
    expect(offersInit(html)).toBe(false);
  });

  it("still reaches the honest welcome once every folder has been checked", () => {
    const html = render({ fleets: [], boot: { discovered: true, folders: [folder({ phase: "unconfigured" })] } });
    expect(html).toContain('data-testid="sidebar-boot-unconfigured"');
    expect(claimsAbsence(html)).toBe(true);
    expect(offersInit(html)).toBe(true);
  });

  it("keeps a ready project's lists on screen while another folder is still starting", () => {
    const alpha: FleetVM = { ...SAMPLE, folder: { hash: "hash-alpha", name: "Alpha" } };
    const html = render({
      fleets: [alpha],
      selectedWsHash: "hash-alpha",
      boot: {
        discovered: true,
        folders: [folder({ hash: "hash-alpha", name: "Alpha", phase: "ready" }), folder({ hash: "h-slow", name: "Slow", phase: "starting" })],
      },
    });
    expect(html).toContain('data-testid="sidebar-boot-row"');
    expect(html).toContain("Starting Tachyon for Slow");
    // The healthy project is untouched — the notice is additive, not a replacement.
    expect(html).toContain(SAMPLE.agents[0]!.name);
    expect(claimsAbsence(html)).toBe(false);
  });

  it("renders nothing extra in the ordinary single-root steady state", () => {
    const alpha: FleetVM = { ...SAMPLE, folder: { hash: "hash-alpha", name: "Alpha" } };
    const html = render({
      fleets: [alpha],
      selectedWsHash: "hash-alpha",
      boot: { discovered: true, folders: [folder({ hash: "hash-alpha", name: "Alpha", phase: "ready" })] },
    });
    expect(html).not.toContain('data-testid="sidebar-boot-row"');
  });
});

/**
 * WHO ELSE CAN REACH THE BOOT SCREEN?
 *
 * The rendering above is one actor (a human reading the sidebar) reaching one state. The state
 * itself is written by the host, and the host is reached through several doors that arrive at
 * different times. These are the plan's actor × trigger rows, named the same way, asserted at the
 * seam production uses: what the provider actually POSTS. A render test cannot see a host that
 * forgot to send discovery at all — and that omission is exactly the old defect returning, because
 * a webview with no `boot` is a webview back to guessing.
 */
describe("SDD 504 — every door onto the boot projection", () => {
  const memento = (initial: Record<string, unknown> = {}) => {
    const store = new Map(Object.entries(initial));
    return {
      get: <T,>(key: string) => store.get(key) as T | undefined,
      update: async (key: string, value: unknown) => { store.set(key, value); },
      keys: () => [...store.keys()],
      setKeysForSync: () => {},
    };
  };

  const target = (fleet: FleetVM): WorkspaceSidebarTarget => ({
    wsHash: fleet.folder!.hash,
    folderName: fleet.folder!.name,
    loadSidebar: async () => fleet as never,
  } as unknown as WorkspaceSidebarTarget);

  function harness(fleets: FleetVM[], boot: () => SidebarBootVM, retry?: (wsHash: string) => void) {
    const pushed: Array<{ boot?: SidebarBootVM; fleets?: FleetVM[] }> = [];
    const handlers: Array<(msg: unknown) => void> = [];
    const view = {
      webview: {
        cspSource: "vscode-resource:",
        options: undefined,
        asWebviewUri: (uri: unknown) => uri,
        postMessage: async (msg: unknown) => { pushed.push(msg as { boot?: SidebarBootVM }); return true; },
        onDidReceiveMessage: (cb: (msg: unknown) => void) => { handlers.push(cb); return { dispose() {} }; },
        html: "",
      },
      onDidDispose: () => ({ dispose() {} }),
    } as unknown as vscode.WebviewView;
    const provider = new SidebarPrototypeProvider(
      { fsPath: "/ext", path: "/ext", scheme: "file", with: () => ({}), toString: () => "/ext" } as unknown as vscode.Uri,
      () => fleets.map(target),
      memento() as unknown as vscode.Memento,
      undefined,
      undefined,
      undefined,
      boot,
      retry,
    );
    provider.resolveWebviewView(view);
    live.push(provider);
    const settle = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
    return { provider, pushed, settle, receive: (msg: unknown) => { for (const cb of handlers) cb(msg); } };
  }

  const live: SidebarPrototypeProvider[] = [];
  beforeEach(() => {
    __resetVscodeMock();
    initializeVsCodeNotifications();
    for (const p of live.splice(0)) p.dispose();
    controlWorkspaceScope.set(undefined);
  });
  afterEach(() => { for (const p of live.splice(0)) p.dispose(); controlWorkspaceScope.set(undefined); });

  it("Tachyon × activation — the very first push already carries discovery", async () => {
    // The regression guard with the most reach. If the host ever stops sending `boot`, the webview
    // is back to inferring absence from an empty array and every render test above still passes.
    const boot: SidebarBootVM = { discovered: true, folders: [folder()] };
    const h = harness([], () => boot);
    await h.settle();
    expect(h.pushed.at(-1)?.boot).toEqual(boot);
    expect(h.pushed.at(-1)?.fleets).toEqual([]);
  });

  it("Interface × reveal before activation settles — an empty fleet ships WITH the reason it is empty", async () => {
    // The frame the owner was actually seeing. Empty fleets, but no longer self-interpreting.
    const h = harness([], () => ({ discovered: false, folders: [] }));
    await h.settle();
    const last = h.pushed.at(-1);
    expect(last?.fleets).toEqual([]);
    expect(last?.boot?.discovered).toBe(false);
    expect(resolveBootState(last?.boot, last?.fleets ?? [], Date.now())).toBe("unknown");
  });

  it("Agent × refresh while attach is pending — discovery is re-read, never cached at resolve time", async () => {
    // A projection snapshotted when the view resolved would be frozen at "starting" forever. The
    // provider takes a GETTER for exactly this reason, so a later refresh reports the newer facts.
    let current: SidebarBootVM = { discovered: true, folders: [folder()] };
    const h = harness([], () => current);
    await h.settle();
    expect(h.pushed.at(-1)?.boot?.folders[0]?.phase).toBe("starting");
    current = { discovered: true, folders: [folder({ phase: "ready" })] };
    h.provider.refresh();
    await h.settle();
    expect(h.pushed.at(-1)?.boot?.folders[0]?.phase).toBe("ready");
  });

  it("Interface × Retry — routes to the named folder, and an unknown hash acts on nobody", async () => {
    const retried: string[] = [];
    const h = harness([], () => ({ discovered: true, folders: [folder({ phase: "failed" })] }), (hash) => retried.push(hash));
    await h.settle();
    h.receive({ type: "global", op: "retryStart", hash: "hash-alpha" });
    expect(retried).toEqual(["hash-alpha"]);
    // A stale hash — a folder closed since the message was queued — must not fall back to workspace
    // 0. That fallback is what `wsFor` already refuses for every other routed op.
    h.receive({ type: "global", op: "retryStart", hash: "hash-gone" });
    expect(retried).toEqual(["hash-alpha", "hash-gone"]);
    // …and a retry with no hash at all names nobody, so it does nothing rather than picking one.
    h.receive({ type: "global", op: "retryStart" });
    expect(retried).toEqual(["hash-alpha", "hash-gone"]);
  });

  it("Tachyon × a host that sends no discovery at all — the webview stays unknown, never 'none'", async () => {
    // Fail-safe direction, asserted rather than assumed: the dangerous end of this failure is
    // claiming absence, so a host with no projection must land on the harmless end.
    const h = harness([], undefined as unknown as () => SidebarBootVM);
    await h.settle();
    expect(h.pushed.at(-1)?.boot).toBeUndefined();
    expect(resolveBootState(h.pushed.at(-1)?.boot, [], Date.now())).toBe("unknown");
  });
});
