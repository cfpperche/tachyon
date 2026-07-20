/**
 * spec 237 — the sidebar view-model (framework-agnostic, no preact/vscode imports).
 * The Preact UI renders ONLY from these types. Today the data is SAMPLE; the real build swaps
 * `SAMPLE` for a model produced by the (extracted) rules layer reading live fleet state — the
 * components don't change. This is the "UI decoupled from rules" contract.
 */
import type { TiptapJSON } from "../richDoc/types.js";
import type { ExternalToolsSummaryVM } from "../externalTools/types.js";

export type AgentStatus = "running" | "needs" | "throttled" | "done" | "idle" | "stopping" | "stop-failed" | "stopped" | "crashed";
export type Verify = "pass" | "fail" | "stale";
/** spec 378 — where `AgentVM.model` came from: a live transcript observation, an explicit `--model` flag,
 *  or the runtime's profile default (no explicit flag, no observation yet). */
export type ModelSource = "observed" | "declared" | "profile";
/** spec 241 — per-agent continuity brief freshness: missing (none yet) | stale (behind activity) | fresh. */
export type ContinuityBadge = "fresh" | "stale" | "missing";
/** spec 390 — source of the human-glance focus line on an agent row. */
export type FocusSource = "task" | "brief" | "continuity";
/** spec 390 — projected "what this agent is working on" for fleet glance. */
export interface AgentFocus {
  text: string;
  source: FocusSource;
  taskId?: string;
  full: string;
}
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
  /** spec 378 — the observed model differs from the declared/profile model (same alias table both sides). */
  modelDivergence?: boolean;
  status: AgentStatus;
  attention?: string;
  parent?: string;
  /** Bridge-resolved requester for a gated delegation. Separate from runtime parent and declaredOwner. */
  delegator?: string;
  declaredOwner?: string;
  sub?: string;
  /** Config/ledger branch when the agent has worktree isolation (gates Review/PR/Remove). Not necessarily live HEAD. */
  worktree?: string;
  /** spec 384 — live HEAD branch name in the agent's session cwd (sidebar badge). */
  liveBranch?: string;
  /** spec 384 — live HEAD differs from the isolation/config branch (`worktree`). */
  branchDrift?: boolean;
  /** spec 384 — absolute session cwd (worktree path or workspace root); tooltip only. */
  worktreePath?: string;
  /** spec 386 — live CPU/RSS for the agent pane subtree (running agents only). */
  resources?: { cpuPct?: number; memMb: number };
  verify?: Verify;
  harness?: boolean;
  resumable?: boolean;
  /** resumable, but the saved transcript is gone → ↻ Resume degrades to a fresh start (spec 221). */
  freshStart?: boolean;
  /** has a DEAD pane from a clean exit (exit 0) — status is "stopped" for grouping, but a postmortem pane
   *  may still exist internally. The UI should route through Activity/Resume/Restart instead of reopening
   *  that dead terminal. Distinguishes it from killed/never-run. */
  exited?: boolean;
  /** false when the process exited cleanly but Tachyon already cleared the dead terminal pane */
  pane?: boolean;
  /** this agent IS a forked sibling (spec 225 — `def.fork`); drives the ⑂ fork badge. */
  forked?: boolean;
  /** spec 241 — continuity brief freshness badge (undefined = don't show, e.g. terminals / non-ai). */
  continuity?: ContinuityBadge;
  /** spec 390 — glance focus line (task / brief / continuity goal); omit when no source. */
  focus?: AgentFocus;
  /** spec 316 — runtime-native persistence hook health for declared Claude/Codex agents. */
  persistenceHooks?: { state: PersistenceHookBadge; reason?: string; path?: string; updatedAt?: string };
  /** spec 273 — non-binary evidence indicator (undefined = none); advisory, never gates. */
  evidence?: EvidenceBadge;
  /** t-327f81 — compact external GUI/tool attribution projected from the runtime-owned registry. */
  externalTools?: ExternalToolsSummaryVM;
  /** t-35d95a — AttentionMonitor.awaitingHuman latch (request_human_attention): an AUTHORED
   *  "I need a human" signal, independent of `attention`/`status`. Undefined = not latched. */
  awaitingHuman?: { reason: string };
  /** t-8354ae — row is shown while tachyon.yml is invalid (ledger and/or LKG). */
  configInvalid?: boolean;
  // capability flags (gate which actions a row offers — mirror of agentContextValue)
  ai?: boolean; // an AI agent (vs a terminal/process)
  adhoc?: boolean; // MCP/forked, not declared in tachyon.yml → can be promoted
  verifiable?: boolean; // has a declared verify gate
  forkable?: boolean; // CAN be forked (running claude session) → offers the Fork action
  canDismiss?: boolean; // legacy capability bit: stopped ad-hoc postmortem row is removable without tachyon.yml edits
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
export type CommandState = "running" | "passed" | "failed" | "idle";
export interface CommandVM { name: string; cmd: string; state: CommandState; detail: string }
export type StepState = "running" | "passed" | "failed" | "skipped";
export interface RunbookStepVM { n: number; label: string; state: StepState; detail?: string }
export interface RunbookVM { name: string; running: boolean; failed: boolean; detail: string; steps: RunbookStepVM[] }
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
export interface BridgeVM { port: string; connected: boolean }
export interface WorkspaceRef { hash: string; name: string }
/** spec 245 — per-folder Project Handoff badge state (drives the sidebar open-button + its dot). */
export type HandoffStaleness = "fresh" | "needs_distill" | "possibly_stale" | "old";
export interface HandoffVM { exists: boolean; staleness: HandoffStaleness; pendingCount: number }

/** t-8354ae — persistent config-error banner payload (webview). */
export interface ConfigErrorVM {
  file: string;
  path: string;
  errors: string[];
  summary: string;
}

export interface FleetVM {
  /** the workspace this fleet belongs to (set when >1 root, so the UI can group + route by folder) */
  folder?: WorkspaceRef;
  bridge: BridgeVM;
  agents: AgentVM[];
  proposals?: ProposalVM[];
  /** Terminals are managed entries with ai:false — same row model + reduced action set. */
  terminals: AgentVM[];
  pipelines: PipelineVM[];
  schedules: ScheduleVM[];
  commands: CommandVM[];
  runbooks: RunbookVM[];
  pins: PinVM[];
  /** spec 415 — oldest-first open human attention. */
  notices?: NoticeVM[];
  /** spec 245 — the per-folder Project Handoff state (drives the header open-button + badge). */
  handoff?: HandoffVM;
  /**
   * t-8354ae — set when the working-tree config failed to load. While present, Agents tab
   * MUST show this banner and must not render the empty-roster placeholder when agents/ledger/LKG exist.
   */
  configError?: ConfigErrorVM;
}

export type TabId = "Agents" | "Terminals" | "Pipelines" | "Schedules" | "Commands" | "Runbooks" | "Pins";
export const TABS: ReadonlyArray<{ id: TabId; icon: string }> = [
  { id: "Agents", icon: "hubot" },
  { id: "Terminals", icon: "terminal" },
  { id: "Pipelines", icon: "run-all" },
  { id: "Schedules", icon: "clock" },
  { id: "Commands", icon: "play-circle" },
  { id: "Runbooks", icon: "book" },
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
    ...f.commands.map((c): SearchItem => ({ name: c.name, tab: "Commands", icon: "play-circle", hint: c.cmd, wsHash: ws })),
    ...f.runbooks.map((r): SearchItem => ({ name: r.name, tab: "Runbooks", icon: "book", hint: r.detail, wsHash: ws })),
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
    { name: "orchestrator", model: "Opus 4.8", status: "running", attention: "working", liveBranch: "main", worktreePath: "/ws", resources: { cpuPct: 12, memMb: 420 }, ai: true },
    { name: "reviewer", model: "Sonnet 5", status: "running", parent: "orchestrator", harness: true, liveBranch: "main", worktreePath: "/ws", resources: { cpuPct: 8, memMb: 310 }, ai: true, adhoc: true },
    { name: "feature-auth", model: "GPT-5.1 Codex", status: "running", attention: "needs input", worktree: "tachyon/feature-auth", liveBranch: "tachyon/feature-auth", worktreePath: "/cache/feature-auth", resources: { cpuPct: 55, memMb: 920 }, verify: "pass", verifiable: true, forked: true, forkable: true, ai: true },
    { name: "researcher", status: "needs", attention: "needs input", harness: true, liveBranch: "main", worktreePath: "/ws", ai: true },
    { name: "docs-writer", status: "idle", liveBranch: "main", worktreePath: "/ws", ai: true },
    { name: "feature-billing", status: "idle", worktree: "tachyon/feature-billing", liveBranch: "feat/billing-wip", branchDrift: true, worktreePath: "/cache/feature-billing", verify: "stale", verifiable: true, ai: true },
    { name: "migration", status: "crashed", sub: "exited (1)", liveBranch: "main", worktreePath: "/ws", verify: "fail", verifiable: true, ai: true },
    { name: "old-spike", status: "stopped", resumable: true, liveBranch: "main", worktreePath: "/ws", ai: true, adhoc: true },
    { name: "qa", status: "stopped", resumable: true, worktree: "tachyon/qa", liveBranch: "tachyon/qa", worktreePath: "/cache/qa", verifiable: true, ai: true },
  ],
  terminals: [
    { name: "dev", status: "running", sub: "npm run dev" },
    { name: "shell", status: "idle", sub: "bash" },
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
    { name: "nightly-audit", when: "every 1d · run test", next: "next in 6h", paused: false },
    { name: "weekly-deps", when: "every 1w · run deps", next: "paused", paused: true },
  ],
  commands: [
    { name: "test", cmd: "npm test", state: "passed", detail: "exit 0 · 12s" },
    { name: "build", cmd: "npm run build", state: "running", detail: "running" },
    { name: "typecheck", cmd: "tsc --noEmit", state: "failed", detail: "exit 1" },
    { name: "lint", cmd: "biome check", state: "idle", detail: "never run" },
  ],
  runbooks: [
    { name: "ship", running: false, failed: false, detail: "passed · 2 steps", steps: [
      { n: 1, label: "lint", state: "passed", detail: "1s" },
      { n: 2, label: "test", state: "passed", detail: "12s" },
    ] },
    { name: "deploy", running: false, failed: true, detail: "failed at step 2", steps: [
      { n: 1, label: "build", state: "passed", detail: "8s" },
      { n: 2, label: "push", state: "failed", detail: "exit 1" },
    ] },
    { name: "nightly", running: false, failed: false, detail: "never run", steps: [] },
  ],
  pins: [
    { text: "Bridge token rotation — confirm 0.26 injection path", done: true, by: "human", tags: ["security"] },
    { text: "Investigate slow refresh on 100+ agents", done: false, by: "claude", tags: ["perf"] },
    { text: "Sidebar webview prototype — review in EDH", done: false, by: "human", tags: ["ui", "dogfood"], detail: true, attachmentCount: 2 },
  ],
  notices: [],
};
