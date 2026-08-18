/**
 * spec 237 — the sidebar view-model (framework-agnostic, no preact/vscode imports).
 * The Preact UI renders ONLY from these types. Today the data is SAMPLE; the real build swaps
 * `SAMPLE` for a model produced by the (extracted) rules layer reading live fleet state — the
 * components don't change. This is the "UI decoupled from rules" contract.
 */
import type { ConfigDiscardsVM } from "../config/configDiscards.js";
import type { EntryKind } from "../config/entry.js";
import type { ResumeRuntime } from "@tachyon/shared/resume/adapters.js";
import type { TiptapJSON } from "@tachyon/shared/richDoc/types.js";
import type { ExternalToolsSummaryVM } from "@tachyon/shared/externalTools/types.js";

export type AgentStatus = "running" | "needs" | "throttled" | "idle" | "stopping" | "stop-failed" | "stopped" | "crashed";
/** spec 378 — where `AgentVM.model` came from: a live transcript observation, an explicit `--model` flag,
 *  or the runtime's profile default (no explicit flag, no observation yet). */
export type ModelSource = "observed" | "declared" | "profile";
/** spec 241 — per-agent continuity brief freshness: missing (none yet) | stale (behind activity) | fresh. */
/** spec 390 — source of the human-glance focus line on an agent row. */
export type FocusSource = "task" | "brief" | "continuity";
/** spec 390 — projected "what this agent is working on" for fleet glance. */
export interface AgentFocus {
  text: string;
  source: FocusSource;
  taskId?: string;
  /** Board status of the assigned card. Present only when source === "task". */
  taskStatus?: "triaged" | "active";
  full: string;
}
/**
 * t-281339 — one operator line on the sidebar card: the current checklist
 * step, or a discrete `absent` mark. `no-channel` is absence (omit the field).
 */
export type AgentChecklistLine =
  | { kind: "step"; text: string }
  | { kind: "absent" };
export type PersistenceHookBadge = "active" | "skipped" | "failed" | "unknown";
/** spec 273 — a compact, mechanical evidence indicator for a worktree agent (advisory; never a gate). */
export interface EvidenceBadge {
  total: number;
  stale: number;
  warn: number;
  error: number;
}

export interface AgentVM {
  name: string;
  /** Active LLM model label — observed from the runtime's own transcript when available, else the declared
   *  `--model` flag, else the runtime's profile default (spec 378). */
  model?: string;
  /** spec 378 — provenance for `model`; undefined only when `model` itself is undefined. */
  modelSource?: ModelSource;
  /** spec 378 — when `modelSource === "observed"`, the transcript timestamp of that observation. */
  modelObservedAt?: string;
  /** spec 378 — an observed model carried across a process-preserving session boundary (in-TUI `/clear`,
   *  resume) without a fresh observation yet. */
  modelStale?: boolean;
  /** spec 378 / t-1464cf — observed label differs from an explicitly declared `--model` (same alias table both sides). */
  modelDivergence?: boolean;
  /**
   * SDD 479 phase 3 — the runtime this row runs on (`claude`, `codex`, …), derived from its command by
   * the same `runtimeOf` the model label uses, so a row cannot report one runtime to the card and
   * another to the model. Absent for terminals and for a command whose binary Tachyon does not
   * recognize. It selects a per-runtime card template; it is a runtime NAME, not a capability claim.
   */
  runtime?: ResumeRuntime;
  status: AgentStatus;
  attention?: string;
  parent?: string;
  /** Bridge-resolved requester for a gated delegation. Separate from runtime parent and declaredOwner. */
  delegator?: string;
  declaredOwner?: string;
  sub?: string;
  /** Config/ledger branch when the agent has a separate worktree (gates Review/PR/Remove). Not necessarily live HEAD. */
  worktree?: string;
  /** spec 384 — live HEAD branch name in the agent's session cwd (sidebar badge). */
  liveBranch?: string;
  /** spec 384 — live HEAD differs from the isolation/config branch (`worktree`). */
  branchDrift?: boolean;
  /** spec 384 — absolute session cwd (worktree path or workspace root); tooltip only. */
  worktreePath?: string;
  /** spec 386 — live CPU/RSS for the agent pane subtree (running agents only). */
  resources?: { cpuPct?: number; memMb: number };
  harness?: boolean;
  resumable?: boolean;
  /** resumable, but the saved transcript is gone → ↻ Resume degrades to a fresh start (spec 221). */
  freshStart?: boolean;
  /** has a DEAD pane from a clean exit (exit 0) — status is "stopped" for grouping, but a postmortem pane
   *  may still exist internally. The UI should route through Activity/Resume/Restart instead of reopening
   *  that dead terminal. Distinguishes it from killed/never-run. */
  exited?: boolean;
  /**
   * Whether a tmux pane EXISTS for this row — measured, and the authority over the status-shaped guess
   * `hasPane` falls back to. `false` when the process exited cleanly and Tachyon already cleared the
   * dead terminal; `true` for any dead pane still held for postmortem (t-9d76b1, where a requested stop
   * became `stopped` and the fallback would have denied its own pane).
   */
  pane?: boolean;
  /** this agent IS a forked sibling (spec 225 — `def.fork`); drives the ⑂ fork badge. */
  forked?: boolean;
  /** spec 390 — glance focus line (task / brief / continuity goal); omit when no source. */
  focus?: AgentFocus;
  /** t-281339 — current checklist step, or `absent`. Omit for mute / all-completed / `no-channel`. */
  checklist?: AgentChecklistLine;
  /** spec 316 — runtime-native persistence hook health for declared Claude/Codex agents. */
  persistenceHooks?: { state: PersistenceHookBadge; reason?: string; path?: string; updatedAt?: string };
  /** spec 273 — non-binary evidence indicator (undefined = none); advisory, never gates. */
  evidence?: EvidenceBadge;
  /** t-327f81 — compact external GUI/tool attribution projected from the runtime-owned registry. */
  externalTools?: ExternalToolsSummaryVM;
  /** t-35d95a — AttentionMonitor.awaitingHuman latch (request_human_attention): an AUTHORED
   *  "I need a human" signal, independent of `attention`/`status`. Undefined = not latched. */
  awaitingHuman?: { reason: string };
  /** SDD 477 / t-5bfb72 — AttentionMonitor.authRequired latch: the runtime itself reported it is not
   *  authenticated, so this row is idle because it CANNOT run, not because it finished. Independent
   *  of `attention`/`status`; undefined = not latched. `action` is the measured human action; neither
   *  field ever carries credential material. */
  authRequired?: { runtime: string; action: string };
  /** t-8354ae — row is shown while tachyon.yml is invalid (ledger and/or LKG). */
  configInvalid?: boolean;
  /**
   * t-0ad300 — this agent is declared and was REFUSED, carrying why. Distinct from `configInvalid`,
   * which says "the file has a problem somewhere". This says "the problem is THIS agent, and it is
   * the reason you cannot start it".
   *
   * The row exists precisely so the refusal is visible and Agent Studio stays reachable — that is
   * where the human repairs it. Dropping the row would hide both.
   */
  refused?: string;
  /**
   * SDD 478 M5 — the managed-entry arm this row renders, carried straight through from the config
   * union. It replaces `ai?: boolean`, which was a SECOND, independent encoding of the same
   * distinction: optional, so its absence meant "agent" to the model/focus code and "terminal" to
   * the action gate, and settable without the union ever agreeing.
   */
  kind: EntryKind;
  // capability flags (gate which actions a row offers — mirror of agentContextValue)
  adhoc?: boolean; // Temporary (MCP/forked), not a declared profile — only a Temporary terminal can be saved as a declaration
  forkable?: boolean; // CAN be forked (running claude session) → offers the Fork action
  canDismiss?: boolean; // legacy capability bit: stopped Temporary postmortem row is removable without tachyon.yml edits
}
/**
 * SDD 478 M5 — the sidebar's one narrowing, mirroring `asAgent` in the config layer. Rows are not a
 * discriminated union of shapes (every row renders from the same fields), so this reads the arm
 * rather than granting one; what matters is that there is exactly ONE place that asks.
 */
export function isAgentRow(row: Pick<AgentVM, "kind">): boolean {
  return row.kind === "agent";
}

/**
 * t-41117e — Temporary instance (wire flag `adhoc` on the row VM).
 * Callers outside the nomenclature allowlist must use this helper so product files never spell the species.
 */
export function isTemporaryAgentRow(row: Pick<AgentVM, "adhoc">): boolean {
  return !!row.adhoc;
}

export type RunState = "idle" | "running" | "paused" | "failed";
export interface PipelineNodeVM {
  id: string;
  status: AgentStatus;
  label: string;
  reason?: string;
  /** Exact managed-entry name for the node's inspect gesture; projected by the engine, not recomputed in the shell. */
  agentName?: string;
}
export interface PipelineVM { name: string; status: RunState; nodes: PipelineNodeVM[] }
export interface ScheduleVM { name: string; when: string; next: string; paused: boolean }
export interface PinVM { id?: string; text: string; done: boolean; by?: string; tags: string[]; detail?: boolean; attachmentCount?: number }
export interface PinPreviewAttachmentVM {
  id: string;
  kind: "image" | "excalidraw";
  name: string;
  available: boolean;
  /** resolved webview URI: the image itself (kind "image") or the sketch's rendered preview (kind "excalidraw"). */
  uri?: string;
  previewUri?: string;
  detail: string;
}
export interface PinPreviewVM {
  id: string;
  title: string;
  by?: string;
  done: boolean;
  tags: string[];
  /** flattened plain-text fallback, used when `doc` is null (a plain, non-rich pin). */
  body: string;
  /** t-321e9d — the pin's rich Tiptap doc (still carrying stored placeholder refs), read-only rendered via
   *  `toEditorDoc` + `StaticDoc`; null for plain pins that never got a rich body. */
  doc: TiptapJSON | null;
  attachments: PinPreviewAttachmentVM[];
}
export interface ProposalVM { id: string; name: string; by?: string; reason?: string; when?: string }
/** spec 415 — engine-owned human attention row. */
export interface NoticeVM {
  id: string;
  message: string;
  level: "info" | "warn" | "error";
  at: string;
  collapsedCount: number;
  actions: Array<{ id: string; label: string }>;
  read: boolean;
  actionsLive: boolean;
}
/**
 * SDD 512 — the current action-less product notice (what used to go to the VS Code
 * status bar). Distinct from `notices[]` (the Human Inbox). Last write wins; absent
 * means nothing to show. `level` is a field, never inferred from text or icon.
 */
export interface StatusNoticeVM {
  message: string;
  level: "info" | "warn" | "error";
  /** When this notice was set. A timestamp, not an expiry. */
  at: string;
}
export interface BridgeVM { port: string; connected: boolean }
export interface WorkspaceRef { hash: string; name: string }
/** spec 245 — per-folder Project Handoff badge state (drives the sidebar open-button + its dot). */
export type HandoffStaleness = "fresh" | "needs_distill" | "possibly_stale" | "old";
export interface HandoffVM { exists: boolean; staleness: HandoffStaleness; pendingCount: number }

/**
 * SDD 504 — what the shell has DISCOVERED about this window, projected so the sidebar never has to
 * infer it from an empty fleet array.
 *
 * `!fleets.length` used to answer two questions with one — "no Tachyon workspace here" and "I have
 * not heard from the engine yet". During boot the second was rendered as the first, so a configured
 * workspace was told it had none and offered a button to initialize what already existed.
 *
 * The plan's finding is what shapes this type: absence is knowable SYNCHRONOUSLY in the activation
 * turn, from `workspaceFolders` + `hasConfig(folder)`, with no engine and no first sync. So this is
 * not a spinner waiting on information that is genuinely slow — `discovered` marks the one moment
 * before the host has answered a question it can answer immediately.
 */
export type SidebarFolderPhase = "unconfigured" | "starting" | "ready" | "failed";

export interface SidebarBootFolderVM {
  /**
   * The folder's `wsHash` — the SAME identity `FleetVM.folder.hash` carries once it is attached.
   *
   * Deliberately not the filesystem path: it is what Retry sends back, and every other webview→host
   * route already speaks hashes. Sharing the identity across boot and ready is also what lets a
   * reader follow one folder from "starting" into its own fleet without the host inventing a
   * correlation.
   */
  hash: string;
  /** Display name of the open folder — what "Starting Tachyon for {name}…" names. */
  name: string;
  phase: SidebarFolderPhase;
  /** `Date.now()` when this folder entered `starting`. "Delayed" is derived from it, not stored. */
  startedAt?: number;
  /** `failed` only — the one-line summary already written to Output → Tachyon. */
  detail?: string;
}

export interface SidebarBootVM {
  /**
   * Has the host enumerated every open folder and answered `hasConfig` for each?
   *
   * `false` is the WEBVIEW'S OWN default and means "not asked yet" — never "no". Only the host sets
   * it true, and only after the check. That asymmetry is the whole fix: it is what keeps the empty
   * welcome from being frame #1 in a workspace that exists.
   */
  discovered: boolean;
  folders: SidebarBootFolderVM[];
}

/** t-8354ae — persistent config-error banner payload (webview). */
export interface ConfigErrorVM {
  file: string;
  path: string;
  errors: string[];
  summary: string;
}

export interface FleetVM {
  /**
   * The workspace this fleet belongs to.
   *
   * t-72ff5a — both production projections have always set it for EVERY root including a lone one
   * (`sidebarFleetService.ts`, `WorkspacePresentation.ts`); the old "set when >1 root" note
   * described an intent the code did not follow. It matters now: `folder.name` is what the sidebar's
   * project chrome paints, and `folder.hash` is what the selection resolves against, so a fleet
   * without one cannot be selected or named. Still optional on the type because fixtures and
   * plugin-facing projections may omit it, and every reader falls back rather than throwing.
   */
  folder?: WorkspaceRef;
  bridge: BridgeVM;
  agents: AgentVM[];
  proposals?: ProposalVM[];
  /** Terminals are managed entries on the `kind: "terminal"` arm — same row model, reduced actions. */
  terminals: AgentVM[];
  pipelines: PipelineVM[];
  schedules: ScheduleVM[];
  pins: PinVM[];
  /** spec 415 — oldest-first open human attention. */
  notices?: NoticeVM[];
  /**
   * SDD 512 — last action-less status notice. Last write wins; absent means nothing
   * to show. There is no expiry — the notice stays until replaced or dismissed.
   * `level` is a field on the value, never inferred from text or icon.
   */
  statusNotice?: StatusNoticeVM;
  /** spec 245 — the per-folder Project Handoff state (drives the header open-button + badge). */
  handoff?: HandoffVM;
  /**
   * t-aa2780 — this folder's engine daemon log ring holds at least one error line.
   *
   * The passive "something is wrong in the log" signal Control's Engine TAB used to carry as a red
   * dot. Control has no tab strip any more, so the signal moved to the sidebar (the Control tab's
   * icon and the launcher's Engine tile). It rides the fleet because that is the projection the
   * sidebar already receives per folder — a window with two roots lights the tab if EITHER has errors,
   * and the tile says which section to open.
   *
   * ABSENT means "not known", not "no errors": only the engine that owns the ring can answer, so the
   * legacy in-extension projection path leaves it unset and no dot is drawn. That matches what Control
   * did before (a failed engineLogHealth read left `logHasError` undefined and the tab dot dark) —
   * this signal has never claimed to be a health check, only a report from the ring itself.
   */
  engineLogHasError?: boolean;
  /**
   * t-8354ae — set when the working-tree config failed to load. While present, Agents tab
   * MUST show this banner and must not render the empty-roster placeholder when agents/ledger/LKG exist.
   */
  configError?: ConfigErrorVM;
  /**
   * t-7d6013 — set when the last successful load DROPPED declarations the file asked for, and the
   * human has not dismissed that exact set yet. The fleet is healthy: rows are never marked
   * `configInvalid` from this, and no degraded roster is drawn. Absent means "nothing discarded, or
   * already read and dismissed" — the two are indistinguishable here on purpose, because the banner
   * has the same job in both.
   */
  configDiscards?: ConfigDiscardsVM;
}

/**
 * t-37f554 — `Attentions` is a first-class tab (not a permanent panel above Agents). Tab order is
 * visual only; the default selected tab remains Agents so a cold open still lands on the roster.
 */
export type TabId = "Attentions" | "Control" | "Agents" | "Terminals" | "Pipelines" | "Schedules" | "Pins";
export const TABS: ReadonlyArray<{ id: TabId; icon: string }> = [
  { id: "Attentions", icon: "bell-dot" },
  // t-6e2952 — Control is a TAB in THIS row (second, right after Attentions), not a sidebar view of its
  // own: its panel is the launcher grid for the twelve Control sections. A separate WebviewView shipped
  // once (0.56.161) and rendered as a second collapsible section stacked above this panel.
  { id: "Control", icon: "dashboard" },
  { id: "Agents", icon: "hubot" },
  { id: "Terminals", icon: "terminal" },
  { id: "Pipelines", icon: "run-all" },
  { id: "Schedules", icon: "clock" },
  { id: "Pins", icon: "pinned" },
];

export interface SearchItem { name: string; tab: TabId; icon: string; hint?: string; keywords?: string; rowKey?: string; wsHash?: string }
/** Flattened global index for cmd+K (grouped by section at render time). wsHash scopes the row lookup so a
 *  duplicate name in another root resolves to the right folder. */
export function searchIndex(f: FleetVM): SearchItem[] {
  const ws = f.folder?.hash;
  return [
    ...f.agents.map((a): SearchItem => ({ name: a.name, tab: "Agents", icon: "hubot", hint: a.attention || a.status, wsHash: ws })),
    ...f.terminals.map((t): SearchItem => ({ name: t.name, tab: "Terminals", icon: "terminal", hint: t.sub, wsHash: ws })),
    ...f.pipelines.map((p): SearchItem => ({ name: p.name, tab: "Pipelines", icon: "run-all", hint: p.status, wsHash: ws })),
    ...f.schedules.map((s): SearchItem => ({ name: s.name, tab: "Schedules", icon: "clock", hint: s.when, wsHash: ws })),
    ...f.pins.map((p): SearchItem => ({
      name: p.text,
      tab: "Pins",
      icon: "pinned",
      hint: [p.id, ...(p.tags.length ? [p.tags.map((t) => `#${t}`).join(" ")] : [])].filter(Boolean).join(" · ") || undefined,
      keywords: [p.id, ...p.tags.flatMap((t) => [t, `#${t}`])].filter(Boolean).join(" "),
      rowKey: [p.text, p.id].filter(Boolean).join(" "),
      wsHash: ws,
    })),
  ];
}

/** Representative sample fleet exercising every state/badge/section. (Real data lands later.) */
export const SAMPLE: FleetVM = {
  folder: { hash: "demohash", name: "Demo" },
  handoff: { exists: true, staleness: "needs_distill", pendingCount: 3 },
  bridge: { port: "42551", connected: true },
  agents: [
    { name: "orchestrator", model: "Opus 4.8", status: "running", attention: "working", liveBranch: "main", worktreePath: "/ws", resources: { cpuPct: 12, memMb: 420 }, kind: "agent" },
    { name: "reviewer", model: "Sonnet 5", status: "running", parent: "orchestrator", harness: true, liveBranch: "main", worktreePath: "/ws", resources: { cpuPct: 8, memMb: 310 }, kind: "agent", adhoc: true },
    { name: "feature-auth", model: "GPT-5.1 Codex", status: "running", attention: "needs input", worktree: "tachyon/feature-auth", liveBranch: "tachyon/feature-auth", worktreePath: "/cache/feature-auth", resources: { cpuPct: 55, memMb: 920 }, forked: true, forkable: true, kind: "agent" },
    { name: "researcher", status: "needs", attention: "needs input", harness: true, liveBranch: "main", worktreePath: "/ws", kind: "agent" },
    { name: "docs-writer", status: "idle", liveBranch: "main", worktreePath: "/ws", kind: "agent" },
    { name: "feature-billing", status: "idle", worktree: "tachyon/feature-billing", liveBranch: "feat/billing-wip", branchDrift: true, worktreePath: "/cache/feature-billing", kind: "agent" },
    { name: "migration", status: "crashed", sub: "exited (1)", liveBranch: "main", worktreePath: "/ws", kind: "agent" },
    // t-9d76b1 — a stop the HUMAN asked for, on a runtime that acknowledges SIGINT by exiting 130
    // (grok, hermes). It sits next to `migration` on purpose: these two rows are the pair a person has
    // to be able to tell apart, and while this state was absent from the sample it was absent from
    // every preview and every visual check too.
    { name: "grok-builder", status: "stopped", sub: "stopped (exit 130)", pane: true, resumable: true, liveBranch: "main", worktreePath: "/ws", kind: "agent" },
    { name: "old-spike", status: "stopped", resumable: true, liveBranch: "main", worktreePath: "/ws", kind: "agent", adhoc: true },
    { name: "qa", status: "stopped", resumable: true, worktree: "tachyon/qa", liveBranch: "tachyon/qa", worktreePath: "/cache/qa", kind: "agent" },
  ],
  terminals: [
    { name: "dev", kind: "terminal", status: "running", sub: "npm run dev" },
    { name: "shell", kind: "terminal", status: "idle", sub: "bash" },
  ],
  pipelines: [
    { name: "feature", status: "running", nodes: [
      { id: "plan", status: "running", label: "done" },
      { id: "implement", status: "running", label: "running" },
      { id: "review", status: "stopped", label: "pending" },
    ] },
    { name: "gated", status: "failed", nodes: [
      { id: "build", status: "running", label: "done" },
      { id: "deploy", status: "crashed", label: "failed", reason: "exit 1" },
    ] },
    { name: "nightly", status: "idle", nodes: [] },
  ],
  proposals: [
    { id: "pr1", name: "hourly-lint", by: "claude", when: "every 1h · run lint", reason: "lint drift on long sessions" },
  ],
  schedules: [
    { name: "nightly-audit", when: "every 1d · spawn auditor", next: "next in 6h", paused: false },
    { name: "weekly-deps", when: "every 1w · spawn deps", next: "paused", paused: true },
  ],
  pins: [
    { text: "Bridge token rotation — confirm 0.26 injection path", done: true, by: "human", tags: ["security"] },
    { text: "Investigate slow refresh on 100+ agents", done: false, by: "claude", tags: ["perf"] },
    { text: "Sidebar webview prototype — review in EDH", done: false, by: "human", tags: ["ui", "dogfood"], detail: true, attachmentCount: 2 },
  ],
  notices: [],
};
