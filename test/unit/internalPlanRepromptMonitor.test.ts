import { describe, expect, it } from "vitest";
import {
  InternalPlanRepromptMonitor,
  type InternalPlanRepromptState,
  type PersistenceStopRow,
} from "@tachyon/engine/workspace/InternalPlanRepromptMonitor.js";
import type { InternalPlanTurnJudgment } from "@tachyon/engine/runtime/internalPlanTurn.js";

/**
 * t-73885b — the host that Workspace.tick drives. It must call
 * considerInternalPlanReprompt (see internalPlanReprompt.test.ts) and
 * must not remprompt twice, block, or accuse sem-canal/pending.
 */

const SEM_PLANO: InternalPlanTurnJudgment = { state: "verdict", verdict: "sem-plano" };
const SEM_CANAL: InternalPlanTurnJudgment = { state: "verdict", verdict: "sem-canal" };
const PENDING: InternalPlanTurnJudgment = { state: "pending", reason: "turn-not-completed" };
const COM_PLANO: InternalPlanTurnJudgment = { state: "verdict", verdict: "com-plano" };

const STOP: PersistenceStopRow = {
  agent: "worker",
  event: "Stop",
  sessionId: "s1",
  cwd: "/ws",
  ts: "2026-08-16T18:00:00.000Z",
};

function harness(opts: {
  stops?: PersistenceStopRow[];
  judgment?: InternalPlanTurnJudgment;
  task?: { id: string; kind?: string };
  exigirEm?: readonly string[];
  state?: InternalPlanRepromptState;
}) {
  let stops = opts.stops ?? [STOP];
  let judgment = opts.judgment ?? SEM_PLANO;
  let store: InternalPlanRepromptState = { ...(opts.state ?? {}) };
  const sent: string[] = [];
  const journals: Array<{ taskId: string; text: string }> = [];
  const warnings: Array<{ agent: string; taskId?: string }> = [];
  const monitor = new InternalPlanRepromptMonitor({
    listStopRows: () => stops,
    assignedTask: (agent) => (agent === "worker" ? opts.task ?? { id: "t-73885b", kind: "feature" } : undefined),
    exigirEm: () => opts.exigirEm ?? ["feature"],
    judgeTurn: () => judgment,
    loadState: () => ({ ...store }),
    saveState: (next) => {
      store = { ...next };
    },
    sendReprompt: async (_agent, text) => {
      sent.push(text);
    },
    appendJournal: (taskId, text) => {
      journals.push({ taskId, text });
    },
    warnHuman: (agent, taskId) => {
      warnings.push({ agent, ...(taskId ? { taskId } : {}) });
    },
  });
  return {
    monitor,
    sent,
    journals,
    warnings,
    get state() {
      return store;
    },
    setStops(next: PersistenceStopRow[]) {
      stops = next;
    },
    setJudgment(next: InternalPlanTurnJudgment) {
      judgment = next;
    },
  };
}

describe("t-73885b — InternalPlanRepromptMonitor", () => {
  it("sends exactly one remprompt for sem-plano + required kind", async () => {
    const h = harness({});
    await h.monitor.tick();
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toMatch(/plan/i);
    expect(h.journals).toEqual([]);
    expect(h.warnings).toEqual([]);

    h.setStops([STOP, { ...STOP, ts: "2026-08-16T18:05:00.000Z" }]);
    await h.monitor.tick();
    expect(h.sent).toHaveLength(1);
    expect(h.journals).toHaveLength(1);
    expect(h.journals[0]?.taskId).toBe("t-73885b");
    expect(h.journals[0]?.text).toMatch(/not blocked|does not block/i);
    expect(h.warnings).toEqual([{ agent: "worker", taskId: "t-73885b" }]);
  });

  it("does not remprompt on sem-canal", async () => {
    const h = harness({ judgment: SEM_CANAL });
    await h.monitor.tick();
    expect(h.sent).toEqual([]);
    expect(h.journals).toEqual([]);
    expect(h.warnings).toEqual([]);
  });

  it("does not remprompt on pending", async () => {
    const h = harness({ judgment: PENDING });
    await h.monitor.tick();
    expect(h.sent).toEqual([]);
  });

  it("does not remprompt when the kind is not required", async () => {
    const h = harness({ task: { id: "t-73885b", kind: "chore" }, exigirEm: ["feature"] });
    await h.monitor.tick();
    expect(h.sent).toEqual([]);
  });

  it("does not remprompt a stop it has already seen", async () => {
    const h = harness({});
    await h.monitor.tick();
    await h.monitor.tick();
    expect(h.sent).toHaveLength(1);
    expect(h.journals).toEqual([]);
  });

  it("give-up does not throw or otherwise block", async () => {
    const h = harness({});
    await h.monitor.tick();
    h.setStops([STOP, { ...STOP, ts: "2026-08-16T18:05:00.000Z" }]);
    await expect(h.monitor.tick()).resolves.toBeUndefined();
    expect(h.sent).toHaveLength(1);
    expect(h.warnings).toHaveLength(1);
    h.setStops([
      STOP,
      { ...STOP, ts: "2026-08-16T18:05:00.000Z" },
      { ...STOP, ts: "2026-08-16T18:10:00.000Z" },
    ]);
    await h.monitor.tick();
    expect(h.sent).toHaveLength(1);
    expect(h.warnings).toHaveLength(1);
  });

  it("clears the spent remprompt after a later com-plano", async () => {
    const h = harness({});
    await h.monitor.tick();
    expect(h.sent).toHaveLength(1);
    h.setJudgment(COM_PLANO);
    h.setStops([STOP, { ...STOP, ts: "2026-08-16T18:05:00.000Z" }]);
    await h.monitor.tick();
    expect(h.journals).toEqual([]);
    h.setJudgment(SEM_PLANO);
    h.setStops([
      STOP,
      { ...STOP, ts: "2026-08-16T18:05:00.000Z" },
      { ...STOP, ts: "2026-08-16T18:10:00.000Z" },
    ]);
    await h.monitor.tick();
    expect(h.sent).toHaveLength(2);
  });
});
