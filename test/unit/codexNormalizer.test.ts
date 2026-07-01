import { describe, it, expect } from "vitest";
import { normalizeCodex } from "../../src/activity/codexNormalizer.js";

const line = (payload: unknown, type = "response_item", timestamp = "2026-06-30T12:00:00Z") =>
  JSON.stringify({ timestamp, type, payload });

describe("Codex activity normalizer (spec 305)", () => {
  it("maps current Codex rollout records to renderable activity events", () => {
    const events = normalizeCodex([
      line({ id: "sid", cwd: "/repo", cli_version: "0.142.4" }, "session_meta"),
      line({ type: "message", id: "u1", role: "user", content: [{ type: "input_text", text: "arrume o bug" }] }),
      line({ type: "message", id: "a1", role: "assistant", content: [{ type: "output_text", text: "Vou investigar." }] }),
      line({ type: "reasoning", id: "r1", summary: [{ text: "checking files" }] }),
      line({ type: "function_call", id: "fc1", name: "exec_command", call_id: "call-1", arguments: "{\"cmd\":\"npm test\"}" }),
      line({ type: "function_call_output", call_id: "call-1", output: "ok\n" }),
      line({ type: "tool_search_call", id: "tsc1", call_id: "call-2", arguments: { query: "tachyon", limit: 5 } }),
      line({ type: "tool_search_output", call_id: "call-2", tools: [{ name: "mcp__tachyon_bridge" }] }),
      line({ type: "web_search_call", id: "ws1", call_id: "call-3", action: { type: "search", query: "docs" } }),
      line({ type: "web_search_end", call_id: "call-3", query: "docs", action: { type: "search" } }, "event_msg"),
      line({ type: "mcp_tool_call_end", call_id: "call-4", invocation: { server: "tachyon_bridge", tool: "list_pins" }, result: { Ok: {} } }, "event_msg"),
      line({ type: "token_count", info: { total_token_usage: { input_tokens: 10, output_tokens: 5, cached_input_tokens: 2 } } }, "event_msg"),
    ], "/tmp/rollout.jsonl");

    expect(events.map((e) => e.type)).toEqual([
      "user.message.completed",
      "assistant.message.completed",
      "assistant.thinking",
      "tool.started",
      "tool.completed",
      "tool.started",
      "tool.completed",
      "tool.started",
      "tool.completed",
      "tool.completed",
      "usage.updated",
    ]);
    expect(events[0]).toMatchObject({ runtime: "codex", sessionId: "sid", cwd: "/repo", runtimeVersion: "0.142.4", sourcePath: "/tmp/rollout.jsonl" });
    expect(events[3].payload).toEqual({ toolUseId: "call-1", name: "exec_command", input: { cmd: "npm test" } });
    expect(events[4].payload).toMatchObject({ toolUseId: "call-1", name: "exec_command", summary: "ok" });
    expect(events[5].payload).toEqual({ toolUseId: "call-2", name: "tool_search", input: { query: "tachyon", limit: 5 } });
    expect(events[6].payload).toMatchObject({ toolUseId: "call-2", name: "tool_search", summary: "1 tool result" });
    expect(events[8].payload).toMatchObject({ toolUseId: "call-3", name: "web_search", summary: "docs" });
    expect(events[9].payload).toMatchObject({ toolUseId: "call-4", name: "tachyon_bridge.list_pins", summary: "ok" });
    expect(events[10].payload).toEqual({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 2 });
  });

  it("ignores unknown and malformed records without throwing or emitting raw noise", () => {
    expect(normalizeCodex(["not json", line({ type: "unknown", value: 1 }, "event_msg")])).toEqual([]);
  });

  it("deduplicates message records mirrored as response_item and event_msg", () => {
    const events = normalizeCodex([
      line({ id: "sid", cwd: "/repo", cli_version: "0.142.5" }, "session_meta"),
      line({ type: "message", id: "u1", role: "user", content: [{ type: "input_text", text: "ola" }] }, "response_item", "2026-07-01T16:52:04.686Z"),
      line({ type: "user_message", message: "ola" }, "event_msg", "2026-07-01T16:52:04.689Z"),
      line({ type: "agent_message", message: "Olá. Como posso ajudar?" }, "event_msg", "2026-07-01T16:52:07.089Z"),
      line({ type: "message", id: "a1", role: "assistant", content: [{ type: "output_text", text: "Olá. Como posso ajudar?" }] }, "response_item", "2026-07-01T16:52:07.092Z"),
    ]);

    expect(events.map((e) => e.type)).toEqual(["user.message.completed", "assistant.message.completed"]);
    expect(events.map((e) => e.payload)).toEqual([
      { text: "ola" },
      { text: "Olá. Como posso ajudar?" },
    ]);
  });

  it("deduplicates image-wrapper user mirrors against the caption-only user message", () => {
    const events = normalizeCodex([
      line({ id: "sid", cwd: "/repo", cli_version: "0.142.5" }, "session_meta"),
      line({
        type: "message",
        id: "u1",
        role: "user",
        content: [
          { type: "input_text", text: "<image name=[Image #1] path=\"/tmp/s.png\">" },
          { type: "input_image", image_url: "data:image/png;base64,QUJD", detail: "high" },
          { type: "input_text", text: "</image>" },
          { type: "input_text", text: "[Image #1] instalei o patch" },
        ],
      }, "response_item", "2026-07-01T17:01:42.483Z"),
      line({ type: "user_message", message: "[Image #1] instalei o patch" }, "event_msg", "2026-07-01T17:01:42.486Z"),
    ]);

    expect(events.map((e) => e.type)).toEqual(["user.message.completed", "image.attached"]);
    expect(events[0]!.payload).toEqual({ text: "[Image #1] instalei o patch" });
    expect(events[1]!.payload).toMatchObject({ mediaType: "image/png", from: "user" });
  });
});
