import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { judgeClaudeInternalChecklistTurn } from "@tachyon/engine/runtime/claudeInternalChecklistTurn.js";
import { readClaudeTurnEvidence } from "@tachyon/engine/runtime/claudeTurnEvidence.js";

/**
 * t-9f21ac — the reader that wedged the engine. It fed the judge the WHOLE transcript, once per
 * turn-end row; the live file here was 335 MB. These tests hold the bound: the window is the last
 * turn, the head still yields `init.tools`, and a window that cannot reach the turn-start says
 * "no evidence" (pending) instead of inventing `absent`.
 */

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** Wide enough that a line-count bound is not a bound: the real records are ~4 KB. */
const PAD_RECORD = { type: "user", pad: "x".repeat(4000) };
const PAD_BYTES = `${JSON.stringify(PAD_RECORD)}\n`.length;
const OVER_THE_CEILING = Math.ceil((3 * 1024 * 1024) / PAD_BYTES);

function transcript(rows: unknown[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-turn-evidence-"));
  dirs.push(dir);
  const file = path.join(dir, "session.jsonl");
  fs.writeFileSync(file, rows.map((row) => `${JSON.stringify(row)}\n`).join(""), "utf8");
  return file;
}

function padding(count = OVER_THE_CEILING): unknown[] {
  return Array.from({ length: count }, () => PAD_RECORD);
}

const INIT = { type: "system", subtype: "init", tools: ["Read", "TodoWrite"] };
const TURN_START = { hook_event_name: "UserPromptSubmit" };
const TODO_WRITE = { hook_event_name: "PreToolUse", tool_name: "TodoWrite" };
const STOP = { hook_event_name: "Stop" };

describe("t-9f21ac — readClaudeTurnEvidence is bounded", () => {
  it("judges a short transcript exactly as before", () => {
    const absent = readClaudeTurnEvidence(transcript([INIT, TURN_START, STOP]));
    expect(judgeClaudeInternalChecklistTurn(absent!)).toEqual({ state: "verdict", verdict: "absent" });

    const present = readClaudeTurnEvidence(transcript([INIT, TURN_START, TODO_WRITE, STOP]));
    expect(judgeClaudeInternalChecklistTurn(present!)).toEqual({ state: "verdict", verdict: "present" });
  });

  it("reads only the last turn out of a transcript far past the ceiling", () => {
    const file = transcript([INIT, ...padding(), TURN_START, TODO_WRITE, STOP]);
    expect(fs.statSync(file).size).toBeGreaterThan(3 * 1024 * 1024);

    const evidence = readClaudeTurnEvidence(file);
    expect(evidence).toBeDefined();
    expect(judgeClaudeInternalChecklistTurn(evidence!)).toEqual({ state: "verdict", verdict: "present" });
    // The bound itself: the evidence is the turn — three records, not the 700+ that precede it.
    expect(evidence!.events).toHaveLength(3);
  });

  it("still finds init.tools in the head when the window starts long after it", () => {
    const withChannel = readClaudeTurnEvidence(transcript([INIT, ...padding(), TURN_START, STOP]));
    expect(withChannel!.initTools).toEqual(["Read", "TodoWrite"]);
    expect(judgeClaudeInternalChecklistTurn(withChannel!)).toEqual({ state: "verdict", verdict: "absent" });

    const noChannel = readClaudeTurnEvidence(
      transcript([{ type: "system", subtype: "init", tools: ["Read"] }, ...padding(), TURN_START, STOP]),
    );
    expect(judgeClaudeInternalChecklistTurn(noChannel!)).toEqual({ state: "verdict", verdict: "no-channel" });
  });

  it("returns no evidence when the turn-start is outside the window", () => {
    // The plan event may be one record beyond the ceiling. Pending is the honest answer; `absent`
    // would accuse an agent that planned.
    expect(readClaudeTurnEvidence(transcript([INIT, TURN_START, ...padding(), STOP]))).toBeUndefined();
  });

  it("is absence of evidence for a missing, empty, or unreadable transcript", () => {
    expect(readClaudeTurnEvidence(path.join(os.tmpdir(), "claude-turn-evidence-nope.jsonl"))).toBeUndefined();
    expect(readClaudeTurnEvidence(transcript([]))).toBeUndefined();
    expect(readClaudeTurnEvidence(path.dirname(transcript([INIT])))).toBeUndefined();
  });

  it("skips a partial trailing record without losing the turn", () => {
    const file = transcript([INIT, TURN_START, TODO_WRITE, STOP]);
    fs.appendFileSync(file, '{"hook_event_name":"Pre', "utf8");
    const evidence = readClaudeTurnEvidence(file);
    expect(judgeClaudeInternalChecklistTurn(evidence!)).toEqual({ state: "verdict", verdict: "present" });
  });

  it("answers an unchanged transcript from the memo, and re-reads after an append", () => {
    const file = transcript([INIT, TURN_START, STOP]);
    const first = readClaudeTurnEvidence(file);
    expect(readClaudeTurnEvidence(file)).toBe(first);
    expect(judgeClaudeInternalChecklistTurn(first!)).toEqual({ state: "verdict", verdict: "absent" });

    fs.appendFileSync(file, `${JSON.stringify(TURN_START)}\n${JSON.stringify(TODO_WRITE)}\n${JSON.stringify(STOP)}\n`);
    const second = readClaudeTurnEvidence(file);
    expect(second).not.toBe(first);
    expect(judgeClaudeInternalChecklistTurn(second!)).toEqual({ state: "verdict", verdict: "present" });
  });
});
