import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { judgeClaudeInternalChecklistTurn } from "@tachyon/engine/runtime/claudeInternalChecklistTurn.js";

/**
 * t-011136 — Claude end-of-turn verdict. These tests import
 * `judgeClaudeInternalChecklistTurn` — the host door. A helper that always
 * returns `absent`, or that treats StopFailure as Stop, turns the
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

describe("t-011136 — judgeClaudeInternalChecklistTurn (production door)", () => {
  it("emits present when a TaskCreate lands before Stop", () => {
    expect(
      judgeClaudeInternalChecklistTurn({
        initTools: FLAG_ON_TOOLS.tools,
        events: [START, TASK_CREATE, TASK_CREATED, STOP],
      }),
    ).toEqual({ state: "verdict", verdict: "present" });
  });

  it("emits absent when the channel existed and Stop arrives with no plan event", () => {
    expect(
      judgeClaudeInternalChecklistTurn({
        initTools: FLAG_ON_TOOLS.tools,
        events: [START, WRITE, STOP],
      }),
    ).toEqual({ state: "verdict", verdict: "absent" });
  });

  it("emits no-channel when init.tools has no plan family — distinct from absent", () => {
    const withoutChannel = judgeClaudeInternalChecklistTurn({
      initTools: FLAG_OFF_TOOLS.tools,
      events: [START, WRITE, STOP],
    });
    const withChannel = judgeClaudeInternalChecklistTurn({
      initTools: FLAG_ON_TOOLS.tools,
      events: [START, WRITE, STOP],
    });
    expect(withoutChannel).toEqual({ state: "verdict", verdict: "no-channel" });
    expect(withChannel).toEqual({ state: "verdict", verdict: "absent" });
    expect(withoutChannel).not.toEqual(withChannel);
  });

  it("does not emit absent while the turn is still open (silence is not absence)", () => {
    const mid = judgeClaudeInternalChecklistTurn({
      initTools: FLAG_ON_TOOLS.tools,
      events: [START, WRITE],
    });
    expect(mid).toEqual({ state: "pending", reason: "turn-open" });
    expect(mid).not.toEqual({ state: "verdict", verdict: "absent" });
    expect(mid).not.toEqual({ state: "verdict", verdict: "no-channel" });
    expect(mid).not.toEqual({ state: "verdict", verdict: "present" });
  });

  it("does not treat StopFailure as Stop — a dead turn is not absent", () => {
    expect(
      judgeClaudeInternalChecklistTurn({
        initTools: FLAG_ON_TOOLS.tools,
        events: [START, WRITE, STOP_FAILURE],
      }),
    ).toEqual({ state: "pending", reason: "turn-not-completed" });
    expect(
      judgeClaudeInternalChecklistTurn({
        initTools: FLAG_ON_TOOLS.tools,
        events: [START, WRITE, RESULT_AUTH],
      }),
    ).toEqual({ state: "pending", reason: "turn-not-completed" });
  });

  it("accepts the print-mode result as the same successful end as Stop", () => {
    expect(
      judgeClaudeInternalChecklistTurn({
        initTools: FLAG_ON_TOOLS.tools,
        events: [START, RESULT_OK],
      }),
    ).toEqual({ state: "verdict", verdict: "absent" });
  });

  it("does not leak a previous turn's plan into the next window", () => {
    expect(
      judgeClaudeInternalChecklistTurn({
        initTools: FLAG_ON_TOOLS.tools,
        events: [START, TASK_CREATE, STOP, START, WRITE, STOP],
      }),
    ).toEqual({ state: "verdict", verdict: "absent" });
  });

  it("does not treat subagent Task as a plan event", () => {
    expect(
      judgeClaudeInternalChecklistTurn({
        initTools: FLAG_ON_TOOLS.tools,
        events: [
          START,
          { type: "assistant", message: { content: [{ type: "tool_use", name: "Task" }] } },
          STOP,
        ],
      }),
    ).toEqual({ state: "verdict", verdict: "absent" });
  });

  it("counts an empty TodoWrite as present — the channel spoke", () => {
    expect(
      judgeClaudeInternalChecklistTurn({
        initTools: [...FLAG_ON_TOOLS.tools, "TodoWrite"],
        events: [
          START,
          { hook_event_name: "PostToolUse", tool_name: "TodoWrite" },
          STOP,
        ],
      }),
    ).toEqual({ state: "verdict", verdict: "present" });
  });

  it("fails if the judge ignores the event stream (red proof)", () => {
    expect(
      judgeClaudeInternalChecklistTurn({
        initTools: FLAG_ON_TOOLS.tools,
        events: [START, { hook_event_name: "PreToolUse", tool_name: "TaskCreate" }, STOP],
      }),
    ).toEqual({ state: "verdict", verdict: "present" });
  });

  it("this suite calls the production judge, not a test-local stand-in", () => {
    const source = fs.readFileSync(path.resolve("test/unit/claudeInternalChecklistTurn.test.ts"), "utf8");
    expect(source).toMatch(/from "@tachyon\/engine\/runtime\/claudeInternalChecklistTurn\.js"/);
    expect(source).toMatch(/judgeClaudeInternalChecklistTurn\(/);
    expect(source).not.toMatch(/function judgeClaudeInternalChecklistTurn\(/);
  });
});
