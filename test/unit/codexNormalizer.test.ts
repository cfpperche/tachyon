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

  it("spec 378: latches model+effort from turn_context.payload only — session_meta/token_count never latch", () => {
    const events = normalizeCodex([
      // session_meta carries `cli_version` (runtimeVersion) but NO model — must not latch.
      line({ id: "sid", cwd: "/repo", cli_version: "0.142.4" }, "session_meta"),
      line({ type: "token_count", info: { total_token_usage: { input_tokens: 1, output_tokens: 1 } } }, "event_msg"),
      line({ turn_id: "t1", cwd: "/repo", model: "gpt-5.6-sol", effort: "high" }, "turn_context"),
      line({ type: "message", id: "a1", role: "assistant", content: [{ type: "output_text", text: "Vou investigar." }] }),
    ], "/tmp/rollout.jsonl");

    const usage = events.find((e) => e.type === "usage.updated");
    expect(usage?.model).toBeUndefined();
    expect(usage?.effort).toBeUndefined();
    const assistant = events.find((e) => e.type === "assistant.message.completed");
    expect(assistant).toMatchObject({ model: "gpt-5.6-sol", effort: "high" });
  });

  it("spec 378: a later turn_context re-latches model+effort (in-TUI /model switch)", () => {
    const events = normalizeCodex([
      line({ turn_id: "t1", cwd: "/repo", model: "gpt-5.5", effort: "medium" }, "turn_context"),
      line({ type: "message", id: "a1", role: "assistant", content: [{ type: "output_text", text: "first" }] }),
      line({ turn_id: "t2", cwd: "/repo", model: "gpt-5.6-sol", effort: "high" }, "turn_context"),
      line({ type: "message", id: "a2", role: "assistant", content: [{ type: "output_text", text: "second" }] }),
    ]);
    const assistants = events.filter((e) => e.type === "assistant.message.completed");
    expect(assistants[0]).toMatchObject({ model: "gpt-5.5", effort: "medium" });
    expect(assistants[1]).toMatchObject({ model: "gpt-5.6-sol", effort: "high" });
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

  it("maps mirrored user interruption records to one user.interrupted event, not a user message", () => {
    const events = normalizeCodex([
      line({ id: "sid", cwd: "/repo", cli_version: "0.142.5" }, "session_meta"),
      line({ type: "message", id: "u1", role: "user", content: [{ type: "input_text", text: "[Request interrupted by user]" }] }, "response_item", "2026-07-02T12:00:00.000Z"),
      line({ type: "user_message", message: "[Request interrupted by user]" }, "event_msg", "2026-07-02T12:00:00.004Z"),
    ]);

    expect(events.map((e) => e.type)).toEqual(["user.interrupted"]);
    expect(events[0]!.payload).toEqual({ text: "[Request interrupted by user]" });
  });

  it("maps Codex turn_aborted envelopes to user.interrupted, not a user message", () => {
    const text = `<turn_aborted>
The user interrupted the previous turn on purpose. Any running unified exec processes may still be running in the background. If any tools/commands were aborted, they may have partially executed.
</turn_aborted>`;
    const events = normalizeCodex([
      line({ id: "sid", cwd: "/repo", cli_version: "0.142.5" }, "session_meta"),
      line({ type: "message", id: "u1", role: "user", content: [{ type: "input_text", text }] }, "response_item", "2026-07-02T17:20:00.000Z"),
    ]);

    expect(events.map((e) => e.type)).toEqual(["user.interrupted"]);
    expect(events[0]!.payload).toEqual({ text });
  });

  it("maps startup environment_context user-role preamble to context.injected, not a user message", () => {
    const text = `<environment_context>
  <cwd>/repo</cwd>
  <shell>bash</shell>
  <current_date>2026-07-04</current_date>
  <timezone>America/Sao_Paulo</timezone>
</environment_context>`;
    const events = normalizeCodex([
      line({ type: "message", id: "env1", role: "user", content: [{ type: "input_text", text }] }, "response_item", "2026-07-04T12:00:00.000Z"),
      line({ type: "user_message", message: text }, "event_msg", "2026-07-04T12:00:00.004Z"),
    ]);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "context.injected", payload: { text, source: "environment", tagged: true } });
  });
});

describe("spec 323 — injected context (developer-role messages)", () => {
  it("plain-prose developer message → context.injected, untagged, dedupe within the window", () => {
    const dev = line({ type: "message", id: "d1", role: "developer", content: [{ type: "input_text", text: "A shared PROJECT HANDOFF exists for this workspace." }] });
    const events = normalizeCodex([dev, dev]); // mirrored record within the same 2s window
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "context.injected", payload: { source: "developer", text: "A shared PROJECT HANDOFF exists for this workspace." } });
    expect((events[0].payload as { tagged?: boolean }).tagged).toBeUndefined();
  });

  it("tag-wrapped runtime preamble → emitted but tagged:true (log keeps it; the view skips it)", () => {
    const cases = [
      "<permissions instructions>\nFilesystem sandboxing defines…",
      "<collaboration_mode># Collaboration Mode: Default",
      "  <UPPER-Case attr=\"x\">indented + attributes</UPPER-Case>",
    ];
    const events = normalizeCodex(cases.map((text, i) => line({ type: "message", id: `t${i}`, role: "developer", content: [{ type: "input_text", text }] })));
    expect(events).toHaveLength(3);
    for (const e of events) expect((e.payload as { tagged?: boolean }).tagged).toBe(true);
  });

  it("system role still emits nothing; a long developer text is capped with truncated metadata", () => {
    const events = normalizeCodex([
      line({ type: "message", id: "s1", role: "system", content: [{ type: "input_text", text: "system preamble" }] }),
      line({ type: "message", id: "d2", role: "developer", content: [{ type: "input_text", text: "y".repeat(5000) }] }),
    ]);
    expect(events).toHaveLength(1);
    const p = events[0].payload as { text: string; truncated?: boolean; originalLength?: number };
    expect(p.text).toHaveLength(4000);
    expect(p.truncated).toBe(true);
    expect(p.originalLength).toBe(5000);
  });
});
