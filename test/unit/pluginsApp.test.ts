import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Uri } from "vscode";
import { __createdPanels, __registeredWebviewPanelSerializers, __resetVscodeMock, __setPanelVisible } from "../mocks/vscode.js";
import { PluginsPanelManager, PLUGINS_VIEW_TYPE, pluginsRefreshKind, sourceSpecAtCommit, type PluginsPanelState } from "../../src/webview/PluginsPanel.js";
import { registerTrustedPanelSerializer } from "../../src/webview/shared/panelSerializer.js";
import type { SectionPanelState } from "../../src/webview/shared/SectionPanelManager.js";
import { serializeLockfile, LOCKFILE_REL_PATH } from "@tachyon/engine/plugins/lockfile.js";
import { pollAction, readyMessage } from "../../src/webview/plugins/messages.js";
import type { WorkspaceGitPresentationTarget } from "../../src/shell/WorkspacePresentation.js";

/**
 * SDD 485 D2 — Plugins as a standalone DASHBOARD app.
 *
 * Three claims are under test and they are different in kind.
 *
 * The CARDINALITY is what this migration decides: one panel per project, re-opening reveals rather than
 * duplicating, two projects are two panels. For Plugins that is not a preference — a plugin install is a
 * per-workspace fact (lockfile, runtime detection and every apply are rooted at one `workspaceRoot`), so
 * two projects genuinely have two different answers and two panels showing them is correct.
 *
 * The SESSION STATE is the claim the cardinality creates. `checks`/`pending`/`busy` used to live in one
 * closure because the Control embed was one session — "one at a time" was its own comment, true of a
 * singleton and false of a dashboard. The three cases below are `pluginsControlEmbed.test.ts`'s
 * (t-0fc9ee) rewritten for the world that replaced it: what the embed had to defend by NOT rebinding, a
 * per-panel closure gets by construction, and what it could not defend at all — two projects — is now
 * asserted directly.
 *
 * The DOMAIN is everything else, and it must be unchanged: reinstall still pins the recorded commit, the
 * runtime-coverage gap still reaches the posted view-model. Those cases are ported verbatim from the
 * embed test, driven through the panel instead of through a bound webview, because a cutover that quietly
 * changed what an action does would be a migration and a regression at once.
 *
 * Every case drives the WIRE — the message a real client posts — rather than the manager's internals
 * (0.56.159's lesson): `ready` and `poll` reach this app through the GATE and never through `onMessage`,
 * which is exactly the sort of difference an internals-level test cannot see.
 */

const dirs: string[] = [];
const mkroot = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plugins-app-"));
  dirs.push(dir);
  return dir;
};

const extensionUri = Uri.file("/ext");
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

beforeEach(() => __resetVscodeMock());
afterEach(() => {
  for (const p of __createdPanels) if (!p.disposed) p.dispose();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A sourced plugin entry — the source makes checkPluginUpdate reach gitExec, which fails fast. */
function writeLockfile(root: string, name: string): void {
  const lockPath = path.join(root, LOCKFILE_REL_PATH);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const entry = {
    name,
    version: "1.0.0",
    runtimes: ["claude"],
    targets: [{ runtime: "claude", kind: "settings-hook", file: ".claude/settings.json", ref: "PreToolUse", removal: [{ hooks: [{ type: "command", command: "echo guard" }] }] }],
    source: { type: "git", spec: `github:acme/${name}@v1.0.0`, remote: `https://github.com/acme/${name}.git`, ref: "v1.0.0", resolvedCommit: "a1b2c3d".padEnd(40, "0") },
    integrity: { algorithm: "sha256", payload: "deadbeef" },
  };
  fs.writeFileSync(lockPath, serializeLockfile({ schemaVersion: 1, plugins: { [name]: entry } } as never));
  // the remove plan reads the target runtime config — present-but-empty keeps previewRemove error-free
  // so it yields a REAL consent fingerprint (an empty fingerprint never reaches confirm: the "confirm"
  // dispatch case requires a truthy token).
  const settingsPath = path.join(root, ".claude", "settings.json");
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, "{}\n");
}

/** Offline-deterministic target: every git call fails fast (no network, no real repo). */
function target(root: string, hash: string): WorkspaceGitPresentationTarget {
  return {
    workspaceRoot: root,
    wsHash: hash,
    folderName: `ws-${hash}`,
    gitExec: async () => ({ code: 1, stdout: "", stderr: "fake git: unavailable" }),
  } as unknown as WorkspaceGitPresentationTarget;
}

function managerFor(targets: WorkspaceGitPresentationTarget[]): PluginsPanelManager {
  return new PluginsPanelManager(extensionUri, () => targets);
}

type Panel = typeof __createdPanels[number];

const posted = (panel: Panel, type: string): Array<Record<string, unknown>> =>
  panel.webview.posted.filter((m) => (m as { type?: string }).type === type) as Array<Record<string, unknown>>;

const pluginsMsgs = (panel: Panel) =>
  posted(panel, "plugins") as unknown as Array<{ vm: { installed: Array<{ name: string; status: { kind: string } }> } }>;

const statusOf = (panel: Panel, name: string): string | undefined =>
  pluginsMsgs(panel).at(-1)?.vm.installed.find((p) => p.name === name)?.status.kind;

/** Open a panel and give the client's own `ready` handshake — the first model arrives through the gate. */
async function open(mgr: PluginsPanelManager, project: string): Promise<Panel> {
  mgr.open(project);
  const panel = __createdPanels.at(-1)!;
  panel.webview.__receive(readyMessage());
  await flush();
  return panel;
}

describe("SDD 485 D2 — the Plugins cardinality is `dashboard`", () => {
  it("opens ONE panel per project and REVEALS it on a second open", () => {
    const mgr = managerFor([target(mkroot(), "ws-1")]);

    mgr.open("ws-1");
    mgr.open("ws-1");

    expect(__createdPanels).toHaveLength(1);
    expect(__createdPanels[0].revealCount).toBe(1);
    expect(mgr.openKeys).toEqual(["tachyonPlugins|ws-1"]);
  });

  it("gives two PROJECTS a panel each — plugins are installed per workspace, so two answers are correct", async () => {
    const rootA = mkroot();
    const rootB = mkroot();
    writeLockfile(rootA, "tdd-guard");
    // rootB gets NO lockfile: two projects with genuinely different plugin sets, which is the fact the
    // cardinality rests on. Under `window` this screen would show one of them to both.
    const mgr = managerFor([target(rootA, "ws-a"), target(rootB, "ws-b")]);

    const a = await open(mgr, "ws-a");
    const b = await open(mgr, "ws-b");

    expect(__createdPanels).toHaveLength(2);
    expect(mgr.openKeys).toEqual(["tachyonPlugins|ws-a", "tachyonPlugins|ws-b"]);
    expect(pluginsMsgs(a).at(-1)?.vm.installed.map((p) => p.name)).toEqual(["tdd-guard"]);
    expect(pluginsMsgs(b).at(-1)?.vm.installed).toEqual([]);
  });

  it("refuses a panel with no project — a dashboard is opened AGAINST one", () => {
    const mgr = managerFor([target(mkroot(), "ws-1")]);
    expect(() => mgr.open("")).toThrow(/dashboard/);
    expect(__createdPanels).toHaveLength(0);
  });

  it("resolves a project from a workspace it does not have, and says so instead of borrowing another's", async () => {
    // STRICT lookup (C5's rule): a panel keyed on a project that is no longer attached must never fall
    // back to the first workspace. For a surface that INSTALLS things into a root, that would not be a
    // cosmetic error.
    const mgr = managerFor([target(mkroot(), "ws-attached")]);
    const panel = await open(mgr, "ws-gone");

    expect(posted(panel, "plugins")).toEqual([]);
    expect(posted(panel, "result").at(-1)).toMatchObject({ ok: false });
    expect(String(posted(panel, "result").at(-1)?.message)).toContain("ws-gone");
  });
});

describe("SDD 485 D2 — the session state is PER PANEL (t-0fc9ee's contract, under the new cardinality)", () => {
  it("a poll does NOT wipe a stored update check — the Refresh button is the only thing that does", async () => {
    const root = mkroot();
    writeLockfile(root, "tdd-guard");
    const mgr = managerFor([target(root, "ws-1")]);
    const panel = await open(mgr, "ws-1");
    expect(statusOf(panel, "tdd-guard")).toBe("unknown"); // no check ran yet

    // the check settles into an error (fake git fails) — a REAL stored result, distinct from unknown
    panel.webview.__receive({ type: "checkPluginUpdate", name: "tdd-guard" });
    await flush();
    expect(statusOf(panel, "tdd-guard")).toBe("error");

    // twenty polls: one minute of the app's own 3s timer. The embed's equivalent hazard was a rebind
    // wiping the closure; here the hazard is the WORD — a poll routed to the `refresh` handler would run
    // `setChecks({})` and the badge would vanish within three seconds.
    for (let i = 0; i < 20; i++) panel.webview.__receive(pollAction());
    await flush();
    expect(statusOf(panel, "tdd-guard")).toBe("error");

    // and the Refresh button still means what it always meant.
    panel.webview.__receive({ type: "refresh" });
    await flush();
    expect(statusOf(panel, "tdd-guard")).toBe("unknown");
  });

  it("a pending consent survives the poll — confirm still applies instead of silently dropping", async () => {
    const root = mkroot();
    writeLockfile(root, "tdd-guard");
    const mgr = managerFor([target(root, "ws-1")]);
    const panel = await open(mgr, "ws-1");

    panel.webview.__receive({ type: "remove", name: "tdd-guard" });
    await flush();
    const consent = posted(panel, "consent").at(-1) as { vm: { token: string } } | undefined;
    expect(consent?.vm.token).toBeTruthy();

    // a poll tick between the drawer opening and the human clicking Confirm
    panel.webview.__receive(pollAction());
    await flush();

    panel.webview.__receive({ type: "confirm", token: consent!.vm.token });
    await flush();
    // the embed's pre-fix failure was a rebound session with no pending: confirmOp silently returned and
    // NO result was ever posted. A per-panel closure cannot be recreated under a live panel at all.
    expect(posted(panel, "result").at(-1)).toBeTruthy();
  });

  it("two projects do not share checks, a pending consent, or the busy guard", async () => {
    const rootA = mkroot();
    const rootB = mkroot();
    writeLockfile(rootA, "tdd-guard");
    writeLockfile(rootB, "tdd-guard");
    const mgr = managerFor([target(rootA, "ws-a"), target(rootB, "ws-b")]);
    const a = await open(mgr, "ws-a");
    const b = await open(mgr, "ws-b");

    a.webview.__receive({ type: "checkPluginUpdate", name: "tdd-guard" });
    await flush();
    expect(statusOf(a, "tdd-guard")).toBe("error");
    // sequential rather than interleaved: the busy guard would drop the second, which is its job.
    a.webview.__receive({ type: "remove", name: "tdd-guard" });
    await flush();
    const tokenA = (posted(a, "consent").at(-1) as { vm: { token: string } }).vm.token;

    // B has neither. A shared closure would leak A's check into B's cards and let B's confirm apply A's
    // pending removal — against B's workspace root.
    b.webview.__receive(pollAction());
    await flush();
    expect(statusOf(b, "tdd-guard")).toBe("unknown");
    expect(posted(b, "consent")).toEqual([]);

    b.webview.__receive({ type: "confirm", token: tokenA });
    await flush();
    expect(posted(b, "result"), "B confirmed a consent that belongs to A").toEqual([]);
  });
});

describe("SDD 485 D2 — a hidden Plugins tab does no work", () => {
  it("ignores the client's own poll while hidden, and catches up once on reveal", async () => {
    const root = mkroot();
    writeLockfile(root, "tdd-guard");
    const mgr = managerFor([target(root, "ws-1")]);
    const panel = await open(mgr, "ws-1");
    // it IS served while visible — asserted before the negative, so a DEAD door cannot pass this case
    // (boardPanel.test.ts's own correction, applied here rather than cited).
    panel.webview.posted.length = 0;
    panel.webview.__receive(pollAction());
    await flush();
    expect(pluginsMsgs(panel)).toHaveLength(1);

    __setPanelVisible(panel, false);
    panel.webview.posted.length = 0;

    for (let i = 0; i < 20; i++) panel.webview.__receive(pollAction()); // one minute of polling
    await flush();
    await flush();

    expect(panel.webview.posted).toEqual([]);

    __setPanelVisible(panel, true);
    await flush();
    await flush();

    // One catch-up, not twenty replays — and it is not empty, which is the property that matters.
    expect(pluginsMsgs(panel)).toHaveLength(1);
  });

  it("claims `ready` and `poll` for the gate, and nothing else — `refresh` is a human action", () => {
    // The host's own decision, testable without a panel. A client that renamed its poll would stop being
    // served through the gate here rather than quietly becoming ungated work.
    expect(pluginsRefreshKind(readyMessage())).toBe("plugins");
    expect(pluginsRefreshKind(pollAction())).toBe("plugins");
    expect(pluginsRefreshKind({ type: "refresh" })).toBeUndefined();
    expect(pluginsRefreshKind({ type: "install", spec: "github:a/b@v1" })).toBeUndefined();
    expect(pluginsRefreshKind(undefined)).toBeUndefined();
  });
});

describe("SDD 485 D2 — reload puts Plugins back in its tab", () => {
  it("persists the project and revives onto the same key, reusing the panel VS Code hands back", async () => {
    const root = mkroot();
    const mgr = managerFor([target(root, "ws-1")]);
    mgr.open("ws-1");
    // Read the persisted state out of the RENDERED page rather than re-deriving it: this is what a real
    // reload would actually be handed.
    const persisted = JSON.parse(/__tachyonPersistedState=(\{.*?\});/.exec(__createdPanels[0].webview.html)![1]) as SectionPanelState;
    expect(persisted).toEqual({ schemaVersion: 1, view: PLUGINS_VIEW_TYPE, project: "ws-1" });

    __createdPanels[0].dispose();
    const context = { subscriptions: [] } as unknown as import("vscode").ExtensionContext;
    const revived = managerFor([target(root, "ws-1")]);
    registerTrustedPanelSerializer<SectionPanelState>(context, PLUGINS_VIEW_TYPE, (panel, state) => revived.deserialize(panel, state));
    const registration = __registeredWebviewPanelSerializers.find((r) => r.viewType === PLUGINS_VIEW_TYPE);
    expect(registration, "no serializer registered for the Plugins viewType").toBeTruthy();

    const panel = makeRevivablePanel();
    await registration!.serializer.deserializeWebviewPanel(panel as never, persisted);

    expect(revived.openKeys).toEqual(["tachyonPlugins|ws-1"]);
    expect(panel.disposed).toBe(false);
    expect(__createdPanels.filter((p) => !p.disposed), "revival created a second panel").toHaveLength(0);
  });

  it("revives a PRE-410 record too: `wsHash` is renamed to `project`, and the tab is kept", async () => {
    // The whole of the compatibility shim, and the reason this viewType was reused rather than replaced.
    // The alternative — a new viewType plus a dispose-and-reopen redirect — is a window in which the
    // human watches one tab close and another open.
    const root = mkroot();
    const legacy: PluginsPanelState = { schemaVersion: 1, view: PLUGINS_VIEW_TYPE, wsHash: "ws-1" };
    const mgr = managerFor([target(root, "ws-1")]);
    const context = { subscriptions: [] } as unknown as import("vscode").ExtensionContext;
    registerTrustedPanelSerializer<SectionPanelState>(context, PLUGINS_VIEW_TYPE, (panel, state) => mgr.deserialize(panel, state));
    const registration = __registeredWebviewPanelSerializers.find((r) => r.viewType === PLUGINS_VIEW_TYPE);

    const panel = makeRevivablePanel();
    await registration!.serializer.deserializeWebviewPanel(panel as never, legacy as never);

    expect(mgr.openKeys).toEqual(["tachyonPlugins|ws-1"]);
    expect(panel.disposed).toBe(false);
  });

  it("disposes a record that names no workspace at all rather than opening a panel keyed on nothing", async () => {
    const mgr = managerFor([target(mkroot(), "ws-1")]);
    const context = { subscriptions: [] } as unknown as import("vscode").ExtensionContext;
    registerTrustedPanelSerializer<SectionPanelState>(context, PLUGINS_VIEW_TYPE, (panel, state) => mgr.deserialize(panel, state));
    const registration = __registeredWebviewPanelSerializers.find((r) => r.viewType === PLUGINS_VIEW_TYPE);

    const panel = makeRevivablePanel();
    await registration!.serializer.deserializeWebviewPanel(panel as never, { schemaVersion: 1, view: PLUGINS_VIEW_TYPE } as never);

    expect(mgr.openKeys).toEqual([]);
    expect(panel.disposed).toBe(true);
  });
});

describe("Reinstall source pin", () => {
  it("replaces a movable ref with the recorded commit while preserving a monorepo subdir", () => {
    expect(sourceSpecAtCommit("github:acme/plugins@v2.3.1#path=diagram", "c".repeat(40)))
      .toBe(`github:acme/plugins@${"c".repeat(40)}#path=diagram`);
  });

  // A single-plugin repo has no `#path=` fragment, and the ref is still the LAST '@' — the same rule
  // `parseSource`'s `splitRef` applies. Pinned separately because this helper is a second copy of that
  // split: if the spec grammar ever grows a locator that can hold an '@', both have to move together.
  it("pins a spec with no monorepo subdir", () => {
    expect(sourceSpecAtCommit("github:acme/tdd-guard@v1.0.0", "d".repeat(40)))
      .toBe(`github:acme/tdd-guard@${"d".repeat(40)}`);
  });

  /**
   * The routing half. `buildReinstallConsent` proves the drawer's SHAPE; this proves the `reinstall`
   * message reaches the new door at all, and that the door pins the recorded COMMIT rather than the
   * movable ref it was installed from.
   *
   * Before the fix the same message was routed to `previewUpdateOp(…, force: true)`, which resolves
   * `source.ref`. The failing resolve names what it tried to fetch, so the message the human gets is
   * itself the evidence of which door ran — no spying on internals required.
   */
  it("routes reinstall to the pinned-commit door, not to force-update on the movable ref", async () => {
    const root = mkroot();
    writeLockfile(root, "tdd-guard");
    const mgr = managerFor([target(root, "ws-1")]);
    const panel = await open(mgr, "ws-1");

    panel.webview.__receive({ type: "reinstall", name: "tdd-guard" });
    await flush();

    const result = posted(panel, "result").at(-1) as { ok: boolean; message: string } | undefined;
    expect(result?.ok).toBe(false); // the fake git cannot fetch; what matters is WHICH fetch was attempted
    expect(result?.message).toContain("a1b2c3d".padEnd(40, "0").slice(0, 12));
  });
});

/**
 * t-fb216a — the HOST half of the runtime-coverage gap. `buildPluginsViewModel` computing
 * `declared ∩ present − lock.runtimes` is worth nothing if the host never injects `declared`; that
 * injection is fs I/O in the vscode layer, which unit tests otherwise never reach.
 *
 * These drive the real gather() through the PANEL (it was the Control embed before D2) and assert on the
 * POSTED view-model. Unchanged in substance, which is the point: the phase moved where this renders.
 */
describe("runtime-coverage gap reaches the posted view-model (t-fb216a)", () => {
  /** the installed payload manifest — the bytes this install materialized, which is what Reinstall re-materializes. */
  function writePayloadManifest(root: string, name: string, runtimes: string[]): void {
    const dir = path.join(root, ".tachyon/plugins", name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "tachyon-plugin.json"), JSON.stringify({ name, version: "1.0.0", description: "test", runtimes }));
  }

  const uncoveredOf = (panel: Panel, name: string): string[] | undefined =>
    (pluginsMsgs(panel).at(-1)?.vm.installed.find((p) => p.name === name) as { uncoveredRuntimes?: string[] } | undefined)?.uncoveredRuntimes;

  it("names grok when the payload declares it, the workspace runs it, and the lockfile never covered it", async () => {
    const root = mkroot();
    writeLockfile(root, "secrets-guard"); // lockfile runtimes: ["claude"]
    writePayloadManifest(root, "secrets-guard", ["claude", "codex", "grok"]);
    fs.mkdirSync(path.join(root, ".grok"), { recursive: true }); // detectRuntimes ⇒ this workspace runs grok
    const panel = await open(managerFor([target(root, "w1")]), "w1");
    // codex is declared but NOT run here → only grok is uncovered
    expect(uncoveredOf(panel, "secrets-guard")).toEqual(["grok"]);
  });

  it("stays silent when the payload manifest is absent — absence of evidence is not a gap", async () => {
    const root = mkroot();
    writeLockfile(root, "secrets-guard");
    fs.mkdirSync(path.join(root, ".grok"), { recursive: true });
    // no .tachyon/plugins/secrets-guard/tachyon-plugin.json written
    const panel = await open(managerFor([target(root, "w1")]), "w1");
    expect(uncoveredOf(panel, "secrets-guard")).toBeUndefined();
  });

  it("stays silent when the payload manifest is corrupt (never guesses a runtime set)", async () => {
    const root = mkroot();
    writeLockfile(root, "secrets-guard");
    fs.mkdirSync(path.join(root, ".tachyon/plugins/secrets-guard"), { recursive: true });
    fs.writeFileSync(path.join(root, ".tachyon/plugins/secrets-guard/tachyon-plugin.json"), "{ not json");
    fs.mkdirSync(path.join(root, ".grok"), { recursive: true });
    const panel = await open(managerFor([target(root, "w1")]), "w1");
    expect(uncoveredOf(panel, "secrets-guard")).toBeUndefined();
  });

  it("surfaces the gap WITHOUT an update-check having run (the silence breaks at rest)", async () => {
    // the measured complaint was "Already up to date." with nothing else said. The gap is local-only
    // (lockfile + payload manifest + detectRuntimes), so it must not wait on "Check for updates".
    const root = mkroot();
    writeLockfile(root, "secrets-guard");
    writePayloadManifest(root, "secrets-guard", ["claude", "grok"]);
    fs.mkdirSync(path.join(root, ".grok"), { recursive: true });
    const panel = await open(managerFor([target(root, "w1")]), "w1");
    expect(statusOf(panel, "secrets-guard")).toBe("unknown"); // no check ran…
    expect(uncoveredOf(panel, "secrets-guard")).toEqual(["grok"]); // …and the gap is named anyway
  });
});

/** a panel shaped like the one VS Code hands a serializer — created outside `createWebviewPanel`. */
function makeRevivablePanel() {
  const disposeHandlers: Array<() => void> = [];
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
      onDidReceiveMessage: (_cb: (msg: unknown) => void) => ({ dispose() {} }),
    },
    reveal: () => { panel.revealCount += 1; },
    dispose: () => { panel.disposed = true; for (const cb of disposeHandlers) cb(); },
    onDidDispose: (cb: () => void) => { disposeHandlers.push(cb); return { dispose() {} }; },
  };
  return panel;
}
