import { describe, it, expect } from "vitest";
import { normalizeGrok } from "../../src/activity/grokNormalizer.js";

const line = (rec: unknown): string => JSON.stringify(rec);

describe("Grok activity normalizer (t-9874be)", () => {
  it("maps chat_history records to renderable activity events", () => {
    const events = normalizeGrok([
      line({ type: "system", content: "You are Grok…" }),
      line({
        type: "user",
        content: [{ type: "text", text: "<user_info>\nOS Version: linux\n</user_info>" }],
        synthetic_reason: "compaction_meta",
      }),
      line({
        type: "user",
        content: [{ type: "text", text: "<user_query>\nfixe o bug\n</user_query>" }],
      }),
      line({
        type: "reasoning",
        id: "rs_1",
        summary: [{ type: "summary_text", text: "looking at the failing test" }],
        status: "completed",
      }),
      line({
        type: "assistant",
        content: "Vou inspecionar o teste.",
        model_id: "grok-4.5",
        tool_calls: [
          {
            id: "call-1",
            name: "read_file",
            arguments: JSON.stringify({ target_file: "src/foo.ts" }),
          },
        ],
      }),
      line({ type: "tool_result", tool_call_id: "call-1", content: "export const x = 1;\n" }),
      line({
        type: "assistant",
        content: "Aplicando o patch.",
        tool_calls: [
          {
            id: "call-2",
            name: "search_replace",
            arguments: JSON.stringify({ file_path: "src/foo.ts", old_string: "1", new_string: "2" }),
          },
        ],
      }),
      line({ type: "tool_result", tool_call_id: "call-2", content: "ok" }),
    ], "/tmp/chat_history.jsonl");

    expect(events.map((e) => e.type)).toEqual([
      "compaction.summary",
      "user.message.completed",
      "assistant.thinking",
      "assistant.message.completed",
      "tool.started",
      "file.referenced",
      "tool.completed",
      "assistant.message.completed",
      "tool.started",
      "tool.completed",
      "file.changed",
    ]);
    expect(events[0].runtime).toBe("grok");
    expect(events[1].payload).toEqual({ text: "fixe o bug" });
    expect(events[2].payload).toEqual({ text: "looking at the failing test" });
    expect(events[4].payload).toEqual({ toolUseId: "call-1", name: "read_file", input: { target_file: "src/foo.ts" } });
    expect(events[5].payload).toEqual({ path: "src/foo.ts", tool: "read_file" });
    expect(events[9].payload).toMatchObject({ toolUseId: "call-2", name: "search_replace" });
    expect(events[10].payload).toEqual({ path: "src/foo.ts", tool: "search_replace" });
    // spec 378 — `assistant.model_id` is exposed via the dedicated `model` field, not smuggled through
    // `runtimeVersion` (grok has no separate CLI version source in the transcript).
    expect(events.some((e) => e.model === "grok-4.5")).toBe(true);
    expect(events.some((e) => e.runtimeVersion === "grok-4.5")).toBe(false);
    expect(events[3].sourcePath).toBe("/tmp/chat_history.jsonl");
  });

  it("classifies synthetic system_reminder as context.injected, not a user bubble", () => {
    const events = normalizeGrok([
      line({
        type: "user",
        synthetic_reason: "system_reminder",
        content: [{ type: "text", text: "<system-reminder>\nAvailable Skills\n</system-reminder>" }],
      }),
      line({ type: "user", content: [{ type: "text", text: "<user_query>\nok\n</user_query>" }] }),
    ]);
    expect(events.map((e) => e.type)).toEqual(["context.injected", "user.message.completed"]);
    expect(events[0].payload).toMatchObject({ source: "environment", tagged: true });
    expect(events[1].payload).toEqual({ text: "ok" });
  });

  it("ignores unparseable lines and unknown types without throwing", () => {
    expect(normalizeGrok(["not json", line({ type: "mystery", value: 1 }), line({ type: "system", content: "x" })])).toEqual([]);
  });

  it("marks tool results that look like failures as tool.failed", () => {
    const events = normalizeGrok([
      line({
        type: "assistant",
        content: "",
        tool_calls: [{ id: "c1", name: "run_terminal_command", arguments: "{\"command\":\"false\"}" }],
      }),
      line({ type: "tool_result", tool_call_id: "c1", content: "exit: 1\nbombed" }),
    ]);
    expect(events.map((e) => e.type)).toEqual(["tool.started", "tool.failed"]);
    expect(events[1].payload).toMatchObject({ toolUseId: "c1", name: "run_terminal_command" });
  });
});
