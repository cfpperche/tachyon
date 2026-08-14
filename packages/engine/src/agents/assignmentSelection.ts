/**
 * t-9d250c — which task a restarted session is actually on.
 *
 * Two real incidents, both after `restart_agent(session:new)`: `claude-opus5` reopened `t-2f6cdd`,
 * already landed; `claude-opus5-3` reopened the umbrella `t-067540`, already satisfied, instead of the
 * phase tasks that were actually active. Both agents then burned turns re-deriving work that was done.
 *
 * The restart brief states two things about work, and until now they could disagree without anyone
 * saying so:
 *
 *  1. the SPAWN CONTRACT, frozen at spawn time and replayed verbatim on every restart;
 *  2. the BOARD, read live at restart.
 *
 * When they disagree the frozen one wins the agent's attention — it is phrased as a contract
 * ("TASK: … DONE_WHEN: …") while the record was a list. So this module makes the board's answer
 * singular and authoritative, and makes a stale contract reference something the brief NAMES rather
 * than something the agent has to notice.
 *
 * Pure and table-testable: callers supply rows, this decides only which one is current and what is
 * merely queued. It infers nothing about work being "finished" — the only thing it trusts is the
 * status the store holds.
 */

/** The only status a current contract may have. Everything else is history or someone else's work. */
export const CURRENT_ASSIGNMENT_STATUS = "active";

/**
 * Statuses that positively mean "this is over". Used only to describe a stale contract reference; a
 * status outside this set (say `inbox`) is reported as-is rather than claimed to be finished.
 */
const CLOSED_STATUSES = new Set(["landed", "done", "dropped"]);

/** One board row, as the task store holds it. */
export interface BoardAssignmentRow {
  id: string;
  title: string;
  status: string;
  assignee?: string;
  priority?: number;
  rank?: string;
  updatedAt?: string;
  body?: string;
}

/** A task on this session's record: the current one, or one waiting behind it. */
export interface AssignedTaskRecord {
  id: string;
  title: string;
  status: string;
  priority?: number;
  body?: string;
}

export interface AssignmentSelection {
  /** The single task this session is on. Absent means the board has none for this agent — a fact. */
  current?: AssignedTaskRecord;
  /** Also assigned and active, deliberately NOT presented as the current contract. */
  queue: AssignedTaskRecord[];
}

/** Unset priority sorts after every set one — the board's own convention (`priority ?? 4`). */
const priorityOf = (row: BoardAssignmentRow): number => (row.priority === undefined ? 4 : row.priority);

function toRecord(row: BoardAssignmentRow): AssignedTaskRecord {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    ...(row.priority === undefined ? {} : { priority: row.priority }),
    ...(row.body === undefined ? {} : { body: row.body }),
  };
}

/**
 * Pick the one current task, and queue the rest.
 *
 * The status filter is the contract's first clause and is absolute: a row is a candidate only if its
 * status is exactly `active`. `landed`, `done`, `dropped`, `inbox` and `triaged` cannot reach a
 * restarted session as its contract, whatever else is true of them.
 *
 * The assignee check refuses a row that names a DIFFERENT agent, and accepts one that names nobody.
 * That asymmetry is deliberate: the resolver is called `assignedWork(name)` and production already
 * scopes by assignee, so a row arriving without the field is a pre-scoped row, not an unowned one.
 * Treating it as unowned would silently empty the record — a restart telling an agent "nothing is
 * assigned" while its task sits on the board is the same class of lie this whole task exists to fix,
 * and it would fail quietly rather than loudly.
 *
 * The order is total, so two restarts of the same board produce the same answer: most urgent
 * priority, then the board's own `rank`, then most recently touched (the one being worked on), then
 * id. Ties never fall through to array order, which is the store's insertion order and means nothing.
 */
export function selectAssignedWork(rows: readonly BoardAssignmentRow[], agent: string): AssignmentSelection {
  const candidates = rows
    .filter((row) => (row.assignee === undefined || row.assignee === agent) && row.status === CURRENT_ASSIGNMENT_STATUS)
    .slice()
    .sort((a, b) =>
      priorityOf(a) - priorityOf(b)
      || (a.rank ?? "￿").localeCompare(b.rank ?? "￿")
      || (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "")
      || a.id.localeCompare(b.id));
  const [current, ...queue] = candidates;
  return { ...(current ? { current: toRecord(current) } : {}), queue: queue.map(toRecord) };
}

/** A task id the frozen spawn brief names that is NOT this session's current work. */
export interface StaleContractReference {
  id: string;
  /** the status the store holds now, or undefined when the id is not on the board at all */
  status?: string;
  /** true when the status positively means the work is over */
  closed: boolean;
}

/** Task ids as the product mints them (`create_task`), matched case-insensitively for safety. */
const TASK_ID_RE = /\bt-[0-9a-f]{6}\b/gi;

/**
 * Which task ids does the replayed spawn brief name, and are any of them no longer live work?
 *
 * Scanning prose is a heuristic, so it is used ONLY to make a factual statement: the id was found,
 * and the store says its status is X. The brief never concludes anything from the scan by itself —
 * an id that is still `active` for this agent, or that the store does not know, produces no claim at
 * all. That keeps a contract that merely mentions a neighbouring task ("follow the pattern from
 * t-abc123") from being described as stale.
 *
 * `statusOf` returning undefined for everything (no store wired) degrades to silence, never to a
 * guess — the same fail-quiet rule the rest of the record follows.
 */
export function staleContractReferences(
  briefText: string | undefined,
  selection: AssignmentSelection,
  statusOf: (id: string) => string | undefined,
): StaleContractReference[] {
  if (!briefText) return [];
  const live = new Set([selection.current?.id, ...selection.queue.map((task) => task.id)].filter(Boolean) as string[]);
  const seen = new Set<string>();
  const stale: StaleContractReference[] = [];
  for (const match of briefText.matchAll(TASK_ID_RE)) {
    const id = match[0].toLowerCase();
    if (seen.has(id) || live.has(id)) continue;
    seen.add(id);
    const status = statusOf(id);
    // Unknown to the store: say nothing. It may be a task from another workspace, or a typo, and
    // "I could not find it" is not evidence that the work is over.
    if (status === undefined) continue;
    stale.push({ id, status, closed: CLOSED_STATUSES.has(status) });
  }
  return stale;
}
