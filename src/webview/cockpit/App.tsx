import type { ComponentChildren } from "preact";
import { lazy, Suspense } from "preact/compat";
import { useEffect, useRef, useState } from "preact/hooks";
import {
  type CockpitModel,
  type CockpitGlobalSettingsState,
  type CockpitSectionId,
} from "../../cockpit/model";
import { parentRoute, isStudioRoute, routeKey } from "../../cockpit/route";
import {
  formatCompanionPairClipboard,
  navigateReturnAction,
  navigateStudioParentAction,
  openGlobalSettingsFileAction,
  openPersonalCardTemplateAction,
  openProjectHandoffAction,
  setGlobalSettingsAction,
  type CockpitAction,
  type CockpitStrings,
  type CompanionPairOffer,
} from "./messages";
import { CardTemplateBlock } from "./CardTemplateBlock";
import { ExecutionGraphSection } from "./ExecutionGraphSection";
import { Button, Badge, PageChrome, EmptyState } from "../shared/ui";
import {
  KitDropdown,
  KitDropdownContent,
  KitDropdownItem,
  KitDropdownTrigger,
} from "../shared/ui/kit";
import { RuntimeLogo } from "../agent-studio-shell/runtimeLogos";
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
import type {
  RuntimeConfigChange,
  RuntimeConfigControlSnapshot,
  RuntimeConfigRuntime,
} from "../../runtimeConfig/types";

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
  runtimeConfigSnapshot?: RuntimeConfigControlSnapshot;
  runtimeConfigUnavailable?: boolean;
  onOpenRuntimeConfigSource: (path: string) => void;
  onSaveRuntimeConfigChanges: (runtime: RuntimeConfigRuntime, documentId: string, expectedRevision: string | undefined, changes: RuntimeConfigChange[]) => void;
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
function usePairCountdown(expiresAt?: string): { label: string; expired: boolean } {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!expiresAt) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [expiresAt]);
  if (!expiresAt) return { label: "", expired: false };
  const ms = Date.parse(expiresAt) - now;
  if (!Number.isFinite(ms) || ms <= 0) return { label: "0:00", expired: true };
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return { label: `${m}:${String(s).padStart(2, "0")}`, expired: false };
}

/** Parse host globs from textarea (newlines and commas). */
export function parseAllowedHostsDraft(raw: string): string[] {
  return [
    ...new Set(
      raw
        .split(/[\n,]+/)
        .map((h) => h.trim())
        .filter((h) => h.length > 0),
    ),
  ];
}

/**
 * `t-585d5c` — the idle-notification window, in Control -> Settings.
 *
 * Three states rather than a number box: a value, the product default (nothing written), and off.
 * They are distinct on purpose — showing "10" for an unconfigured workspace would make a default
 * indistinguishable from a deliberate choice, and it is the difference a later reader needs.
 *
 * The field REFUSES a bad value locally rather than posting it: the runtime-api schema is still the
 * gate, but a save that silently does nothing is the worst version of this. The bounds shown are the
 * bounds enforced, both derived from the same setting.
 */
/**
 * t-aaad95 — the per-person half of Tachyon's settings, edited where every other Tachyon setting is
 * edited now that VS Code contributes none.
 *
 * Each row says whether it takes effect immediately or waits for Control to be reopened. That is not
 * decoration: with the VS Code settings UI gone there is no other place that would have told the
 * person their change did land, and "I changed it and nothing happened" is how a working setting gets
 * reported as a bug.
 */
/**
 * t-aaad95 (visual QA) — which file THIS block writes to.
 *
 * The two scope cards at the top of the page teach the split, and then the page is a flat stack of
 * blocks for the next 2300px with nothing saying which authority each one belongs to. Measured on the
 * shipped surface: a reader who scrolls past the first 230px has to re-derive the split from each
 * block's prose. The marker is per block because that is where the question is actually asked.
 */
function WritesTo({ s, file }: { s: CockpitStrings; file: "global" | "workspace" | "either" | "none" }) {
  const label = file === "either"
    ? s.settingsWritesToEither
    : file === "none"
      ? s.settingsWritesToNothing
      : `${s.settingsWritesTo} ${file === "global" ? s.settingsScopeGlobalTitle : s.settingsScopeWorkspaceTitle}`;
  return <p class="ck-settings-block-scope" data-testid={`settings-writes-to-${file}`}>{label}</p>;
}

function GlobalSettingsBlock({
  s,
  settings,
  onPost,
}: {
  s: CockpitStrings;
  settings: CockpitGlobalSettingsState;
  onPost: (action: CockpitAction) => void;
}) {
  const [gitPath, setGitPath] = useState(settings.gitPath);
  useEffect(() => {
    setGitPath(settings.gitPath);
  }, [settings.gitPath]);

  return (
    <div class="ck-settings-block" data-testid="control-settings-global">
      <h3 class="ck-settings-block-title">{s.globalSettingsTitle}</h3>
      <WritesTo s={s} file="global" />
      <p class="ck-settings-block-hint">{s.globalSettingsHint}</p>
      <p class="ck-settings-block-body dim" data-testid="global-settings-file">
        {s.globalSettingsFileLabel} <code>{settings.file}</code>
      </p>
      {settings.refusal?.length ? (
        <p class="ck-settings-block-body" data-testid="global-settings-refusal">
          {s.globalSettingsRefused} {settings.refusal.join("; ")}
        </p>
      ) : null}

      <div class="ck-settings-hosts-actions">
        <label class="ck-settings-hosts-label" for="global-settings-code-theme">
          <strong>{s.globalSettingsCodeTheme}</strong>
          <span class="ck-settings-toggle-help">{s.globalSettingsCodeThemeHelp}</span>
        </label>
        <select
          id="global-settings-code-theme"
          class="ck-settings-hosts-input"
          data-testid="global-settings-code-theme"
          value={settings.activityCodeTheme}
          onChange={(e) =>
            onPost(setGlobalSettingsAction({
              activityCodeTheme: (e.target as HTMLSelectElement).value as "auto" | "dark" | "light",
            }))
          }
        >
          <option value="auto">{s.globalSettingsCodeThemeAuto}</option>
          <option value="dark">{s.globalSettingsCodeThemeDark}</option>
          <option value="light">{s.globalSettingsCodeThemeLight}</option>
        </select>
        <span class="ck-settings-toggle-help">{s.globalSettingsNeedsReopen}</span>
      </div>

      <label class="ck-settings-toggle">
        <input
          type="checkbox"
          checked={settings.agentPaneEnabled}
          data-testid="global-settings-agent-pane"
          onChange={(e) => onPost(setGlobalSettingsAction({ agentPaneEnabled: (e.target as HTMLInputElement).checked }))}
        />
        <span>
          <strong>{s.globalSettingsAgentPane}</strong>
          <span class="ck-settings-toggle-help">{s.globalSettingsAgentPaneHelp} — {s.globalSettingsLive}</span>
        </span>
      </label>

      <div class="ck-settings-hosts-actions">
        <label class="ck-settings-hosts-label" for="global-settings-git-path">
          <strong>{s.globalSettingsGitPath}</strong>
          <span class="ck-settings-toggle-help">{s.globalSettingsGitPathHelp} — {s.globalSettingsLive}</span>
        </label>
        <input
          id="global-settings-git-path"
          type="text"
          class="ck-settings-hosts-input"
          data-testid="global-settings-git-path"
          value={gitPath}
          onInput={(e) => setGitPath((e.target as HTMLInputElement).value)}
        />
        <Button
          variant="default"
          disabled={gitPath === settings.gitPath}
          data-testid="global-settings-git-path-save"
          onClick={() => onPost(setGlobalSettingsAction({ gitPath }))}
        >
          {s.globalSettingsSave}
        </Button>
      </div>

      <div class="ck-settings-hosts-actions">
        <Button
          variant="default"
          data-testid="global-settings-open-file"
          onClick={() => onPost(openGlobalSettingsFileAction())}
        >
          {s.globalSettingsOpenFile}
        </Button>
      </div>
    </div>
  );
}

function IdleNotifyField({
  s,
  idle,
  onSave,
}: {
  s: CockpitStrings;
  idle: NonNullable<CockpitModel["idleNotify"]>;
  onSave: (wsHash: string, minutes?: number | "never") => void;
}) {
  const off = idle.configured === "never";
  const serverValue = typeof idle.configured === "number" ? String(idle.configured) : "";
  const [draft, setDraft] = useState(serverValue);
  useEffect(() => {
    setDraft(serverValue);
  }, [idle.wsHash, serverValue]);

  const parsed = Number(draft.trim());
  const valid = draft.trim().length > 0 && Number.isFinite(parsed) && parsed > 0 && parsed <= 10080;
  const dirty = draft.trim() !== serverValue;

  return (
    <div class="ck-settings-block" data-testid="control-settings-idle-notify">
      <h3 class="ck-settings-block-title">{s.idleNotifyTitle}</h3>
      <WritesTo s={s} file="workspace" />
      <p class="ck-settings-block-hint">{s.idleNotifyHelp}</p>
      {idle.configured === undefined ? (
        <p class="ck-settings-block-body dim" data-testid="idle-notify-default">
          {s.idleNotifyUsingDefault.replace("{0}", String(idle.defaultMinutes))}
        </p>
      ) : null}
      {off ? <p class="ck-settings-block-body dim" data-testid="idle-notify-off">{s.idleNotifyOff}</p> : null}
      <div class="ck-settings-hosts-actions">
        <input
          type="number"
          min={1}
          max={10080}
          class="ck-settings-hosts-input"
          data-testid="idle-notify-input"
          value={draft}
          disabled={off}
          placeholder={String(idle.defaultMinutes)}
          onInput={(e) => setDraft((e.target as HTMLInputElement).value)}
        />
        <span class="ck-settings-toggle-help">{s.idleNotifyUnit}</span>
        <Button
          variant="default"
          disabled={off || !valid || !dirty}
          data-testid="idle-notify-save"
          onClick={() => onSave(idle.wsHash, parsed)}
        >
          {s.idleNotifySave}
        </Button>
        <Button
          variant="default"
          disabled={idle.configured === undefined}
          data-testid="idle-notify-reset"
          onClick={() => onSave(idle.wsHash, undefined)}
        >
          {s.idleNotifyReset}
        </Button>
      </div>
      <label class="ck-settings-toggle">
        <input
          type="checkbox"
          checked={off}
          data-testid="idle-notify-off-toggle"
          onChange={(e) =>
            onSave(idle.wsHash, (e.target as HTMLInputElement).checked ? "never" : idle.defaultMinutes)
          }
        />
        <span>
          <strong>{s.idleNotifyOffLabel}</strong>
        </span>
      </label>
    </div>
  );
}

function CompanionAllowedHostsField({
  s,
  wsHash,
  allowedHosts,
  onSave,
}: {
  s: CockpitStrings;
  wsHash: string;
  allowedHosts: string[];
  onSave: (wsHash: string, hosts: string[]) => void;
}) {
  const serverKey = allowedHosts.join("\n");
  const [draft, setDraft] = useState(serverKey);
  useEffect(() => {
    setDraft(serverKey);
  }, [wsHash, serverKey]);
  const dirty = parseAllowedHostsDraft(draft).join("\n") !== serverKey;
  return (
    <div class="ck-settings-hosts" data-testid="companion-allowed-hosts">
      <div class="ck-settings-hosts-label">
        <strong>{s.companionAllowedHosts}</strong>
        <span class="ck-settings-toggle-help">{s.companionAllowedHostsHelp}</span>
      </div>
      <textarea
        class="ck-settings-hosts-input"
        data-testid="companion-allowed-hosts-input"
        rows={3}
        value={draft}
        placeholder={s.companionAllowedHostsPlaceholder}
        spellcheck={false}
        onInput={(e) => setDraft((e.target as HTMLTextAreaElement).value)}
      />
      <div class="ck-settings-hosts-actions">
        <Button
          variant="default"
          data-testid="companion-allowed-hosts-save"
          disabled={!dirty}
          onClick={() => onSave(wsHash, parseAllowedHostsDraft(draft))}
        >
          {s.companionAllowedHostsSave}
        </Button>
      </div>
    </div>
  );
}

function CompanionPairOfferCard({
  s,
  offer,
  onCopyText,
  onNewCode,
}: {
  s: CockpitStrings;
  offer: CompanionPairOffer;
  onCopyText: (text: string) => void;
  onNewCode: () => void;
}) {
  const expiresAt = offer.ok ? offer.expiresAt : undefined;
  const { label: countdown, expired } = usePairCountdown(expiresAt);

  if (!offer.ok) {
    return (
      <div class="ck-pair-offer ck-pair-offer-err" data-testid="companion-pair-offer">
        <p class="ck-settings-block-body">
          {s.companionPairUnavailable}
          {offer.reason ? <span class="dim"> ({offer.reason})</span> : null}
        </p>
        <div class="ck-pair-offer-actions">
          <Button variant="default" data-testid="companion-pair-retry" onClick={onNewCode}>
            {s.companionShowPairCode}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div class="ck-pair-offer" data-testid="companion-pair-offer">
      {expired ? (
        <p class="ck-settings-block-body dim" data-testid="companion-pair-expired">
          {s.companionPairExpired}
        </p>
      ) : null}
      {offer.qrDataUrl ? (
        <div class="ck-pair-offer-qr" data-testid="companion-pair-qr">
          <span class="ck-pair-offer-label">{s.companionPairQrLabel}</span>
          <img
            class="ck-pair-offer-qr-img"
            src={offer.qrDataUrl}
            width={200}
            height={200}
            alt={s.companionPairQrLabel}
          />
          <p class="ck-settings-block-body dim">{s.companionPairQrHint}</p>
        </div>
      ) : null}
      <div class="ck-pair-offer-row">
        <span class="ck-pair-offer-label">{s.companionPairCodeLabel}</span>
        <span class="ck-pair-offer-code ck-mono" data-testid="companion-pair-code">
          {offer.code}
        </span>
      </div>
      <div class="ck-pair-offer-row">
        <span class="ck-pair-offer-label">{s.companionPairUrlLabel}</span>
        <span class="ck-pair-offer-url ck-mono" data-testid="companion-pair-url" title={offer.baseUrl}>
          {offer.baseUrl}
        </span>
      </div>
      {offer.openUrl ? (
        <div class="ck-pair-offer-row">
          <span class="ck-pair-offer-label">open</span>
          <span class="ck-pair-offer-url ck-mono" data-testid="companion-pair-open-url" title={offer.openUrl}>
            {offer.openUrl}
          </span>
        </div>
      ) : null}
      <p class="ck-settings-block-body dim" data-testid="companion-lan-hint">
        {s.companionLanAccessHint}
      </p>
      <div class="ck-pair-offer-row">
        <span class="ck-pair-offer-label">{s.companionPairExpires}</span>
        <span class="ck-mono" data-testid="companion-pair-expires">
          {expired ? "0:00" : countdown}
          {!expired && expiresAt ? (
            <span class="dim"> · {expiresAt.slice(0, 19).replace("T", " ")}</span>
          ) : null}
        </span>
      </div>
      <div class="ck-pair-offer-actions">
        <Button
          variant="default"
          data-testid="companion-pair-copy-code"
          disabled={expired}
          onClick={() => onCopyText(offer.code)}
        >
          {s.companionCopyCode}
        </Button>
        {offer.openUrl ? (
          <Button
            variant="default"
            data-testid="companion-pair-copy-open-url"
            disabled={expired}
            onClick={() => onCopyText(offer.openUrl!)}
          >
            {s.companionCopyUrl}
          </Button>
        ) : (
          <Button
            variant="default"
            data-testid="companion-pair-copy-url"
            onClick={() => onCopyText(offer.baseUrl)}
          >
            {s.companionCopyUrl}
          </Button>
        )}
        <Button
          variant="default"
          data-testid="companion-pair-copy-all"
          disabled={expired}
          onClick={() => onCopyText(formatCompanionPairClipboard(offer))}
        >
          {s.companionCopyAll}
        </Button>
        <Button variant="default" data-testid="companion-pair-new-code" onClick={onNewCode}>
          {s.companionNewCode}
        </Button>
      </div>
    </div>
  );
}


function ModuleChrome({
  title,
  hint,
  actionLabel,
  onAction,
  children,
}: {
  title: string;
  hint: string;
  actionLabel?: string;
  onAction?: () => void;
  children?: ComponentChildren;
}) {
  return (
    <>
      <PageChrome
        title={title}
        hint={hint}
        actions={
          actionLabel && onAction ? (
            <Button variant="primary" onClick={onAction}>
              {actionLabel}
            </Button>
          ) : undefined
        }
      />
      {children}
    </>
  );
}

function RuntimeConfigInventory({
  s,
  snapshot,
  unavailable,
  onOpenSource,
  onSaveChanges,
}: {
  s: CockpitStrings;
  snapshot?: RuntimeConfigControlSnapshot;
  unavailable?: boolean;
  onOpenSource: (path: string) => void;
  onSaveChanges: (runtime: RuntimeConfigRuntime, documentId: string, expectedRevision: string | undefined, changes: RuntimeConfigChange[]) => void;
}) {
  const runtimeLabel = (id: RuntimeConfigRuntime) => ({
    claude: s.runtimeConfigClaude,
    codex: s.runtimeConfigCodex,
    grok: s.runtimeConfigGrok,
  } as Record<string, string>)[id] ?? id;
  const documentLabel = (id: string) => ({
    "codex-global": s.runtimeConfigGlobalConfig,
    "codex-workspace": s.runtimeConfigWorkspaceConfig,
    "claude-global-settings": s.runtimeConfigGlobalSettings,
    "claude-workspace-settings": s.runtimeConfigWorkspaceSettings,
    "claude-workspace-mcp": s.runtimeConfigWorkspaceMcp,
    "grok-global-config": s.runtimeConfigGlobalConfig,
    "grok-workspace-config": s.runtimeConfigWorkspaceConfig,
    "grok-folder-trust": s.runtimeConfigFolderTrust,
  } as Record<string, string>)[id] ?? id;
  const settingLabel = (key: string, fallback: string) => ({
    theme: s.runtimeConfigTheme,
    prefersReducedMotion: s.runtimeConfigReducedMotion,
    spinnerTipsEnabled: s.runtimeConfigSpinnerTips,
    showTurnDuration: s.runtimeConfigTurnDuration,
    terminalProgressBarEnabled: s.runtimeConfigTerminalProgress,
    alwaysThinkingEnabled: s.runtimeConfigAlwaysThinking,
  } as Record<string, string>)[key] ?? fallback;
  const [runtimeId, setRuntimeId] = useState<RuntimeConfigRuntime>("codex");
  const runtime = snapshot?.runtimes.find((candidate) => candidate.runtime === runtimeId) ?? snapshot?.runtimes[0];
  const [documentId, setDocumentId] = useState("");
  const [unknownOpen, setUnknownOpen] = useState(false);
  const [draftSettings, setDraftSettings] = useState<Record<string, string | boolean | string[] | number>>({});
  const [draftMcp, setDraftMcp] = useState<Record<string, boolean>>({});
  const config = runtime?.documents.find((document) => document.id === documentId) ?? runtime?.documents[0];
  const snapshotKey = `${runtime?.runtime ?? "missing"}:${config?.id ?? "missing"}:${config?.revision ?? "missing"}`;
  useEffect(() => {
    if (!config) return;
    const settings: Record<string, string | boolean | string[] | number> = {};
    for (const setting of config.knownSettings) {
      if (setting.editValue !== undefined) settings[setting.key] = setting.editValue;
    }
    setDraftSettings(settings);
    setDraftMcp(Object.fromEntries(config.mcpServers.map((server) => [server.name, server.enabled])));
  }, [snapshotKey]);
  // t-aa2780 — the degraded state keeps the section's H1. It was the one section body whose "no
  // snapshot yet / engine can't serve it" screen said nothing about WHICH section it was, which the
  // tab strip used to answer from outside. Same chrome as the loaded state, so the two do not read as
  // two different screens.
  if (!config) {
    return (
      <div class="rcp-root" data-testid="control-runtime-config">
        <PageChrome title={s.runtimeConfigTitle} hint={s.runtimeConfigHint} />
        <div class="ds-empty">{unavailable ? s.runtimeConfigUnavailable : "Loading runtime configuration…"}</div>
      </div>
    );
  }
  const activeRuntime = runtime!;
  const initialSettings: Record<string, string | boolean | string[] | number> = Object.fromEntries(config.knownSettings.filter((setting) => setting.editValue !== undefined).map((setting) => [setting.key, setting.editValue])) as Record<string, string | boolean | string[] | number>;
  const initialMcp = Object.fromEntries(config.mcpServers.map((server) => [server.name, server.enabled]));
  const dirtySettings = Object.keys({ ...initialSettings, ...draftSettings }).some((key) => JSON.stringify(initialSettings[key]) !== JSON.stringify(draftSettings[key]));
  const dirtyMcp = Object.keys({ ...initialMcp, ...draftMcp }).some((name) => initialMcp[name] !== draftMcp[name]);
  const dirty = dirtySettings || dirtyMcp;
  const save = () => {
    const changes: Array<{ kind: "setting"; key: string; value: unknown } | { kind: "set-mcp-enabled"; name: string; enabled: boolean }> = [];
    for (const [key, value] of Object.entries(draftSettings)) {
      if (JSON.stringify(initialSettings[key]) !== JSON.stringify(value)) changes.push({ kind: "setting", key, value });
    }
    for (const [name, enabled] of Object.entries(draftMcp)) {
      if (initialMcp[name] !== enabled) changes.push({ kind: "set-mcp-enabled", name, enabled });
    }
    if (changes.length && runtime) onSaveChanges(runtime.runtime, config.id, config.revision, changes);
  };
  const cancel = () => {
    setDraftSettings(initialSettings);
    setDraftMcp(initialMcp);
  };
  return (
    <div class="rcp-root" data-testid="control-runtime-config">
      <PageChrome
        title={s.runtimeConfigTitle}
        hint={s.runtimeConfigHint}
        actions={<Badge tone="ok">Measured editor</Badge>}
      />

      <div class="rcp-toolbar">
        <div class="rcp-toolbar-field">
          <span class="rcp-eyebrow">{s.runtimeConfigRuntime}</span>
          <KitDropdown>
            <KitDropdownTrigger asChild>
              <button
                type="button"
                class="rcp-runtime-select"
                aria-label={s.runtimeConfigRuntime}
                data-testid="runtime-config-runtime-trigger"
              >
                <span class="rcp-runtime-logo"><RuntimeLogo id={activeRuntime.runtime} /></span>
                <span class="rcp-runtime-label">{runtimeLabel(activeRuntime.runtime)}</span>
                <span class="codicon codicon-chevron-down rcp-runtime-chevron" aria-hidden="true" />
              </button>
            </KitDropdownTrigger>
            <KitDropdownContent className="rcp-runtime-menu" align="start">
              {snapshot?.runtimes.map((candidate) => {
                const selected = candidate.runtime === activeRuntime.runtime;
                return (
                  <KitDropdownItem
                    key={candidate.runtime}
                    className="rcp-runtime-option"
                    data-testid={`runtime-config-runtime-${candidate.runtime}`}
                    onSelect={() => {
                      setRuntimeId(candidate.runtime);
                      setDocumentId(candidate.documents[0]?.id ?? "");
                    }}
                  >
                    <span class="rcp-runtime-logo"><RuntimeLogo id={candidate.runtime} /></span>
                    <span>{runtimeLabel(candidate.runtime)}</span>
                    {selected ? <span class="codicon codicon-check rcp-runtime-check" aria-label="Selected" /> : null}
                  </KitDropdownItem>
                );
              })}
            </KitDropdownContent>
          </KitDropdown>
        </div>
        <div class="rcp-toolbar-field">
          <span class="rcp-eyebrow">{s.runtimeConfigScope}</span>
          <div class="rcp-segmented" role="group" aria-label={s.runtimeConfigScope}>
            {runtime?.documents.map((document) => (
              <button type="button" class={document.id === config.id ? "active" : ""} onClick={() => setDocumentId(document.id)}>
                <span class={`codicon codicon-${document.scope === "global" ? "globe" : "folder"}`} /> {documentLabel(document.id)}
              </button>
            ))}
          </div>
        </div>
        <div class="rcp-toolbar-field">
          <span class="rcp-eyebrow">{s.runtimeConfigSourceFile}</span>
          <code class="rcp-toolbar-value rcp-source-value">{config.path}</code>
        </div>
        <div class="rcp-toolbar-action">
          <span class="rcp-eyebrow" aria-hidden="true">&nbsp;</span>
          <Button variant="default" onClick={() => onOpenSource(config.path)}>{s.runtimeConfigOpenFile}</Button>
        </div>
      </div>

      <div class="rcp-impact">
        <span>{s.runtimeConfigUsedBy} (potential)</span>
        <div class="rcp-agent-list">
          {runtime?.potentialAgents.length === 0 ? <span>{s.none}</span> : runtime?.potentialAgents.map((agent) => <Badge key={agent}>{agent}</Badge>)}
        </div>
      </div>
      {(runtime?.pendingAgents?.length ?? 0) > 0 ? <div class="rcp-global-warning" data-testid="runtime-config-pending">
        Current sessions still use the previous source. The next Start, Restart or Resume will apply this change: {runtime!.pendingAgents!.join(", ")}.
      </div> : null}
      {config.impact ? <div class="rcp-global-warning" data-testid="runtime-config-impact">{config.impact}</div> : null}
      {config.scope === "global" && !config.readOnly ? <div class="rcp-global-warning">{s.runtimeConfigGlobalWarning}</div> : null}

      {config.readOnly ? (
        <div class="rcp-actions-bar" role="region" aria-label="Runtime configuration actions">
          <span class="rcp-actions-state" data-testid="runtime-config-read-only">{s.runtimeConfigReadOnlyDocument}</span>
        </div>
      ) : (
        <div class="rcp-actions-bar" role="region" aria-label="Runtime configuration actions">
          <span class="rcp-actions-state" aria-live="polite">{dirty ? "Unsaved changes" : "No pending changes"}</span>
          <div class="rcp-card-actions">
            <Button variant="default" disabled={!dirty} onClick={cancel}>Cancel</Button>
            <Button variant="primary" disabled={!dirty} onClick={save}>{s.runtimeConfigSave}</Button>
          </div>
        </div>
      )}

      <div class="rcp-grid">
        <section class="rcp-card rcp-card--settings">
          <div class="rcp-card-head">
            <div>
              <span class="rcp-eyebrow">{s.runtimeConfigEditable}</span>
              <h2>{runtime ? runtimeLabel(runtime.runtime) : ""} · {documentLabel(config.id)}</h2>
            </div>
            <Badge tone={config.exists ? "ok" : "default"}>{config.exists ? `${config.knownSettings.length} ${s.runtimeConfigConfigured}` : "Not found"}</Badge>
          </div>
          {config.parseError ? <div class="rcp-capability-empty">{s.runtimeConfigReadError}: {config.parseError}</div> : (
            <div class="rcp-setting-list">{config.knownSettings.map((setting) => {
              const boolean = setting.inputKind === "boolean" || setting.key === "tui.status_line_use_colors" || setting.key === "features.terminal_resize_reflow";
              const statusLine = setting.inputKind === "string-list" || setting.key === "tui.status_line";
              const numeric = setting.inputKind === "number";
              const raw = draftSettings[setting.key];
              const value = Array.isArray(raw) ? raw.join(", ") : raw === undefined ? (setting.editable ? "" : setting.value ?? "") : String(raw);
              const readInput = (event: Event) => (event.currentTarget as HTMLInputElement).value;
              return <div class="rcp-setting rcp-setting--editable" key={`${config.id}:${setting.key}`}>
                <label title={setting.readOnlyReason ?? ""}>
                  {settingLabel(setting.key, setting.label)}
                  {setting.shadowedBy ? ` (${s.runtimeConfigOverriddenBy} ${setting.shadowedBy})` : ""}
                  {setting.readOnlyReason ? <span class="rcp-setting-note"> — {setting.readOnlyReason}</span> : null}
                </label>
                <div class="rcp-setting-editor">
                  {boolean ? <input type="checkbox" checked={raw === true} disabled={!setting.editable} onInput={(event) => setDraftSettings((previous) => ({ ...previous, [setting.key]: (event.currentTarget as HTMLInputElement).checked }))} /> : (
                    <input
                      type={numeric ? "number" : "text"}
                      value={value}
                      disabled={!setting.editable}
                      placeholder={setting.editable ? s.runtimeConfigUnset : "Unsupported value"}
                      onInput={(event) => setDraftSettings((previous) => {
                        const text = readInput(event);
                        if (statusLine) return { ...previous, [setting.key]: text.split(",").map((item) => item.trim()).filter(Boolean) };
                        // A non-numeric draft is kept as typed so the measured host validator, not
                        // the field, is what refuses it.
                        if (numeric) return { ...previous, [setting.key]: text.trim() !== "" && Number.isFinite(Number(text)) ? Number(text) : text };
                        return { ...previous, [setting.key]: text };
                      })}
                    />
                  )}
                </div>
              </div>;
            })}</div>
          )}
        </section>

        <section class="rcp-card">
          <div class="rcp-card-head">
            <div>
              <span class="rcp-eyebrow">{s.runtimeConfigCapabilities}</span>
              <h2>MCP servers</h2>
            </div>
          </div>
          <div class="rcp-capability-list">
            {config.mcpServers.length === 0 ? <div class="rcp-capability-empty">{s.none}</div> : config.mcpServers.map((server) => (
              <div class="rcp-capability-item" key={server.name}><div><strong>{server.name}</strong><span>{server.enabled ? "Configured in this source" : "Disabled in this source"}</span></div><label class="rcp-toggle"><input type="checkbox" disabled={server.editable === false} checked={draftMcp[server.name] ?? server.enabled} onInput={(event) => setDraftMcp((previous) => ({ ...previous, [server.name]: (event.currentTarget as HTMLInputElement).checked }))} /> {server.editable === false ? s.runtimeConfigReadOnly : draftMcp[server.name] ?? server.enabled ? "Enabled" : "Disabled"}</label></div>
            ))}
          </div>
        </section>

        <section class="rcp-card rcp-card--other">
          <div class="rcp-card-head">
            <div>
              <span class="rcp-eyebrow">{s.runtimeConfigOther}</span>
              <h2>{config.unknownKeys.length} {s.runtimeConfigDetected}</h2>
              <p>Values stay in the source file. This view lists only keys that are not yet editable in Control.</p>
            </div>
            <Button variant="default" onClick={() => setUnknownOpen((open) => !open)}>
              {s.runtimeConfigViewRaw}
            </Button>
          </div>
          {config.internalStateCount > 0 ? <div class="rcp-runtime-state">{config.internalStateCount} {s.runtimeConfigHiddenRecords}</div> : null}
          {(config.opaqueKeys?.length ?? 0) > 0 ? <div class="rcp-runtime-state">{s.runtimeConfigOpaqueSections}: {config.opaqueKeys!.join(", ")}.</div> : null}
          {config.unknownKeys.length === 0 ? <div class="rcp-capability-empty">{s.none}</div> : unknownOpen ? (
            <pre>{config.unknownKeys.join("\n")}</pre>
          ) : (
            <div class="rcp-other-preview">{config.unknownKeys.slice(0, 8).map((key) => <code key={key}>{key}</code>)}</div>
          )}
        </section>
      </div>
    </div>
  );
}

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
  // SDD 480 Phase 4 — selection and filters are CLIENT state. They are a way of looking, not a fact
  // about the workspace, so they never round-trip to the host and never touch the ledger.
  const [egSelected, setEgSelected] = useState<string | undefined>(undefined);
  const [egFilters, setEgFilters] = useState<{ turnId?: string; state?: string; kind?: string; agentId?: string }>({});
  // Derived, not stored: keeping the detail in state as well as the selection is how the two drift
  // and the panel ends up describing a node that is no longer on screen.
  // Looked up from the VM the host already sent, not rebuilt from a projection the client does not
  // have. Derived rather than stored, so selection and detail cannot drift apart.
  const egDetail = egSelected ? m?.executionGraph?.details[egSelected] : undefined;
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
  } else if (section === "execution-graph") {
    body = (
      <ModuleChrome title={s.executionGraphTitle} hint={s.executionGraphHint}>
        <ExecutionGraphSection
          s={s}
          // A host that serves no ledger yields `no-telemetry`, not an empty diagram: "nothing is
          // recorded here" and "nothing ran" are different answers and only one of them is true.
          vm={m.executionGraph ?? { status: "no-telemetry", nodes: [], edges: [], rows: [], width: 0, height: 0, available: { turnIds: [], states: [], kinds: [], agentIds: [] }, matched: 0, grouped: false, details: {} }}
          detail={egDetail}
          selected={egSelected}
          filters={egFilters}
          onSelect={setEgSelected}
          onFilter={setEgFilters}
        />
      </ModuleChrome>
    );
  } else if (section === "runtime-config") {
    body = <RuntimeConfigInventory s={s} snapshot={p.runtimeConfigSnapshot} unavailable={p.runtimeConfigUnavailable} onOpenSource={p.onOpenRuntimeConfigSource} onSaveChanges={p.onSaveRuntimeConfigChanges} />;
  } else {
    // settings (and any unknown section fallback)
    const companion = m.companion;
    const settingsWsHash = companion?.wsHash ?? m.control.workspaces[0]?.wsHash;
    const settingsWorkspace = m.control.workspaces.find((w) => w.wsHash === settingsWsHash) ?? m.control.workspaces[0];
    // Display path only — openConfigFile still resolves the live file through the host.
    const workspaceSettingsPath = settingsWorkspace
      ? `${settingsWorkspace.workspaceRoot.replace(/[/\\]+$/, "")}/tachyon.yml`
      : "tachyon.yml";
    body = (
      <ModuleChrome title={s.settingsTitle} hint={s.settingsHint} actionLabel={s.settingsDoctor} onAction={p.onOpenDoctor}>
        <div class="ck-panel" data-testid="control-settings">
          {/* t-7b4bb5 — scope split first: two authorities, named paths, no VS Code settings detour. */}
          <p class="ck-settings-intro" data-testid="control-settings-intro">{s.settingsBody}</p>
          <div class="ck-settings-scopes" data-testid="control-settings-scopes">
            <section class="ck-settings-scope" data-testid="control-settings-scope-global" aria-labelledby="ck-settings-scope-global-title">
              <h3 class="ck-settings-scope-title" id="ck-settings-scope-global-title">{s.settingsScopeGlobalTitle}</h3>
              <p class="ck-settings-scope-hint">{s.settingsScopeGlobalHint}</p>
              {m.globalSettings?.file ? (
                <p class="ck-settings-scope-path" data-testid="control-settings-global-path">
                  <span class="ck-settings-scope-path-label">{s.settingsFileLabel}</span>{" "}
                  <code class="ck-settings-path">{m.globalSettings.file}</code>
                </p>
              ) : null}
              <div class="ck-settings-scope-actions">
                <Button variant="default" data-testid="control-settings-open-global" onClick={p.onOpenSettings}>
                  {s.settingsOpenTachyon}
                </Button>
              </div>
            </section>
            <section class="ck-settings-scope" data-testid="control-settings-scope-workspace" aria-labelledby="ck-settings-scope-workspace-title">
              <h3 class="ck-settings-scope-title" id="ck-settings-scope-workspace-title">{s.settingsScopeWorkspaceTitle}</h3>
              <p class="ck-settings-scope-hint">{s.settingsScopeWorkspaceHint}</p>
              <p class="ck-settings-scope-path" data-testid="control-settings-workspace-path">
                <span class="ck-settings-scope-path-label">{s.settingsFileLabel}</span>{" "}
                <code class="ck-settings-path">{workspaceSettingsPath}</code>
              </p>
              <div class="ck-settings-scope-actions">
                <Button
                  variant="default"
                  data-testid="control-settings-open-workspace"
                  onClick={() => p.onOpenConfigFile(settingsWsHash)}
                >
                  {s.settingsOpenConfig}
                </Button>
              </div>
            </section>
          </div>
          {/* SDD 479 phase 4 — compose a card layout and watch the REAL card update (ratified fork 5). */}
          <CardTemplateBlock
            s={s}
            onOpenConfig={() => p.onOpenConfigFile(settingsWsHash)}
            // SDD 479 phase 5 — the personal home is a settings KEY, so its button opens the settings
            // editor filtered to that key rather than a file.
            onOpenSettings={() => p.onPost(openPersonalCardTemplateAction())}
            inEffect={m.cardTemplate}
          />

          {m.globalSettings ? <GlobalSettingsBlock s={s} settings={m.globalSettings} onPost={p.onPost} /> : null}

          {/* t-aaad95 (visual QA) — the second workspace card is GONE. It repeated the "Workspace
            * (project)" scope card verbatim 1400px above it: same file path, same button, overlapping
            * hint. Two cards for one authority taught the reader to check whether they differed. Its
            * one unique sentence — which knobs live in the yml — moved into the scope card's hint. */}
          {m.idleNotify ? <IdleNotifyField s={s} idle={m.idleNotify} onSave={p.onSetIdleAfterMinutes} /> : null}

          <div class="ck-settings-block" data-testid="control-settings-companion">
            <h3 class="ck-settings-block-title">{s.companionTitle}</h3>
            <WritesTo s={s} file="workspace" />
            <p class="ck-settings-block-hint">{s.companionHint}</p>
            {m.companionNeedsWorkspacePick ? (
              <p class="ck-settings-block-body dim">{s.companionPickWorkspace}</p>
            ) : companion ? (
              <>
                <p class="ck-settings-block-body">{s.companionBody}</p>
                <label class="ck-settings-toggle">
                  <input
                    type="checkbox"
                    checked={companion.tabTools}
                    data-testid="companion-tab-tools-toggle"
                    onChange={(e) =>
                      p.onSetCompanionTabTools(companion.wsHash, (e.target as HTMLInputElement).checked)
                    }
                  />
                  <span>
                    <strong>{s.companionTabTools}</strong>
                    <span class="ck-settings-toggle-help">{s.companionTabToolsHelp}</span>
                  </span>
                </label>
                <CompanionAllowedHostsField
                  s={s}
                  wsHash={companion.wsHash}
                  allowedHosts={companion.allowedHosts}
                  onSave={p.onSetCompanionAllowedHosts}
                />
                <div class="ck-settings-status" data-testid="companion-pair-status">
                  <span class={`ck-badge ${companion.paired ? "ok" : "muted"}`}>
                    {companion.paired ? s.companionPaired : s.companionNotPaired}
                  </span>
                  {companion.baseUrl ? (
                    <span class="ck-mono" title={s.companionBaseUrl}>
                      {companion.baseUrl}
                    </span>
                  ) : null}
                  <span class="dim">{companion.folderName}</span>
                </div>

                <div class="ck-pair-actions" data-testid="companion-pair-actions">
                  <Button
                    variant="default"
                    data-testid="companion-show-pair-code"
                    onClick={() => p.onIssueCompanionPairCode(companion.wsHash)}
                  >
                    {s.companionShowPairCode}
                  </Button>
                  {companion.baseUrl ? (
                    <Button
                      variant="default"
                      data-testid="companion-copy-base-url"
                      onClick={() => p.onCopyText(companion.baseUrl!)}
                    >
                      {s.companionCopyBaseUrl}
                    </Button>
                  ) : null}
                </div>
                {p.companionPairOffer ? (
                  <CompanionPairOfferCard
                    s={s}
                    offer={p.companionPairOffer}
                    onCopyText={p.onCopyText}
                    onNewCode={() => p.onIssueCompanionPairCode(companion.wsHash)}
                  />
                ) : null}

                <div class="ck-settings-block ck-settings-block-nested" data-testid="control-settings-devices">
                  <h3 class="ck-settings-block-title">{s.devicesTitle}</h3>
                  <p class="ck-settings-block-hint">{s.devicesHint}</p>
                  {companion.devices.length === 0 ? (
                    <p class="ck-settings-block-body dim" data-testid="companion-devices-empty">
                      {s.devicesEmpty}
                    </p>
                  ) : (
                    <ul class="ck-device-list">
                      {companion.devices.map((d) => (
                        <li key={d.id} class="ck-device-row" data-testid="companion-device-row">
                          <div class="ck-device-main">
                            <div class="ck-device-name">
                              <strong>{d.name}</strong>
                              {d.version ? <span class="dim"> · {d.version}</span> : null}
                            </div>
                            <div class="ck-device-meta">
                              <span class="dim">
                                {d.kind === "mobile" ? s.devicesKindMobile : s.devicesKindBrowser}
                              </span>
                              <span class={`ck-badge ${d.live ? "ok" : "muted"}`}>
                                {d.live ? s.devicesLive : s.devicesOffline}
                              </span>
                              {d.pairedAt ? (
                                <span class="dim" title={d.pairedAt}>
                                  {s.devicesPairedAt} {d.pairedAt.slice(0, 19).replace("T", " ")}
                                </span>
                              ) : null}
                            </div>
                          </div>
                          <Button
                            variant="default"
                            data-testid="companion-device-unpair"
                            onClick={() => p.onUnpairCompanionDevice(companion.wsHash, d.id)}
                          >
                            {s.devicesUnpair}
                          </Button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </>
            ) : (
              <p class="ck-settings-block-body dim">{s.empty}</p>
            )}
          </div>
        </div>
      </ModuleChrome>
    );
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
