import type { ComponentChildren } from "preact";
import {
  type CockpitModel,
  type CockpitSectionId,
} from "../../cockpit/model";
import { routeKey } from "../../cockpit/route";
import {
  type CockpitAction,
  type CockpitStrings,
  type CompanionPairOffer,
} from "./messages";
import { Button } from "../shared/ui";
import type { StudioDispatch } from "../shared/studio/protocol";

// spec 410 — lazy section bodies (ESM chunks). Keeps eager cockpit.js under budget.
// t-610705 (Phase B #6) — CSS co-load, sixth surface (see the Approvals comment below for the
// mechanism); two sheets (Tailwind layer + base) share the chunk.
// SDD 485 C5 — the Board's lazy block is GONE, not disabled: the board is a standalone app
// (src/webview/mission-control/main.tsx + BoardPanel.ts) and this file no longer imports its
// component, its stylesheets or its dispatch — the same journey C4's task detail made one commit
// earlier. Two live renderers of one screen is what the atomic cutover forbids: Control's host state
// is global (`panel`, `currentRoute`, `navEpoch`), so the same screen in two places means two
// subscriptions and two possible answers to one command.
// SDD 485 C4 — the task-detail lazy block is GONE with the subroute: the task detail is a standalone
// `document` app (src/webview/task-detail/main.tsx) with its own bundle, error boundary and stylesheet
// list, so Control neither imports its renderer nor co-loads its CSS. Two live renderers of one screen is
// what the atomic cutover exists to prevent.
// t-b30efd — Approval and Validation renderers are gone from Control. Their shared owner is the
// Human Inbox app; compatibility section routes redirect there in Cockpit.ts without mounting UI.
// SDD 485 D4 — the two Human Inbox lazy imports are GONE with the section: it is a standalone
// `dashboard` app now (src/webview/HumanInboxPanel.ts + human-inbox/main.tsx), one tab per project, and
// two live renderers of one screen is the thing spec.md forbids. `src/webview/human-inbox/App.tsx` keeps
// both components; what changed is who mounts them, and that the item’s back affordance moved INTO the
// app — the breadcrumb below was this file’s chrome, and a standalone item route has no host to render it.
// SDD 485 D3 — the Runtime Ops lazy import is GONE with its section: it is a standalone `window` app now
// (src/webview/RuntimeOpsPanel.ts + runtime-ops/main.tsx), one tab for the whole window, and two live
// renderers of one screen is the thing spec.md forbids. `src/webview/runtime-ops/App.tsx` is unchanged and
// unmoved — what changed is who mounts it, which is the whole of a Phase D cutover.
// SDD 485 D2 — the Plugins lazy import is GONE with its section: it is a standalone `dashboard` app now
// (src/webview/PluginsPanel.ts + plugins/main.tsx), one panel per project, and two live renderers of one
// screen is the thing spec.md forbids. `src/webview/plugins/App.tsx` is unchanged and unmoved — what
// changed is who mounts it, which is the whole of a Phase D cutover.
// SDD 485 D1 — the tmux Server Inspector's lazy import is GONE with its section: it is a standalone
// `window` app now (src/webview/TmuxPanel.ts + inspector/main.tsx), and two live renderers of one screen
// is the thing spec.md forbids. `src/webview/inspector/App.tsx` is unchanged and unmoved — what changed is
// who mounts it, which is the whole of a Phase D cutover.
// t-610705 (Phase C.2) — CSS co-load, eighth surface: the agent-activity subroute of Fleet. Shares
// the mermaid-block.css sheet with Handoff (see Cockpit.ts's combined eager-styles condition)
// but under its OWN bootstrap-global key ("activity-mermaid") — same href, distinct id, so the
// cockpitCssParity key-parity check stays a clean 1:1 client-id ↔ host-key mapping.
// t-610705 (Phase C.2) — CSS co-load, ninth surface: the agent-probes/workspace-probes subroutes of
// Fleet (read-only, no mermaid content).
/** t-d16a39 — non-empty UI sentinel for "All workspaces" (Radix Select forbids value=""). */

export interface CockpitAppProps {
  model: CockpitModel | undefined;
  strings: CockpitStrings | undefined;
  auto: boolean;
  onToggleAuto: (on: boolean) => void;
  onRefresh: () => void;
  onCopyDiagnostics: () => void;
  onOpenSettings: () => void;
  onOpenDoctor: () => void;
  onSetSection: (section: CockpitSectionId) => void;
  /** t-d16a39 — shell-level workspace scope; "" = All workspaces. */
  onSwitchWorkspace: (wsHash: string) => void;
  onRevealPath: (path: string) => void;
  onCopyText: (text: string) => void;
  onOpenConfigFile: (wsHash?: string) => void;
  /** SDD 414 — settings.companion.tabTools for the scoped workspace. */
  onSetCompanionTabTools: (wsHash: string, enabled: boolean) => void;
  /** SDD 420 — settings.companion.allowedHosts for the scoped workspace. */
  onSetCompanionAllowedHosts: (wsHash: string, hosts: string[]) => void;
  /** t-585d5c — `undefined` minutes resets to the product default (removes the key). */
  onSetIdleAfterMinutes: (wsHash: string, minutes?: number | "never") => void;
  /** SDD 414/422 — host unpair; deviceId clears one row, omit clears all. */
  onUnpairCompanionDevice: (wsHash: string, deviceId?: string) => void;
  /** SDD 414 — mint pair code (result arrives as companionPairOffer prop). */
  onIssueCompanionPairCode: (wsHash: string) => void;
  /** Ephemeral pair offer from host (not polled model). */
  companionPairOffer?: CompanionPairOffer;
  /** Low-level post for Engine log actions (clear/journal/copy). */
  onPost: (action: CockpitAction) => void;
  /**
   * t-ac79a7 — the navigation the host has committed but not finished loading, if any. See the
   * state's doc comment in cockpit/main.tsx for why it has phases rather than being a boolean.
   */
  navPending?: { routeKey: string; phase: "pending" | "slow" | "stalled" };
  /** t-ac79a7 — retry from the stalled banner. */
  onRetryNavigation?: () => void;
  /** t-610705 (Phase D, D0/D1a) — the studio-new/studio-edit subroute (fleet/... — command, terminal,
   *  runbook, schedule). The studio App receives raw protocol/nav-transaction messages, not a
   *  decoded VM — see command-studio-shell/App.tsx's own doc comment for why. `studioDispatch` is
   *  ONE shared prop for every StudioId (D1a — was `commandStudioDispatch: CommandStudioDispatch`,
   *  D0's studio-specific name/type for what turned out to be an identical `{post}` wrapper every
   *  studio needs): only one studio binding is ever active at a time, so there is nothing to
   *  disambiguate between studios on this prop the way there is for e.g. `activityVm`/`probesVm`. */
  studioIncoming?: { seq: number; message: unknown };
  studioDispatch: StudioDispatch;
}

/** Countdown for pair-code TTL (mm:ss or "0:00" when expired). */

export function App(p: CockpitAppProps) {
  // SDD 443 — in-webview QuickPicker for Continue task (replaces vscode.showQuickPick).
  const s = p.strings;
  if (!s) return <div class="ds-empty" />;
  const m = p.model;
  const section = m?.section ?? "overview";
  const activeRoute = m?.activeRoute;
  // t-610705 (Phase C.2) — Fleet subroutes want the SAME full-bleed/no-checkedAt-footer treatment
  // as an embedded section, even though their nav section ("fleet") isn't one itself (Fleet's own
  // plain list IS a native page and keeps its checkedAt footer — only its subroutes opt out).
  // D17 took `agent-activity` out of this list; D20 took the studio-subroute term out entirely (its
  // name is not spelled here on purpose — cockpitFullpageSubrouteChrome.test.ts scans this file's
  // TEXT for it, so even a comment would keep the guard red). Both removals belong here: this is the
  // merge the Phase D header warns about, where two migrations touch one line and keeping either
  // side alone silently restores a renderer the other retired.
  // t-ace77f — Project Handoff is a detail route now; it keeps the embedded full-bleed body it had
  // as a section, and gains the same "← Overview" top chrome every other subroute already renders.
  // SDD 485 D4 — no `inbox-item` term: Control never commits that route any more (Cockpit.ts's
  // `navigate` redirects it into the Human Inbox app, which renders the item as its own subroute), so a
  // branch for it here would be a path nothing reaches — the same shape C4 left for `task-detail`.
  const isEmbed = false;
  // t-aa2780 — `isNavlessStudio` is gone with the tab strip: it existed ONLY to stop the Overview tab
  // rendering as active while a nav-less route (Project Handoff) was open. There is no tab
  // to light now, and `model.section` was deliberately never coerced (t-610705 Phase D, D3), so the
  // distinction it protected is no longer observable anywhere.
  // t-fullpage-proto — every surviving subroute (the 3 Fleet subroutes and Handoff) gets the
  // SAME fullpage chrome: the section tab strip is replaced by a single minimal "← Back" row at the
  // very top, and the content area gets the vertical space the tab strip would have used. Each
  // branch below sets `breadcrumb` to the exact same back-link it already computed for its own
  // inline placement — this only changes WHERE it renders, not the navigation logic itself.
  // SDD 485 C4 — no `task-detail` term: Control never commits that route any more (Cockpit.ts's
  // `navigate` redirects it to the document app), so a branch for it here would be a path nothing reaches.
  let body: ComponentChildren = null;
  if (!m) {
    body = <div class="ck-empty">{s.empty}</div>;
  } else {
    // SDD 485 D10 — unknown sections never masquerade as Settings; the host redirects them to Overview.
    body = null;
  }

  // t-ac79a7 — the bar and aria-busy go up the instant the host commits the navigation, because
  // "immediate acknowledgement that the click was accepted" is the actual requirement and the
  // measured wait is seconds, not frames. The NAV_SLOW_MS grace deliberately gates only the SPOKEN
  // announcement: a screen reader should not narrate every fast route change, but a sighted user
  // should never wonder whether their click registered. Read once here so the consumers below
  // (bar, aria-busy, live region, banner) cannot drift apart.
  const navBusy = !!p.navPending;
  const navStalled = p.navPending?.phase === "stalled";
  const navAnnounce = p.navPending?.phase === "slow" || navStalled;
  return (
    <div class="ck-root">
      {/* t-ac79a7 — immediate, layout-stable evidence that a navigation is in flight. The bar is
          position:absolute at the panel's top edge so showing/hiding it never reflows the content
          underneath — the requirement is feedback WITHOUT a jump. t-aa2780: it was described as
          sitting over the header's bottom edge, but it is `top: 0` against an unpositioned .ck-root,
          so removing the tab strip moved nothing — the bar still paints across the panel's top. */}
      {navBusy && !navStalled ? <div class="ck-nav-progress" data-testid="control-nav-progress" aria-hidden="true" /> : null}
      {/* Announced politely and owned by no control, so a screen reader hears the navigation without
          focus moving off whatever the user actuated. Rendered always (not just while busy) because a
          live region has to exist BEFORE its text changes for the change to be announced. */}
      <div class="ck-sr-only" role="status" aria-live="polite" data-testid="control-nav-status">
        {navAnnounce ? (navStalled ? s.navStalled : s.navLoading) : ""}
      </div>
      {/* t-aa2780 — Control has NO section tab strip. Navigation is the launcher grid in the sidebar's
          Control tab (src/webview/sidebar/App.tsx, catalog in cockpit/sectionNav.ts): an always-visible
          strip beside Control, so switching section is one click on a surface already on screen.

          t-fullpage-proto — the ONE header Control still renders is a subroute's minimal "← Back" row.
          When `breadcrumb` is null (the deep-link edge: a studio whose parent is neither a section nor
          a task-detail) there is now no header at all rather than a fallback tab strip — the way out of
          that route is the launcher, the same as from any section. */}
      <main
        class={`ck-main${isEmbed ? " ck-main--embed" : ""}`}
        aria-busy={navBusy ? "true" : undefined}
      >
        {/* t-ac79a7 — the stalled end state. Replaces the progress bar rather than joining it: past
            NAV_STALL_MS the UI has no evidence anything is still progressing, so it stops implying
            it and offers a way out instead. */}
        {navStalled ? (
          <div class="ck-nav-stalled" role="alert" data-testid="control-nav-stalled">
            <span class="codicon codicon-warning" aria-hidden="true" />
            <span>{s.navStalled}</span>
            {p.onRetryNavigation ? (
              <Button variant="default" icon="refresh" onClick={p.onRetryNavigation}>
                {s.navRetry}
              </Button>
            ) : null}
          </div>
        ) : null}
        {/* t-ac79a7 — keyed on the active route so Preact remounts this wrapper when the route
            actually changes, which is what replays the enter animation. Keying on the route (not on
            a render counter) is what makes the transition fire ONCE per navigation, on content that
            is already loaded — a poll re-render of the same route keeps the same key and does not
            re-animate. `ck-route-content` is a no-op under prefers-reduced-motion (see cockpit.css). */}
        <div class="ck-route-content" key={activeRoute ? routeKey(activeRoute) : `section:${section}`}>
          {body}
        </div>
        {m && !isEmbed ? (
          <div class="ck-checked">
            {s.checkedAt}: {m.checkedAt}
          </div>
        ) : null}
      </main>

    </div>
  );
}
