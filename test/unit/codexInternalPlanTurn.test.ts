import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { CODEX_TOOL_HOOK_RECORDER_SOURCE, PERSISTENCE_STOP_RECORDER_SOURCE } from "@tachyon/engine/activity/sessionOwners.js";
import { CODEX_INTERNAL_PLAN_NOTIFICATION } from "@tachyon/engine/runtime/codexInternalPlanReader.js";
import { judgeCodexInternalPlanTurn } from "@tachyon/engine/runtime/codexInternalPlanTurn.js";
import { makeTempDir } from "../helpers/tempDir.js";

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

/**
 * t-17b510 — TUI door. Measured payloads from
 * docs/research/poc-plano-interno-codex-tui.md (codex-cli 0.147.0).
 * These call `judgeCodexInternalPlanTurn` — the same production door as
 * the app-server suite above. A helper that classifies TUI hooks only
 * inside this file turns the suite red.
 */
const TUI_STOP_INDUCE = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, "tui-stop-induce.json"), "utf8"),
) as { turn_id: string; hook_event_name: string };
const TUI_STOP_TRIVIAL = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, "tui-stop-trivial.json"), "utf8"),
) as { turn_id: string; hook_event_name: string };
const TUI_POST_PLAN = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, "tui-post-tool-update-plan.json"), "utf8"),
) as { turn_id: string; hook_event_name: string; tool_name: string; tool_input: { plan: unknown } };
const TUI_PRE_PLAN = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, "tui-pre-tool-update-plan.json"), "utf8"),
) as { turn_id: string; hook_event_name: string; tool_name: string; tool_input: { plan: unknown } };

describe("t-17b510 — judgeCodexInternalPlanTurn from Codex TUI hooks", () => {
  it("emits com-plano for measured Stop + PostToolUse update_plan on the same turn_id", () => {
    expect(
      judgeCodexInternalPlanTurn({
        notifications: [TUI_PRE_PLAN, TUI_POST_PLAN, TUI_STOP_INDUCE],
        turnId: TUI_STOP_INDUCE.turn_id,
      }),
    ).toEqual({ state: "verdict", verdict: "com-plano" });
  });

  it("emits sem-plano for the measured trivial turn (Stop, zero plan hooks)", () => {
    expect(
      judgeCodexInternalPlanTurn({
        notifications: [TUI_STOP_TRIVIAL],
        turnId: TUI_STOP_TRIVIAL.turn_id,
      }),
    ).toEqual({ state: "verdict", verdict: "sem-plano" });
  });

  it("emits sem-canal when the TUI hook inventory omits PreToolUse/PostToolUse", () => {
    const withoutChannel = judgeCodexInternalPlanTurn({
      notifications: [TUI_STOP_TRIVIAL],
      turnId: TUI_STOP_TRIVIAL.turn_id,
      knownHookEvents: ["SessionStart", "Stop"],
    });
    const withChannel = judgeCodexInternalPlanTurn({
      notifications: [TUI_STOP_TRIVIAL],
      turnId: TUI_STOP_TRIVIAL.turn_id,
      knownHookEvents: ["SessionStart", "Stop", "PreToolUse", "PostToolUse"],
    });
    expect(withoutChannel).toEqual({ state: "verdict", verdict: "sem-canal" });
    expect(withChannel).toEqual({ state: "verdict", verdict: "sem-plano" });
    expect(withoutChannel).not.toEqual(withChannel);
  });

  it("does not treat rollout exec, logs_2 names, or prompt-text update_plan as a plan", () => {
    expect(
      judgeCodexInternalPlanTurn({
        notifications: [
          { type: "response_item", payload: { name: "exec", input: "tools.update_plan({plan:[{step:'x',status:'pending'}]})" } },
          { event: "app-server event: turn/plan/updated targeted_connections=1" },
          { text: "please call update_plan", session_id: "state_5" },
          TUI_STOP_INDUCE,
        ],
        turnId: TUI_STOP_INDUCE.turn_id,
      }),
    ).toEqual({ state: "verdict", verdict: "sem-plano" });
  });

  it("does not leak turn A's TUI plan into turn B (red proof on the production judge)", () => {
    expect(
      judgeCodexInternalPlanTurn({
        notifications: [TUI_POST_PLAN, TUI_STOP_INDUCE, TUI_STOP_TRIVIAL],
        turnId: TUI_STOP_TRIVIAL.turn_id,
      }),
    ).toEqual({ state: "verdict", verdict: "sem-plano" });
    expect(
      judgeCodexInternalPlanTurn({
        notifications: [TUI_POST_PLAN, TUI_STOP_INDUCE, TUI_STOP_TRIVIAL],
        turnId: TUI_STOP_INDUCE.turn_id,
      }),
    ).toEqual({ state: "verdict", verdict: "com-plano" });
  });

  it("stays pending while TUI Stop has not arrived for that turn_id", () => {
    expect(
      judgeCodexInternalPlanTurn({
        notifications: [TUI_POST_PLAN],
        turnId: TUI_POST_PLAN.turn_id,
      }),
    ).toEqual({ state: "pending", reason: "turn-open" });
  });

  it("reads turn_id and tool_input.plan from the production recorders (red if either drops them)", () => {
    const tmp = makeTempDir("tachyon-tui-plan-recorders-");
    const stopScript = path.join(tmp, "persistence-stop-record.cjs");
    const toolScript = path.join(tmp, "codex-tool-hook-record.cjs");
    const stopFile = path.join(tmp, "persistence-stop.jsonl");
    const toolFile = path.join(tmp, "codex-tool-hooks.jsonl");
    const failureFile = path.join(tmp, "failures.jsonl");
    fs.writeFileSync(stopScript, PERSISTENCE_STOP_RECORDER_SOURCE);
    fs.writeFileSync(toolScript, CODEX_TOOL_HOOK_RECORDER_SOURCE);

    const stop = spawnSync(process.execPath, [stopScript, "codex-x", stopFile, failureFile], {
      input: JSON.stringify(TUI_STOP_INDUCE),
      encoding: "utf8",
    });
    const tool = spawnSync(process.execPath, [toolScript, "codex-x", toolFile, failureFile], {
      input: JSON.stringify(TUI_POST_PLAN),
      encoding: "utf8",
    });
    expect(stop.status).toBe(0);
    expect(tool.status).toBe(0);

    const stopRow = JSON.parse(fs.readFileSync(stopFile, "utf8").trim()) as Record<string, unknown>;
    const toolRow = JSON.parse(fs.readFileSync(toolFile, "utf8").trim()) as Record<string, unknown>;
    expect(stopRow.turnId).toBe(TUI_STOP_INDUCE.turn_id);
    expect(stopRow).not.toHaveProperty("transcript_path");
    expect(stopRow).not.toHaveProperty("last_assistant_message");
    expect(toolRow.turnId).toBe(TUI_POST_PLAN.turn_id);
    expect(toolRow.toolInput).toEqual(TUI_POST_PLAN.tool_input);
    expect((toolRow.toolInput as { plan: unknown }).plan).toEqual(TUI_POST_PLAN.tool_input.plan);

    expect(
      judgeCodexInternalPlanTurn({
        notifications: [toolRow, stopRow],
        turnId: TUI_STOP_INDUCE.turn_id,
      }),
    ).toEqual({ state: "verdict", verdict: "com-plano" });

    const trivialStop = spawnSync(process.execPath, [stopScript, "codex-x", stopFile, failureFile], {
      input: JSON.stringify(TUI_STOP_TRIVIAL),
      encoding: "utf8",
    });
    expect(trivialStop.status).toBe(0);
    const trivialRow = fs.readFileSync(stopFile, "utf8").trim().split("\n").map((line) => JSON.parse(line)).at(-1) as Record<string, unknown>;
    expect(trivialRow.turnId).toBe(TUI_STOP_TRIVIAL.turn_id);
    expect(
      judgeCodexInternalPlanTurn({
        notifications: [trivialRow],
        turnId: TUI_STOP_TRIVIAL.turn_id,
      }),
    ).toEqual({ state: "verdict", verdict: "sem-plano" });
  });
});
