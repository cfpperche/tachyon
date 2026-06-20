import { describe, it, expect } from "vitest";
import { normalizeClaude, createClaudeNormalizer } from "../../src/activity/claudeNormalizer.js";
import type { NormalizedEvent } from "../../src/activity/types.js";

/**
 * Synthetic-but-faithful fixtures (spec 238 fold): the SHAPES mirror a real claude JSONL
 * (type/message.content blocks/usage/version) but carry no real cwd/path/prompt/secret.
 */
const SRC = "/x/projects/enc/sess.jsonl";
const base = { sessionId: "s1", cwd: "/repo", timestamp: "2026-06-20T00:00:00Z", version: "2.1.183" };

const line = (o: unknown): string => JSON.stringify(o);

const assistantText = line({
  ...base,
  type: "assistant",
  message: { role: "assistant", content: [{ type: "text", text: "Working on it." }] },
});
const assistantWrite = line({
  ...base,
  type: "assistant",
  message: {
    role: "assistant",
    content: [{ type: "tool_use", id: "tu1", name: "Write", input: { file_path: "/repo/a.ts", content: "x" } }],
  },
});
const assistantRead = line({
  ...base,
  type: "assistant",
  message: { role: "assistant", content: [{ type: "tool_use", id: "tu2", name: "Read", input: { file_path: "/repo/b.ts" } }] },
});
const assistantUsage = line({
  ...base,
  type: "assistant",
  message: {
    role: "assistant",
    content: [{ type: "text", text: "done" }],
    usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 5, cache_creation_input_tokens: 1 },
  },
});
const userOk = line({ ...base, type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1" }] } });
const userErr = line({
  ...base,
  type: "user",
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu2", is_error: true }] },
});
const sysRefusal = line({ ...base, type: "system", subtype: "model_refusal_fallback", apiRefusalCategory: "policy", apiRefusalExplanation: "nope" });
const sysOther = line({ ...base, type: "system", subtype: "hook" });
const snapshot = line({ ...base, type: "file-history-snapshot", snapshot: {} });
const unknown = line({ ...base, type: "queue-operation", operation: "enqueue" });

const firstOf = (evs: NormalizedEvent[], t: string): NormalizedEvent | undefined => evs.find((e) => e.type === t);

describe("normalizeClaude", () => {
  it("maps an assistant text block to assistant.message.completed", () => {
    const e = firstOf(normalizeClaude([assistantText], SRC), "assistant.message.completed");
    expect(e?.payload).toEqual({ text: "Working on it." });
  });

  it("emits file.changed only when the write's tool_result SUCCEEDS (not at tool_use time)", () => {
    expect(firstOf(normalizeClaude([assistantWrite]), "file.changed")).toBeUndefined(); // tool_use alone — no proof yet
    const evs = normalizeClaude([assistantWrite, userOk]); // userOk is the success result for tu1
    expect(firstOf(evs, "tool.started")?.payload).toMatchObject({ toolUseId: "tu1", name: "Write" });
    expect(firstOf(evs, "file.changed")?.payload).toEqual({ path: "/repo/a.ts", tool: "Write" });
    expect(firstOf(evs, "file.referenced")).toBeUndefined();
  });

  it("a FAILED write must NOT claim file.changed (no lying about a mutation)", () => {
    const failTu1 = line({ ...base, type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu1", is_error: true }] } });
    const evs = normalizeClaude([assistantWrite, failTu1]);
    expect(firstOf(evs, "tool.failed")?.payload).toMatchObject({ toolUseId: "tu1", name: "Write" });
    expect(firstOf(evs, "file.changed")).toBeUndefined();
  });

  it("correlates a failed tool's NAME from its earlier tool_use, across a streaming boundary", () => {
    const n = createClaudeNormalizer();
    n.push([assistantWrite]); // tu1 started in one chunk
    const later = n.push([line({ ...base, type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu1", is_error: true }] } })]);
    expect(later.find((e) => e.type === "tool.failed")?.payload).toMatchObject({ name: "Write" });
  });

  it("maps a read tool_use to tool.started + file.referenced (not changed)", () => {
    const evs = normalizeClaude([assistantRead]);
    expect(firstOf(evs, "file.referenced")?.payload).toEqual({ path: "/repo/b.ts", tool: "Read" });
    expect(firstOf(evs, "file.changed")).toBeUndefined();
  });

  it("maps message.usage to usage.updated", () => {
    const e = firstOf(normalizeClaude([assistantUsage]), "usage.updated");
    expect(e?.payload).toEqual({ inputTokens: 10, outputTokens: 20, cacheReadTokens: 5, cacheCreationTokens: 1 });
  });

  it("emits user.message.completed for a typed human prompt, but NOT for tool results or meta", () => {
    const human = line({ ...base, type: "user", message: { role: "user", content: "do the thing please" } });
    const meta = line({ ...base, type: "user", isMeta: true, message: { role: "user", content: "injected context" } });
    expect(firstOf(normalizeClaude([human]), "user.message.completed")?.payload).toEqual({ text: "do the thing please" });
    expect(firstOf(normalizeClaude([meta]), "user.message.completed")).toBeUndefined(); // injected, not a human turn
    expect(firstOf(normalizeClaude([userOk]), "user.message.completed")).toBeUndefined(); // tool_result, not a human turn
    expect(firstOf(normalizeClaude([userOk]), "tool.completed")).toBeDefined();
  });

  it("emits user.message.completed for a text-block human turn with no tool_result", () => {
    const interrupt = line({ ...base, type: "user", message: { content: [{ type: "text", text: "[Request interrupted by user]" }] } });
    expect(firstOf(normalizeClaude([interrupt]), "user.message.completed")?.payload).toEqual({ text: "[Request interrupted by user]" });
  });

  it("attaches a one-line result summary to tool.completed", () => {
    const started = line({ ...base, type: "assistant", message: { content: [{ type: "tool_use", id: "tc", name: "Bash", input: { command: "npm test" } }] } });
    const okResult = line({ ...base, type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tc", content: "ok\nmore lines" }] } });
    expect(firstOf(normalizeClaude([started, okResult]), "tool.completed")?.payload).toMatchObject({ toolUseId: "tc", name: "Bash", summary: "ok" });
  });

  it("maps tool_result to tool.completed / tool.failed by is_error", () => {
    expect(firstOf(normalizeClaude([userOk]), "tool.completed")?.payload).toMatchObject({ toolUseId: "tu1" });
    expect(firstOf(normalizeClaude([userErr]), "tool.failed")?.payload).toMatchObject({ toolUseId: "tu2" });
    expect(firstOf(normalizeClaude([userErr]), "tool.completed")).toBeUndefined();
  });

  it("surfaces a model refusal as error, other system lines as raw", () => {
    expect(firstOf(normalizeClaude([sysRefusal]), "error")?.payload).toMatchObject({ message: "nope", category: "policy" });
    const other = normalizeClaude([sysOther]);
    expect(other).toHaveLength(1);
    expect(other[0].type).toBe("raw");
  });

  it("maps a thinking block to assistant.thinking (#8)", () => {
    const think = line({ ...base, type: "assistant", message: { content: [{ type: "thinking", thinking: "let me reason", signature: "x" }] } });
    expect(firstOf(normalizeClaude([think]), "assistant.thinking")?.payload).toEqual({ text: "let me reason" });
  });

  it("maps a base64 image block to image.attached with a content id + side (#10)", () => {
    const img = line({ ...base, type: "user", message: { content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "QUJD" } }] } });
    const ev = firstOf(normalizeClaude([img]), "image.attached");
    expect(ev?.payload).toMatchObject({ mediaType: "image/png", from: "user" });
    expect((ev?.payload as { id: string }).id).toMatch(/^img_/);
  });

  it("builds a +N −M summary and a diff body from structuredPatch (#9)", () => {
    const start = line({ ...base, type: "assistant", message: { content: [{ type: "tool_use", id: "e1", name: "Edit", input: { file_path: "/repo/x.ts" } }] } });
    const result = line({ ...base, type: "user", toolUseResult: { structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: [" ctx", "-old", "+new1", "+new2"] }] }, message: { content: [{ type: "tool_result", tool_use_id: "e1", content: "ok" }] } });
    const done = firstOf(normalizeClaude([start, result]), "tool.completed");
    expect(done?.payload).toMatchObject({ name: "Edit", summary: "+2 −1" });
    expect((done?.payload as { full: string }).full).toContain("@@");
  });

  it("maps a file-history-snapshot to file.snapshot (not file.changed)", () => {
    const evs = normalizeClaude([snapshot]);
    expect(firstOf(evs, "file.snapshot")).toBeDefined();
    expect(firstOf(evs, "file.changed")).toBeUndefined();
  });

  it("dumps an unknown type to raw, never dropping it", () => {
    const evs = normalizeClaude([unknown]);
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({ type: "raw", payload: { note: "queue-operation" } });
  });

  it("degrades a garbled line to raw without throwing, and skips blanks", () => {
    const evs = normalizeClaude(["", "  ", "{not json", assistantText]);
    expect(evs.filter((e) => e.type === "raw")).toHaveLength(1);
    expect(evs.find((e) => e.type === "raw")?.raw).toBe("{not json");
    expect(firstOf(evs, "assistant.message.completed")).toBeDefined();
  });

  it("stamps common fields (runtime/version/session/cwd/timestamp/source) + monotonic sequence", () => {
    const evs = normalizeClaude([assistantWrite], SRC);
    for (const e of evs) {
      expect(e.runtime).toBe("claude");
      expect(e.runtimeVersion).toBe("2.1.183");
      expect(e.sessionId).toBe("s1");
      expect(e.cwd).toBe("/repo");
      expect(e.timestamp).toBe("2026-06-20T00:00:00Z");
      expect(e.sourcePath).toBe(SRC);
    }
    expect(evs.map((e) => e.sequence)).toEqual(evs.map((_, i) => i));
  });
});
