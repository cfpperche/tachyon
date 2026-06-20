/**
 * spec 237 — the sidebar view-model (framework-agnostic, no preact/vscode imports).
 * The Preact UI renders ONLY from these types. Today the data is SAMPLE; the real build swaps
 * `SAMPLE` for a model produced by the (extracted) rules layer reading live fleet state — the
 * components don't change. This is the "UI decoupled from rules" contract.
 */
export type AgentStatus = "running" | "needs" | "idle" | "stopped" | "crashed";
export type Verify = "pass" | "fail" | "stale";

export interface AgentVM {
  name: string;
  status: AgentStatus;
  attention?: string;
  parent?: string;
  sub?: string;
  worktree?: string;
  verify?: Verify;
  harness?: boolean;
  resumable?: boolean;
  /** resumable, but the saved transcript is gone → ↻ Resume degrades to a fresh start (spec 221). */
  freshStart?: boolean;
  /** has a DEAD pane from a clean exit (exit 0) — status is "stopped" for grouping, but a postmortem pane
   *  exists, so it gets inspect/kill/restart (not spawn), like a crash. Distinguishes it from killed/never-run. */
  exited?: boolean;
  fork?: boolean;
  // capability flags (gate which actions a row offers — mirror of agentContextValue)
  ai?: boolean; // an AI agent (vs a terminal/process)
  adhoc?: boolean; // MCP/forked, not declared in tachyon.yml → can be promoted
  verifiable?: boolean; // has a declared verify gate
}
export type RunState = "idle" | "running" | "paused" | "failed";
export interface PipelineNodeVM { id: string; status: AgentStatus; label: string; reason?: string }
export interface PipelineVM { name: string; status: RunState; nodes: PipelineNodeVM[] }
export interface ScheduleVM { name: string; when: string; next: string; paused: boolean }
export type CommandState = "running" | "passed" | "failed" | "idle";
export interface CommandVM { name: string; cmd: string; state: CommandState; detail: string }
export type StepState = "running" | "passed" | "failed" | "skipped";
export interface RunbookStepVM { n: number; label: string; state: StepState; detail?: string }
export interface RunbookVM { name: string; running: boolean; failed: boolean; detail: string; steps: RunbookStepVM[] }
export interface PinVM { id?: string; text: string; done: boolean; by?: string }
export interface ProposalVM { id: string; name: string; by?: string; reason?: string; when?: string }
export interface BridgeVM { port: string; connected: boolean }
export interface WorkspaceRef { hash: string; name: string }

export interface FleetVM {
  /** the workspace this fleet belongs to (set when >1 root, so the UI can group + route by folder) */
  folder?: WorkspaceRef;
  bridge: BridgeVM;
  agents: AgentVM[];
  proposals?: ProposalVM[];
  /** Terminals are non-AI agents (ai:false) — same model + action matrix as agents, reduced action set. */
  terminals: AgentVM[];
  pipelines: PipelineVM[];
  schedules: ScheduleVM[];
  commands: CommandVM[];
  runbooks: RunbookVM[];
  pins: PinVM[];
  /** first non-empty line of the shared notes (.tachyon/notes.md), "" when empty — rendered as a row */
  notes: string;
}

export type TabId = "Agents" | "Terminals" | "Pipelines" | "Schedules" | "Commands" | "Runbooks" | "Pins";
export const TABS: ReadonlyArray<{ id: TabId; icon: string }> = [
  { id: "Agents", icon: "hubot" },
  { id: "Terminals", icon: "terminal" },
  { id: "Pipelines", icon: "run-all" },
  { id: "Schedules", icon: "clock" },
  { id: "Commands", icon: "zap" },
  { id: "Runbooks", icon: "checklist" },
  { id: "Pins", icon: "pinned" },
];

export function countOf(f: FleetVM, tab: TabId): number {
  switch (tab) {
    case "Agents": return f.agents.length;
    case "Terminals": return f.terminals.length;
    case "Pipelines": return f.pipelines.length;
    case "Schedules": return f.schedules.length;
    case "Commands": return f.commands.length;
    case "Runbooks": return f.runbooks.length;
    case "Pins": return f.pins.length;
  }
}

export interface SearchItem { name: string; tab: TabId; icon: string; hint?: string }
/** Flattened global index for cmd+K (grouped by section at render time). */
export function searchIndex(f: FleetVM): SearchItem[] {
  return [
    ...f.agents.map((a): SearchItem => ({ name: a.name, tab: "Agents", icon: "hubot", hint: a.attention || a.status })),
    ...f.terminals.map((t): SearchItem => ({ name: t.name, tab: "Terminals", icon: "terminal", hint: t.sub })),
    ...f.pipelines.map((p): SearchItem => ({ name: p.name, tab: "Pipelines", icon: "run-all", hint: p.status })),
    ...f.schedules.map((s): SearchItem => ({ name: s.name, tab: "Schedules", icon: "clock", hint: s.when })),
    ...f.commands.map((c): SearchItem => ({ name: c.name, tab: "Commands", icon: "zap", hint: c.cmd })),
    ...f.runbooks.map((r): SearchItem => ({ name: r.name, tab: "Runbooks", icon: "checklist", hint: r.detail })),
    ...f.pins.map((p): SearchItem => ({ name: p.text, tab: "Pins", icon: "pinned" })),
  ];
}

/** Representative sample fleet exercising every state/badge/section. (Real data lands later.) */
export const SAMPLE: FleetVM = {
  bridge: { port: "42551", connected: true },
  agents: [
    { name: "orchestrator", status: "running", attention: "working", ai: true },
    { name: "reviewer", status: "running", parent: "orchestrator", harness: true, ai: true, adhoc: true },
    { name: "feature-auth", status: "running", attention: "needs input", worktree: "tachyon/feature-auth", verify: "pass", verifiable: true, fork: true, ai: true },
    { name: "researcher", status: "needs", attention: "needs input", harness: true, ai: true },
    { name: "docs-writer", status: "idle", ai: true },
    { name: "feature-billing", status: "idle", worktree: "tachyon/feature-billing", verify: "stale", verifiable: true, ai: true },
    { name: "migration", status: "crashed", sub: "exited (1)", verify: "fail", verifiable: true, ai: true },
    { name: "old-spike", status: "stopped", resumable: true, ai: true, adhoc: true },
    { name: "qa", status: "stopped", resumable: true, worktree: "tachyon/qa", verifiable: true, ai: true },
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
    { text: "Bridge token rotation — confirm 0.26 injection path", done: true, by: "human" },
    { text: "Investigate slow refresh on 100+ agents", done: false, by: "claude" },
    { text: "Sidebar webview prototype — review in EDH", done: false, by: "human" },
  ],
  notes: "release checklist + open questions",
};
