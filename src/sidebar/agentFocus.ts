/**
 * spec 390 — resolve the human-glance "focus line" for an agent row.
 * Pure: no IO. Priority: open MC task (assignee) → spawn brief → continuity Current Goal → omit.
 */
import type { EntryKind } from "../config/loadConfig.js";

export type FocusSource = "task" | "brief" | "continuity";

export interface AgentFocus {
  /** Truncated display text (sidebar). */
  text: string;
  source: FocusSource;
  /** Mission Control task id when source === "task". */
  taskId?: string;
  /** Full untruncated text for tooltip. */
  full: string;
}

export interface FocusTaskInput {
  id: string;
  title: string;
  status: string;
  assignee?: string | null;
  updatedAt: string;
}

export interface FocusLedgerInput {
  /** Spawn contract task field (spec 246). */
  contractTask?: string;
  /** Free-form long brief pointer/summary on the ledger def. */
  taskBrief?: string;
}

/** Open statuses that count as "working on a task" for focus + On-task filter. */
export const FOCUS_OPEN_TASK_STATUSES = new Set(["triaged", "active"]);

export const FOCUS_TEXT_MAX = 60;

export function truncateFocusText(text: string, max = FOCUS_TEXT_MAX): string {
  const t = text.replace(/\s+/g, " ").trim();
  const points = Array.from(t);
  if (points.length <= max) return t;
  if (max <= 1) return "…";
  // t-b15872 — by CODE POINT. This one is a genuinely tiny label (60 chars) where a count marker
  // would cost more than it explains, so it keeps the bare ellipsis and only stops splitting pairs.
  return `${points.slice(0, max - 1).join("")}…`;
}

/**
 * First non-empty line under a `# Current Goal` (or `## Current Goal`) heading.
 * Returns undefined when the heading or body is missing.
 */
export function parseContinuityCurrentGoal(body: string | null | undefined): string | undefined {
  if (!body) return undefined;
  const lines = body.split(/\r?\n/);
  let inGoal = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (/^#{1,3}\s*Current Goal\s*$/i.test(line)) {
      inGoal = true;
      continue;
    }
    if (inGoal) {
      if (/^#{1,3}\s+\S/.test(line)) break; // next section
      if (!line) continue;
      // strip leading list markers / quotes
      return line.replace(/^[-*]\s+/, "").replace(/^>\s*/, "").trim() || undefined;
    }
  }
  return undefined;
}

/** Prefer active, then newest updatedAt among open assigned tasks. */
export function pickFocusTask(
  agent: string,
  tasks: readonly FocusTaskInput[],
): FocusTaskInput | undefined {
  const assigned = tasks.filter(
    (t) => t.assignee === agent && FOCUS_OPEN_TASK_STATUSES.has(t.status),
  );
  if (assigned.length === 0) return undefined;
  assigned.sort((a, b) => {
    const aActive = a.status === "active" ? 0 : 1;
    const bActive = b.status === "active" ? 0 : 1;
    if (aActive !== bActive) return aActive - bActive;
    return (b.updatedAt || "").localeCompare(a.updatedAt || "");
  });
  return assigned[0];
}

export function briefFromLedger(ledger?: FocusLedgerInput | null): string | undefined {
  if (!ledger) return undefined;
  const contract = ledger.contractTask?.replace(/\s+/g, " ").trim();
  if (contract) return contract;
  const brief = ledger.taskBrief?.replace(/\s+/g, " ").trim();
  if (brief) return brief;
  return undefined;
}

export interface ResolveAgentFocusInput {
  agent: string;
  /** SDD 478 M5 — the managed-entry arm; terminals carry no focus. */
  kind?: EntryKind;
  tasks?: readonly FocusTaskInput[];
  ledger?: FocusLedgerInput | null;
  continuityBody?: string | null;
}

/**
 * Resolve focus for one agent. Returns undefined when no source yields text
 * (or the row is not an AI agent).
 */
export function resolveAgentFocus(input: ResolveAgentFocusInput): AgentFocus | undefined {
  if (input.kind === "terminal") return undefined;

  const task = pickFocusTask(input.agent, input.tasks ?? []);
  if (task) {
    const full = `${task.id}  ${task.title}`.trim();
    return {
      source: "task",
      taskId: task.id,
      full,
      text: truncateFocusText(task.title),
    };
  }

  const brief = briefFromLedger(input.ledger);
  if (brief) {
    return {
      source: "brief",
      full: brief,
      text: truncateFocusText(brief),
    };
  }

  const goal = parseContinuityCurrentGoal(input.continuityBody);
  if (goal) {
    return {
      source: "continuity",
      full: goal,
      text: truncateFocusText(goal),
    };
  }

  return undefined;
}

export function agentHasFocus(a: { focus?: AgentFocus | null }): boolean {
  return !!a.focus?.text;
}

export function agentOnTask(a: { focus?: AgentFocus | null }): boolean {
  return a.focus?.source === "task";
}
