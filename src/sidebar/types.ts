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
  fork?: boolean;
  // capability flags (gate which actions a row offers — mirror of agentContextValue)
  ai?: boolean; // an AI agent (vs a terminal/process)
  adhoc?: boolean; // MCP/forked, not declared in tachyon.yml → can be promoted
  verifiable?: boolean; // has a declared verify gate
}
export interface TerminalVM { name: string; status: AgentStatus; sub?: string }
export interface PipelineNodeVM { id: string; status: AgentStatus; label: string }
export interface PipelineVM { name: string; state: string; nodes: PipelineNodeVM[] }
export interface ScheduleVM { name: string; when: string; next: string }
export interface CommandVM { name: string; cmd: string; last: "pass" | "fail" | "none" }
export interface RunbookVM { name: string; steps: number }
export interface PinVM { id?: string; text: string; done: boolean }
export interface ProposalVM { id: string; name: string; by?: string; reason?: string }
export interface BridgeVM { port: string; connected: boolean; tools: number }
export interface WorkspaceRef { hash: string; name: string }

export interface FleetVM {
  bridge: BridgeVM;
  agents: AgentVM[];
  proposals?: ProposalVM[];
  workspaces?: WorkspaceRef[];
  activeWorkspace?: string;
  terminals: TerminalVM[];
  pipelines: PipelineVM[];
  schedules: ScheduleVM[];
  commands: CommandVM[];
  runbooks: RunbookVM[];
  pins: PinVM[];
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
    ...f.pipelines.map((p): SearchItem => ({ name: p.name, tab: "Pipelines", icon: "run-all", hint: p.state })),
    ...f.schedules.map((s): SearchItem => ({ name: s.name, tab: "Schedules", icon: "clock", hint: s.when })),
    ...f.commands.map((c): SearchItem => ({ name: c.name, tab: "Commands", icon: "zap", hint: c.cmd })),
    ...f.runbooks.map((r): SearchItem => ({ name: r.name, tab: "Runbooks", icon: "checklist", hint: `${r.steps} steps` })),
    ...f.pins.map((p): SearchItem => ({ name: p.text, tab: "Pins", icon: "pinned" })),
  ];
}

/** Representative sample fleet exercising every state/badge/section. (Real data lands later.) */
export const SAMPLE: FleetVM = {
  bridge: { port: "42551", connected: true, tools: 22 },
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
    { name: "feature", state: "2/3 running", nodes: [
      { id: "plan", status: "idle", label: "done ✓" },
      { id: "implement", status: "running", label: "running…" },
      { id: "review", status: "stopped", label: "queued" },
    ] },
  ],
  schedules: [
    { name: "nightly-audit", when: "0 3 * * *", next: "in 6h" },
    { name: "weekly-deps", when: "0 9 * * 1", next: "in 3d" },
  ],
  commands: [
    { name: "test", cmd: "npm test", last: "pass" },
    { name: "build", cmd: "npm run build", last: "pass" },
    { name: "typecheck", cmd: "tsc --noEmit", last: "fail" },
    { name: "lint", cmd: "biome check", last: "none" },
  ],
  runbooks: [
    { name: "release", steps: 4 },
    { name: "deploy", steps: 3 },
  ],
  pins: [
    { text: "Bridge token rotation — confirm 0.26 injection path", done: true },
    { text: "Investigate slow refresh on 100+ agents", done: false },
    { text: "Sidebar webview prototype — review in EDH", done: false },
  ],
};
