/**
 * t-73885b — apply considerInternalChecklistReprompt at turn-end.
 *
 * Trigger: a new persistence-stop row (the existing Stop hook). The
 * verdict still comes from the fatia-2 judges — this host does not
 * invent absent from Stop alone.
 *
 * Actor × trigger:
 *   Tachyon × Stop row → consider
 *   Tachyon × tick with no new Stop → none
 *   Tachyon × restart → loadState, so the one reprompt is not resent
 *   Interface / Agent / Bridge → cannot enqueue a reprompt here
 */
import { considerInternalChecklistReprompt } from "../runtime/internalChecklistReprompt.js";
import type { InternalChecklistTurnJudgment } from "../runtime/internalChecklistTurn.js";

export interface PersistenceStopRow {
  agent: string;
  event: string;
  sessionId: string;
  cwd: string;
  ts: string;
}

export type InternalChecklistRepromptStatus = "asked" | "given-up";

export type InternalChecklistRepromptState = Record<string, InternalChecklistRepromptStatus>;

export interface AssignedPlanTask {
  id: string;
  kind?: string;
}

export interface InternalChecklistRepromptDeps {
  listStopRows(): PersistenceStopRow[];
  assignedTask(agent: string): AssignedPlanTask | undefined;
  requireIn(): readonly string[] | undefined;
  judgeTurn(agent: string): InternalChecklistTurnJudgment;
  loadState(): InternalChecklistRepromptState;
  saveState(state: InternalChecklistRepromptState): void;
  sendReprompt(agent: string, text: string): Promise<void>;
  appendJournal(taskId: string, text: string): void;
  warnHuman(agent: string, taskId?: string): void;
}

export function repromptStateKey(agent: string, taskId: string | undefined): string {
  return `${agent}\t${taskId ?? ""}`;
}

export function parsePersistenceStopRows(text: string): PersistenceStopRow[] {
  const out: PersistenceStopRow[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const raw = JSON.parse(trimmed) as Partial<PersistenceStopRow>;
      if (typeof raw.agent !== "string" || raw.agent.length === 0) continue;
      if (raw.event !== "Stop") continue;
      out.push({
        agent: raw.agent,
        event: "Stop",
        sessionId: typeof raw.sessionId === "string" ? raw.sessionId : "",
        cwd: typeof raw.cwd === "string" ? raw.cwd : "",
        ts: typeof raw.ts === "string" ? raw.ts : "",
      });
    } catch {
      /* skip a non-JSON / partial line */
    }
  }
  return out;
}

function stopIdentity(row: PersistenceStopRow): string {
  return `${row.agent}\t${row.ts}\t${row.sessionId}`;
}

export class InternalChecklistRepromptMonitor {
  private seen = new Set<string>();

  constructor(private readonly deps: InternalChecklistRepromptDeps) {}

  async tick(): Promise<void> {
    const rows = this.deps.listStopRows();
    const state = this.deps.loadState();
    let dirty = false;

    for (const row of rows) {
      const id = stopIdentity(row);
      if (this.seen.has(id)) continue;
      this.seen.add(id);

      const task = this.deps.assignedTask(row.agent);
      const key = repromptStateKey(row.agent, task?.id);
      const judgment = this.deps.judgeTurn(row.agent);

      if (judgment.state === "verdict" && judgment.verdict === "present") {
        if (state[key]) {
          delete state[key];
          dirty = true;
        }
        continue;
      }

      if (state[key] === "given-up") continue;

      const decision = considerInternalChecklistReprompt({
        judgment,
        taskKind: task?.kind,
        requireIn: this.deps.requireIn(),
        alreadyReprompted: state[key] === "asked",
      });

      if (decision.action === "reprompt" && decision.prompt) {
        try {
          await this.deps.sendReprompt(row.agent, decision.prompt);
          state[key] = "asked";
          dirty = true;
        } catch {
          /* best-effort: a failed send must not count as the one reprompt */
        }
        continue;
      }

      if (decision.action === "give-up") {
        if (task?.id && decision.journal) {
          try {
            this.deps.appendJournal(task.id, decision.journal);
          } catch {
            /* journal cap or missing task must not block */
          }
        }
        try {
          this.deps.warnHuman(row.agent, task?.id);
        } catch {
          /* notify is best-effort */
        }
        state[key] = "given-up";
        dirty = true;
      }
    }

    if (dirty) this.deps.saveState(state);
  }
}
