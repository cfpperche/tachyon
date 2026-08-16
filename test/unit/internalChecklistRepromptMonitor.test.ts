import { describe, expect, it } from "vitest";
import {
  InternalChecklistRepromptMonitor,
  type InternalChecklistRepromptState,
  type PersistenceStopRow,
} from "@tachyon/engine/workspace/InternalChecklistRepromptMonitor.js";
import type { InternalChecklistTurnJudgment } from "@tachyon/engine/runtime/internalChecklistTurn.js";

/**
 * t-73885b — the host that Workspace.tick drives. It must call
 * considerInternalChecklistReprompt (see internalChecklistReprompt.test.ts) and
 * must not reprompt twice, block, or accuse no-channel/pending.
 */

const ABSENT: InternalChecklistTurnJudgment = { state: "verdict", verdict: "absent" };
const NO_CHANNEL: InternalChecklistTurnJudgment = { state: "verdict", verdict: "no-channel" };
const PENDING: InternalChecklistTurnJudgment = { state: "pending", reason: "turn-not-completed" };
const PRESENT: InternalChecklistTurnJudgment = { state: "verdict", verdict: "present" };

const STOP: PersistenceStopRow = {
  agent: "worker",
  event: "Stop",
  sessionId: "s1",
  cwd: "/ws",
  ts: "2026-08-16T18:00:00.000Z",
};

function harness(opts: {
  stops?: PersistenceStopRow[];
  judgment?: InternalChecklistTurnJudgment;
  task?: { id: string; kind?: string };
  requireIn?: readonly string[];
  state?: InternalChecklistRepromptState;
}) {
  let stops = opts.stops ?? [STOP];
  let judgment = opts.judgment ?? ABSENT;
  let store: InternalChecklistRepromptState = { ...(opts.state ?? {}) };
  const sent: string[] = [];
  const journals: Array<{ taskId: string; text: string }> = [];
  const warnings: Array<{ agent: string; taskId?: string }> = [];
  const monitor = new InternalChecklistRepromptMonitor({
    listStopRows: () => stops,
    assignedTask: (agent) => (agent === "worker" ? opts.task ?? { id: "t-73885b", kind: "feature" } : undefined),
    requireIn: () => opts.requireIn ?? ["feature"],
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
    setJudgment(next: InternalChecklistTurnJudgment) {
      judgment = next;
    },
  };
}

describe("t-73885b — InternalChecklistRepromptMonitor", () => {
  it("sends exactly one reprompt for absent + required kind", async () => {
    const h = harness({});
    await h.monitor.tick();
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toMatch(/checklist/i);
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

  it("does not reprompt on no-channel", async () => {
    const h = harness({ judgment: NO_CHANNEL });
    await h.monitor.tick();
    expect(h.sent).toEqual([]);
    expect(h.journals).toEqual([]);
    expect(h.warnings).toEqual([]);
  });

  it("does not reprompt on pending", async () => {
    const h = harness({ judgment: PENDING });
    await h.monitor.tick();
    expect(h.sent).toEqual([]);
  });

  it("does not reprompt when the kind is not required", async () => {
    const h = harness({ task: { id: "t-73885b", kind: "chore" }, requireIn: ["feature"] });
    await h.monitor.tick();
    expect(h.sent).toEqual([]);
  });

  it("does not reprompt a stop it has already seen", async () => {
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

  it("clears the spent reprompt after a later present", async () => {
    const h = harness({});
    await h.monitor.tick();
    expect(h.sent).toHaveLength(1);
    h.setJudgment(PRESENT);
    h.setStops([STOP, { ...STOP, ts: "2026-08-16T18:05:00.000Z" }]);
    await h.monitor.tick();
    expect(h.journals).toEqual([]);
    h.setJudgment(ABSENT);
    h.setStops([
      STOP,
      { ...STOP, ts: "2026-08-16T18:05:00.000Z" },
      { ...STOP, ts: "2026-08-16T18:10:00.000Z" },
    ]);
    await h.monitor.tick();
    expect(h.sent).toHaveLength(2);
  });
});
