import { describe, it, expect } from "vitest";
import { normalizeHermesRows, type HermesMessageRow } from "../../src/activity/hermesNormalizer.js";

const row = (partial: Partial<HermesMessageRow> & Pick<HermesMessageRow, "id" | "role">): HermesMessageRow => ({
  session_id: "20260713_185208_da5df2",
  content: null,
  ...partial,
});

describe("hermesNormalizer", () => {
  it("maps user + assistant turns", () => {
    const events = normalizeHermesRows([
      row({ id: 1, role: "user", content: "hello hermes" }),
      row({ id: 2, role: "assistant", content: "hi there", reasoning_content: "thinking…" }),
    ]);
    expect(events.map((e) => e.type)).toEqual([
      "user.message.completed",
      "assistant.thinking",
      "assistant.message.completed",
    ]);
    expect(events[0].runtime).toBe("hermes");
    expect((events[0].payload as { text: string }).text).toBe("hello hermes");
    expect((events[2].payload as { text: string }).text).toBe("hi there");
  });

  it("emits tool.started from assistant tool_calls and tool.completed from tool role", () => {
    const toolCalls = JSON.stringify([
      { id: "call_1", function: { name: "read_file", arguments: JSON.stringify({ path: "src/a.ts" }) } },
    ]);
    const events = normalizeHermesRows([
      row({ id: 3, role: "assistant", content: "", tool_calls: toolCalls }),
      row({ id: 4, role: "tool", tool_call_id: "call_1", tool_name: "read_file", content: "ok contents" }),
    ]);
    expect(events.map((e) => e.type)).toEqual(["tool.started", "file.referenced", "tool.completed"]);
    expect((events[0].payload as { name: string }).name).toBe("read_file");
    expect((events[1].payload as { path: string }).path).toBe("src/a.ts");
  });

  it("marks tachyon nudges and user interrupts", () => {
    const nudge = normalizeHermesRows([row({ id: 5, role: "user", content: "[tachyon] handoff reminder" })]);
    expect(nudge[0].type).toBe("system.nudge");
    const ir = normalizeHermesRows([row({ id: 6, role: "user", content: "Interrupted by user." })]);
    expect(ir[0].type).toBe("user.interrupted");
  });

  it("uses stable record ids from message id", () => {
    const events = normalizeHermesRows([row({ id: 42, role: "user", content: "x" })]);
    expect(events[0].recordId).toBe("msg:42");
  });
});
