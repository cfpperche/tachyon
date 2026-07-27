import { createContext, Fragment } from "preact";
import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { Button, Badge, EmptyState, DenseRow } from "../shared/ui";
import {
  SAMPLE, TABS, searchIndex,
  type FleetVM, type TabId, type AgentVM, type AgentStatus, type SearchItem,
} from "../../sidebar/types";
import {
  inlineMembers, readmittedCriticalComponents, resolveCardTemplate, topLevelComponents,
  type CardComponentId, type CardRegion, type CardTemplate,
} from "../../sidebar/cardTemplate";
import { primaryActions, moreActions, ACTION_META, type ActionId } from "../../sidebar/actions";
import { sortRows, groupByParent, SORT_LABEL, asSortMode, type SortMode } from "../../sidebar/sortRows";
import { agentAncestorNames, agentGroupParent, agentHierarchyRows } from "./grouping";
import { attentionRows, splitNoticeAuthor } from "../../sidebar/attentionStack.js";
import { placeMoreMenu } from "./menuPosition";
import {
  AGENT_STATUS_FILTERS,
  AGENT_STATUS_FILTER_LABEL,
  asAgentStatusFilter,
  countAgentStatusFilters,
  filterAgentsByStatus,
  type AgentStatusFilter,
} from "./agentStatusFilter";

const Icon = ({ name }: { name: string }) => <span class={`codicon codicon-${name}`} aria-hidden="true" />;

/** Alphabetical sort glyph — codicons have no A–Z/Z–A icon, so we draw one inline and flip it with the
 *  direction: A↓Z for ascending, Z↑A for descending (letters and arrow both invert on each toggle). */
const SortIcon = ({ dir }: { dir: SortMode }) => {
  const asc = dir === "name-asc";
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <text x="0.5" y="6.9" font-size="7.5" font-weight="700" fill="currentColor">{asc ? "A" : "Z"}</text>
      <text x="0.5" y="15" font-size="7.5" font-weight="700" fill="currentColor">{asc ? "Z" : "A"}</text>
      <g stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">
        {asc
          ? <><path d="M12 3.4 V11" /><path d="M9.9 8.9 L12 11.6 L14.1 8.9" /></>
          : <><path d="M12 12.6 V5" /><path d="M9.9 7.1 L12 4.4 L14.1 7.1" /></>}
      </g>
    </svg>
  );
};

/** The host bridge (from main.tsx). Each method's LAST arg is the target folder's wsHash, so multi-root
 *  actions route to the right workspace (omitted → the first). */
export interface Dispatch {
  action: (id: ActionId, agent: string, wsHash?: string) => void;
  section: (op: string, id: string, extra?: { done?: boolean; label?: string; actionId?: string }, wsHash?: string) => void;
  global: (op: GlobalOp, wsHash?: string) => void;
  pipeline: (op: string, name: string, nodeId?: string, wsHash?: string) => void;
  /** spec 242 — persist the chosen sort for a status list (global per-user, per-section). */
  setSort?: (section: "agents" | "terminals", mode: SortMode) => void;
  /** Persist all collapsed sidebar group keys. Keys include workspace hashes when workspace-scoped. */
  setCollapsedKeys?: (keys: string[]) => void;
}
/** Global (section-level, not per-row) ops: pins + the per-section "new …" studios. */
export type GlobalOp = "addPin" | "copyBridge" | "init" | "openHandoff" | "openConfig" | "openControl" | "doctor" | "studio:agents" | "studio:terminals" | "studio:commands" | "studio:runbooks" | "studio:schedules";

/** One entry in the in-webview "..." overflow menu (edit/remove etc. live here across ALL tabs, not inline). */
export interface MenuItem { label: string; icon: string; run: () => void }

/** What rows consume via context: the bridge methods with the folder's wsHash already curried in, plus the
 *  LOCAL opener for the in-webview "more" menu. App builds one of these per folder. */
interface SidebarCtx {
  action: (id: ActionId, agent: string) => void;
  section: (op: string, id: string, extra?: { done?: boolean; label?: string }) => void;
  global: (op: GlobalOp) => void;
  pipeline: (op: string, name: string, nodeId?: string) => void;
  openMore: (items: MenuItem[], x: number, y: number) => void;
}
const NOOP_CTX: SidebarCtx = { action: () => {}, section: () => {}, global: () => {}, pipeline: () => {}, openMore: () => {} };
const DispatchCtx = createContext<SidebarCtx>(NOOP_CTX);

/** Contextual "new …" studio per tab (opens the existing Studio command; it picks the folder itself). */
const STUDIO_OF: Partial<Record<TabId, { op: GlobalOp; label: string }>> = {
  Agents: { op: "studio:agents", label: "New agent" },
  Terminals: { op: "studio:terminals", label: "New terminal" },
  Commands: { op: "studio:commands", label: "New command" },
  Runbooks: { op: "studio:runbooks", label: "New runbook" },
  Schedules: { op: "studio:schedules", label: "New schedule" },
};

const STATUS_LABEL: Record<AgentStatus, string> = { running: "Running", needs: "Needs input", throttled: "Throttled", done: "Done", idle: "Idle", stopping: "Stopping", "stop-failed": "Stop failed", stopped: "Stopped", crashed: "Crashed" };

function externalToolBadgeLabel(a: AgentVM): string | undefined {
  const tools = a.externalTools;
  if (!tools?.active) return undefined;
  if (tools.active > 1) return `tools ${tools.active}`;
  const item = tools.items[0];
  return item?.kind === "browser" || item?.kind === "desktop" || item?.kind === "screen" ? item.kind : "tool";
}

function externalToolBadgeTitle(a: AgentVM): string {
  const tools = a.externalTools;
  if (!tools?.active) return "";
  return tools.items.map((item) => {
    const ids = [item.pid !== undefined ? `pid ${item.pid}` : undefined, item.windowId ? `window ${item.windowId}` : undefined].filter(Boolean).join(", ");
    return [item.tool, item.kind, item.source, item.confidence, ids, new Date(item.startedAt).toLocaleString()].filter(Boolean).join(" · ");
  }).join("\n");
}

/** t-8354ae — persistent config-error banner (Agents tab). */
function ConfigErrorBanner({ err }: { err: NonNullable<FleetVM["configError"]> }) {
  const d = useContext(DispatchCtx);
  return (
    <div class="config-error-banner" role="alert">
      <div class="config-error-title">
        <Icon name="warning" />
        <strong>Invalid {err.file}</strong>
      </div>
      <div class="config-error-summary" title={err.errors.join("\n")}>{err.summary}</div>
      <div class="config-error-actions">
        <Button variant="primary" onClick={() => d.global("openConfig")}>Open {err.file}</Button>
        <Button variant="default" onClick={() => d.global("doctor")}>Doctor</Button>
      </div>
    </div>
  );
}

/**
 * SDD 479 — a written card template that could not be honored. The fleet is FINE (the config loaded);
 * only the layout fell back to the default, so this is `role="status"`, warn-toned, and never claims
 * the file is invalid. Without it the fallback is indistinguishable from the feature not working.
 */
function CardTemplateRefusalBanner({ refusal }: { refusal: NonNullable<FleetVM["cardTemplateRefusal"]> }) {
  const d = useContext(DispatchCtx);
  const [first, ...rest] = refusal.errors;
  return (
    <div class="config-error-banner card-template-banner" role="status">
      <div class="config-error-title">
        <Icon name="warning" />
        <strong>Card layout ignored — showing the default</strong>
      </div>
      <div class="config-error-summary" title={refusal.errors.join("\n")}>
        {first}{rest.length > 0 ? ` (+${rest.length} more)` : ""}
      </div>
      <div class="config-error-actions">
        <Button variant="default" onClick={() => d.global("openConfig")}>Open {refusal.file}</Button>
      </div>
    </div>
  );
}

/** spec 378 — a TEXTUAL provenance marker for the model suffix (never styling alone): "· declared"/"· profile"
 *  before the first live observation, "· stale" once an observation survives a process-preserving boundary
 *  (in-TUI /clear, resume) without a fresh one yet, or "≠ declared" when the observed model diverges from
 *  what was declared/configured. */
function ModelProvenance({ a }: { a: AgentVM }) {
  if (!a.model || !a.modelSource) return null;
  if (a.modelDivergence) {
    return <span class="model-marker warn" title={`Observed model differs from the ${a.modelSource === "observed" ? "declared/profile" : a.modelSource} default`}> ≠ declared</span>;
  }
  if (a.modelSource === "observed") {
    return a.modelStale
      ? <span class="model-marker warn" title="Carried across a session boundary — awaiting a fresh observation"> · stale</span>
      : null;
  }
  return <span class="model-marker" title={a.modelSource === "declared" ? "From the declared --model flag; not yet observed live" : "Runtime profile default; not yet observed live"}> · {a.modelSource}</span>;
}

/** spec 384 — live HEAD badge; always first in the meta list. Isolation config stays on `worktree` for actions. */
function BranchBadge({ a }: { a: AgentVM }) {
  if (!a.liveBranch) return null;
  const isolated = !!a.worktree;
  const drift = !!a.branchDrift;
  const titleParts = [
    isolated ? "Worktree session" : "Shared workspace cwd",
    `HEAD ${a.liveBranch}`,
    a.worktreePath ? a.worktreePath : undefined,
    drift && a.worktree ? `config/isolation branch was ${a.worktree}` : undefined,
  ].filter(Boolean);
  // Isolated stays on the green --ds-ok chip (prototype). Drift is signalled by ⚠ + tooltip only —
  // do NOT apply warn tone on the whole chip (that paints yellow and hid the green in dogfood).
  const cls = ["git-branch", !isolated ? "shared" : "", drift ? "drift" : ""].filter(Boolean).join(" ");
  return (
    <Badge tone={isolated ? "ok" : "default"} class={cls} title={titleParts.join("\n")}>
      ⎇ {a.liveBranch}{drift ? <span class="git-drift-mark" aria-label="diverged from config branch"> ⚠</span> : null}
    </Badge>
  );
}

/** spec 386 — format helpers (mirror attention/resourceSample pure formatters; keep webview free of node imports). */
function fmtCpu(n: number): string { return `${Math.round(n)}%`; }
function fmtMem(mb: number): string {
  if (mb >= 1024) {
    const g = mb / 1024;
    return `${g >= 10 ? g.toFixed(0) : g.toFixed(1).replace(/\.0$/, "")}G`;
  }
  return `${Math.round(mb)}M`;
}

/** spec 386 — collapsible CPU/Mem lanes (L3–L4). */
function ResourceDetail({ a }: { a: AgentVM }) {
  const r = a.resources;
  if (!r) return null;
  const cpu = r.cpuPct;
  const hot = cpu !== undefined && cpu >= 80;
  const cpuW = cpu === undefined ? 0 : Math.min(100, cpu);
  const memW = Math.min(100, (r.memMb / 2048) * 100);
  return (
    <div class="row-detail">
      <div class="lane" title="CPU of the agent pane process subtree">
        <span class="lab">CPU</span>
        <div class="body">
          <span class={`meter cpu${hot ? " hot" : ""}`}><i style={{ width: `${cpuW}%` }} /></span>
          <span class={`val cpu${hot ? " hot" : ""}`}>{cpu === undefined ? "—" : fmtCpu(cpu)}</span>
        </div>
      </div>
      <div class="lane" title="Resident set size of the pane process subtree">
        <span class="lab">Mem</span>
        <div class="body">
          <span class="meter mem"><i style={{ width: `${memW}%` }} /></span>
          <span class="val mem">{fmtMem(r.memMb)}</span>
        </div>
      </div>
    </div>
  );
}

/**
 * SDD 479 phase 1 — everything one catalog component needs to render itself. A card is a function of
 * this and nothing else: no component reads context or state of its own, which is what lets the
 * equality proof render the whole matrix statically.
 */
interface CardSlot {
  a: AgentVM;
  template: CardTemplate;
  d: SidebarCtx;
  nested: boolean;
  hasChildren: boolean;
  collapsed: boolean;
  hiddenCount: number;
  hiddenNeedsAttention: boolean;
  /** collapsed AND hiding at least one child row */
  hasHidden: boolean;
  /** has metrics AND a status live enough to show them */
  hasResources: boolean;
  metricsOpen: boolean;
  onToggle?: () => void;
  onToggleMetrics?: () => void;
  /** SDD 479 — critical components this template omits that the row's state puts back (fork 3). */
  readmitted: readonly CardComponentId[];
}

/**
 * SDD 479 — a re-admitted component explains itself in its own tooltip. Someone who curated a layout
 * and then sees a badge they removed needs to know the product put it back, and why, or the template
 * looks broken.
 */
function cardTitle(slot: CardSlot, id: CardComponentId, base?: string): string | undefined {
  const note = "Your card template omits this badge — Tachyon is showing it because this row is in that state.";
  if (!slot.readmitted.includes(id)) return base;
  return base ? `${base}\n\n${note}` : note;
  // `base` is optional because not every critical badge carries a tooltip today (`✗ verify` does not).
  // Returning undefined leaves the attribute off entirely, so an un-configured card is unchanged —
  // which the phase-1 equality proof checks on every run.
}

type CardComponentRenderer = (slot: CardSlot) => preact.ComponentChildren;

/**
 * SDD 479 phase 1 — the closed catalog's renderers, one fragment per id.
 *
 * `Record<CardComponentId, …>` is load-bearing: a catalog id with no renderer, or a renderer with no
 * catalog id, does not compile. That is what keeps the catalog closed in fact and not just in prose —
 * an id the product cannot render could only be rendered by interpreting it, and interpretation is how
 * markup gets in (`docs/specs/479-sidebar-agent-card-templates/plan.md` § 1).
 *
 * Nothing here decides ORDER or PRESENCE beyond each component's own product-owned condition; the
 * template decides that, and today the only template is the default one.
 */
export const CARD_COMPONENTS: Record<CardComponentId, CardComponentRenderer> = {
  "status-dot": ({ a }) => (
    <span class={`sdot ${a.status}`} role="img" title={STATUS_LABEL[a.status]} aria-label={STATUS_LABEL[a.status]} />
  ),

  name: (slot) => <span class="name">{slot.a.name}<InlineRun slot={slot} host="name" /></span>,

  // The model label and its provenance marker live INSIDE `.name` (catalog `inlineWith`), where the
  // sidebar's CSS and the row's reading order expect them.
  model: (slot) =>
    slot.a.model ? (
      <><span class="model-sep"> — </span><span class="model">{slot.a.model}</span><InlineRun slot={slot} host="model" /></>
    ) : null,

  "model-provenance": ({ a }) => <ModelProvenance a={a} />,

  /* spec 386 — metrics pill only (no extra ▤ control): click expands L3–L4, click again collapses */
  "metrics-pill": (slot) => {
    if (!slot.hasResources) return null;
    const { a, metricsOpen } = slot;
    const cpu = a.resources?.cpuPct;
    const hot = cpu !== undefined && cpu >= 80;
    return (
      <button
        type="button"
        class={`peek${hot ? " hot" : ""}${metricsOpen ? " open" : ""}`}
        title={metricsOpen ? `Collapse metrics — ${a.name}` : `Expand metrics — ${a.name}`}
        aria-label={metricsOpen ? `Collapse metrics — ${a.name}` : `Expand metrics — ${a.name}`}
        aria-expanded={metricsOpen}
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); slot.onToggleMetrics?.(); }}
      >
        <span class="c">{cpu === undefined ? "—" : fmtCpu(cpu)}</span>
        {" · "}
        <span class="m">{fmtMem(a.resources!.memMb)}</span>
      </button>
    );
  },

  sub: ({ a }) => (a.sub ? <span class="msub">{a.sub}</span> : null),

  "hidden-count": ({ hasHidden, hiddenCount, hiddenNeedsAttention }) =>
    hasHidden ? (
      <Badge tone={hiddenNeedsAttention ? "warn" : "default"} title={hiddenNeedsAttention ? "Collapsed children include attention" : "Collapsed children"}>
        {hiddenNeedsAttention ? "◆ " : ""}+{hiddenCount}
      </Badge>
    ) : null,

  /* spec 384 — branch/worktree badge is FIXED first in the meta list (DEFAULT_CARD_TEMPLATE.meta).
     The `liveBranch` guard is duplicated from BranchBadge on purpose: `CardMetaRegion` decides whether
     `.row-meta` exists from what its components RETURN, and a component vnode that renders nothing
     internally is still a vnode. Every meta renderer must answer "nothing" with null — pinned by
     test/unit/sidebarCardMetaRegion.test.ts, because getting this wrong put an empty div on EVERY row. */
  branch: ({ a }) => (a.liveBranch ? <BranchBadge a={a} /> : null),

  "config-invalid": (slot) =>
    slot.a.configInvalid ? (
      <Badge tone="err" title={cardTitle(slot, "config-invalid", "tachyon.yml is invalid — row shown from session ledger or last-known-good snapshot (read-only for spawn)")}>
        config invalid
      </Badge>
    ) : null,

  // spec 390 — no "delegated by / owned by" text (tree indent is hierarchy); no "working" chip (live-dot).
  attention: ({ a }) => (a.attention && a.attention !== "working" ? <Badge tone="warn">{a.attention}</Badge> : null),

  "awaiting-human": (slot) =>
    slot.a.awaitingHuman ? (
      <Badge tone="warn" title={cardTitle(slot, "awaiting-human", slot.a.awaitingHuman.reason || "needs a human — request_human_attention")}>
        ◆ needs you
      </Badge>
    ) : null,

  /* SDD 477 — err tone, not warn: this row will never move again on its own, and nothing but a
     human logging the runtime back in can change that. */
  "auth-required": (slot) =>
    slot.a.authRequired ? (
      <Badge
        tone="err"
        title={cardTitle(slot, "auth-required", `${slot.a.authRequired.runtime} reports this agent is not authenticated — ${slot.a.authRequired.action}. Tachyon will not retry or restart it automatically.`)}
      >
        ◆ auth required
      </Badge>
    ) : null,

  // Returns null rather than an empty fragment when no gate result applies: `CardMetaRegion` decides
  // whether `.row-meta` exists from whether its components RENDERED, so "nothing" has to be nothing.
  verify: (slot) =>
    slot.a.verify === "pass" ? <Badge tone="ok">✓ verified</Badge>
      : slot.a.verify === "fail" ? <Badge tone="err" title={cardTitle(slot, "verify")}>✗ verify</Badge>
        : slot.a.verify === "stale" ? <Badge>⊘ stale</Badge>
          : null,

  evidence: ({ a }) =>
    a.evidence ? (
      <Badge
        tone={a.evidence.error > 0 ? "err" : a.evidence.warn > 0 ? "warn" : "default"}
        title={`${a.evidence.total} evidence record(s)${a.evidence.error ? `, ${a.evidence.error} error` : ""}${a.evidence.warn ? `, ${a.evidence.warn} warn` : ""}${a.evidence.stale ? `, ${a.evidence.stale} stale` : ""} — advisory, never gates (list_evidence to read)`}
      >
        ⊙ {a.evidence.total}{a.evidence.stale > 0 ? ` (${a.evidence.stale}⊘)` : ""}
      </Badge>
    ) : null,

  "external-tools": ({ a }) => {
    const externalToolLabel = externalToolBadgeLabel(a);
    return externalToolLabel ? (
      <Badge tone={a.externalTools?.strongestConfidence === "weak" ? "warn" : "default"} title={externalToolBadgeTitle(a)}>
        {externalToolLabel}
      </Badge>
    ) : null;
  },

  harness: ({ a }) => (a.harness ? <Badge>⚙ harness</Badge> : null),

  resume: ({ a }) =>
    a.resumable
      ? (a.freshStart ? (
          <Badge tone="warn" title="Saved transcript is gone — Resume starts fresh">
            ↻ fresh start
          </Badge>
        ) : (
          <Badge>↻ resumable</Badge>
        ))
      : null,

  fork: ({ a }) => (a.forked ? <Badge>⑂ fork</Badge> : null),

  // Null, not an empty fragment, when the brief is fresh — see the note on `verify`.
  continuity: ({ a }) =>
    a.continuity === "stale" ? (
      <Badge tone="warn" title="Continuity brief is behind recent activity — the agent should checkpoint (set_continuity)">
        ◐ continuity stale
      </Badge>
    ) : a.continuity === "missing" ? (
      <Badge title="No continuity brief yet — the agent hasn't checkpointed its working state">○ no continuity</Badge>
    ) : null,

  "persistence-hooks": ({ a }) =>
    a.persistenceHooks && a.persistenceHooks.state !== "active" ? (
      <Badge
        class="hook-badge"
        tone={a.persistenceHooks.state === "failed" ? "err" : a.persistenceHooks.state === "unknown" ? "default" : "warn"}
        title={a.persistenceHooks.reason ?? `Persistence hooks ${a.persistenceHooks.state}`}
      >
        ⛓ hooks {a.persistenceHooks.state}
      </Badge>
    ) : null,

  /* spec 390 — focus line: what the agent is working on (task → brief → continuity goal) */
  focus: ({ a }) => {
    const focus = a.focus;
    if (!focus) return null;
    const focusTitle = `${focus.source === "continuity" ? "goal" : focus.source}${focus.taskId ? ` · ${focus.taskId}` : ""}\n${focus.full}`;
    return (
      <div class="row-focus" title={focusTitle}>
        <span class="focus-arrow" aria-hidden="true">↳</span>
        <span class={`focus-src src-${focus.source}`}>
          {focus.source === "continuity" ? "goal" : focus.source}
        </span>
        {focus.taskId && <span class="focus-id">{focus.taskId}</span>}
        <span class="focus-text">{focus.text}</span>
      </div>
    );
  },

  "metrics-lanes": ({ a, metricsOpen, hasResources }) => (metricsOpen && hasResources ? <ResourceDetail a={a} /> : null),

  actions: ({ a, d }) => (
    <div class="actions" role="group" aria-label={`${a.name} actions`}>
      {primaryActions(a).map((id) => <Act icon={ACTION_META[id].icon} title={ACTION_META[id].label} on={() => d.action(id, a.name)} />)}
      {moreActions(a).length > 0 && <MoreBtn items={moreActions(a).map((id) => ({ label: ACTION_META[id].label, icon: ACTION_META[id].icon, run: () => d.action(id, a.name) }))} />}
    </div>
  ),
};

/** The components a region renders as siblings, in template order. */
function CardRegionView({ slot, region }: { slot: CardSlot; region: CardRegion }) {
  return <>{topLevelComponents(slot.template, region).map((id) => <Fragment key={id}>{CARD_COMPONENTS[id](slot)}</Fragment>)}</>;
}

/**
 * SDD 479 phase 2 — the meta region, plus any critical component this row's state re-admits.
 *
 * Returns `null` when NOTHING rendered, and the wrapper follows: `.row-meta` exists when it has
 * content, not when the row happens to carry a field. That answers the question phase 1 left open —
 * once a template can omit components, a fixed field-based predicate would leave an empty div
 * (padding and all) on rows whose badges the person hid. It also retires two pre-existing cases of the
 * same bug: a row with `worktree` but no live branch, and one whose persistence hooks are healthy.
 */
function CardMetaRegion({ slot }: { slot: CardSlot }): preact.VNode | null {
  const ids = [...topLevelComponents(slot.template, "meta"), ...slot.readmitted];
  const rendered = ids
    .map((id) => ({ id, node: CARD_COMPONENTS[id](slot) }))
    .filter((entry) => entry.node !== null && entry.node !== undefined && entry.node !== false);
  if (rendered.length === 0) return null;
  return <div class="row-meta">{rendered.map((entry) => <Fragment key={entry.id}>{entry.node}</Fragment>)}</div>;
}

/** The components `host` renders inside its own element (catalog `inlineWith`), in template order. */
function InlineRun({ slot, host }: { slot: CardSlot; host: CardComponentId }) {
  return <>{inlineMembers(slot.template, host).map((id) => <Fragment key={id}>{CARD_COMPONENTS[id](slot)}</Fragment>)}</>;
}

export function AgentRow({ a, flash, nested = false, hasChildren = false, collapsed = false, hiddenCount = 0, hiddenNeedsAttention = false, onToggle, metricsOpen = false, onToggleMetrics, cardTemplate }: {
  a: AgentVM; flash: boolean; nested?: boolean; hasChildren?: boolean; collapsed?: boolean; hiddenCount?: number; hiddenNeedsAttention?: boolean; onToggle?: () => void;
  /** spec 386 — metrics detail lanes open for this agent (independent of hierarchy collapse). */
  metricsOpen?: boolean;
  onToggleMetrics?: () => void;
  /** SDD 479 — the folder's project template; omitted (or a terminal row) renders the default card. */
  cardTemplate?: CardTemplate;
}) {
  const d = useContext(DispatchCtx);
  const hasHidden = collapsed && hiddenCount > 0;
  const hasResources = !!a.resources && (a.status === "running" || a.status === "idle" || a.status === "done" || a.status === "needs" || a.status === "throttled" || a.status === "stop-failed");
  // SDD 479 — the resolver, not the caller, enforces the ratified V1 boundary: a terminal row takes
  // the default template whatever this folder configured.
  const template = resolveCardTemplate(a, cardTemplate);
  // Ratified fork 3 — the one place the product overrides the person: a failure state the template
  // omits is re-admitted for THIS row, and says so in its tooltip.
  const readmitted = readmittedCriticalComponents(template, a);
  const slot: CardSlot = {
    a, template, d, nested, hasChildren, collapsed, hiddenCount, hiddenNeedsAttention,
    hasHidden, hasResources, metricsOpen, onToggle, onToggleMetrics, readmitted,
  };
  return (
    <div class={`row${nested ? " child" : ""}${flash ? " flash" : ""}${metricsOpen && hasResources ? " metrics-open" : ""}`} data-name={a.name.toLowerCase()}>
      <div class="row-top">
        {/* Tree chrome, deliberately NOT a catalog component: it reveals child ROWS, and a template
            able to hide it would make collapsed children unreachable. */}
        {hasChildren ? (
          <button
            class={`agent-toggle${collapsed ? " collapsed" : ""}`}
            type="button"
            title={`${collapsed ? "Expand" : "Collapse"} children of ${a.name}`}
            aria-label={`${collapsed ? "Expand" : "Collapse"} children of ${a.name}`}
            aria-expanded={!collapsed}
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); onToggle?.(); }}
          >
            <span class="chev">▼</span>
          </button>
        ) : (
          // Reserves the gutter for a childless TOP-LEVEL row only (t-b8ff2c). A nested `.row.child` row
          // never reserves it — stacking would float its dot away from the "↳" connector.
          !nested && <span class="agent-toggle-spacer" aria-hidden="true" />
        )}
        <CardRegionView slot={slot} region="header" />
      </div>
      <CardMetaRegion slot={slot} />
      <CardRegionView slot={slot} region="footer" />
    </div>
  );
}

function Group({ title, count, collapsed, onToggle, actions, children }: { title: string; count: number; collapsed: boolean; onToggle: () => void; actions?: preact.ComponentChildren; children: preact.ComponentChildren }) {
  // A group with actions (e.g. a pipeline definition with no active run → 0 nodes) is still meaningful —
  // it must show its header + actions, not vanish. Only action-less, empty groups collapse away.
  if (!count && !actions) return null;
  return (
    <>
      <div class={`grp${collapsed ? " collapsed" : ""}`}>
        <button class="grp-toggle" type="button" aria-expanded={!collapsed} onClick={onToggle}>
          <span class="chev">▼</span><span>{title}</span>
        </button>
        {actions && <span class="grp-actions" onClick={(e) => e.stopPropagation()}>{actions}</span>}
      </div>
      {!collapsed && <div class="grp-body">{children}</div>}
    </>
  );
}

/** Dense section rows — shared DenseRow (keeps `.row` DOM for sidebar CSS). */
const ListRow = DenseRow;

/** Icon hit-target — native button + Icon. Do NOT use IconButton here: .ds-btn padding/border fights .act (22×22). */
const Act = ({ icon, title, on }: { icon: string; title: string; on: () => void }) => (
  <button class="act" type="button" title={title} aria-label={title}
    onClick={(e) => { e.preventDefault(); e.stopPropagation(); on(); }}>
    <Icon name={icon} />
  </button>
);

/** The "..." overflow trigger — edit/remove (and any secondary action) live here, never inline, on every tab. */
function MoreBtn({ items }: { items: MenuItem[] }) {
  const d = useContext(DispatchCtx);
  if (!items.length) return null;
  return (
    <button class="act" type="button" title="More actions" aria-label="More actions"
      onClick={(e) => { e.stopPropagation(); d.openMore(items, e.clientX, e.clientY); }}>
      <Icon name="ellipsis" />
    </button>
  );
}

const Empty = () => <EmptyState kind="empty" message="(none)" />;

/** spec 245/331 — a tiny folder-scoped Project Handoff affordance: a staleness badge → opens the panel.
 *  Lives in the folder header, which is now ALWAYS present (single-root is multi-root with N=1, pin
 *  p-cf707f). Text + glyph, never color alone; QUIET (glyph only, no label) when fresh with nothing
 *  pending — noise proportional to pending action. */
function HandoffBtn({ handoff, onOpen }: { handoff?: import("../../sidebar/types").HandoffVM; onOpen: () => void }) {
  // Map staleness → {glyph, label, tone} (mirrors handoffViewModel.stalenessLabel; kept inline so the sidebar
  // bundle doesn't import the panel module). A missing/cold handoff still offers Open (to create it).
  const s = handoff?.staleness;
  const meta = !handoff?.exists ? { glyph: "○", label: "no handoff", tone: "" }
    : s === "needs_distill" ? { glyph: "◆", label: `handoff · ${handoff.pendingCount}`, tone: "warn" }
      : s === "possibly_stale" ? { glyph: "◷", label: "stale", tone: "warn" }
        : s === "old" ? { glyph: "✗", label: "old", tone: "err" }
          : { glyph: "◆", label: "fresh", tone: "" };
  const quiet = !!handoff?.exists && !meta.tone && !handoff.pendingCount;
  return (
    <Button class="handoff-btn" title="Open Project Handoff" aria-label={`Project Handoff — ${meta.label}`} onClick={(e) => { e.stopPropagation(); onOpen(); }}>
      <Badge tone={meta.tone === "warn" ? "warn" : meta.tone === "err" ? "err" : "default"}>{quiet ? meta.glyph : `${meta.glyph} ${meta.label}`}</Badge>
    </Button>
  );
}

function Panel({ tab, fleet, scope, collapsed, toggle, flashName, agentSort, terminalSort, activePinTag, onPinTag, metricsOpen, onToggleMetrics, agentFilter = "all" }: {
  tab: TabId; fleet: FleetVM; scope: string; collapsed: Set<string>; toggle: (k: string) => void; flashName: string | null; agentSort: SortMode; terminalSort: SortMode; activePinTag: string | null; onPinTag: (tag: string | null) => void;
  /** spec 386 — scoped keys `${scope}:m:${agent}` that currently show resource detail lanes. */
  metricsOpen: Set<string>;
  onToggleMetrics: (agentName: string) => void;
  /** t-eddf90 — session-local status bucket filter (Agents tab only). */
  agentFilter?: AgentStatusFilter;
}) {
  const d = useContext(DispatchCtx);
  // Collapse keys are scoped to the folder so multi-root groups with the same name don't collapse together.
  const k = (suffix: string) => `${scope}:${suffix}`;
  if (tab === "Agents") {
    // t-8354ae — while config is invalid, never show the empty-fleet placeholder as the sole signal
    // (banner + ledger/LKG rows replace the "destroyed fleet" illusion).
    // SDD 479 — a refused card template is reported HERE, beside the config banner, because this is
    // where the consequence is: the cards below are the default layout, not the one that was written.
    const banner = (
      <>
        {fleet.configError ? <ConfigErrorBanner err={fleet.configError} /> : null}
        {fleet.cardTemplateRefusal ? <CardTemplateRefusalBanner refusal={fleet.cardTemplateRefusal} /> : null}
      </>
    );
    // spec 242 — a flat, human-sorted list (default name-asc is stable: a status change only recolors the dot
    // in place, no reflow). The dot + the header count-chips carry status; no status group headers.
    if (!fleet.agents.length) {
      return <>{banner}{fleet.configError ? <div class="empty">No agents in ledger or last-known-good snapshot</div> : <div class="empty">(no agents)</div>}</>;
    }
    // t-eddf90 — filter BEFORE sort/group so hierarchy rebuilds on the visible subset only (v1: no dimmed parents).
    const visible = filterAgentsByStatus(fleet.agents, agentFilter);
    if (!visible.length) {
      return <>{banner}<div class="empty">No agents in this filter</div></>;
    }
    const sorted = sortRows(visible, agentSort, (a) => a.name);
    // spec 304 — group a spawned agent's row next to its parent's; sortRows itself stays parent-unaware.
    // spec 352/t-4eb8bf — declared ownership also nests visually, but runtime parent wins when both exist.
    // spec 362/t-1b6ab0 — gated top-level delegations nest by delegator before declared owner.
    const grouped = groupByParent(sorted, (a) => a.name, agentGroupParent);
    const collapsedAgents = new Set([...collapsed].filter((key) => key.startsWith(k("a:"))).map((key) => key.slice(k("a:").length)));
    const rows = agentHierarchyRows(grouped, collapsedAgents);
    return <>
      {banner}
      {rows.map((r) => (
        <AgentRow
          key={r.agent.name}
          a={r.agent}
          flash={r.agent.name === flashName}
          nested={r.nested}
          hasChildren={r.hasChildren}
          collapsed={r.collapsed}
          hiddenCount={r.hiddenCount}
          hiddenNeedsAttention={r.hiddenNeedsAttention}
          onToggle={() => toggle(k(`a:${r.agent.name}`))}
          metricsOpen={metricsOpen.has(k(`m:${r.agent.name}`))}
          onToggleMetrics={() => onToggleMetrics(r.agent.name)}
          cardTemplate={fleet.cardTemplate}
        />
      ))}
    </>;
  }
  if (tab === "Terminals") {
    // spec 242 — flat human-sorted list (same machinery as Agents); terminals are managed entries with ai:false.
    if (!fleet.terminals.length) return <Empty />;
    const sorted = sortRows(fleet.terminals, terminalSort, (t) => t.name);
    return <>{sorted.map((t) => <AgentRow key={t.name} a={t} flash={t.name === flashName} />)}</>;
  }
  if (tab === "Pipelines") return fleet.pipelines.length ? <>{fleet.pipelines.map((p) => {
    const st = p.status;                       // idle | running | paused | failed
    const live = st === "running" || st === "paused";
    // Node actions mirror the tree: Approve/Reject only on awaiting-approval; Review + Rerun on EVERY node.
    const nodeActs = (n: typeof p.nodes[number]) => {
      const a: preact.ComponentChildren[] = [];
      if (n.label === "awaiting-approval") { a.push(<Act icon="check" title="Approve node" on={() => d.pipeline("node:approve", p.name, n.id)} />, <Act icon="close" title="Reject node" on={() => d.pipeline("node:reject", p.name, n.id)} />); }
      a.push(<Act icon="eye" title="Open node terminal" on={() => d.pipeline("node:inspect", p.name, n.id)} />);
      a.push(<Act icon="git-compare" title="Review changes" on={() => d.pipeline("node:review", p.name, n.id)} />);
      a.push(<Act icon="debug-restart" title="Re-run from here" on={() => d.pipeline("node:rerun", p.name, n.id)} />);
      return <>{a}</>;
    };
    const more = [
      ...(live || st === "failed" ? [{ label: "Edit input", icon: "list-selection", run: () => d.pipeline("editInput", p.name) }] : []),
      { label: "Edit pipeline", icon: "edit", run: () => d.pipeline("edit", p.name) },
      { label: "Delete", icon: "trash", run: () => d.pipeline("delete", p.name) },
    ];
    return (
      <Group title={p.name} count={p.nodes.length} collapsed={collapsed.has(k(`p:${p.name}`))} onToggle={() => toggle(k(`p:${p.name}`))}
        actions={<>
          {st === "idle" && <Act icon="run-all" title="Run" on={() => d.pipeline("run", p.name)} />}
          {live && <Act icon="git-compare" title="Review changes" on={() => d.pipeline("review", p.name)} />}
          {live && <Act icon="stop-circle" title="Cancel run" on={() => d.pipeline("cancel", p.name)} />}
          {st === "failed" && <Act icon="trash" title="Dismiss failed run" on={() => d.pipeline("dismiss", p.name)} />}
          <MoreBtn items={more} />
        </>}>
        {p.nodes.map((n) => <ListRow dot={n.status} name={n.id} sub={n.reason ? `${n.label} — ${n.reason}` : n.label} child actions={nodeActs(n)} />)}
      </Group>
    );
  })}</> : <Empty />;
  if (tab === "Schedules") {
    const props = fleet.proposals ?? [];
    if (!props.length && !fleet.schedules.length) return <Empty />;
    return <>
      {props.length > 0 && (
        <Group title="Pending approval" count={props.length} collapsed={collapsed.has(k("s:prop"))} onToggle={() => toggle(k("s:prop"))}>
          {props.map((p) => (
            <ListRow name={p.name} sub={[p.when, p.by && `by ${p.by}`].filter(Boolean).join(" · ") || undefined}
              meta={p.reason ? <span class="msub">{p.reason}</span> : undefined}
              actions={<><Act icon="check" title="Approve" on={() => d.section("proposal:approve", p.id)} /><Act icon="close" title="Reject" on={() => d.section("proposal:reject", p.id, { label: p.name })} /></>} />
          ))}
        </Group>
      )}
      {fleet.schedules.map((s) => (
        <ListRow dot={s.paused ? "stopped" : "running"} name={s.name} sub={s.when} meta={<Badge tone={s.paused ? "default" : "ok"}>{s.next}</Badge>}
          actions={<>
            <Act icon={s.paused ? "debug-continue" : "debug-pause"} title={s.paused ? "Resume" : "Pause"} on={() => d.section("schedule:pause", s.name)} />
            <MoreBtn items={[
              { label: "Edit in Studio", icon: "edit", run: () => d.section("schedule:edit", s.name) },
              { label: "Edit YAML", icon: "file-code", run: () => d.section("schedule:editYaml", s.name) },
              { label: "Delete", icon: "trash", run: () => d.section("schedule:delete", s.name) },
            ]} />
          </>} />
      ))}
    </>;
  }
  if (tab === "Commands") return fleet.commands.length ? <>{fleet.commands.map((c) => {
    const badge = c.state === "running" ? <Badge tone="warn">▶ {c.detail}</Badge>
      : c.state === "passed" ? <Badge tone="ok">✓ {c.detail}</Badge>
        : c.state === "failed" ? <Badge tone="err">✗ {c.detail}</Badge>
          : <Badge>— {c.detail}</Badge>;
    return <ListRow dot={c.state === "running" ? "running" : null} name={c.name} sub={c.cmd} meta={badge}
      actions={<>
        {c.state !== "running" && <Act icon="play" title="Run" on={() => d.section("command:run", c.name)} />}
        {c.state !== "idle" && <Act icon="eye" title="Open output" on={() => d.section("command:open", c.name)} />}
        <MoreBtn items={[
          { label: "Edit in Studio", icon: "edit", run: () => d.section("command:edit", c.name) },
          { label: "Edit YAML", icon: "file-code", run: () => d.section("command:editYaml", c.name) },
          { label: "Delete", icon: "trash", run: () => d.section("command:delete", c.name) },
        ]} />
      </>} />;
  })}</> : <Empty />;
  if (tab === "Runbooks") return fleet.runbooks.length ? <>{fleet.runbooks.map((r) => {
    const stepBadge = (s: typeof r.steps[number]) =>
      s.state === "passed" ? <Badge tone="ok">✓ {s.detail ?? "passed"}</Badge>
        : s.state === "failed" ? <Badge tone="err">✗ {s.detail}</Badge>
          : s.state === "running" ? <Badge tone="warn">▶ running</Badge>
            : <Badge>skipped</Badge>;
    return (
      <Group title={r.name} count={r.steps.length} collapsed={collapsed.has(k(`r:${r.name}`))} onToggle={() => toggle(k(`r:${r.name}`))}
        actions={<>
          {!r.running && <Act icon="play" title="Run" on={() => d.section("runbook:run", r.name)} />}
          <MoreBtn items={[
            { label: "Edit in Studio", icon: "edit", run: () => d.section("runbook:edit", r.name) },
            { label: "Edit YAML", icon: "file-code", run: () => d.section("runbook:editYaml", r.name) },
            { label: "Delete", icon: "trash", run: () => d.section("runbook:delete", r.name) },
          ]} />
        </>}>
        <div class="row-meta" style="padding:2px 12px 4px">
          {r.running ? <Badge tone="warn">▶ running</Badge>
            : r.failed ? <Badge tone="err">✗ {r.detail}</Badge>
              : r.detail === "never run" ? <Badge>— never run</Badge>
                : <Badge tone="ok">✓ {r.detail}</Badge>}
        </div>
        {r.steps.map((s) => (
          <ListRow child name={`${s.n}. ${s.label}`} meta={stepBadge(s)}
            actions={s.state === "failed" ? <Act icon="eye" title="Open output" on={() => d.section("runbook:step", `${r.name}#${s.n - 1}`)} /> : undefined} />
        ))}
      </Group>
    );
  })}</> : <Empty />;
  // Pins — the shared checklist.
  const pins = activePinTag ? fleet.pins.filter((p) => p.tags.includes(activePinTag)) : fleet.pins;
  return <>
    {pins.length ? pins.map((p) => (
      <div class={`pin${p.done ? " done" : ""}`} data-name={`${p.text} ${p.id ?? ""}`.toLowerCase()}>
        <button class={`box${p.done ? " done" : ""}`} type="button" role="checkbox" aria-checked={p.done}
          aria-label={`${p.done ? "Mark not done" : "Mark done"}: ${p.text}`}
          onClick={() => p.id && d.section("pin:toggle", p.id, { done: !p.done })}>{p.done && <Icon name="check" />}</button>
        <div class="pin-body">
          <span class="txt">{p.text}</span>
          {!!p.attachmentCount && (
            <span class="pin-att" title={`${p.attachmentCount} visual attachment${p.attachmentCount === 1 ? "" : "s"}`}>
              <Icon name="file-media" /> {p.attachmentCount}
            </span>
          )}
          {p.tags.map((tag) => (
            <Button class={`pin-tag${tag === activePinTag ? " active" : ""}`} title={`Filter by #${tag}`} onClick={() => onPinTag(tag)}>
              #{tag}
            </Button>
          ))}
          {p.by && <span class="pin-by">— {p.by}</span>}
          {p.id && (
            <Button class="pin-id" title={`Copy pin ID ${p.id}`} onClick={() => d.section("pin:copyId", p.id!)}>
              {p.id}
            </Button>
          )}
        </div>
        {p.id && <div class="actions">
          <Act icon="eye" title="Preview pin" on={() => d.section("pin:preview", p.id!)} />
          <Act icon="copy" title="Copy pin ID and title" on={() => d.section("pin:copy", p.id!, { label: p.text })} />
          <MoreBtn items={[
            { label: "Edit", icon: "pencil", run: () => d.section("pin:edit", p.id!) },
            { label: "Delete", icon: "trash", run: () => d.section("pin:delete", p.id!) },
          ]} />
        </div>}
      </div>
    )) : activePinTag ? <div class="empty">No pins tagged #{activePinTag}</div> : <Empty />}
  </>;
}

function CmdK({ fleets, onClose, onPick }: { fleets: FleetVM[]; onClose: () => void; onPick: (it: SearchItem) => void }) {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const index = useMemo(() => fleets.flatMap(searchIndex), [fleets]);
  const matches = useMemo(() => {
    const t = q.trim().toLowerCase();
    const hit = t ? index.filter((x) => `${x.name} ${x.hint ?? ""} ${x.keywords ?? ""} ${x.rowKey ?? ""}`.toLowerCase().includes(t)) : index;
    const out: SearchItem[] = [];
    for (const { id } of TABS) for (const x of hit) if (x.tab === id) out.push(x);
    return out;
  }, [q, index]);
  useEffect(() => { if (sel >= matches.length) setSel(0); }, [matches.length]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onClose(); }
      else if (e.key === "Tab") { e.preventDefault(); } // focus trap — keep focus on the input
      else if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => (matches.length ? (s + 1) % matches.length : 0)); }
      else if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => (matches.length ? (s - 1 + matches.length) % matches.length : 0)); }
      else if (e.key === "Enter") { e.preventDefault(); if (matches[sel]) onPick(matches[sel]); }
    };
    document.addEventListener("keydown", h);
    return () => document.removeEventListener("keydown", h);
  }, [matches, sel]);

  let i = -1, cur: string | null = null;
  return (
    <div class="cmdk open" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div class="cmdk-panel" role="dialog" aria-modal="true" aria-label="Search the fleet">
        <input autofocus role="combobox" aria-expanded="true" aria-controls="cmdk-list" aria-autocomplete="list"
          aria-activedescendant={matches.length ? `cmdk-opt-${sel}` : undefined}
          placeholder="Go to agent, command, pin, schedule…" aria-label="Global search" value={q}
          onInput={(e) => { setQ((e.target as HTMLInputElement).value); setSel(0); }} />
        <div class="cmdk-results" role="listbox" id="cmdk-list" aria-label="Search results">
          {matches.length === 0 && <div class="ci" style="opacity:.55;cursor:default">No matches</div>}
          {matches.map((m) => {
            i++; const flat = i; const header = m.tab !== cur ? (cur = m.tab) : null;
            return (
              <>
                {header && <div class="ci-group" role="presentation">{header}</div>}
                <div class={`ci${flat === sel ? " sel" : ""}`} role="option" id={`cmdk-opt-${flat}`} aria-selected={flat === sel}
                  onMouseEnter={() => setSel(flat)} onClick={() => onPick(m)}>
                  <Icon name={m.icon} /><span class="ci-name">{m.name}</span>{m.hint && <span class="ci-hint">{m.hint}</span>}
                </div>
              </>
            );
          })}
        </div>
        <div class="cmdk-foot"><span><kbd>↑↓</kbd>navigate</span><span><kbd>↵</kbd>open</span><span><kbd>esc</kbd>close</span></div>
      </div>
    </div>
  );
}

interface MenuState { items: MenuItem[]; x: number; y: number }
function MoreMenu({ menu, onClose }: { menu: MenuState | null; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const estimate = menu
    ? placeMoreMenu({
      anchorX: menu.x,
      anchorY: menu.y,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      menuWidth: 186,
      menuHeight: menu.items.length * 28 + 16,
    })
    : { left: 6, top: 6 };
  const [pos, setPos] = useState(estimate);
  useEffect(() => {
    if (!menu) return;
    const trigger = document.activeElement as HTMLElement | null; // restore focus here on close
    const items = () => Array.from(ref.current?.querySelectorAll<HTMLButtonElement>(".more-item") ?? []);
    setTimeout(() => items()[0]?.focus(), 0); // open with the first item focused (keyboard entry)
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onClose(); return; }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const list = items(); if (!list.length) return;
        const cur = list.indexOf(document.activeElement as HTMLButtonElement);
        const next = e.key === "ArrowDown" ? (cur + 1) % list.length : (cur - 1 + list.length) % list.length;
        list[next]?.focus();
      }
    };
    // Webview is an iframe: clicks on the editor never hit .menu-backdrop. Close when the
    // webview loses focus (blur) or is hidden so the overflow menu does not stay stuck.
    const dismissOnFocusLoss = () => onClose();
    const onVisibility = () => { if (document.hidden) onClose(); };
    document.addEventListener("keydown", h);
    window.addEventListener("blur", dismissOnFocusLoss);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("keydown", h);
      window.removeEventListener("blur", dismissOnFocusLoss);
      document.removeEventListener("visibilitychange", onVisibility);
      trigger?.focus?.();
    };
  }, [menu]); // onClose is stable enough for this session menu; avoid re-bind loops from inline lambdas
  useLayoutEffect(() => {
    if (!menu) return;
    setPos(estimate);
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setPos(placeMoreMenu({
      anchorX: menu.x,
      anchorY: menu.y,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      menuWidth: rect.width || 186,
      menuHeight: rect.height || menu.items.length * 28 + 16,
    }));
  }, [menu]);
  if (!menu) return null;
  return (
    <div class="menu-backdrop" onClick={onClose}>
      <div ref={ref} class="more-menu" role="menu" aria-label="Actions" style={`left:${pos.left}px;top:${pos.top}px`} onClick={(e) => e.stopPropagation()}>
        {menu.items.map((it) => (
          <button class="more-item" type="button" role="menuitem" onClick={() => { it.run(); onClose(); }}>
            {it.icon ? <Icon name={it.icon} /> : null}<span>{it.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/** spec 415 — Tachyon's sole non-modal attention surface. */
function AttentionStack({ fleets, dispatch }: { fleets: FleetVM[]; dispatch?: Dispatch }) {
  const rows = useMemo(() => attentionRows(fleets), [fleets]);
  if (rows.length === 0) return null;
  return (
    <section class="attention-stack" aria-labelledby="attention-title">
      <div class="attention-head">
        <span class="attention-title" id="attention-title">
          <Icon name="bell-dot" /> Attention
          <span class="notice-unread" title={`${rows.length} open`}>{rows.length}</span>
        </span>
        <Button class="attention-clear"
          title="Dismiss all attention items"
          onClick={() => {
            for (const f of fleets) {
              if ((f.notices ?? []).some((n) => !n.read)) {
                dispatch?.section("notice:markAllRead", "all", undefined, f.folder?.hash);
              }
            }
          }}
        >
          Clear
        </Button>
      </div>
      <div class="attention-list" role="list">
        {rows.map(({ n, hash, folder }) => {
          const { body, author } = splitNoticeAuthor(n.message);
          return (
          <article class={`attention-card level-${n.level}`} role="listitem" key={`${hash ?? ""}:${n.id}`}>
            <div class="attention-card-head">
              <span class={`notice-level l-${n.level}`}>{n.level}</span>
              {folder && fleets.length > 1 ? <span class="attention-folder">{folder}</span> : null}
              <time class="attention-time" dateTime={n.at} title={new Date(n.at).toLocaleString()}>
                {new Date(n.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
              </time>
              {n.collapsedCount > 1 && <span class="notice-x" title={`${n.collapsedCount} occurrences`}>×{n.collapsedCount}</span>}
              <Button class="attention-dismiss"
                title="Dismiss"
                aria-label={`Dismiss: ${n.message}`}
                onClick={() => dispatch?.section("notice:markRead", n.id, undefined, hash)}
              >
                <Icon name="close" />
              </Button>
            </div>
            <div class="attention-message">{body}</div>
            {/* t-8aeaac follow-up — one footer row: author on the left (when the message carried
                one), actions on the right; empty and collapses cleanly when neither is present. */}
            {(author || n.actions.length > 0) && <div class="attention-foot">
              <span class="attention-author">{author}</span>
              {n.actions.length > 0 && <div class="attention-actions">
                {n.actions.map((a) => n.actionsLive ? (
                <Button
                  key={a.id}
                  class="attention-action"
                  title={a.label}
                  onClick={() => dispatch?.section("notice:invoke", n.id, { actionId: a.id }, hash)}
                >
                  {a.label}
                </Button>
                ) : <span class="attention-action-expired" key={a.id} title={`${a.label} is unavailable after engine restart`}>{a.label} unavailable</span>)}
              </div>}
            </div>}
          </article>
          );
        })}
      </div>
    </section>
  );
}

export function App({ fleets = [SAMPLE], dispatch, prefs = {}, collapsedKeys = [] }: { fleets?: FleetVM[]; dispatch?: Dispatch; prefs?: { agents?: string; terminals?: string }; collapsedKeys?: string[]; appVersion?: string }) {
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [tab, setTab] = useState<TabId>("Agents");
  const [open, setOpen] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set(collapsedKeys));
  /** spec 386 — which agents show resource detail lanes (`${wsHash}:m:${name}`); session-local. */
  const [metricsOpen, setMetricsOpen] = useState<Set<string>>(() => new Set());
  const [flashName, setFlashName] = useState<string | null>(null);
  const [activePinTag, setActivePinTag] = useState<string | null>(null);
  /** t-eddf90/t-a9d1f2 — session-local Agents status filter (like pin tags; not host-persisted). */
  const [agentFilter, setAgentFilter] = useState<AgentStatusFilter>("all");
  // spec 242 — sort: the host's persisted pref seeds it; a user choice this session OVERRIDES (and persists),
  // so a stale fleet snapshot can never revert the user's pick (codex D9). Default name-asc.
  const [sortOverride, setSortOverride] = useState<{ agents?: SortMode; terminals?: SortMode }>({});
  const sortAgents = sortOverride.agents ?? asSortMode(prefs.agents);
  const sortTerminals = sortOverride.terminals ?? asSortMode(prefs.terminals);
  const changeSort = (section: "agents" | "terminals", mode: SortMode) => {
    setSortOverride((o) => ({ ...o, [section]: mode })); // optimistic + session-authoritative
    dispatch?.setSort?.(section, mode); // persist for next load
  };
  const isMac = (navigator.platform || "").toLowerCase().includes("mac");
  const collapsedKeySig = collapsedKeys.join("\0");
  useEffect(() => {
    setCollapsed(new Set(collapsedKeys));
  }, [collapsedKeySig]);
  const updateCollapsed = (next: (cur: Set<string>) => Set<string>) => {
    setCollapsed((cur) => {
      const n = next(cur);
      dispatch?.setCollapsedKeys?.([...n]);
      return n;
    });
  };
  const toggle = (k: string) => updateCollapsed((c) => { const n = new Set(c); n.has(k) ? n.delete(k) : n.add(k); return n; });
  const toggleMetrics = (scope: string, agentName: string) => {
    const key = `${scope}:m:${agentName}`;
    setMetricsOpen((cur) => {
      const n = new Set(cur);
      n.has(key) ? n.delete(key) : n.add(key);
      return n;
    });
  };
  const setAllMetrics = (open: boolean) => {
    setMetricsOpen(() => {
      const n = new Set<string>();
      if (open) {
        for (const f of fleets) {
          const scope = f.folder?.hash ?? "";
          for (const a of f.agents) {
            if (a.resources) n.add(`${scope}:m:${a.name}`);
          }
        }
      }
      return n;
    });
  };
  const pinTags = useMemo(() => [...new Set(fleets.flatMap((f) => f.pins.flatMap((p) => p.tags)))].sort((a, b) => a.localeCompare(b)), [fleets]);
  const metricsCapable = useMemo(
    () => fleets.reduce((n, f) => n + f.agents.filter((a) => a.resources).length, 0),
    [fleets],
  );
  const metricsOpenCount = metricsOpen.size;
  /** t-eddf90 — chip counts from the full multi-root fleet (stable anchors, not the filtered subset). */
  const agentFilterCounts = useMemo(
    () => countAgentStatusFilters(fleets.flatMap((f) => f.agents)),
    [fleets],
  );
  const totalAgents = agentFilterCounts.all;

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setOpen((o) => !o); } };
    document.addEventListener("keydown", h);
    return () => document.removeEventListener("keydown", h);
  }, []);

  useEffect(() => {
    if (activePinTag && !pinTags.includes(activePinTag)) setActivePinTag(null);
  }, [activePinTag, pinTags]);

  // Auto-expand a pipeline group the moment it goes active (a run starts) — like the tree's run-aware id.
  // Only on the idle→active TRANSITION, so the user can still collapse a running pipeline afterward.
  const prevActive = useRef<Set<string>>(new Set());
  useEffect(() => {
    const active = new Set<string>();
    for (const f of fleets) for (const p of f.pipelines) if (p.status !== "idle") active.add(`${f.folder?.hash ?? ""}:p:${p.name}`);
    const newly = [...active].filter((k) => !prevActive.current.has(k));
    if (newly.length) updateCollapsed((c) => { const n = new Set(c); for (const k of newly) n.delete(k); return n; });
    prevActive.current = active;
  }, [fleets]);

  const pick = (it: SearchItem) => {
    setOpen(false); setTab(it.tab);
    if (it.tab === "Pins") setActivePinTag(null);
    if (it.tab === "Agents") {
      const fleet = fleets.find((f) => (f.folder?.hash ?? undefined) === it.wsHash) ?? fleets[0];
      const ancestors = fleet ? agentAncestorNames(fleet.agents, it.name) : [];
      if (ancestors.length) {
        const scope = fleet?.folder?.hash ?? "";
        updateCollapsed((c) => {
          const n = new Set(c);
          for (const parent of ancestors) n.delete(`${scope}:a:${parent}`);
          return n;
        });
      }
    }
    setFlashName(it.name);
    // Scroll + flash the row in ANY section, scoped to the item's folder (multi-root) so a duplicate name
    // in another root doesn't win. Match data-name in JS (no fragile selector escaping for arbitrary text).
    setTimeout(() => {
      const root = it.wsHash ? document.querySelector(`.ws-scope[data-ws="${it.wsHash}"]`) ?? document : document;
      const target = (it.rowKey ?? it.name).toLowerCase();
      const el = [...root.querySelectorAll("[data-name]")].find((e) => e.getAttribute("data-name") === target);
      el?.scrollIntoView({ block: "center" });
      el?.classList.add("flash");
      setTimeout(() => el?.classList.remove("flash"), 1100);
    }, 0);
    setTimeout(() => setFlashName(null), 1100);
  };

  const tabKey = (e: KeyboardEvent, idx: number) => {
    let n = idx;
    if (e.key === "ArrowRight") n = (idx + 1) % TABS.length;
    else if (e.key === "ArrowLeft") n = (idx - 1 + TABS.length) % TABS.length;
    else if (e.key === "Home") n = 0;
    else if (e.key === "End") n = TABS.length - 1;
    else return;
    e.preventDefault();
    const id = TABS[n].id;
    setTab(id);
    setTimeout(() => document.getElementById(`tab-${id}`)?.focus(), 0);
  };
  const closeK = () => { setOpen(false); setTimeout(() => document.getElementById("kbar-trigger")?.focus(), 0); };

  // One curried bridge per folder — rows dispatch without knowing their wsHash; the closure routes it.
  const ctxFor = (hash?: string): SidebarCtx => ({
    action: (id, agent) => dispatch?.action(id, agent, hash),
    section: (op, id, extra) => dispatch?.section(op, id, extra, hash),
    global: (op) => dispatch?.global(op, hash),
    pipeline: (op, name, nodeId) => dispatch?.pipeline(op, name, nodeId, hash),
    openMore: (items, x, y) => setMenu({ items, x, y }),
  });
  // No workspace booted → an honest empty state, never SAMPLE (which would show fake, unactionable rows).
  if (!fleets.length) return (
    <div class="init">
      <Icon name="rocket" />
      <p>No Tachyon workspace.</p>
      <p class="dim">Open a folder, then generate a <code>tachyon.yml</code> to manage its fleet here.</p>
      <Button class="init-btn" onClick={() => dispatch?.global("init")}>
        <Icon name="add" /><span>Initialize Tachyon</span>
      </Button>
    </div>
  );
  const renderFolder = (f: FleetVM) => (
    <DispatchCtx.Provider value={ctxFor(f.folder?.hash)}>
      <div class="ws-scope" data-ws={f.folder?.hash ?? ""}>
        <Panel
          tab={tab}
          fleet={f}
          scope={f.folder?.hash ?? ""}
          collapsed={collapsed}
          toggle={toggle}
          flashName={flashName}
          agentSort={sortAgents}
          terminalSort={sortTerminals}
          activePinTag={activePinTag}
          onPinTag={setActivePinTag}
          metricsOpen={metricsOpen}
          onToggleMetrics={(name) => toggleMetrics(f.folder?.hash ?? "", name)}
          agentFilter={agentFilter}
        />
      </div>
    </DispatchCtx.Provider>
  );

  return (
    <>
      <div class="kbar" id="kbar-trigger" role="button" tabindex={0} aria-label={`Search agents, commands, pins (${isMac ? "Cmd K" : "Ctrl K"})`}
        onClick={() => setOpen(true)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpen(true); } }}>
        <Icon name="search" /><span class="kgrow">Search agents, commands, pins…</span><span class="kbd">{isMac ? "⌘K" : "Ctrl K"}</span>
      </div>
      <AttentionStack fleets={fleets} dispatch={dispatch} />
      <div class="tabs" role="tablist" aria-label="Sidebar sections">
        {TABS.map(({ id, icon }, i) => (
          <button class={`tab${tab === id ? " active" : ""}`} type="button" role="tab" id={`tab-${id}`}
            aria-selected={tab === id} aria-controls="sidebar-panel" aria-label={id}
            tabindex={tab === id ? 0 : -1} onClick={() => setTab(id)} onKeyDown={(e) => tabKey(e, i)}>
            <Icon name={icon} />
          </button>
        ))}
      </div>
      <div class="sec">
        <b>{tab}</b>
        {(tab === "Agents" || tab === "Terminals") && (() => {
          const section = tab === "Agents" ? "agents" : "terminals";
          const active = section === "agents" ? sortAgents : sortTerminals;
          // A–Z ⇄ Z–A toggle (one click flips direction); no menu — there are only two alphabetical modes.
          const flipSort = () => changeSort(section, active === "name-asc" ? "name-desc" : "name-asc");
          // spec 386 — one icon toggle for all metrics (same act affordance as sort/add), not two text buttons.
          const allMetricsOpen = metricsCapable > 0 && metricsOpenCount >= metricsCapable;
          const flipAllMetrics = () => setAllMetrics(!allMetricsOpen);
          return <>
            <span class="sec-actions">
              {tab === "Agents" && totalAgents > 0 && (
                <select
                  class={`agent-filter-select${agentFilter !== "all" ? " on" : ""}`}
                  value={agentFilter}
                  title={`Filter agents — ${AGENT_STATUS_FILTER_LABEL[agentFilter]} (${agentFilterCounts[agentFilter]})`}
                  aria-label={`Filter agents by status; selected ${AGENT_STATUS_FILTER_LABEL[agentFilter]}, ${agentFilterCounts[agentFilter]} agents`}
                  onChange={(e) => setAgentFilter(asAgentStatusFilter((e.currentTarget as HTMLSelectElement).value))}
                >
                  {AGENT_STATUS_FILTERS.map((filter) => {
                    const count = agentFilterCounts[filter];
                    return (
                      <option key={filter} value={filter} disabled={filter !== "all" && count === 0}>
                        {AGENT_STATUS_FILTER_LABEL[filter]} · {count}
                      </option>
                    );
                  })}
                </select>
              )}
              {tab === "Agents" && metricsCapable > 0 && (
                <button
                  type="button"
                  class={`act${allMetricsOpen ? " on" : ""}`}
                  title={allMetricsOpen ? "Collapse all resource metrics" : "Expand all resource metrics"}
                  aria-label={allMetricsOpen ? "Collapse all resource metrics" : "Expand all resource metrics"}
                  aria-pressed={allMetricsOpen}
                  onClick={flipAllMetrics}
                >
                  <Icon name="graph" />
                </button>
              )}
              <button type="button" class="act" title={`Sort ${section} — ${SORT_LABEL[active]} (click to flip)`} aria-label={`Sort ${section} (${SORT_LABEL[active]}); click to flip`} onClick={flipSort}><SortIcon dir={active} /></button>
              {STUDIO_OF[tab] && <Act icon="add" title={STUDIO_OF[tab]!.label} on={() => dispatch?.global(STUDIO_OF[tab]!.op)} />}
            </span>
          </>;
        })()}
        {tab !== "Agents" && tab !== "Terminals" && STUDIO_OF[tab] && <span class="sec-new"><Act icon="add" title={STUDIO_OF[tab]!.label} on={() => dispatch?.global(STUDIO_OF[tab]!.op)} /></span>}
        {tab === "Pins" && (
          <span class="sec-actions pin-filter">
            {pinTags.length > 0 && (
              <select value={activePinTag ?? ""} title="Filter pins by tag" aria-label="Filter pins by tag"
                onChange={(e) => setActivePinTag((e.currentTarget as HTMLSelectElement).value || null)}>
                <option value="">all tags</option>
                {pinTags.map((tag) => <option value={tag}>#{tag}</option>)}
              </select>
            )}
            {activePinTag && <Button class="tag-clear" title={`Clear #${activePinTag} filter`} onClick={() => setActivePinTag(null)}>#{activePinTag}<Icon name="close" /></Button>}
            <Act icon="add" title="Add pin" on={() => dispatch?.global("addPin")} />
          </span>
        )}
      </div>
      <div class="panel active" role="tabpanel" id="sidebar-panel" aria-labelledby={`tab-${tab}`} tabindex={0}>
        {fleets.map((f) => {
          // spec 331 (pin p-cf707f) — the folder header is the workspace identity line, ALWAYS present:
          // single-root is multi-root with N=1, one code path. It's where the Project Handoff chip lives.
          const fkey = `folder:${f.folder?.hash}`;
          const fcoll = collapsed.has(fkey);
          return (
            <>
              <div class={`grp folder${fcoll ? " collapsed" : ""}`} role="button" tabindex={0}
                onClick={() => toggle(fkey)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(fkey); } }}>
                <span class="chev">▼</span><Icon name="folder" /><span>{f.folder?.name}</span>
                <HandoffBtn handoff={f.handoff} onOpen={() => dispatch?.global("openHandoff", f.folder?.hash)} />
              </div>
              {!fcoll && <div class="folder-body">{renderFolder(f)}</div>}
            </>
          );
        })}
      </div>
      {open && <CmdK fleets={fleets} onClose={closeK} onPick={pick} />}
      <MoreMenu menu={menu} onClose={() => setMenu(null)} />
    </>
  );
}
