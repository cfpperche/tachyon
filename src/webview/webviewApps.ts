/**
 * SDD 485 Phase C — the STANDALONE APP manifest: the apps that are built as ES-module entrypoints in ONE
 * esbuild invocation with `splitting: true`, so Preact, the kit and every shared utility land in COMMON
 * chunks instead of being copied once per app.
 *
 * Why a manifest at all, and why this one rather than `WEBVIEW_SURFACES`: the surface manifest answers a
 * conformance question (spec 279 + 485 Phase A — does this surface mount the shared shell, and what does it
 * declare?) and spans surfaces that are not apps in this sense (a WebviewView, a static preview page, a
 * plugin relay). This list answers two different questions that need the SAME source or they drift:
 *
 *   1. what does `SectionPanelManager` configure itself from — including CARDINALITY, which is the one
 *      parameter that separates a dashboard (one panel per section per project) from a document (one panel
 *      per identity). Twelve hand-written managers were rejected in `spec.md` precisely so that this stays
 *      a row in a table rather than a class to read;
 *   2. what does the bundle budget measure. `cockpitBundleBudget.test.ts` measured one hardcoded filename
 *      (`dist/webview/cockpit.js`); with N apps that shape cannot survive, so its successor walks THIS list
 *      and measures every app's eager entry plus the reachable total.
 *
 * `esbuild.mjs` cannot import a TypeScript module, so it carries its own `WEBVIEW_APP_VIEWS` array and
 * `test/unit/webviewAppBudget.test.ts` fails if the two ever disagree, in either direction. That is the same
 * bargain the rest of this repo already takes (the convention guard reads `esbuild.mjs` as text too): the
 * declaration of record lives in TypeScript, and a test — not a habit — keeps the build honest against it.
 */

/**
 * How many panels of one app may exist at once, and — equivalently — what a panel's KEY is made of.
 * `spec.md` introduced two kinds ("Two kinds of app, not one"); SDD 485 D1 added the third, because the
 * first migrated dashboard turned out not to be one:
 *
 *  - `dashboard` — ONE panel per app per project; key `viewId | project`. Opening it again REVEALS the
 *    panel that is already open. The Board, Fleet, Engine, Settings and most of the rest land here.
 *  - `document`  — ONE panel per IDENTITY; key `viewId | project | identity`. Two identities are two
 *    panels, side by side, and a document's identity is fixed at open: the project selector changes what
 *    the NEXT thing opens against, never what an open document IS (`route.ts:37` already treats a task
 *    detail's `wsHash` that way).
 *  - `window`    — ONE panel, full stop; key `viewId`, with NO project and NO identity. For a surface
 *    whose subject is not per-project: the tmux Server Inspector reads ONE socket shared by every
 *    workspace in the window, and its own screen already filters by workspace with an "all" option
 *    (`inspector/App.tsx`, protected by `controlWorkspaceScope.test.ts`). Under `dashboard` two attached
 *    projects would open two byte-identical panels onto the same server; under `window` they open one.
 *
 * **A project constant would have been a lie, and that is why this is a third member rather than a
 * convention.** "Dashboard, keyed on a fixed string" produces one panel too — but the key would carry a
 * project the panel does not have, `panelStateFor` would persist it, `openInCurrentScope` would resolve a
 * scope and hand over something meaningless, and nothing would stop the next caller passing a REAL project
 * and getting a second identical panel. A cardinality is enforcement; this one has to be able to enforce
 * "there is no project here", which only a member `sectionPanelKey` can REFUSE against can do.
 */
export type SectionAppCardinality = "dashboard" | "document" | "window";

/**
 * Which host owns an app's panel lifecycle. A union rather than an optional field, for the same reason
 * `WebviewPosture` is one: a section app that forgets to say which cardinality it has must be a COMPILE
 * error, not a runtime default that quietly picks dashboard and loses "two task details side by side".
 */
export type WebviewAppHost =
  /** SDD 485's generic `SectionPanelManager`. Cardinality is its one behavioural parameter. */
  | { host: "section"; cardinality: SectionAppCardinality }
  /**
   * Control's own singleton host (`Cockpit.ts`), which SDD 485 Phase E removes. It is listed here because
   * it SHARES this build — it is the reason the split chunks have a second consumer at all today — not
   * because `SectionPanelManager` drives it. When Phase E lands, this row goes with it.
   */
  | { host: "control" };

interface WebviewAppBase {
  /** the app directory + bundle basename: `src/webview/<view>/main.tsx` → `dist/webview/<view>.js`. */
  view: string;
  /** the `createWebviewPanel` viewType. Must match a `WEBVIEW_SURFACES` row's `viewId`. */
  viewId: string;
  /**
   * Budget for this app's EAGER entry — the bytes the webview must fetch and execute before it can paint
   * anything. Lazily-imported route bodies land in chunks and are not counted here; the reachable total
   * below is what bounds those.
   */
  eagerBudgetBytes: number;
}

export type WebviewAppEntry = WebviewAppBase & WebviewAppHost;

/** 350 KB — SDD 410's eager gate, carried forward per app rather than for the one app that used to exist. */
const EAGER_BUDGET_BYTES = 350 * 1024;

export const WEBVIEW_APPS: readonly WebviewAppEntry[] = [
  // Control. Still the singleton it has been since SDD 410; here because it is an entry of the same
  // splitting invocation, and because its eager size is the number 410's budget was written about.
  { view: "cockpit", viewId: "tachyonCockpit", host: "control", eagerBudgetBytes: EAGER_BUDGET_BYTES },
  // SDD 485 C1–C3's proof surface. Dev-only, never contributed as a command, never opened by
  // `extension.ts` — the same status as spec 350's two studio fakes, and like them it buys NO exemption
  // from the Phase A conformance contract (it is a `conform` row in `WEBVIEW_SURFACES`). It exists so the
  // mechanism this phase delivers is exercised by a REAL app rather than only by test doubles: a second
  // entry in the splitting invocation (without which "shared chunks" is a claim with no witness), a second
  // measurement for the budget test, and a live host wiring that C4/C5 can copy.
  { view: "section-app-fixture", viewId: "tachyonSectionAppFixture", host: "section", cardinality: "document", eagerBudgetBytes: 64 * 1024 },
  // SDD 485 C4 — the task detail, the FIRST shipped app on this mechanism and the motivating case the
  // "twelve sections" framing would have missed: `document`, so one panel per identity and two task
  // details stand side by side. It keeps the `tachyonTaskDetail` viewType SDD 410 retired to a
  // serializer-only tombstone, so a pre-410 window state revives INTO this app rather than redirecting
  // through Control (see TaskDetailPanel.ts).
  { view: "task-detail", viewId: "tachyonTaskDetail", host: "section", cardinality: "document", eagerBudgetBytes: EAGER_BUDGET_BYTES },
  // SDD 485 C5 — the Board, and the maintainer's motivating case #1 (the Board open beside an agent
  // terminal). `dashboard` is the whole of its difference from the task detail above: one panel per project,
  // and re-opening it reveals the panel that is already open rather than making a second. `view` stays
  // "mission-control" because that is the directory the screen has always lived in and the basename its two
  // stylesheets already ship under; the viewType is NEW (`tachyonBoard`) so the legacy `tachyonMissionControl`
  // serializer can keep redirecting a pre-410 panel instead of colliding with this one — the opposite call
  // from C4's, and for the opposite reason: that tombstone has no live redirect left to preserve.
  { view: "mission-control", viewId: "tachyonBoard", host: "section", cardinality: "dashboard", eagerBudgetBytes: EAGER_BUDGET_BYTES },
  // SDD 485 D1 — the tmux Server Inspector, the FIRST Phase D migration and the app that introduced
  // `window`. The socket is one per user, shared by every workspace in the window (`WEBVIEW_SURFACES`
  // recorded that when 410 retired this panel: "no per-workspace scoping needed — the tmux socket is
  // cross-workspace by design"), and the screen's own universe is wider than any project: its groups
  // include `foreign: true` rows for closed and other-window workspaces, which no project key could name.
  //
  // `view` stays "inspector" — the directory the screen has always lived in and the basename its
  // stylesheet already ships under; renaming it inside a cutover would touch ~10 files to say the same
  // thing (the same call C5 made for "mission-control"). The viewType is the RETIRED
  // `tachyonServerInspector`, reused rather than replaced: 410 left it a serializer-only tombstone whose
  // persisted state is `{schemaVersion, view}` and nothing else — which is EXACTLY what a `window` app
  // persists, since it has no project and no identity. So a pre-410 window state is not migrated, it is
  // already valid, and restore REVIVES instead of redirecting. (C4 reused its viewType for a weaker
  // version of this reason; C5 could not, because its tombstone carried an incompatible `wsHash`.)
  { view: "inspector", viewId: "tachyonServerInspector", host: "section", cardinality: "window", eagerBudgetBytes: EAGER_BUDGET_BYTES },
  // SDD 485 D2 — Plugins, the SECOND Phase D migration and the second `dashboard`. Where D1's tmux found
  // the third cardinality by not fitting, this one is the case the spec's table always described: a plugin
  // install is a per-workspace fact end to end (the lockfile is `<workspaceRoot>/.tachyon/plugins-lock.json`,
  // `detectRuntimes` reads that root, every apply writes into it), so two attached projects have two
  // genuinely different plugin sets and two panels showing two answers is CORRECT rather than duplicated.
  //
  // `view` and `viewId` agree here, which is what let the RETIRED `tachyonPlugins` viewType be reused: the
  // id still names this app, and the pre-410 panel's one scoping field (`wsHash`) is exactly the one field
  // a dashboard key is made of, so restore REVIVES through a one-field rename (`migrateLegacy` in
  // PluginsPanel.ts) instead of disposing and reopening. That is C4's call rather than C5's, and the
  // difference is not the tombstone — all three were redirects — but whether the id still names the app.
  { view: "plugins", viewId: "tachyonPlugins", host: "section", cardinality: "dashboard", eagerBudgetBytes: EAGER_BUDGET_BYTES },
];

/**
 * Budget for the whole REACHABLE graph of one app: its eager entry plus every chunk reachable from it.
 * The eager budget alone cannot see the cost this phase actually risks — code-splitting makes it trivial to
 * keep an entry small by pushing everything behind a dynamic import, and a reader six months from now
 * comparing against 410's ~244 KB deserves to know whether the reversal moved bytes or merely moved them.
 */
export const WEBVIEW_APP_REACHABLE_BUDGET_BYTES = 2 * 1024 * 1024;

/** the apps `SectionPanelManager` drives — everything except Control's departing singleton. */
export function sectionApps(): WebviewAppEntry[] {
  return WEBVIEW_APPS.filter((a) => a.host === "section");
}

/** Look one app up by its `view`. Throws rather than returning undefined: every caller here has a
 *  hardcoded view name, so a miss is a typo at startup, not a runtime condition worth branching on. */
export function webviewApp(view: string): WebviewAppEntry {
  const found = WEBVIEW_APPS.find((a) => a.view === view);
  if (!found) throw new Error(`unknown webview app "${view}" — add it to WEBVIEW_APPS (src/webview/webviewApps.ts)`);
  return found;
}
