import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { judgeClaudeInternalPlanTurn } from "@tachyon/engine/runtime/claudeInternalPlanTurn.js";

/**
 * t-011136 — Claude end-of-turn verdict. These tests import
 * `judgeClaudeInternalPlanTurn` — the host door. A helper that always
 * returns `sem-plano`, or that treats StopFailure as Stop, turns the
 * suite red.
 */

const FIXTURE_HOME = path.resolve("test/fixtures/claude-internal-plan");
const FLAG_OFF_TOOLS = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_HOME, "init-tools-default.json"), "utf8"),
) as { tools: string[] };
const FLAG_ON_TOOLS = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_HOME, "init-tools-todo-tools.json"), "utf8"),
) as { tools: string[] };

const START = { hook_event_name: "UserPromptSubmit" };
const STOP = { hook_event_name: "Stop" };
const STOP_FAILURE = { hook_event_name: "StopFailure", error: "authentication_failed" };
const WRITE = {
  type: "assistant",
  message: { content: [{ type: "tool_use", name: "Write" }] },
};
const TASK_CREATE = {
  type: "assistant",
  message: { content: [{ type: "tool_use", name: "TaskCreate" }] },
};
const TASK_CREATED = { hook_event_name: "TaskCreated", task_id: "1" };
const RESULT_OK = { type: "result", subtype: "success", stop_reason: "end_turn", terminal_reason: "completed" };
const RESULT_AUTH = { type: "result", is_error: true, terminal_reason: "api_error" };

describe("t-011136 — judgeClaudeInternalPlanTurn (production door)", () => {
  it("emits com-plano when a TaskCreate lands before Stop", () => {
    expect(
      judgeClaudeInternalPlanTurn({
        initTools: FLAG_ON_TOOLS.tools,
        events: [START, TASK_CREATE, TASK_CREATED, STOP],
      }),
    ).toEqual({ state: "verdict", verdict: "com-plano" });
  });

  it("emits sem-plano when the channel existed and Stop arrives with no plan event", () => {
    expect(
      judgeClaudeInternalPlanTurn({
        initTools: FLAG_ON_TOOLS.tools,
        events: [START, WRITE, STOP],
      }),
    ).toEqual({ state: "verdict", verdict: "sem-plano" });
  });

  it("emits sem-canal when init.tools has no plan family — distinct from sem-plano", () => {
    const withoutChannel = judgeClaudeInternalPlanTurn({
      initTools: FLAG_OFF_TOOLS.tools,
      events: [START, WRITE, STOP],
    });
    const withChannel = judgeClaudeInternalPlanTurn({
      initTools: FLAG_ON_TOOLS.tools,
      events: [START, WRITE, STOP],
    });
    expect(withoutChannel).toEqual({ state: "verdict", verdict: "sem-canal" });
    expect(withChannel).toEqual({ state: "verdict", verdict: "sem-plano" });
    expect(withoutChannel).not.toEqual(withChannel);
  });

  it("does not emit sem-plano while the turn is still open (silence is not absence)", () => {
    const mid = judgeClaudeInternalPlanTurn({
      initTools: FLAG_ON_TOOLS.tools,
      events: [START, WRITE],
    });
    expect(mid).toEqual({ state: "pending", reason: "turn-open" });
    expect(mid).not.toEqual({ state: "verdict", verdict: "sem-plano" });
    expect(mid).not.toEqual({ state: "verdict", verdict: "sem-canal" });
    expect(mid).not.toEqual({ state: "verdict", verdict: "com-plano" });
  });

  it("does not treat StopFailure as Stop — a dead turn is not sem-plano", () => {
    expect(
      judgeClaudeInternalPlanTurn({
        initTools: FLAG_ON_TOOLS.tools,
        events: [START, WRITE, STOP_FAILURE],
      }),
    ).toEqual({ state: "pending", reason: "turn-not-completed" });
    expect(
      judgeClaudeInternalPlanTurn({
        initTools: FLAG_ON_TOOLS.tools,
        events: [START, WRITE, RESULT_AUTH],
      }),
    ).toEqual({ state: "pending", reason: "turn-not-completed" });
  });

  it("accepts the print-mode result as the same successful end as Stop", () => {
    expect(
      judgeClaudeInternalPlanTurn({
        initTools: FLAG_ON_TOOLS.tools,
        events: [START, RESULT_OK],
      }),
    ).toEqual({ state: "verdict", verdict: "sem-plano" });
  });

  it("does not leak a previous turn's plan into the next window", () => {
    expect(
      judgeClaudeInternalPlanTurn({
        initTools: FLAG_ON_TOOLS.tools,
        events: [START, TASK_CREATE, STOP, START, WRITE, STOP],
      }),
    ).toEqual({ state: "verdict", verdict: "sem-plano" });
  });

  it("does not treat subagent Task as a plan event", () => {
    expect(
      judgeClaudeInternalPlanTurn({
        initTools: FLAG_ON_TOOLS.tools,
        events: [
          START,
          { type: "assistant", message: { content: [{ type: "tool_use", name: "Task" }] } },
          STOP,
        ],
      }),
    ).toEqual({ state: "verdict", verdict: "sem-plano" });
  });

  it("counts an empty TodoWrite as com-plano — the channel spoke", () => {
    expect(
      judgeClaudeInternalPlanTurn({
        initTools: [...FLAG_ON_TOOLS.tools, "TodoWrite"],
        events: [
          START,
          { hook_event_name: "PostToolUse", tool_name: "TodoWrite" },
          STOP,
        ],
      }),
    ).toEqual({ state: "verdict", verdict: "com-plano" });
  });

  it("fails if the judge ignores the event stream (red proof)", () => {
    expect(
      judgeClaudeInternalPlanTurn({
        initTools: FLAG_ON_TOOLS.tools,
        events: [START, { hook_event_name: "PreToolUse", tool_name: "TaskCreate" }, STOP],
      }),
    ).toEqual({ state: "verdict", verdict: "com-plano" });
  });

  it("this suite calls the production judge, not a test-local stand-in", () => {
    const source = fs.readFileSync(path.resolve("test/unit/claudeInternalPlanTurn.test.ts"), "utf8");
    expect(source).toMatch(/from "@tachyon\/engine\/runtime\/claudeInternalPlanTurn\.js"/);
    expect(source).toMatch(/judgeClaudeInternalPlanTurn\(/);
    expect(source).not.toMatch(/function judgeClaudeInternalPlanTurn\(/);
  });
});
