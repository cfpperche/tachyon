import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { grokInternalChecklistUpdatesPath } from "@tachyon/engine/runtime/grokInternalChecklistReader.js";
import { judgeGrokInternalChecklistTurn } from "@tachyon/engine/runtime/grokInternalChecklistTurn.js";

/**
 * t-011136 — Grok end-of-turn verdict. These tests import
 * `judgeGrokInternalChecklistTurn` — the host door that opens the session's
 * `updates.jsonl`. A helper that treats mid-turn silence as `absent`,
 * or that reads `plan.json` / `events.jsonl` as the plan channel, turns
 * the suite red.
 */

const FIXTURE_HOME = path.resolve("test/fixtures/grok-internal-plan");

const INDUCE = {
  cwd: "/tmp/t-339e47-grok-plan/m1-induce/cwd",
  sessionId: "6bc8226f-8fba-48d7-bd02-61b9a6eb55d9",
} as const;

const TRIVIAL = {
  cwd: "/tmp/t-339e47-grok-plan/m2-trivial/cwd",
  sessionId: "188ca393-8919-4261-ac9e-843c54c8f564",
} as const;

const EMPTY = {
  cwd: "/tmp/t-339e47-grok-plan/m4-empty/cwd",
  sessionId: "1202ad7c-09b9-4fed-8ec1-128437c17aa4",
} as const;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempHome(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-grok-plan-turn-"));
  dirs.push(root);
  return root;
}

function writeSession(
  home: string,
  cwd: string,
  sessionId: string,
  files: { updates?: readonly unknown[]; events?: readonly unknown[] },
): void {
  const updates = grokInternalChecklistUpdatesPath({ configHome: home, cwd, sessionId });
  expect(updates).toBeTypeOf("string");
  const dir = path.dirname(updates!);
  fs.mkdirSync(dir, { recursive: true });
  if (files.updates) {
    fs.writeFileSync(updates!, `${files.updates.map((line) => JSON.stringify(line)).join("\n")}\n`);
  }
  if (files.events) {
    fs.writeFileSync(
      path.join(dir, "events.jsonl"),
      `${files.events.map((line) => JSON.stringify(line)).join("\n")}\n`,
    );
  }
}

function sessionUpdate(update: Record<string, unknown>, meta: Record<string, unknown> = {}): unknown {
  return { method: "session/update", params: { update, _meta: meta } };
}

describe("t-011136 — judgeGrokInternalChecklistTurn (production door)", () => {
  it("emits present for the measured induce updates.jsonl", () => {
    expect(
      judgeGrokInternalChecklistTurn({
        configHome: FIXTURE_HOME,
        cwd: INDUCE.cwd,
        sessionId: INDUCE.sessionId,
      }),
    ).toEqual({ state: "verdict", verdict: "present" });
  });

  it("emits absent for the measured trivial turn", () => {
    expect(
      judgeGrokInternalChecklistTurn({
        configHome: FIXTURE_HOME,
        cwd: TRIVIAL.cwd,
        sessionId: TRIVIAL.sessionId,
      }),
    ).toEqual({ state: "verdict", verdict: "absent" });
  });

  it("emits present for the measured empty-list write — the channel spoke", () => {
    expect(
      judgeGrokInternalChecklistTurn({
        configHome: FIXTURE_HOME,
        cwd: EMPTY.cwd,
        sessionId: EMPTY.sessionId,
      }),
    ).toEqual({ state: "verdict", verdict: "present" });
  });

  it("does not emit absent while turn_completed is missing (the 7-minute silence)", () => {
    const home = tempHome();
    const cwd = "/tmp/mid-turn-silence";
    const sessionId = "aaaaaaaa-bbbb-4ccc-8ddd-111111111111";
    const promptId = "mid-turn-prompt";
    writeSession(home, cwd, sessionId, {
      updates: [
        sessionUpdate({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "work" } }),
        sessionUpdate(
          { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking" } },
          { promptId, turnStartMs: 1 },
        ),
        sessionUpdate(
          { sessionUpdate: "tool_call", title: "Bash", rawInput: { command: "ls" } },
          { promptId, turnStartMs: 1 },
        ),
      ],
    });
    const mid = judgeGrokInternalChecklistTurn({ configHome: home, cwd, sessionId });
    expect(mid).toEqual({ state: "pending", reason: "turn-open" });
    expect(mid).not.toEqual({ state: "verdict", verdict: "absent" });
  });

  it("becomes present only after the late plan and turn_completed arrive", () => {
    const home = tempHome();
    const cwd = "/tmp/late-plan";
    const sessionId = "aaaaaaaa-bbbb-4ccc-8ddd-222222222222";
    const promptId = "late-plan-prompt";
    const prefix = [
      sessionUpdate({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "work" } }),
      sessionUpdate(
        { sessionUpdate: "tool_call", title: "Bash", rawInput: { command: "sleep 420" } },
        { promptId, turnStartMs: 10 },
      ),
    ];
    writeSession(home, cwd, sessionId, { updates: prefix });
    expect(judgeGrokInternalChecklistTurn({ configHome: home, cwd, sessionId })).toEqual({
      state: "pending",
      reason: "turn-open",
    });

    writeSession(home, cwd, sessionId, {
      updates: [
        ...prefix,
        sessionUpdate(
          {
            sessionUpdate: "plan",
            entries: [{ content: "late", status: "pending" }],
          },
          { promptId, turnStartMs: 10 },
        ),
        sessionUpdate(
          { sessionUpdate: "turn_completed", prompt_id: promptId, stop_reason: "end_turn" },
          { promptId },
        ),
      ],
    });
    expect(judgeGrokInternalChecklistTurn({ configHome: home, cwd, sessionId })).toEqual({
      state: "verdict",
      verdict: "present",
    });
  });

  it("emits no-channel when turn-end is only on events.jsonl — distinct from absent", () => {
    const home = tempHome();
    const cwd = "/tmp/events-only";
    const sessionId = "aaaaaaaa-bbbb-4ccc-8ddd-333333333333";
    writeSession(home, cwd, sessionId, {
      events: [{ type: "turn_ended", prompt_id: "events-only" }],
    });
    const withoutChannel = judgeGrokInternalChecklistTurn({ configHome: home, cwd, sessionId });
    expect(withoutChannel).toEqual({ state: "verdict", verdict: "no-channel" });

    const withChannel = judgeGrokInternalChecklistTurn({
      configHome: FIXTURE_HOME,
      cwd: TRIVIAL.cwd,
      sessionId: TRIVIAL.sessionId,
    });
    expect(withChannel).toEqual({ state: "verdict", verdict: "absent" });
    expect(withoutChannel).not.toEqual(withChannel);
  });

  it("does not leak turn 1's plan into turn 2", () => {
    const home = tempHome();
    const cwd = "/tmp/two-turns";
    const sessionId = "aaaaaaaa-bbbb-4ccc-8ddd-444444444444";
    writeSession(home, cwd, sessionId, {
      updates: [
        sessionUpdate({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "plan" } }),
        sessionUpdate(
          { sessionUpdate: "plan", entries: [{ content: "one", status: "pending" }] },
          { promptId: "p1", turnStartMs: 1 },
        ),
        sessionUpdate({ sessionUpdate: "turn_completed", prompt_id: "p1", stop_reason: "end_turn" }),
        sessionUpdate({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "pong" } }),
        sessionUpdate(
          { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "PONG" } },
          { promptId: "p2", turnStartMs: 2 },
        ),
        sessionUpdate({ sessionUpdate: "turn_completed", prompt_id: "p2", stop_reason: "end_turn" }),
      ],
    });
    expect(judgeGrokInternalChecklistTurn({ configHome: home, cwd, sessionId, promptId: "p2" })).toEqual({
      state: "verdict",
      verdict: "absent",
    });
    expect(judgeGrokInternalChecklistTurn({ configHome: home, cwd, sessionId, promptId: "p1" })).toEqual({
      state: "verdict",
      verdict: "present",
    });
  });

  it("a missing session is pending, not absent — post-dismiss is not evidence", () => {
    expect(
      judgeGrokInternalChecklistTurn({
        configHome: tempHome(),
        cwd: INDUCE.cwd,
        sessionId: INDUCE.sessionId,
      }),
    ).toEqual({ state: "pending", reason: "turn-open" });
  });

  it("fails if the judge does not open updates.jsonl (red proof)", () => {
    const home = tempHome();
    const cwd = "/tmp/red-proof-turn";
    const sessionId = "aaaaaaaa-bbbb-4ccc-8ddd-555555555555";
    writeSession(home, cwd, sessionId, {
      updates: [
        sessionUpdate({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "canary" } }),
        sessionUpdate(
          {
            sessionUpdate: "tool_call_update",
            status: "completed",
            rawOutput: {
              type: "Todo",
              TodosUpdated: { todos: [{ content: "CANARY_TURN_PLAN", status: "pending" }] },
            },
          },
          { promptId: "canary", turnStartMs: 1 },
        ),
        sessionUpdate({ sessionUpdate: "turn_completed", prompt_id: "canary", stop_reason: "end_turn" }),
      ],
    });
    expect(judgeGrokInternalChecklistTurn({ configHome: home, cwd, sessionId })).toEqual({
      state: "verdict",
      verdict: "present",
    });
  });

  it("this suite calls the production judge, not a test-local stand-in", () => {
    const source = fs.readFileSync(path.resolve("test/unit/grokInternalChecklistTurn.test.ts"), "utf8");
    expect(source).toMatch(/from "@tachyon\/engine\/runtime\/grokInternalChecklistTurn\.js"/);
    expect(source).toMatch(/judgeGrokInternalChecklistTurn\(/);
    expect(source).not.toMatch(/function judgeGrokInternalChecklistTurn\(/);
    const impl = fs.readFileSync(path.resolve("packages/engine/src/runtime/grokInternalChecklistTurn.ts"), "utf8");
    expect(impl).not.toMatch(/["']plan\.json["']/);
  });
});
