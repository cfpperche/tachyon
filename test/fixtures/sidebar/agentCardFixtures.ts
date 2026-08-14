/**
 * SDD 479 phase 1 — the fixture matrix the card-equality proof runs over.
 *
 * The set is chosen so that every catalog component appears at least once in its rendering AND its
 * non-rendering state, plus the structural cases that decide wrappers rather than content: a row with
 * no meta at all, a row whose `.row-meta` renders EMPTY today (an existing quirk of the `hasMeta`
 * predicate, preserved on purpose), children collapsed/expanded, metrics open/closed, and terminal
 * rows — which share this component and must come out unchanged (§ V1 boundary: agent cards only).
 *
 * Real product data is reused where it exists (`SAMPLE` from the sidebar view-model) instead of being
 * re-invented here, so the proof covers the rows the preview harness and the shipped sample show.
 */
import { SAMPLE, type AgentVM } from "@tachyon/shared/sidebar/types.js";

/** Props `AgentRow` accepts. Declared here because the component's prop type is inline (not exported). */
export interface AgentCardProps {
  a: AgentVM;
  flash: boolean;
  nested?: boolean;
  hasChildren?: boolean;
  collapsed?: boolean;
  hiddenCount?: number;
  hiddenNeedsAttention?: boolean;
  onToggle?: () => void;
  metricsOpen?: boolean;
  onToggleMetrics?: () => void;
}

export interface AgentCardFixture {
  name: string;
  props: AgentCardProps;
}

/**
 * `externalToolBadgeTitle` formats this with `toLocaleString()`, which is machine-dependent (locale +
 * timezone). The rendered form is scrubbed by `scrubLocaleTimestamps` so the golden file stays a
 * statement about the CARD and not about the machine that captured it.
 */
export const EXTERNAL_TOOL_STARTED_AT = "2026-07-27T12:00:00.000Z";

export function scrubLocaleTimestamps(html: string): string {
  const rendered = new Date(EXTERNAL_TOOL_STARTED_AT).toLocaleString();
  return html.split(rendered).join("«startedAt»");
}

const noop = () => {};

function agent(overrides: Partial<AgentVM> & { name: string }): AgentVM {
  return { status: "running", kind: "agent", ...overrides };
}

/** Every badge-bearing field set at once — the densest card the product can produce. */
const EVERYTHING: AgentVM = agent({
  name: "everything",
  model: "Opus 5",
  modelSource: "observed",
  modelDivergence: true,
  status: "needs",
  attention: "needs input",
  sub: "waiting on approval",
  worktree: "tachyon/change/everything",
  liveBranch: "tachyon/change/other",
  branchDrift: true,
  worktreePath: "/cache/everything",
  resources: { cpuPct: 91, memMb: 3072 },
  harness: true,
  resumable: true,
  freshStart: true,
  forked: true,
  continuity: "stale",
  focus: { text: "landing the catalog", source: "task", taskId: "t-067540", full: "landing the catalog through the closed catalog" },
  persistenceHooks: { state: "failed", reason: "hook script exited 1" },
  evidence: { total: 7, stale: 2, warn: 1, error: 3 },
  externalTools: {
    active: 2,
    kinds: ["browser"],
    strongestConfidence: "weak",
    items: [
      { id: "e1", kind: "browser", tool: "chrome", pid: 4242, windowId: "w-1", startedAt: EXTERNAL_TOOL_STARTED_AT, source: "registry", confidence: "strong" },
      { id: "e2", kind: "screen", tool: "scrot", startedAt: EXTERNAL_TOOL_STARTED_AT, source: "probe", confidence: "weak" },
    ],
  },
  awaitingHuman: { reason: "ratify the schema" },
  authRequired: { runtime: "claude", action: "run `claude login`" },
  configInvalid: true,
  adhoc: true,
  forkable: true,
  canDismiss: true,
});

export const AGENT_CARD_FIXTURES: readonly AgentCardFixture[] = [
  // ── the shipped sample fleet, rendered exactly as the Agents tab renders it ──────────────────
  ...SAMPLE.agents.map((a) => ({ name: `sample:${a.name}`, props: { a, flash: false } })),
  // ── terminals: same component, different arm. Must be untouched by anything this spec adds ──
  ...SAMPLE.terminals.map((a) => ({ name: `terminal:${a.name}`, props: { a, flash: false } })),

  // ── structural cases (wrappers, not content) ────────────────────────────────────────────────
  { name: "minimal", props: { a: agent({ name: "minimal" }), flash: false } },
  { name: "flashing", props: { a: agent({ name: "flashing" }), flash: true } },
  {
    // `hasMeta` is true (worktree is set) but no meta component renders: `.row-meta` comes out EMPTY.
    // Today's quirk, pinned so the refactor cannot "fix" it silently.
    name: "empty-meta-quirk",
    props: { a: agent({ name: "empty-meta", worktree: "tachyon/change/x" }), flash: false },
  },
  {
    name: "nested-child",
    props: { a: agent({ name: "child", parent: "orchestrator", sub: "delegated" }), flash: false, nested: true },
  },
  {
    name: "collapsed-with-hidden-attention",
    props: {
      a: agent({ name: "parent", model: "Sonnet 5", modelSource: "declared" }),
      flash: false,
      hasChildren: true,
      collapsed: true,
      hiddenCount: 3,
      hiddenNeedsAttention: true,
      onToggle: noop,
    },
  },
  {
    name: "expanded-with-children",
    props: { a: agent({ name: "parent-open" }), flash: false, hasChildren: true, collapsed: false, onToggle: noop },
  },
  {
    name: "metrics-open-hot",
    props: {
      a: agent({ name: "hot", resources: { cpuPct: 96, memMb: 1536 } }),
      flash: false,
      metricsOpen: true,
      onToggleMetrics: noop,
    },
  },
  {
    name: "metrics-open-no-cpu",
    props: {
      a: agent({ name: "no-cpu", resources: { memMb: 64 } }),
      flash: false,
      metricsOpen: true,
      onToggleMetrics: noop,
    },
  },
  {
    // resources present but the status is not live-ish → no pill, no lanes even when metricsOpen.
    name: "metrics-suppressed-by-status",
    props: {
      a: agent({ name: "stopping", status: "stopping", resources: { cpuPct: 5, memMb: 100 } }),
      flash: false,
      metricsOpen: true,
      onToggleMetrics: noop,
    },
  },

  // ── identity / model provenance (spec 378) ──────────────────────────────────────────────────
  { name: "model-declared", props: { a: agent({ name: "m-declared", model: "Opus 5", modelSource: "declared" }), flash: false } },
  { name: "model-profile", props: { a: agent({ name: "m-profile", model: "Opus 5", modelSource: "profile" }), flash: false } },
  { name: "model-observed", props: { a: agent({ name: "m-observed", model: "Opus 5", modelSource: "observed" }), flash: false } },
  { name: "model-stale", props: { a: agent({ name: "m-stale", model: "Opus 5", modelSource: "observed", modelStale: true }), flash: false } },
  { name: "model-divergent", props: { a: agent({ name: "m-diverged", model: "Haiku 4.5", modelSource: "declared", modelDivergence: true }), flash: false } },
  { name: "model-without-source", props: { a: agent({ name: "m-nosource", model: "Opus 5" }), flash: false } },

  // ── branch (spec 384) ───────────────────────────────────────────────────────────────────────
  { name: "branch-shared", props: { a: agent({ name: "b-shared", liveBranch: "main", worktreePath: "/ws" }), flash: false } },
  { name: "branch-isolated", props: { a: agent({ name: "b-iso", worktree: "tachyon/change/b", liveBranch: "tachyon/change/b", worktreePath: "/cache/b" }), flash: false } },
  { name: "branch-drift", props: { a: agent({ name: "b-drift", worktree: "tachyon/change/b", liveBranch: "detached", branchDrift: true }), flash: false } },

  // ── each badge on its own, so a mis-ordered region cannot hide behind a neighbour ────────────
  { name: "badge-config-invalid", props: { a: agent({ name: "cfg", configInvalid: true }), flash: false } },
  { name: "badge-attention", props: { a: agent({ name: "attn", attention: "needs input" }), flash: false } },
  { name: "badge-attention-working", props: { a: agent({ name: "attn-working", attention: "working" }), flash: false } },
  { name: "badge-awaiting-human", props: { a: agent({ name: "human", awaitingHuman: { reason: "review the diff" } }), flash: false } },
  { name: "badge-awaiting-human-no-reason", props: { a: agent({ name: "human2", awaitingHuman: { reason: "" } }), flash: false } },
  { name: "badge-auth-required", props: { a: agent({ name: "auth", status: "idle", authRequired: { runtime: "codex", action: "run `codex login`" } }), flash: false } },
  { name: "badge-evidence-clean", props: { a: agent({ name: "ev-ok", evidence: { total: 2, stale: 0, warn: 0, error: 0 } }), flash: false } },
  { name: "badge-evidence-warn", props: { a: agent({ name: "ev-warn", evidence: { total: 4, stale: 1, warn: 2, error: 0 } }), flash: false } },
  { name: "badge-evidence-error", props: { a: agent({ name: "ev-err", evidence: { total: 5, stale: 0, warn: 0, error: 1 } }), flash: false } },
  {
    name: "badge-external-tool-single",
    props: {
      a: agent({
        name: "tool-1",
        externalTools: {
          active: 1,
          kinds: ["desktop"],
          strongestConfidence: "strong",
          items: [{ id: "t1", kind: "desktop", tool: "vscode", pid: 7, startedAt: EXTERNAL_TOOL_STARTED_AT, source: "registry", confidence: "strong" }],
        },
      }),
      flash: false,
    },
  },
  {
    name: "badge-external-tool-unknown-kind",
    props: {
      a: agent({
        name: "tool-unknown",
        externalTools: {
          active: 1,
          kinds: [],
          strongestConfidence: "weak",
          items: [{ id: "t2", kind: "other", tool: "mystery", startedAt: EXTERNAL_TOOL_STARTED_AT, source: "probe", confidence: "weak" }],
        },
      }),
      flash: false,
    },
  },
  { name: "badge-harness", props: { a: agent({ name: "harness", harness: true }), flash: false } },
  { name: "badge-resumable", props: { a: agent({ name: "res", status: "stopped", resumable: true }), flash: false } },
  { name: "badge-fresh-start", props: { a: agent({ name: "fresh", status: "stopped", resumable: true, freshStart: true }), flash: false } },
  { name: "badge-fork", props: { a: agent({ name: "fork", forked: true }), flash: false } },
  { name: "badge-continuity-stale", props: { a: agent({ name: "cont-stale", continuity: "stale" }), flash: false } },
  { name: "badge-continuity-missing", props: { a: agent({ name: "cont-missing", continuity: "missing" }), flash: false } },
  { name: "badge-continuity-fresh", props: { a: agent({ name: "cont-fresh", continuity: "fresh" }), flash: false } },
  { name: "badge-hooks-failed", props: { a: agent({ name: "hooks-failed", persistenceHooks: { state: "failed", reason: "exit 1" } }), flash: false } },
  { name: "badge-hooks-skipped", props: { a: agent({ name: "hooks-skipped", persistenceHooks: { state: "skipped" } }), flash: false } },
  { name: "badge-hooks-unknown", props: { a: agent({ name: "hooks-unknown", persistenceHooks: { state: "unknown" } }), flash: false } },
  { name: "badge-hooks-active", props: { a: agent({ name: "hooks-active", persistenceHooks: { state: "active" } }), flash: false } },

  // ── focus line (spec 390) ───────────────────────────────────────────────────────────────────
  { name: "focus-task", props: { a: agent({ name: "f-task", focus: { text: "phase 1", source: "task", taskId: "t-067540", full: "phase 1 — catalog" } }), flash: false } },
  { name: "focus-brief", props: { a: agent({ name: "f-brief", focus: { text: "read the brief", source: "brief", full: "read the brief" } }), flash: false } },
  { name: "focus-continuity", props: { a: agent({ name: "f-goal", focus: { text: "ship the slice", source: "continuity", full: "ship the slice" } }), flash: false } },

  // ── the edges the narrow sidebar cares about ────────────────────────────────────────────────
  {
    name: "long-strings",
    props: {
      a: agent({
        name: "a-very-long-agent-name-that-will-not-fit-in-the-narrow-sidebar-at-all",
        model: "claude-opus-5-with-an-implausibly-long-label",
        modelSource: "declared",
        sub: "a sub line long enough to wrap twice at the sidebar's minimum practical width",
        liveBranch: "tachyon/change/a-branch-name-that-is-also-far-too-long-to-fit",
        focus: { text: "an unusually long focus line that has to truncate somewhere sensible", source: "task", taskId: "t-abcdef", full: "…" },
      }),
      flash: false,
    },
  },
  { name: "escaping", props: { a: agent({ name: "<script>&\"'", model: "<b>m</b>", modelSource: "declared", sub: "a & b < c" }), flash: false } },

  // ── every state at once ─────────────────────────────────────────────────────────────────────
  {
    name: "everything",
    props: {
      a: EVERYTHING,
      flash: true,
      hasChildren: true,
      collapsed: true,
      hiddenCount: 2,
      hiddenNeedsAttention: true,
      onToggle: noop,
      metricsOpen: true,
      onToggleMetrics: noop,
    },
  },
];
