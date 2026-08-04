import type { ComponentChildren } from "preact";
import { lazy, Suspense } from "preact/compat";
import { useRef } from "preact/hooks";
import {
  type CockpitModel,
  type CockpitSectionId,
} from "../../cockpit/model";
import { parentRoute, isStudioRoute, routeKey } from "../../cockpit/route";
import {
  navigateReturnAction,
  navigateStudioParentAction,
  openProjectHandoffAction,
  type CockpitAction,
  type CockpitStrings,
  type CompanionPairOffer,
} from "./messages";
import { Button, Badge, PageChrome, EmptyState } from "../shared/ui";
import { loadSectionStylesheet } from "../shared/lazySectionStyles";
import type { ActivityDispatch, PendingShareAgentTargets } from "../activity/App";
import type { ActivityViewModel } from "../../activity/activityView";
import type { ProbesVM } from "../probes/messages";
import type { HandoffDispatch } from "../handoff/App";
import type { HandoffViewModel } from "../handoff/handoffViewModel";
import type { ValidationsDispatch } from "../validations/App";
import type { ValidationsViewModel } from "../validations/viewModel";
import type { ApprovalDispatch } from "../approval/App";
import type { ApprovalViewModel } from "../approval/viewModel";

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
// t-610705 — CSS co-load, third surface (see the Approvals comment below for the mechanism).
const ValidationsApp = lazy(() =>
  import("../validations/App").then((m) => {
    loadSectionStylesheet("validations");
    return { default: m.App };
  }),
);
// t-610705 — pilot for CSS co-load: approval.css loads with this chunk, not unconditionally in
// the cockpit shell (the shell still loads it eagerly ONLY when Approvals is the opening section).
const ApprovalsApp = lazy(() =>
  import("../approval/App").then((m) => {
    loadSectionStylesheet("approvals");
    return { default: m.App };
  }),
);
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
const ActivityApp = lazy(() =>
  import("../activity/App").then((m) => {
    loadSectionStylesheet("activity-mermaid");
    loadSectionStylesheet("activity");
    return { default: m.App };
  }),
);
// t-610705 (Phase C.2) — CSS co-load, ninth surface: the agent-probes/workspace-probes subroutes of
// Fleet (read-only, no mermaid content).
const ProbesApp = lazy(() =>
  import("../probes/App").then((m) => {
    loadSectionStylesheet("probes");
    return { default: m.App };
  }),
);
// t-610705 (Phase C.3) — CSS co-load, tenth surface: the Handoff section (its own sheet plus the
// mermaid-block sheet its doc body's MarkdownView can render, same combined-condition mechanism as
// activity above).
const HandoffApp = lazy(() =>
  import("../handoff/App").then((m) => {
    loadSectionStylesheet("handoff-mermaid");
    loadSectionStylesheet("handoff");
    return { default: m.App };
  }),
);

// t-610705 (Phase D, D0/D1a) — CSS co-load, eleventh+ surfaces: the shared studio-frame.css (every
// StudioPanelManagerBase-based studio) plus THIS studio's own sheet under its own bootstrap-global
// key. D1b/D2/D3 each add their own studio-scoped loadSectionStylesheet call the same way. Each
// studio's own loadSectionStylesheet call for the shared sheet uses a PER-STUDIO "studio-frame-X" key
// even though every key resolves to the SAME studio-frame.css href — same convention as the 3
// "*-mermaid" keys below
// (activity-mermaid/handoff-mermaid, both → mermaid-block.css): cockpitCssParity's
// client/host id-set comparison is a plain 1:1 match, not a dedup, so 4 lazy blocks sharing ONE
// "studio-frame" key would read as 4 client calls against 1 host key and fail parity.
const CommandStudioApp = lazy(() =>
  import("../command-studio-shell/App").then((m) => {
    loadSectionStylesheet("studio-frame-command");
    loadSectionStylesheet("studio-command");
    return { default: m.App };
  }),
);
const TerminalStudioApp = lazy(() =>
  import("../terminal-studio-shell/App").then((m) => {
    loadSectionStylesheet("studio-frame-terminal");
    loadSectionStylesheet("studio-terminal");
    return { default: m.App };
  }),
);
const RunbookStudioApp = lazy(() =>
  import("../runbook-studio-shell/App").then((m) => {
    loadSectionStylesheet("studio-frame-runbook");
    loadSectionStylesheet("studio-runbook");
    return { default: m.App };
  }),
);
const ScheduleStudioApp = lazy(() =>
  import("../schedule-studio-shell/App").then((m) => {
    loadSectionStylesheet("studio-frame-schedule");
    loadSectionStylesheet("studio-schedule");
    return { default: m.App };
  }),
);
// t-610705 (Phase D, D1b) — Agent Studio additionally needs its own compiled Tailwind utilities
// (KitDropdown/KitFilePicker) before its surface CSS — same 3-sheet order the retired standalone
// panel's styleFiles declared (vscode-theme.css is already unconditional in Cockpit.ts's main
// styles: [...] array, so only the token-bridge Tailwind sheet needs its own co-load key here).
// t-610705 (Phase D, D1b code-review finding) — `loadSectionStylesheet` APPENDS a real `<link>` to
// <head> on every call, so CSS precedence follows the ACTUAL DOM insertion order, not call intent —
// the tailwind sheet must be requested BEFORE studio-frame-agent here, or a lazy in-session
// navigation INTO Agent Studio (e.g. from Terminal) ends up with the opposite cascade order from a
// direct deep-link (whose initial unconditional <link> tags — Cockpit.ts's styles: [...] array — are
// already correctly ordered tailwind-before-studio-frame). Getting this backwards is invisible on a
// fresh Control open (agent-studio-shell.tailwind.css never gets a lazy call at all when it was
// already eagerly linked) and only bites on the lazy-navigation path — exactly the kind of
// route-history-dependent rendering bug that's easy to miss without testing BOTH entry paths.
const AgentStudioApp = lazy(() =>
  import("../agent-studio-shell/App").then((m) => {
    loadSectionStylesheet("studio-agent-tailwind");
    loadSectionStylesheet("studio-frame-agent");
    loadSectionStylesheet("studio-agent");
    return { default: m.App };
  }),
);
// t-610705 (Phase D, D2) — Task Studio needs its own compiled Tailwind utilities (KitFieldRow/
// KitLabeledInput/KitSelect) PLUS the entity-neutral rich-doc editor sheet (shared with the retired
// standalone panel and Pin Studio's future D3 migration) BEFORE studio-frame.css — same cascade-order
// requirement Agent Studio's own comment above explains (actual <link> DOM insertion order, not call
// intent), matching Cockpit.ts's eager `styles: [...]` order exactly: tailwind, rich-doc,
// studio-frame, THEN Task Studio's own sheet.
const TaskStudioApp = lazy(() =>
  import("../task-studio/App").then((m) => {
    loadSectionStylesheet("studio-task-tailwind");
    loadSectionStylesheet("studio-task-richdoc");
    loadSectionStylesheet("studio-frame-task");
    loadSectionStylesheet("studio-task");
    return { default: m.App };
  }),
);
// t-610705 (Phase D, D3) — Pin Studio needs the SAME entity-neutral rich-doc.css HREF as Task Studio
// BEFORE studio-frame.css, matching the retired standalone panel's own styleFiles order (`rich-doc.css,
// studio-frame.css, pin-studio.css`) — no Tailwind sheet of its own (unlike Task/Agent Studio: Pin's UI
// has no KitFieldRow/KitSelect-family controls). Own co-load KEY ("studio-pin-richdoc", not a reused
// "studio-task-richdoc") even though both resolve to the same file — same "one distinct key per client
// call site" convention studio-frame's per-studio keys already use (cockpitCssParity.test.ts's client/
// host co-load-id parity check is a plain array compare, not set-based — a shared key called from two
// lazy blocks would appear twice on the client side but only once in the host's bootstrap map).
const PinStudioApp = lazy(() =>
  import("../pin-studio/App").then((m) => {
    loadSectionStylesheet("studio-pin-richdoc");
    loadSectionStylesheet("studio-frame-pin");
    loadSectionStylesheet("studio-pin");
    return { default: m.App };
  }),
);

/**
 * t-aa2780 — a lazy section's loading screen now NAMES the section.
 *
 * With the tab strip gone, the body is the only thing that says which section is on screen, and a
 * code-split chunk's fallback is frequently the FIRST thing a human sees after clicking a launcher
 * tile. A bare "Loading…" left the whole panel anonymous for that window. `title` is the launcher's
 * own label (TAB_META's navKey), so the screen echoes the tile that was clicked rather than the
 * section's eventual H1, which is sometimes worded differently ("Inbox" tile → "Human Inbox" page).
 *
 * Subroutes deliberately pass nothing: they render the "← Back" breadcrumb above this, which already
 * says where the human is and where they came from.
 */
function SectionFallback({ title }: { title?: string }) {
  return (
    <>
      {title ? <PageChrome title={title} /> : null}
      <EmptyState kind="loading" message="Loading…" />
    </>
  );
}

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
  /** t-610705 (Phase C.2) — the agent-activity subroute of Fleet. */
  activityVm?: ActivityViewModel;
  activityPrepended: boolean;
  activityImages: Record<string, string>;
  activityDispatch: ActivityDispatch;
  /** t-a983e1 — host-listed targets for Activity share → agent QuickPicker. */
  pendingShareAgentTargets?: PendingShareAgentTargets | null;
  onConsumeShareAgentTargets?: () => void;
  /** t-610705 (Phase C.2) — the agent-probes/workspace-probes subroutes of Fleet. */
  probesVm?: ProbesVM;
  /** t-610705 (Phase C.3) — the Handoff section. */
  handoffVm?: HandoffViewModel;
  handoffDispatch: HandoffDispatch;
  /** Embedded product surfaces (not Task/Pin/form studios). */
  approvalVm?: ApprovalViewModel;
  approvalError?: string;
  approvalDispatch: ApprovalDispatch;
  validationsVm?: ValidationsViewModel;
  validationsError?: string;
  validationsDispatch: ValidationsDispatch;
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

/** Tabs that host a full product surface (no ModuleChrome table / deep-link stub). */
const EMBED_SECTIONS = new Set<CockpitSectionId>(["validations", "approvals"]);

const TAB_META: Record<CockpitSectionId, { icon: string; navKey: keyof CockpitStrings }> = {
  overview: { icon: "dashboard", navKey: "navOverview" },
  engine: { icon: "server-environment", navKey: "navEngine" },
  fleet: { icon: "organization", navKey: "navFleet" },
  inbox: { icon: "inbox", navKey: "navInbox" },
  approvals: { icon: "pass", navKey: "navApprovals" },
  mission: { icon: "checklist", navKey: "navMission" },
  validations: { icon: "checklist", navKey: "navValidations" },
  worktrees: { icon: "folder-library", navKey: "navWorktrees" },
  "execution-graph": { icon: "type-hierarchy", navKey: "navExecutionGraph" },
  runtime: { icon: "graph", navKey: "navRuntime" },
  "runtime-config": { icon: "settings", navKey: "navRuntimeConfig" },
  tmux: { icon: "terminal-tmux", navKey: "navTmux" },
  plugins: { icon: "extensions", navKey: "navPlugins" },
  settings: { icon: "settings-gear", navKey: "navSettings" },
};

function StateBadge({ s, state }: { s: CockpitStrings; state: "attached" | "error" | "none" }) {
  const label = state === "attached" ? s.attached : state === "error" ? s.error : s.none;
  const tone = state === "attached" ? "ok" : state === "error" ? "err" : "default";
  return <Badge tone={tone}>{label}</Badge>;
}


/** Countdown for pair-code TTL (mm:ss or "0:00" when expired). */

export function App(p: CockpitAppProps) {
  // t-610705 (Phase C.2) — declared BEFORE the `!s` early return below so this hook always runs in
  // the same order every render (the Activity subroute needs the actual overflow:auto ancestor for
  // its scroll math — window/document.body no longer work now that the standalone panel is retired).
  const activityScrollRef = useRef<HTMLDivElement>(null);
  // SDD 443 — in-webview QuickPicker for Continue task (replaces vscode.showQuickPick).
  const s = p.strings;
  if (!s) return <div class="ds-empty" />;
  const m = p.model;
  const section = m?.section ?? "overview";
  const activeRoute = m?.activeRoute;
  // t-610705 (Phase C.2) — Fleet subroutes want the SAME full-bleed/no-checkedAt-footer treatment
  // as an embedded section, even though their nav section ("fleet") isn't one itself (Fleet's own
  // plain list IS a native page and keeps its checkedAt footer — only its subroutes opt out).
  const isFleetSubroute = activeRoute?.kind === "agent-activity" || activeRoute?.kind === "agent-probes" || activeRoute?.kind === "workspace-probes";
  const isStudioSubroute = !!activeRoute && isStudioRoute(activeRoute);
  // t-ace77f — Project Handoff is a detail route now; it keeps the embedded full-bleed body it had
  // as a section, and gains the same "← Overview" top chrome every other subroute already renders.
  const isProjectHandoff = activeRoute?.kind === "project-handoff";
  // SDD 485 D4 — no `inbox-item` term: Control never commits that route any more (Cockpit.ts's
  // `navigate` redirects it into the Human Inbox app, which renders the item as its own subroute), so a
  // branch for it here would be a path nothing reaches — the same shape C4 left for `task-detail`.
  const isEmbed = EMBED_SECTIONS.has(section) || isFleetSubroute || isStudioSubroute || isProjectHandoff;
  // t-aa2780 — `isNavlessStudio` is gone with the tab strip: it existed ONLY to stop the Overview tab
  // rendering as active while a nav-less route (Pin Studio, Project Handoff) was open. There is no tab
  // to light now, and `model.section` was deliberately never coerced (t-610705 Phase D, D3), so the
  // distinction it protected is no longer observable anywhere.
  // t-fullpage-proto — every subroute (the 3 Fleet subroutes, all 7 studios) gets the
  // SAME fullpage chrome: the section tab strip is replaced by a single minimal "← Back" row at the
  // very top, and the content area gets the vertical space the tab strip would have used. Each
  // branch below sets `breadcrumb` to the exact same back-link it already computed for its own
  // inline placement — this only changes WHERE it renders, not the navigation logic itself.
  // SDD 485 C4 — no `task-detail` term: Control never commits that route any more (Cockpit.ts's
  // `navigate` redirects it to the document app), so a branch for it here would be a path nothing reaches.
  const isSubroute = isFleetSubroute || isStudioSubroute || isProjectHandoff;
  let breadcrumb: ComponentChildren = null;

  let body: ComponentChildren = null;
  if (!m) {
    body = <div class="ck-empty">{s.empty}</div>;
  } else if (activeRoute?.kind === "agent-activity" || activeRoute?.kind === "agent-probes" || activeRoute?.kind === "workspace-probes") {
    // t-610705 (Phase C.2) — Fleet subroutes: same "checked before the section branch" reasoning as
    // the section branch below (nav section reads "fleet" for all three; this renders the content).
    const parent = parentRoute(activeRoute);
    // t-fullpage-proto — was a compact "← Fleet" line under the surface's OWN title
    // (ActivityApp/ProbesApp rendered it there); now lives in the top chrome instead, so neither
    // component receives a backLink prop any more.
    if (parent && parent.kind === "section") {
      breadcrumb = (
        <Button variant="default" icon="arrow-left" class="ck-top-breadcrumb-btn" data-testid="control-fleet-subroute-breadcrumb" onClick={() => p.onSetSection(parent.section)}>
          {s.navFleet}
        </Button>
      );
    }
    body = (
      <div class="ck-embed-host" data-testid="control-fleet-subroute" ref={activityScrollRef}>
        <Suspense fallback={<SectionFallback />}>
          {activeRoute.kind === "agent-activity" ? (
            <ActivityApp
              vm={p.activityVm}
              prepended={p.activityPrepended}
              images={p.activityImages}
              dispatch={p.activityDispatch}
              scrollContainer={activityScrollRef}
              pendingShareAgentTargets={p.pendingShareAgentTargets}
              onConsumeShareAgentTargets={p.onConsumeShareAgentTargets}
            />
          ) : (
            <ProbesApp vm={p.probesVm} />
          )}
        </Suspense>
      </div>
    );
  } else if (activeRoute?.kind === "project-handoff") {
    // t-ace77f — checked before the section branch, same as every other subroute: `model.section`
    // reads "overview" underneath (the nav-less fallback), but the document is what renders.
    const parent = parentRoute(activeRoute);
    if (parent && parent.kind === "section") {
      breadcrumb = (
        <Button variant="default" icon="arrow-left" class="ck-top-breadcrumb-btn" data-testid="control-handoff-breadcrumb" onClick={() => p.onSetSection(parent.section)}>
          {s[TAB_META[parent.section].navKey]}
        </Button>
      );
    }
    body = (
      <div class="ck-embed-host" data-testid="control-handoff">
        <Suspense fallback={<SectionFallback />}>
          <HandoffApp vm={p.handoffVm} dispatch={p.handoffDispatch} />
        </Suspense>
      </div>
    );
  } else if (activeRoute && isStudioRoute(activeRoute)) {
    // t-610705 (Phase D, D0/D1a) — a studio route is its own full-bleed body (StudioFrame is its own
    // chrome: title, dirty dot, Cancel/Save) — same "checked before the section branch" pattern as
    // the Fleet subroutes above. D1b/D2/D3 add their own branch the same way (no generic
    // dispatch-by-registry on the client — Preact's `lazy()` calls must stay static top-level calls
    // for esbuild's code-split analysis). Every branch shares `key`/`routeKey`/`mountNonce`/
    // `incoming`/`dispatch` wiring — only the component and its own studio-scoped stylesheet differ.
    const parent = parentRoute(activeRoute);
    // t-610705 (Phase D, D3) — pin is nav-less: its breadcrumb ALWAYS posts the parameterless
    // "navigateReturn" action (the host is the sole authority on the destination — its own
    // already-sanitized `currentRoute.returnRoute`, see Cockpit.ts's "navigateReturn" case; the
    // client never sends a route object). `parent` (computed client-side via the SAME pure
    // parentRoute() the host uses) only decides the button's LABEL here — a specific nav-tab name
    // when returnRoute is a flat section, else the generic "Back" (returnRoute can also be
    // task-detail/agent-activity/agent-probes/workspace-probes, none of which have their own fixed
    // breadcrumb dispatch the way Task's task-detail parent does below).
    // t-fullpage-proto — was a compact "← Parent" line under StudioFrame's OWN title (backLink
    // prop); now lives in the top chrome instead, same as every other subroute's breadcrumb.
    breadcrumb = activeRoute.studio === "pin" ? (
      <Button variant="default" icon="arrow-left" class="ck-top-breadcrumb-btn" data-testid="control-studio-breadcrumb" onClick={() => p.onPost(navigateReturnAction(routeKey(activeRoute)))}>
        {parent && parent.kind === "section" ? s[TAB_META[parent.section].navKey] : s.back}
      </Button>
      // t-610705 (Phase D, D2) — Task Studio's edit route is the one OTHER studio whose parent is
      // NOT a flat section (route.ts's parentRoute special-cases studio-edit + studio:"task" to the
      // task's own task-detail route).
      // SDD 485 C4 — that parent is no longer a Control route that renders: it is the task's own editor
      // tab. So the button posts `navigateStudioParent` and the HOST derives the destination from
      // parentRoute — the same no-client-destination rule pin's `navigateReturn` follows, and the same
      // reason: a queued click from a route the human already left must be dropped, not fired.
    ) : parent && parent.kind === "section" ? (
      <Button variant="default" icon="arrow-left" class="ck-top-breadcrumb-btn" data-testid="control-studio-breadcrumb" onClick={() => p.onSetSection(parent.section)}>
        {s[TAB_META[parent.section].navKey]}
      </Button>
    ) : parent && parent.kind === "task-detail" ? (
      <Button
        variant="default"
        icon="arrow-left"
        class="ck-top-breadcrumb-btn"
        data-testid="control-studio-breadcrumb"
        // t-c3c819 — task-detail is the correct parent for a REAL edit, but Task Studio's
        // staged-create pattern opens a brand-new task straight into studio-edit with a
        // pre-minted, still-unsaved id (mintTaskId()); m.studioPersisted === false means this
        // is that case — task-detail(id) would 404 ("never found on disk"), so land on the
        // Board itself instead, same as every other studio's flat-section parent.
        onClick={() => (m.studioPersisted === false ? p.onSetSection("mission") : p.onPost(navigateStudioParentAction(routeKey(activeRoute))))}
      >
        {s.navMission}
      </Button>
    ) : null;
    // t-610705 (Phase D, D0, round-3 major) — an explicit `key` forces Preact to fully UNMOUNT +
    // remount on identity change instead of reusing the component instance with stale state visible
    // under the new props for one render (the internal reset-effect alone left exactly that window —
    // code review round 3 caught it).
    const studioKey = `${routeKey(activeRoute)}:${m.studioMountNonce ?? ""}`;
    const studioMountProps = { routeKey: routeKey(activeRoute), mountNonce: m.studioMountNonce ?? "", incoming: p.studioIncoming, dispatch: p.studioDispatch };
    body = (
      <div class="ck-embed-host" data-testid="control-studio">
        <Suspense fallback={<SectionFallback />}>
          {activeRoute.studio === "command" ? (
            <CommandStudioApp key={studioKey} {...studioMountProps} />
          ) : activeRoute.studio === "terminal" ? (
            <TerminalStudioApp key={studioKey} {...studioMountProps} />
          ) : activeRoute.studio === "runbook" ? (
            <RunbookStudioApp key={studioKey} {...studioMountProps} />
          ) : activeRoute.studio === "schedule" ? (
            <ScheduleStudioApp key={studioKey} {...studioMountProps} />
          ) : activeRoute.studio === "agent" ? (
            <AgentStudioApp key={studioKey} {...studioMountProps} />
          ) : activeRoute.studio === "task" ? (
            <TaskStudioApp key={studioKey} {...studioMountProps} />
          ) : activeRoute.studio === "pin" ? (
            <PinStudioApp key={studioKey} {...studioMountProps} />
          ) : null}
        </Suspense>
      </div>
    );
  } else if (section === "overview") {
    const o = m.overview;
    body = (
      <>
        <PageChrome
          title={s.overviewTitle}
          hint={s.overviewHint}
          actions={
            <div class="ck-overview-actions">
              {/* t-46eb4f — THE global workspace scope, and the only one in Control. It lives here,
                  in Overview, and is always visible: with a single root it still answers "which root
                  am I looking at", which the header's old >1-workspace condition never did. Every
                  other screen consumes the resulting scope; none offers its own copy of it. */}
              <label class="ck-auto" title={s.auto}>
                <input type="checkbox" checked={p.auto} onChange={(e) => p.onToggleAuto((e.target as HTMLInputElement).checked)} />
                {s.auto}
              </label>
              <Button variant="default" icon="refresh" onClick={p.onRefresh} title={s.refresh}>
                {s.refresh}
              </Button>
              <Button variant="default" icon="copy" onClick={p.onCopyDiagnostics} title={s.copyDiagnostics}>
                {s.copyDiagnostics}
              </Button>
            </div>
          }
        />
        <div class="ck-metrics">
          <div class="ck-metric">
            <div class="label">{s.workspaces}</div>
            <div class="value">{o.workspaceCount}</div>
          </div>
          <div class={`ck-metric ${o.enginesAttached > 0 ? "ok" : ""}`}>
            <div class="label">{s.engines}</div>
            <div class="value">{o.enginesAttached}</div>
          </div>
          <div class={`ck-metric ${o.enginesError > 0 ? "warn" : ""}`}>
            <div class="label">{s.errors}</div>
            <div class="value">{o.enginesError}</div>
          </div>
          <div class="ck-metric">
            <div class="label">{s.agents}</div>
            <div class="value">
              {o.agentsRunning}/{o.agentsTotal}
            </div>
          </div>
          {/* t-e76acc / t-bce1ad — ONE actionable number for everything waiting on a human. */}
          <button
            type="button"
            class={`ck-metric ck-metric-btn ${o.inboxPending > 0 ? "warn" : ""}`}
            data-testid="control-overview-inbox"
            onClick={() => p.onSetSection("inbox")}
          >
            <div class="label">{s.inbox}</div>
            <div class="value">{o.inboxPending}</div>
          </button>
          <div class="ck-metric">
            <div class="label">{s.worktrees}</div>
            <div class="value">{o.worktreesActive}</div>
          </div>
        </div>
        <div class="ck-panel">
          <h2>{s.bridges}</h2>
          {o.bridges.length === 0 ? (
            <p class="ck-empty">{s.empty}</p>
          ) : (
            <ul class="ck-bridge-list">
              {o.bridges.map((b) => (
                <li key={b.folder + b.url}>
                  <span class="name">{b.folder}</span>
                  <span>{b.url}</span>
                  <StateBadge s={s} state={b.ok ? "attached" : "error"} />
                </li>
              ))}
            </ul>
          )}
        </div>
        <div class="ck-panel">
          <h2>Jump</h2>
          <div class="ck-jump">
            <Button variant="default" onClick={() => p.onSetSection("engine")}>
              {s.navEngine}
            </Button>
            <Button variant="default" onClick={() => p.onSetSection("fleet")}>
              {s.navFleet}
            </Button>
            <Button variant="default" onClick={() => p.onSetSection("inbox")}>
              {s.navInbox}
            </Button>
            <Button variant="default" onClick={() => p.onSetSection("mission")}>
              {s.navMission}
            </Button>
            <Button variant="default" data-testid="control-overview-open-handoff" onClick={() => p.onPost(openProjectHandoffAction())}>
              {s.navHandoff}
            </Button>
            <Button variant="default" onClick={() => p.onSetSection("runtime")}>
              {s.navRuntime}
            </Button>
            <Button variant="default" onClick={() => p.onSetSection("plugins")}>
              {s.navPlugins}
            </Button>
            <Button variant="default" onClick={p.onOpenSettings}>
              {s.navSettings}
            </Button>
            <Button variant="default" onClick={() => p.onSetSection("tmux")}>
              {s.navTmux}
            </Button>
            <Button variant="default" onClick={p.onOpenDoctor}>
              Doctor
            </Button>
          </div>
        </div>
      </>
    );
  } else if (section === "approvals") {
    body = (
      <div class="ck-embed-host" data-testid="control-approvals">
        <Suspense fallback={<SectionFallback title={s[TAB_META["approvals"].navKey]} />}>
          <ApprovalsApp vm={p.approvalVm} error={p.approvalError} dispatch={p.approvalDispatch} />
        </Suspense>
      </div>
    );
  } else if (section === "validations") {
    body = (
      <div class="ck-embed-host" data-testid="control-validations-host">
        <Suspense fallback={<SectionFallback title={s[TAB_META["validations"].navKey]} />}>
          <ValidationsApp vm={p.validationsVm} error={p.validationsError} dispatch={p.validationsDispatch} />
        </Suspense>
      </div>
    );
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
      {isSubroute && breadcrumb ? (
        <header class="ck-top ck-top--fullpage">
          <div class="ck-chrome ck-chrome--fullpage">{breadcrumb}</div>
        </header>
      ) : null}

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
