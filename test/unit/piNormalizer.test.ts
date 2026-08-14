import { describe, expect, it } from "vitest";
import { createPiNormalizer, normalizePi } from "@tachyon/engine/activity/piNormalizer.js";

const line = (value: unknown) => JSON.stringify(value);
const header = line({ type: "session", version: 3, id: "sess-pi", timestamp: "2026-07-18T00:00:00.000Z", cwd: "/repo" });
const entry = (id: string, message: unknown) => line({ type: "message", id, parentId: null, timestamp: `2026-07-18T00:00:${id.length.toString().padStart(2, "0")}.000Z`, message });

describe("Pi activity normalizer (SDD 402)", () => {
  it("classifies conversation, primer, nudges, thinking, model, effort and usage", () => {
    const events = normalizePi([
      header,
      line({ type: "model_change", id: "m1", modelId: "gpt-pi" }),
      line({ type: "thinking_level_change", id: "t1", thinkingLevel: "high" }),
      entry("u1", { role: "user", content: "human request" }),
      entry("primer", { role: "user", content: "── TACHYON PRIMER ──\nmanaged context" }),
      entry("nudge", { role: "user", content: "[tachyon] remember the handoff" }),
      entry("a1", {
        role: "assistant", model: "pi-observed", stopReason: "stop",
        content: [{ type: "thinking", thinking: "reasoning" }, { type: "text", text: "answer" }],
        usage: { input: 12, output: 4, cacheRead: 3, cacheWrite: 2 },
      }),
    ], "/private/sess.jsonl");

    expect(events.map((event) => event.type)).toEqual([
      "session.started", "user.message.completed", "context.injected", "system.nudge",
      "assistant.thinking", "assistant.message.completed", "usage.updated",
    ]);
    expect(events.find((event) => event.type === "user.message.completed")?.payload).toEqual({ text: "human request" });
    expect(events.find((event) => event.type === "context.injected")?.payload).toMatchObject({ source: "environment" });
    const answer = events.find((event) => event.type === "assistant.message.completed")!;
    expect(answer).toMatchObject({ runtime: "pi", sessionId: "sess-pi", cwd: "/repo", model: "pi-observed", effort: "high", recordId: "a1", sourcePath: "/private/sess.jsonl" });
    expect(events.find((event) => event.type === "usage.updated")?.payload).toEqual({ inputTokens: 12, outputTokens: 4, cacheReadTokens: 3, cacheCreationTokens: 2 });
  });

  it("correlates tools and emits file effects only after successful mutation", () => {
    const normalizer = createPiNormalizer();
    normalizer.push([header]);
    const calls = normalizer.push([entry("calls", {
      role: "assistant", content: [
        { type: "toolCall", id: "read-1", name: "read", arguments: { path: "/repo/a.ts" } },
        { type: "toolCall", id: "edit-1", name: "edit", arguments: { path: "/repo/b.ts", oldText: "a", newText: "b" } },
        { type: "toolCall", id: "edit-2", name: "write", arguments: { path: "/repo/c.ts", content: "x" } },
      ], stopReason: "toolUse",
    })]);
    expect(calls.filter((event) => event.type === "tool.started")).toHaveLength(3);
    expect(calls.find((event) => event.type === "file.referenced")?.payload).toEqual({ path: "/repo/a.ts", tool: "read" });

    const ok = normalizer.push([entry("ok", { role: "toolResult", toolCallId: "edit-1", toolName: "edit", content: [{ type: "text", text: "done" }], isError: false })]);
    expect(ok.map((event) => event.type)).toEqual(["tool.completed", "file.changed"]);
    expect(ok[1].payload).toEqual({ path: "/repo/b.ts", tool: "edit" });

    const failed = normalizer.push([entry("bad", { role: "toolResult", toolCallId: "edit-2", toolName: "write", content: [{ type: "text", text: "permission denied" }], isError: true })]);
    expect(failed.map((event) => event.type)).toEqual(["tool.failed"]);
    expect(failed[0].payload).toMatchObject({ toolUseId: "edit-2", name: "write" });
  });

  it("maps direct bash, images, custom context, summaries, interruptions and provider errors", () => {
    const image = Buffer.from("pi-image").toString("base64");
    const events = normalizePi([
      header,
      entry("img", { role: "user", content: [{ type: "text", text: "look" }, { type: "image", data: image, mimeType: "image/png" }] }),
      entry("bash", { role: "bashExecution", command: "false", output: "failed", exitCode: 1, cancelled: false }),
      entry("custom", { role: "custom", customType: "extension", content: "hidden context", display: false }),
      entry("interrupt", { role: "user", content: "Interrupted by user." }),
      entry("error", { role: "assistant", model: "m", content: [], stopReason: "error", errorMessage: "provider unavailable" }),
      line({ type: "compaction", id: "cmp", timestamp: "2026-07-18T00:01:00Z", summary: "compact recap", tokensBefore: 9000 }),
      line({ type: "branch_summary", id: "br", timestamp: "2026-07-18T00:02:00Z", summary: "branch recap" }),
    ]);
    expect(events.map((event) => event.type)).toEqual([
      "session.started", "image.attached", "user.message.completed", "user.command", "tool.failed",
      "context.injected", "user.interrupted", "error", "compaction.boundary", "compaction.summary", "compaction.summary",
    ]);
    expect(events.find((event) => event.type === "image.attached")?.raw).toMatchObject({ data: image, mimeType: "image/png" });
    expect(events.find((event) => event.type === "error")?.payload).toEqual({ message: "provider unavailable", category: "provider" });
  });

  it("drops malformed, partial, custom-state, label and unknown records without throwing", () => {
    expect(() => normalizePi(["", "{partial", line({ type: "custom", id: "x", data: { secret: true } }), line({ type: "label", id: "l" }), line({ type: "mystery", value: 1 })])).not.toThrow();
    expect(normalizePi(["", "{partial", line({ type: "custom" }), line({ type: "mystery" })])).toEqual([]);
  });

  it("degrades an orphan tool result after normalizer restart without inventing a name or file effect", () => {
    const events = normalizePi([entry("orphan", { role: "toolResult", toolCallId: "unknown", content: "ok", isError: false })]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "tool.completed", payload: { toolUseId: "unknown", summary: "ok", full: "ok" } });
  });
});
