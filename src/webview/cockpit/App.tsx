import type { ComponentChildren } from "preact";
import { lazy, Suspense } from "preact/compat";
import { useEffect, useRef, useState } from "preact/hooks";
import {
  COCKPIT_SECTION_ORDER,
  type CockpitModel,
  type CockpitSectionId,
  type CockpitWorktreeRow,
} from "../../cockpit/model";
import { parentRoute, isStudioRoute, routeKey } from "../../cockpit/route";
import type { ControlInspectorWorkspaceRow } from "../../control-inspector/model";
import {
  formatCompanionPairClipboard,
  navigateReturnAction,
  type CockpitAction,
  type CockpitStrings,
  type CompanionPairOffer,
} from "./messages";
import { EngineLogPanel } from "./EngineLogPanel";
import { Button, Badge, ListRow, PageChrome, EmptyState } from "../shared/ui";
import { KitSelect } from "../shared/ui/kit";
import { loadSectionStylesheet } from "../shared/lazySectionStyles";
import type { MissionControlDispatch, TaskErrorEvent } from "../mission-control/App";
import type { MissionControlVM } from "../mission-control/messages";
import type { TaskDetailDispatch } from "../task-detail/App";
import type { TaskDetailVM } from "../task-detail/messages";
import type { ActivityDispatch } from "../activity/App";
import type { ActivityViewModel } from "../../activity/activityView";
import type { ProbesVM } from "../probes/messages";
import type { HandoffDispatch } from "../handoff/App";
import type { HandoffViewModel } from "../handoff/handoffViewModel";
import type { ValidationsDispatch } from "../validations/App";
import type { ValidationsViewModel } from "../validations/viewModel";
import type { ApprovalDispatch } from "../approval/App";
import type { ApprovalViewModel } from "../approval/viewModel";
import type { RuntimeOpsProviderV2, RuntimeOpsSnapshot } from "../../runtimeOps/types";
import type { InspectorAppProps } from "../inspector/App";
import type { PluginsDispatch } from "../plugins/App";
import type { PluginsViewModel } from "../../plugins/viewModel";
import type { ConsentVM } from "../../plugins/consentViewModel";
import type { Toast as PluginsToast } from "../plugins/messages";
import type { StudioDispatch } from "../shared/studio/protocol";

// spec 410 — lazy section bodies (ESM chunks). Keeps eager cockpit.js under budget.
// t-610705 (Phase B #6) — CSS co-load, sixth surface (see the Approvals comment below for the
// mechanism); two sheets (Tailwind layer + base) share the chunk, like Plugins.
const MissionControlApp = lazy(() =>
  import("../mission-control/App").then((m) => {
    loadSectionStylesheet("mission-tailwind");
    loadSectionStylesheet("mission");
    return { default: m.App };
  }),
);
// t-610705 (Phase C.1) — CSS co-load, seventh surface: the task-detail subroute of Mission (its own
// sheet plus the mermaid-block sheet its body's MarkdownView can render).
const TaskDetailApp = lazy(() =>
  import("../task-detail/App").then((m) => {
    loadSectionStylesheet("task-detail-mermaid");
    loadSectionStylesheet("task-detail");
    return { default: m.App };
  }),
);
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
// t-610705 — CSS co-load, second surface (see the Approvals comment above for the mechanism).
const RuntimeOpsApp = lazy(() =>
  import("../runtime-ops/App").then((m) => {
    loadSectionStylesheet("runtime");
    return { default: m.App };
  }),
);
// t-610705 — CSS co-load, fourth surface; two sheets (base + its Tailwind utility layer) share the
// section id's chunk, so both load via distinct bootstrap-global keys off one lazy-import resolve.
const PluginsApp = lazy(() =>
  import("../plugins/App").then((m) => {
    loadSectionStylesheet("plugins-tailwind");
    loadSectionStylesheet("plugins");
    return { default: m.App };
  }),
);
// t-610705 (SDD 410 Phase B #5) — CSS co-load, fifth surface (see the Approvals comment above for
// the mechanism). Also retires the tmux Server Inspector's standalone dual-path: Cockpit.ts already
// builds and handles the tmux model/actions independently of ServerInspector.ts (spec 410 Phase B #5).
const InspectorApp = lazy(() =>
  import("../inspector/App").then((m) => {
    loadSectionStylesheet("tmux");
    return { default: m.App };
  }),
);
// t-610705 (Phase C.2) — CSS co-load, eighth surface: the agent-activity subroute of Fleet. Shares
// the mermaid-block.css sheet with task-detail (see Cockpit.ts's combined eager-styles condition)
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
// task-detail/activity above).
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
// (task-detail-mermaid/activity-mermaid/handoff-mermaid, all → mermaid-block.css): cockpitCssParity's
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

function SectionFallback() {
  return <EmptyState kind="loading" message="Loading…" />;
}

/** t-d16a39 — non-empty UI sentinel for "All workspaces" (Radix Select forbids value=""). */
const ALL_WORKSPACES = "__all__";

export interface CockpitAppProps {
  model: CockpitModel | undefined;
  strings: CockpitStrings | undefined;
  toast?: string;
  auto: boolean;
  onToggleAuto: (on: boolean) => void;
  onRefresh: () => void;
  onCopyDiagnostics: () => void;
  onOpenSettings: () => void;
  onOpenDoctor: () => void;
  onSetSection: (section: CockpitSectionId) => void;
  /** t-d16a39 — shell-level workspace scope; "" = All workspaces. */
  onSwitchWorkspace: (wsHash: string) => void;
  onFleetStart: (name: string, wsHash?: string) => void;
  onFleetStop: (name: string, wsHash?: string) => void;
  onFleetTerminal: (name: string, wsHash?: string) => void;
  onFleetActivity: (name: string, wsHash?: string) => void;
  /** t-610705 (Phase D, D1c) — Fleet's own Probes/Edit buttons (previously only reachable via the
   *  agent-less `tachyon.openProbes` command / the sidebar tree's context menu). */
  onFleetProbes: (name: string, wsHash?: string) => void;
  onFleetAgentStudio: (name: string, wsHash?: string) => void;
  onRevealPath: (path: string) => void;
  onCopyText: (text: string) => void;
  onOpenConfigFile: (wsHash?: string) => void;
  /** SDD 414 — settings.companion.tabTools for the scoped workspace. */
  onSetCompanionTabTools: (wsHash: string, enabled: boolean) => void;
  /** SDD 420 — settings.companion.allowedHosts for the scoped workspace. */
  onSetCompanionAllowedHosts: (wsHash: string, hosts: string[]) => void;
  /** SDD 414/422 — host unpair; deviceId clears one row, omit clears all. */
  onUnpairCompanionDevice: (wsHash: string, deviceId?: string) => void;
  /** SDD 414 — mint pair code (result arrives as companionPairOffer prop). */
  onIssueCompanionPairCode: (wsHash: string) => void;
  /** Ephemeral pair offer from host (not polled model). */
  companionPairOffer?: CompanionPairOffer;
  /** Low-level post for Engine log actions (clear/journal/copy). */
  onPost: (action: CockpitAction) => void;
  /** Embedded Mission Control board (same Preact App as the standalone panel). */
  missionVm?: MissionControlVM;
  missionError?: TaskErrorEvent;
  missionDispatch: MissionControlDispatch;
  /** t-610705 (Phase C.1) — the task-detail subroute of Mission (model.activeRoute drives which). */
  taskVm?: TaskDetailVM;
  taskErrorSeq: number;
  taskErrorMessage?: string;
  taskDetailDispatch: TaskDetailDispatch;
  /** t-610705 (Phase C.2) — the agent-activity subroute of Fleet. */
  activityVm?: ActivityViewModel;
  activityPrepended: boolean;
  activityImages: Record<string, string>;
  activityDispatch: ActivityDispatch;
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
  runtimeSnapshot?: RuntimeOpsSnapshot;
  onRuntimeSetProviderObservation: (provider: RuntimeOpsProviderV2, enabled: boolean) => void;
  inspector: Pick<
    InspectorAppProps,
    "model" | "strings" | "captures" | "open" | "auto" | "onToggleAuto" | "onToggleCapture" | "onCloseCapture" | "onAction"
  >;
  pluginsVm?: PluginsViewModel;
  pluginsConsent?: ConsentVM;
  pluginsBusy?: string;
  pluginsToast?: PluginsToast;
  pluginsDispatch: PluginsDispatch;
  /** t-610705 (Phase D, D0/D1a) — the studio-new/studio-edit subroute (fleet/... — command, terminal,
   *  runbook, schedule). The studio App receives raw protocol/nav-transaction messages, not a
   *  decoded VM — see command-studio-shell/App.tsx's own doc comment for why. `studioDispatch` is
   *  ONE shared prop for every StudioId (D1a — was `commandStudioDispatch: CommandStudioDispatch`,
   *  D0's studio-specific name/type for what turned out to be an identical `{post}` wrapper every
   *  studio needs): only one studio binding is ever active at a time, so there is nothing to
   *  disambiguate between studios on this prop the way there is for e.g. `taskVm`/`activityVm`. */
  studioIncoming?: { seq: number; message: unknown };
  studioDispatch: StudioDispatch;
}

/** Tabs that host a full product surface (no ModuleChrome table / deep-link stub). */
const EMBED_SECTIONS = new Set<CockpitSectionId>(["mission", "validations", "handoff", "approvals", "runtime", "tmux", "plugins"]);

const TAB_META: Record<CockpitSectionId, { icon: string; navKey: keyof CockpitStrings }> = {
  overview: { icon: "dashboard", navKey: "navOverview" },
  engine: { icon: "server-environment", navKey: "navEngine" },
  fleet: { icon: "organization", navKey: "navFleet" },
  approvals: { icon: "pass", navKey: "navApprovals" },
  mission: { icon: "checklist", navKey: "navMission" },
  validations: { icon: "checklist", navKey: "navValidations" },
  handoff: { icon: "book", navKey: "navHandoff" },
  worktrees: { icon: "folder-library", navKey: "navWorktrees" },
  deliveries: { icon: "git-commit", navKey: "navDeliveries" },
  runtime: { icon: "graph", navKey: "navRuntime" },
  tmux: { icon: "terminal-tmux", navKey: "navTmux" },
  plugins: { icon: "extensions", navKey: "navPlugins" },
  settings: { icon: "settings-gear", navKey: "navSettings" },
};

function StateBadge({ s, state }: { s: CockpitStrings; state: "attached" | "error" | "none" }) {
  const label = state === "attached" ? s.attached : state === "error" ? s.error : s.none;
  const tone = state === "attached" ? "ok" : state === "error" ? "err" : "default";
  return <Badge tone={tone}>{label}</Badge>;
}

function Kv({ k, v }: { k: string; v?: string | number | null }) {
  if (v === undefined || v === null || v === "") return null;
  return (
    <>
      <span class="k">{k}</span>
      <span class="v">{String(v)}</span>
    </>
  );
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

function WorkspaceCard({
  s,
  row,
  onPost,
}: {
  s: CockpitStrings;
  row: ControlInspectorWorkspaceRow;
  onPost: (a: CockpitAction) => void;
}) {
  return (
    <section class="ci-ws">
      <div class="ci-ws-head">
        <div>
          <div class="name">{row.folderName}</div>
          <div class="meta">{row.wsHash}</div>
        </div>
        <StateBadge s={s} state={row.engine.state} />
      </div>
      <div class="ci-grid">
        <div class="ci-card">
          <h3>
            <span class="codicon codicon-server-environment" /> Engine
          </h3>
          <div class="ci-kv">
            <Kv k={s.state} v={row.engine.state} />
            <Kv k={s.pid} v={row.engine.pid} />
            <Kv
              k={s.version}
              v={[row.engine.engineVersion, row.engine.channel].filter(Boolean).join(" · ") || undefined}
            />
            <Kv k={s.instance} v={row.engine.instanceId} />
            <Kv k={s.started} v={row.engine.startedAt} />
            <Kv k={s.bundle} v={row.engine.bundleId} />
            <Kv
              k={s.protocol}
              v={
                row.engine.protocolMin !== undefined && row.engine.protocolMax !== undefined
                  ? `${row.engine.protocolMin}…${row.engine.protocolMax}`
                  : undefined
              }
            />
            <Kv k={s.error} v={row.engine.error} />
          </div>
        </div>
        <div class="ci-card">
          <h3>
            <span class="codicon codicon-plug" /> Bridge
          </h3>
          <div class="ci-kv">
            <Kv k={s.url} v={row.bridge.url} />
            <Kv k={s.port} v={row.bridge.port} />
            <Kv k={s.instance} v={row.bridge.instanceId} />
            <Kv k={s.auth} v={row.bridge.authConfigured === undefined ? undefined : String(row.bridge.authConfigured)} />
          </div>
        </div>
        <div class="ci-card">
          <h3>
            <span class="codicon codicon-folder" /> Workspace
          </h3>
          <div class="ci-kv">
            <Kv k={s.root} v={row.workspaceRoot} />
            <Kv k={s.hash} v={row.wsHash} />
            <Kv k={s.agents} v={row.agents ? `${row.agents.running}/${row.agents.total} ${s.running}` : undefined} />
          </div>
        </div>
      </div>
      <EngineLogPanel row={row} post={onPost} />
    </section>
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

/** spec 444 — hygiene classification groups, in action-priority order. */
const WT_GROUPS = ["ready-to-remove", "needs-review", "occupied", "record-only"] as const;
type WtGroup = (typeof WT_GROUPS)[number];
const WT_RECORD_COLLAPSE_AT = 4;

/** Fail-closed: a row the engine did not classify is NEVER treated as safe. */
function wtGroupOf(row: CockpitWorktreeRow): WtGroup {
  return row.classification?.state ?? "needs-review";
}

function WtGroupHead({ group, title, count, action }: { group: WtGroup; title: string; count: number; action?: ComponentChildren }) {
  return (
    <div class="ck-wt-group-head">
      <span class={`ck-wt-dot ck-wt-dot-${group}`} aria-hidden="true" />
      <span class="ck-wt-group-title">{title}</span>
      <span class="ck-wt-group-count">{count}</span>
      {action ? <span class="ck-wt-group-action">{action}</span> : null}
    </div>
  );
}

/**
 * spec 444 — the Worktrees tab body: classification-grouped rows, per-row blocked reasons, gated
 * actions, and batch cleanup restricted to the two provably-safe groups. All destructive dispatch
 * goes through `onPost` to the host, where the engine re-validates fail-closed per call.
 */
function WorktreesHygiene({
  s,
  rows,
  unavailable,
  onRevealPath,
  onCopyText,
  onPost,
}: {
  s: CockpitStrings;
  rows: CockpitWorktreeRow[];
  unavailable?: Array<{ folder: string; reason: string }>;
  onRevealPath: (path: string) => void;
  onCopyText: (text: string) => void;
  onPost: (action: CockpitAction) => void;
}) {
  const [selected, setSelected] = useState<Record<string, "remove" | "forget">>({});
  const [confirming, setConfirming] = useState(false);
  const [showAllRecords, setShowAllRecords] = useState(false);
  const [branchConsent, setBranchConsent] = useState<Record<string, boolean>>({});

  const byGroup = new Map<WtGroup, CockpitWorktreeRow[]>(WT_GROUPS.map((g) => [g, []]));
  for (const row of rows) byGroup.get(wtGroupOf(row))!.push(row);
  // Selection survives model refreshes only while the row is still in its safe group.
  const stillSafe = (id: string, op: "remove" | "forget"): boolean => {
    const row = rows.find((r) => r.id === id);
    return !!row && wtGroupOf(row) === (op === "remove" ? "ready-to-remove" : "record-only");
  };
  const selection = Object.entries(selected).filter(([id, op]) => stillSafe(id, op));
  const toggle = (id: string, op: "remove" | "forget") =>
    setSelected((prev) => {
      const next = { ...prev };
      if (next[id]) delete next[id];
      else next[id] = op;
      return next;
    });
  const selectAll = (group: "ready-to-remove" | "record-only", op: "remove" | "forget") =>
    setSelected((prev) => {
      const next = { ...prev };
      for (const row of byGroup.get(group)!) next[row.id] = op;
      return next;
    });
  const runBatch = () => {
    onPost({
      type: "worktreeBatchCleanup",
      items: selection.map(([id, op]) => {
        const row = rows.find((r) => r.id === id);
        return { id, op, ...(row?.wsHash ? { wsHash: row.wsHash } : {}) };
      }),
    });
    setSelected({});
    setConfirming(false);
  };

  const groupMeta: Record<WtGroup, { title: string; desc: string }> = {
    "ready-to-remove": { title: s.wtReadyTitle, desc: s.wtReadyDesc },
    "needs-review": { title: s.wtReviewTitle, desc: s.wtReviewDesc },
    occupied: { title: s.wtOccupiedTitle, desc: s.wtOccupiedDesc },
    "record-only": { title: s.wtRecordTitle, desc: s.wtRecordDesc },
  };

  const renderRow = (row: CockpitWorktreeRow, group: WtGroup) => {
    const reasons = row.classification?.reasons ?? [];
    const selectable = group === "ready-to-remove" || group === "record-only";
    const op: "remove" | "forget" = group === "ready-to-remove" ? "remove" : "forget";
    const occupant = row.classification?.occupant;
    return (
      <ListRow
        key={row.id}
        leading={
          selectable ? (
            <input
              type="checkbox"
              class="ck-wt-check"
              checked={!!selected[row.id]}
              onChange={() => toggle(row.id, op)}
              aria-label={`${row.slug || row.agent || row.id}`}
            />
          ) : undefined
        }
        title={
          <>
            <span class="name">{row.slug || row.agent || row.id}</span>
            <Badge tone={row.status === "active" ? "ok" : "default"}>{row.status}</Badge>
            <Badge>{row.kind === "agent" ? s.agent : row.kind === "change" ? s.change : row.kind}</Badge>
          </>
        }
        meta={
          <>
            {row.branch ? (
              <span>
                {s.branch}: <span class="ck-mono">{row.branch}</span>
              </span>
            ) : null}
            {row.folder ? <span>{row.folder}</span> : null}
            {group === "occupied" && occupant ? (
              <span class="ck-wt-reason-occupied">
                {s.wtOccupiedBy} <b>{occupant.agent}</b> ({occupant.state})
              </span>
            ) : null}
            {group === "needs-review" && reasons.length > 0 ? (
              <span class="ck-wt-reason-warn">⚠ {reasons.join("; ")}</span>
            ) : null}
            {group === "record-only" ? <span class="ck-wt-reason-muted">{reasons.join("; ")}</span> : null}
          </>
        }
        detail={group !== "record-only" && row.path ? <span class="ck-mono">{row.path}</span> : undefined}
        actions={
          group === "record-only" ? (
            <Button variant="default" onClick={() => onPost({ type: "worktreeForgetRecord", id: row.id, ...(row.wsHash ? { wsHash: row.wsHash } : {}) })}>
              {s.wtForgetRecord}
            </Button>
          ) : group === "ready-to-remove" ? (
            <>
              {row.tachyonCreatedBranch ? (
                <label class="ck-wt-branch-consent">
                  <input
                    type="checkbox"
                    checked={!!branchConsent[row.id]}
                    onChange={() => setBranchConsent((prev) => ({ ...prev, [row.id]: !prev[row.id] }))}
                  />
                  {s.wtAlsoDeleteBranch}
                </label>
              ) : null}
              <Button
                variant="default"
                onClick={() =>
                  onPost({
                    type: "worktreeRemove",
                    id: row.id,
                    ...(branchConsent[row.id] ? { deleteBranch: true } : {}),
                    ...(row.wsHash ? { wsHash: row.wsHash } : {}),
                  })
                }
              >
                {s.wtRemoveCheckout}
              </Button>
              <Button variant="default" onClick={() => onRevealPath(row.path)}>
                {s.reveal}
              </Button>
            </>
          ) : (
            <>
              <Button variant="default" disabled title={`${s.wtBlocked}: ${reasons.join("; ") || group}`}>
                {s.wtRemoveCheckout}
              </Button>
              {row.path ? (
                <>
                  <Button variant="default" onClick={() => onRevealPath(row.path)}>
                    {s.reveal}
                  </Button>
                  <Button variant="default" onClick={() => onCopyText(row.path)}>
                    {s.copyPath}
                  </Button>
                </>
              ) : null}
            </>
          )
        }
      />
    );
  };

  const recordRows = byGroup.get("record-only")!;
  const visibleRecords = showAllRecords ? recordRows : recordRows.slice(0, WT_RECORD_COLLAPSE_AT);

  return (
    <div data-testid="control-worktrees">
      {unavailable && unavailable.length > 0 ? (
        <div class="ck-wt-unavailable" role="alert">
          {s.wtEngineUnavailable}
          {unavailable.map((u) => (
            <div key={u.folder} class="ck-mono ck-wt-unavailable-detail">
              {u.folder}: {u.reason}
            </div>
          ))}
        </div>
      ) : null}
      {rows.length === 0 && (!unavailable || unavailable.length === 0) ? (
        <EmptyState kind="empty" message={s.noneListed} />
      ) : null}
      {WT_GROUPS.map((group) => {
        const groupRows = group === "record-only" ? visibleRecords : byGroup.get(group)!;
        const total = byGroup.get(group)!.length;
        if (total === 0) return null;
        return (
          <section key={group} class="ck-wt-group">
            <WtGroupHead
              group={group}
              title={groupMeta[group].title}
              count={total}
              action={
                group === "ready-to-remove" || group === "record-only" ? (
                  <Button variant="default" onClick={() => selectAll(group, group === "ready-to-remove" ? "remove" : "forget")}>
                    {s.wtSelectAll}
                  </Button>
                ) : undefined
              }
            />
            <p class="ck-wt-group-desc">{groupMeta[group].desc}</p>
            <div class="ck-card-list">
              {groupRows.map((row) => renderRow(row, group))}
              {group === "record-only" && !showAllRecords && recordRows.length > WT_RECORD_COLLAPSE_AT ? (
                <button class="ck-wt-show-all" onClick={() => setShowAllRecords(true)}>
                  {s.wtShowAll} ({recordRows.length})
                </button>
              ) : null}
            </div>
          </section>
        );
      })}
      {selection.length > 0 && !confirming ? (
        <div class="ck-wt-batch-bar">
          <span>
            <b>{selection.length}</b> {s.wtSelected}
          </span>
          <Button variant="default" onClick={() => setSelected({})}>
            {s.wtClearSelection}
          </Button>
          <Button variant="primary" onClick={() => setConfirming(true)}>
            {s.wtReviewConfirm}
          </Button>
        </div>
      ) : null}
      {confirming && selection.length > 0 ? (
        <div class="ck-wt-confirm" role="dialog" aria-modal="true">
          <div class="ck-wt-confirm-card">
            <h3>{s.wtConfirmTitle}</h3>
            <p>{s.wtConfirmBody}</p>
            <ul>
              {selection.map(([id, op]) => {
                const row = rows.find((r) => r.id === id);
                return (
                  <li key={id}>
                    {row?.slug || row?.agent || id} — {op === "remove" ? s.wtRemoveCheckout : s.wtForgetRecord}
                  </li>
                );
              })}
            </ul>
            <div class="ck-wt-confirm-actions">
              <Button variant="default" onClick={() => setConfirming(false)}>
                {s.wtCancel}
              </Button>
              <Button variant="primary" onClick={runBatch}>
                {s.wtConfirmRun}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function App(p: CockpitAppProps) {
  // t-610705 (Phase C.2) — declared BEFORE the `!s` early return below so this hook always runs in
  // the same order every render (the Activity subroute needs the actual overflow:auto ancestor for
  // its scroll math — window/document.body no longer work now that the standalone panel is retired).
  const activityScrollRef = useRef<HTMLDivElement>(null);
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
  const isEmbed = EMBED_SECTIONS.has(section) || isFleetSubroute || isStudioSubroute;
  // t-610705 (Phase D, D3) — pin is nav-less (navSection: null — route.ts): `section` above already
  // falls back to "overview" (the same fallback Cockpit.ts's host uses for background-data purposes),
  // but "overview" IS a real, clickable tab — without this, it would incorrectly render as visually
  // active while Pin Studio is open. Suppressed here, client-side only; deliberately NOT threaded
  // through `model.section` itself (design-dueto probe-43bca1cc minor finding: coercing null to
  // "overview" anywhere but a background-data fallback would make nav-less state indistinguishable
  // from "Overview is genuinely active").
  const isNavlessStudio = !!activeRoute && isStudioRoute(activeRoute) && activeRoute.studio === "pin";
  // t-fullpage-proto — every subroute (task-detail, the 3 Fleet subroutes, all 7 studios) gets the
  // SAME fullpage chrome: the section tab strip is replaced by a single minimal "← Back" row at the
  // very top, and the content area gets the vertical space the tab strip would have used. Each
  // branch below sets `breadcrumb` to the exact same back-link it already computed for its own
  // inline placement — this only changes WHERE it renders, not the navigation logic itself.
  const isSubroute = activeRoute?.kind === "task-detail" || isFleetSubroute || isStudioSubroute;
  let breadcrumb: ComponentChildren = null;

  let body: ComponentChildren = null;
  if (!m) {
    body = <div class="ck-empty">{s.empty}</div>;
  } else if (activeRoute?.kind === "task-detail") {
    // t-610705 (Phase C.1) — a subroute of Mission: same embed host styling as the board (checked
    // BEFORE the section branch below, since model.section still reads "mission" here — navSection
    // keeps the Mission tab highlighted while this subroute is what's actually on screen).
    const parent = parentRoute(activeRoute);
    // t-610705 (Phase C.1) — a lone back-link, not a full "parent / current" trail: the task's own
    // title already renders right below as the page H1 (PageChrome), so repeating it here would just
    // be the same text twice with nothing between them.
    if (parent && parent.kind === "section") {
      breadcrumb = (
        <Button variant="default" icon="arrow-left" class="ck-top-breadcrumb-btn" data-testid="control-task-detail-breadcrumb" onClick={() => p.onSetSection(parent.section)}>
          {s.navMission}
        </Button>
      );
    }
    body = (
      <div class="ck-embed-host" data-testid="control-task-detail">
        <Suspense fallback={<SectionFallback />}>
          <TaskDetailApp vm={p.taskVm} errorSeq={p.taskErrorSeq} errorMessage={p.taskErrorMessage} dispatch={p.taskDetailDispatch} />
        </Suspense>
      </div>
    );
  } else if (activeRoute?.kind === "agent-activity" || activeRoute?.kind === "agent-probes" || activeRoute?.kind === "workspace-probes") {
    // t-610705 (Phase C.2) — Fleet subroutes: same "checked before the section branch" reasoning as
    // task-detail above (nav section reads "fleet" for all three; this renders the actual content).
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
            <ActivityApp vm={p.activityVm} prepended={p.activityPrepended} images={p.activityImages} dispatch={p.activityDispatch} scrollContainer={activityScrollRef} />
          ) : (
            <ProbesApp vm={p.probesVm} />
          )}
        </Suspense>
      </div>
    );
  } else if (activeRoute && isStudioRoute(activeRoute)) {
    // t-610705 (Phase D, D0/D1a) — a studio route is its own full-bleed body (StudioFrame is its own
    // chrome: title, dirty dot, Cancel/Save) — same "checked before the section branch" pattern as
    // task-detail/Fleet subroutes above. D1b/D2/D3 add their own branch the same way (no generic
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
      // task's own task-detail subroute) — reuses taskDetailDispatch's existing "openTask" round trip
      // (the SAME one Task Detail's own breadcrumb and the Board's card-click already navigate
      // through) rather than inventing a new generic route-navigate prop for this one case.
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
        onClick={() => (m.studioPersisted === false ? p.onSetSection("mission") : p.taskDetailDispatch.openTask(parent.taskId))}
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
          <div class={`ck-metric ${o.approvalsPending > 0 ? "warn" : ""}`}>
            <div class="label">{s.approvals}</div>
            <div class="value">{o.approvalsPending}</div>
          </div>
          <div class="ck-metric">
            <div class="label">{s.worktrees}</div>
            <div class="value">{o.worktreesActive}</div>
          </div>
          <div class="ck-metric">
            <div class="label">{s.deliveries}</div>
            <div class="value">{o.deliveriesOpen}</div>
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
            <Button variant="default" onClick={() => p.onSetSection("approvals")}>
              {s.navApprovals}
            </Button>
            <Button variant="default" onClick={() => p.onSetSection("mission")}>
              {s.navMission}
            </Button>
            <Button variant="default" onClick={() => p.onSetSection("validations")}>
              {s.navValidations}
            </Button>
            <Button variant="default" onClick={() => p.onSetSection("handoff")}>
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
  } else if (section === "engine") {
    body = (
      <ModuleChrome title={s.engineTitle} hint="Control plane per attached workspace." actionLabel={s.openDoctor} onAction={p.onOpenDoctor}>
        {m.control.workspaces.length === 0 ? (
          <div class="ck-empty">{s.empty}</div>
        ) : (
          m.control.workspaces.map((row) => (
            <WorkspaceCard key={row.wsHash + row.workspaceRoot} s={s} row={row} onPost={p.onPost} />
          ))
        )}
      </ModuleChrome>
    );
  } else if (section === "fleet") {
    body = (
      <ModuleChrome title={s.fleetTitle} hint={s.fleetHint} actionLabel={s.openMissionControl} onAction={() => p.onSetSection("mission")}>
        {m.fleet.length === 0 ? (
          <EmptyState kind="empty" message={s.noneListed} />
        ) : (
          <div class="ck-card-list" data-testid="control-fleet">
            {m.fleet.map((a) => (
              <ListRow
                key={`${a.wsHash ?? ""}:${a.name}`}
                title={
                  <>
                    <span class="name">{a.name}</span>
                    <Badge tone={a.running ? "ok" : "default"}>{a.running ? s.running : s.stopped}</Badge>
                    {a.declared === false ? <Badge tone="info">{s.adhoc}</Badge> : <Badge>{s.declared}</Badge>}
                    {a.kind ? <Badge>{a.kind}</Badge> : null}
                  </>
                }
                meta={
                  <>
                    {a.folder ? <span>{a.folder}</span> : null}
                    {a.wsHash ? <span class="ck-mono">{a.wsHash.slice(0, 8)}</span> : null}
                  </>
                }
                actions={
                  <>
                    {a.running ? (
                      <Button variant="default" onClick={() => p.onFleetStop(a.name, a.wsHash)}>
                        {s.stop}
                      </Button>
                    ) : (
                      <Button variant="default" onClick={() => p.onFleetStart(a.name, a.wsHash)}>
                        {s.start}
                      </Button>
                    )}
                    <Button variant="default" onClick={() => p.onFleetTerminal(a.name, a.wsHash)}>
                      {s.openTerminal}
                    </Button>
                    <Button variant="default" onClick={() => p.onFleetActivity(a.name, a.wsHash)}>
                      {s.openActivity}
                    </Button>
                    <Button variant="default" onClick={() => p.onFleetProbes(a.name, a.wsHash)}>
                      {s.openProbes}
                    </Button>
                    {a.declared !== false ? (
                      <Button variant="default" onClick={() => p.onFleetAgentStudio(a.name, a.wsHash)}>
                        {s.editAgent}
                      </Button>
                    ) : null}
                  </>
                }
              />
            ))}
          </div>
        )}
      </ModuleChrome>
    );
  } else if (section === "approvals") {
    body = (
      <div class="ck-embed-host" data-testid="control-approvals">
        <Suspense fallback={<SectionFallback />}>
          <ApprovalsApp vm={p.approvalVm} error={p.approvalError} dispatch={p.approvalDispatch} />
        </Suspense>
      </div>
    );
  } else if (section === "mission") {
    // Visual monolith POC: full Mission Control board in-tab (same App + host actions as standalone).
    // t-b87bfe: Validations live on the dedicated Control → Validations tab (not on the task board).
    body = (
      <div class="ck-embed-host ck-mission-host" data-testid="control-mission-board">
        <Suspense fallback={<SectionFallback />}>
          <MissionControlApp vm={p.missionVm} lastError={p.missionError} dispatch={p.missionDispatch} />
        </Suspense>
      </div>
    );
  } else if (section === "validations") {
    body = (
      <div class="ck-embed-host" data-testid="control-validations-host">
        <Suspense fallback={<SectionFallback />}>
          <ValidationsApp vm={p.validationsVm} error={p.validationsError} dispatch={p.validationsDispatch} />
        </Suspense>
      </div>
    );
  } else if (section === "handoff") {
    body = (
      <div class="ck-embed-host" data-testid="control-handoff">
        <Suspense fallback={<SectionFallback />}>
          <HandoffApp vm={p.handoffVm} dispatch={p.handoffDispatch} />
        </Suspense>
      </div>
    );
  } else if (section === "worktrees") {
    body = (
      <ModuleChrome title={s.worktreesTitle} hint={s.worktreesHint}>
        <WorktreesHygiene
          s={s}
          rows={m.worktrees}
          unavailable={m.worktreesUnavailable}
          onRevealPath={p.onRevealPath}
          onCopyText={p.onCopyText}
          onPost={p.onPost}
        />
      </ModuleChrome>
    );
  } else if (section === "deliveries") {
    body = (
      <ModuleChrome title={s.deliveriesTitle} hint={s.deliveriesHint}>
        {m.deliveries.length === 0 ? (
          <EmptyState kind="empty" message={s.noneListed} />
        ) : (
          <div class="ck-card-list" data-testid="control-deliveries">
            {m.deliveries.map((d) => (
              <ListRow
                key={d.id}
                title={
                  <>
                    <span class="name ck-mono">{d.id}</span>
                    <Badge tone={["pruned", "abandoned"].includes(d.phase) ? "default" : "ok"}>{d.phase}</Badge>
                  </>
                }
                meta={
                  <>
                    {d.branchRef ? (
                      <span>
                        {s.branch}: <span class="ck-mono">{d.branchRef}</span>
                      </span>
                    ) : null}
                    {d.agent ? (
                      <span>
                        {s.agent}: {d.agent}
                      </span>
                    ) : null}
                    {d.folder ? <span>{d.folder}</span> : null}
                  </>
                }
                detail={d.worktreePath ? <span class="ck-mono">{d.worktreePath}</span> : undefined}
                actions={
                  <>
                    <Button variant="default" onClick={() => p.onCopyText(d.id)}>
                      {s.copyId}
                    </Button>
                    {d.worktreePath ? (
                      <>
                        <Button variant="default" onClick={() => p.onRevealPath(d.worktreePath!)}>
                          {s.reveal}
                        </Button>
                        <Button variant="default" onClick={() => p.onCopyText(d.worktreePath!)}>
                          {s.copyPath}
                        </Button>
                      </>
                    ) : null}
                  </>
                }
              />
            ))}
          </div>
        )}
      </ModuleChrome>
    );
  } else if (section === "runtime") {
    body = (
      <div class="ck-embed-host" data-testid="control-runtime-ops">
        <Suspense fallback={<SectionFallback />}>
          <RuntimeOpsApp snapshot={p.runtimeSnapshot} onSetProviderObservation={p.onRuntimeSetProviderObservation} />
        </Suspense>
      </div>
    );
  } else if (section === "tmux") {
    body = (
      <div class="ck-embed-host" data-testid="control-tmux-inspector">
        <Suspense fallback={<SectionFallback />}>
          <InspectorApp {...p.inspector} />
        </Suspense>
      </div>
    );
  } else if (section === "plugins") {
    body = (
      <div class="ck-embed-host" data-testid="control-plugins">
        <Suspense fallback={<SectionFallback />}>
          <PluginsApp
            vm={p.pluginsVm}
            consent={p.pluginsConsent}
            busy={p.pluginsBusy}
            toast={p.pluginsToast}
            dispatch={p.pluginsDispatch}
          />
        </Suspense>
      </div>
    );
  } else {
    // settings (and any unknown section fallback)
    const companion = m.companion;
    body = (
      <ModuleChrome title={s.settingsTitle} hint={s.settingsHint}>
        <div class="ck-panel" data-testid="control-settings">
          <p>{s.settingsBody}</p>
          <div class="ck-jump">
            <Button variant="default" onClick={p.onOpenSettings}>
              {s.settingsOpenTachyon}
            </Button>
            <Button
              variant="default"
              onClick={() => p.onOpenConfigFile(companion?.wsHash ?? m.control.workspaces[0]?.wsHash)}
            >
              {s.settingsOpenConfig}
            </Button>
            <Button variant="default" onClick={p.onOpenDoctor}>
              {s.settingsDoctor}
            </Button>
          </div>

          <div class="ck-settings-block" data-testid="control-settings-companion">
            <h3 class="ck-settings-block-title">{s.companionTitle}</h3>
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

  return (
    <div class="ck-root">
      {/* t-fullpage-proto — a subroute (task-detail, a Fleet subroute, or any studio) replaces the
          whole section tab strip with ONE minimal "← Back" row; the content area gets the vertical
          space the tabs would have used. `breadcrumb` is null for a genuine deep-link edge case
          (pin with no captured returnRoute) — falls back to the normal tab strip rather than showing
          an empty header. */}
      {isSubroute && breadcrumb ? (
        <header class="ck-top ck-top--fullpage">
          <div class="ck-chrome ck-chrome--fullpage">{breadcrumb}</div>
        </header>
      ) : (
        <header class="ck-top">
          {/* Tabs only — Refresh / Auto / Diagnostics live on Overview. */}
          <div class="ck-chrome">
            <div class="ck-tabs" role="tablist" aria-label={s.title}>
              {COCKPIT_SECTION_ORDER.map((id) => {
                const meta = TAB_META[id];
                const engineErr =
                  id === "engine" && m?.control.workspaces.some((w) => w.engine.logHasError);
                return (
                  <button
                    type="button"
                    role="tab"
                    key={id}
                    aria-selected={section === id && !isNavlessStudio}
                    class={`${section === id && !isNavlessStudio ? "active" : ""}${engineErr ? " has-err" : ""}`}
                    onClick={() => p.onSetSection(id)}
                  >
                    <span class={`codicon codicon-${meta.icon}`} />
                    {s[meta.navKey]}
                    {engineErr ? <span class="ck-tab-dot" aria-label="errors in engine log" /> : null}
                  </button>
                );
              })}
            </div>
            {/* t-d16a39 — ONE shell-level workspace scope for every section. Hidden for the common
                single-workspace case (nothing to choose). Radix Select rejects an empty-string item
                value, so the UI uses the ALL_WORKSPACES sentinel and translates to "" on dispatch
                (the wire/host side keeps "" = All). */}
            {m && m.workspaces.length > 1 ? (
              <KitSelect
                aria-label="Control workspace"
                data-testid="control-workspace-select"
                class="ck-workspace-select"
                value={m.selectedWsHash ?? ALL_WORKSPACES}
                onValueChange={(value) => p.onSwitchWorkspace(value === ALL_WORKSPACES ? "" : value)}
                options={[
                  { value: ALL_WORKSPACES, label: "All workspaces" },
                  ...m.workspaces.map((w) => ({ value: w.hash, label: w.folder })),
                ]}
              />
            ) : null}
          </div>
        </header>
      )}

      <main class={`ck-main${isEmbed ? " ck-main--embed" : ""}${section === "mission" ? " ck-main--mission" : ""}`}>
        {body}
        {m && !isEmbed ? (
          <div class="ck-checked">
            {s.checkedAt}: {m.checkedAt}
          </div>
        ) : null}
      </main>

      {p.toast ? <div class="ck-toast">{p.toast}</div> : null}
    </div>
  );
}
