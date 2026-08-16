/**
 * t-73885b — apply considerInternalPlanReprompt at turn-end.
 *
 * Trigger: a new persistence-stop row (the existing Stop hook). The
 * verdict still comes from the fatia-2 judges — this host does not
 * invent sem-plano from Stop alone.
 *
 * Actor × trigger:
 *   Tachyon × Stop row → consider
 *   Tachyon × tick with no new Stop → none
 *   Tachyon × restart → loadState, so the one remprompt is not resent
 *   Interface / Agent / Bridge → cannot enqueue a remprompt here
 */
import { considerInternalPlanReprompt } from "../runtime/internalPlanReprompt.js";
import type { InternalPlanTurnJudgment } from "../runtime/internalPlanTurn.js";

export interface PersistenceStopRow {
  agent: string;
  event: string;
  sessionId: string;
  cwd: string;
  ts: string;
}

export type InternalPlanRepromptStatus = "asked" | "given-up";

export type InternalPlanRepromptState = Record<string, InternalPlanRepromptStatus>;

export interface AssignedPlanTask {
  id: string;
  kind?: string;
}

export interface InternalPlanRepromptDeps {
  listStopRows(): PersistenceStopRow[];
  assignedTask(agent: string): AssignedPlanTask | undefined;
  exigirEm(): readonly string[] | undefined;
  judgeTurn(agent: string): InternalPlanTurnJudgment;
  loadState(): InternalPlanRepromptState;
  saveState(state: InternalPlanRepromptState): void;
  sendReprompt(agent: string, text: string): Promise<void>;
  appendJournal(taskId: string, text: string): void;
  warnHuman(agent: string, taskId?: string): void;
}

export function rempromptStateKey(agent: string, taskId: string | undefined): string {
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

export class InternalPlanRepromptMonitor {
  private seen = new Set<string>();

  constructor(private readonly deps: InternalPlanRepromptDeps) {}

  async tick(): Promise<void> {
    const rows = this.deps.listStopRows();
    const state = this.deps.loadState();
    let dirty = false;

    for (const row of rows) {
      const id = stopIdentity(row);
      if (this.seen.has(id)) continue;
      this.seen.add(id);

      const task = this.deps.assignedTask(row.agent);
      const key = rempromptStateKey(row.agent, task?.id);
      const judgment = this.deps.judgeTurn(row.agent);

      if (judgment.state === "verdict" && judgment.verdict === "com-plano") {
        if (state[key]) {
          delete state[key];
          dirty = true;
        }
        continue;
      }

      if (state[key] === "given-up") continue;

      const decision = considerInternalPlanReprompt({
        judgment,
        taskKind: task?.kind,
        exigirEm: this.deps.exigirEm(),
        alreadyReprompted: state[key] === "asked",
      });

      if (decision.action === "reprompt" && decision.prompt) {
        try {
          await this.deps.sendReprompt(row.agent, decision.prompt);
          state[key] = "asked";
          dirty = true;
        } catch {
          /* best-effort: a failed send must not count as the one remprompt */
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
