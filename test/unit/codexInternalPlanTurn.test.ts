import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CODEX_INTERNAL_PLAN_NOTIFICATION } from "@tachyon/engine/runtime/codexInternalPlanReader.js";
import { judgeCodexInternalPlanTurn } from "@tachyon/engine/runtime/codexInternalPlanTurn.js";

/**
 * t-011136 — Codex end-of-turn verdict. These tests import
 * `judgeCodexInternalPlanTurn` — the host door. A helper that emits
 * `sem-plano` from `turn/started` alone, or that treats `item/plan/delta`
 * as a plan, turns the suite red.
 */

const FIXTURE_DIR = path.resolve("test/fixtures/codex-internal-plan");
const MEASURED_PLAN = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, "turn-plan-updated.json"), "utf8"),
) as { method: string; params: { threadId: string; turnId: string } };
const TURN_COMPLETED = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, "turn-completed.json"), "utf8"),
) as { method: string; params: { threadId: string; turn: { id: string; status: string } } };
const PLAN_DELTA = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, "item-plan-delta.json"), "utf8"),
) as unknown;

const TURN_A = MEASURED_PLAN.params.turnId;
const THREAD = MEASURED_PLAN.params.threadId;
const TURN_B = "01a00b3b-0acc-7e33-b019-124302957ebf";

function started(turnId: string): unknown {
  return { method: "turn/started", params: { threadId: THREAD, turn: { id: turnId, status: "inProgress" } } };
}

function completed(turnId: string, status = "completed"): unknown {
  return {
    method: "turn/completed",
    params: { threadId: THREAD, turn: { id: turnId, status, itemsView: "summary", items: [] } },
  };
}

describe("t-011136 — judgeCodexInternalPlanTurn (production door)", () => {
  it("emits com-plano for the measured turn/plan/updated + turn/completed pair", () => {
    expect(
      judgeCodexInternalPlanTurn({
        notifications: [started(TURN_A), MEASURED_PLAN, TURN_COMPLETED],
        turnId: TURN_A,
      }),
    ).toEqual({ state: "verdict", verdict: "com-plano" });
  });

  it("emits sem-plano when turn/completed arrives with no turn/plan/updated for that turnId", () => {
    expect(
      judgeCodexInternalPlanTurn({
        notifications: [started(TURN_B), completed(TURN_B)],
        turnId: TURN_B,
      }),
    ).toEqual({ state: "verdict", verdict: "sem-plano" });
  });

  it("emits sem-canal when the protocol omits turn/plan/updated — distinct from sem-plano", () => {
    const withoutChannel = judgeCodexInternalPlanTurn({
      notifications: [started(TURN_B), completed(TURN_B)],
      turnId: TURN_B,
      knownNotifications: ["turn/started", "turn/completed", "item/plan/delta"],
    });
    const withChannel = judgeCodexInternalPlanTurn({
      notifications: [started(TURN_B), completed(TURN_B)],
      turnId: TURN_B,
      knownNotifications: ["turn/started", "turn/completed", CODEX_INTERNAL_PLAN_NOTIFICATION],
    });
    expect(withoutChannel).toEqual({ state: "verdict", verdict: "sem-canal" });
    expect(withChannel).toEqual({ state: "verdict", verdict: "sem-plano" });
    expect(withoutChannel).not.toEqual(withChannel);
  });

  it("does not emit sem-plano while turn/completed is missing (silence is not absence)", () => {
    const mid = judgeCodexInternalPlanTurn({
      notifications: [started(TURN_B)],
      turnId: TURN_B,
    });
    expect(mid).toEqual({ state: "pending", reason: "turn-open" });
    expect(mid).not.toEqual({ state: "verdict", verdict: "sem-plano" });
  });

  it("does not treat a failed-before-model turn as sem-plano", () => {
    expect(
      judgeCodexInternalPlanTurn({
        notifications: [started(TURN_B), completed(TURN_B, "failed")],
        turnId: TURN_B,
      }),
    ).toEqual({ state: "pending", reason: "turn-not-completed" });
    expect(
      judgeCodexInternalPlanTurn({
        notifications: [started(TURN_B), completed(TURN_B, "interrupted")],
        turnId: TURN_B,
      }),
    ).toEqual({ state: "pending", reason: "turn-not-completed" });
  });

  it("does not treat item/plan/delta or turn.completed.items as a plan event", () => {
    expect(
      judgeCodexInternalPlanTurn({
        notifications: [started(TURN_A), PLAN_DELTA, TURN_COMPLETED],
        turnId: TURN_A,
      }),
    ).toEqual({ state: "verdict", verdict: "sem-plano" });
  });

  it("does not leak turn A's plan into turn B", () => {
    expect(
      judgeCodexInternalPlanTurn({
        notifications: [started(TURN_A), MEASURED_PLAN, TURN_COMPLETED, started(TURN_B), completed(TURN_B)],
        turnId: TURN_B,
      }),
    ).toEqual({ state: "verdict", verdict: "sem-plano" });
    expect(
      judgeCodexInternalPlanTurn({
        notifications: [started(TURN_A), MEASURED_PLAN, TURN_COMPLETED, started(TURN_B), completed(TURN_B)],
        turnId: TURN_A,
      }),
    ).toEqual({ state: "verdict", verdict: "com-plano" });
  });

  it("fails if the judge ignores turnId (red proof)", () => {
    const canaryTurn = "red-proof-turn";
    const canary = {
      method: CODEX_INTERNAL_PLAN_NOTIFICATION,
      params: {
        threadId: "red-proof-thread",
        turnId: canaryTurn,
        plan: [{ step: "CANARY_TURN_PLAN", status: "pending" }],
      },
    };
    expect(
      judgeCodexInternalPlanTurn({
        notifications: [started(canaryTurn), canary, completed(canaryTurn)],
        turnId: canaryTurn,
      }),
    ).toEqual({ state: "verdict", verdict: "com-plano" });
  });

  it("this suite calls the production judge, not a test-local stand-in", () => {
    const source = fs.readFileSync(path.resolve("test/unit/codexInternalPlanTurn.test.ts"), "utf8");
    expect(source).toMatch(/from "@tachyon\/engine\/runtime\/codexInternalPlanTurn\.js"/);
    expect(source).toMatch(/judgeCodexInternalPlanTurn\(/);
    expect(source).not.toMatch(/function judgeCodexInternalPlanTurn\(/);
  });
});
