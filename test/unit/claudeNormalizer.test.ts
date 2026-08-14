import { describe, it, expect } from "vitest";
import { normalizeClaude, createClaudeNormalizer } from "@tachyon/engine/activity/claudeNormalizer.js";
import type { NormalizedEvent } from "@tachyon/engine/activity/types.js";

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

  it("maps user interruption markers to user.interrupted, not a human message", () => {
    const interrupt = line({ ...base, type: "user", message: { content: [{ type: "text", text: "[Request interrupted by user]" }] } });
    const evs = normalizeClaude([interrupt]);
    expect(firstOf(evs, "user.interrupted")?.payload).toEqual({ text: "[Request interrupted by user]" });
    expect(firstOf(evs, "user.message.completed")).toBeUndefined();
  });

  it("maps turn_aborted envelopes to user.interrupted, not a human message", () => {
    const text = "<turn_aborted>\nThe user interrupted the previous turn on purpose.\n</turn_aborted>";
    const interrupt = line({ ...base, type: "user", message: { content: [{ type: "text", text }] } });
    const evs = normalizeClaude([interrupt]);
    expect(firstOf(evs, "user.interrupted")?.payload).toEqual({ text });
    expect(firstOf(evs, "user.message.completed")).toBeUndefined();
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

  it("treats wait_for_agent bounded timeout as a neutral completed tool result", () => {
    const start = line({
      ...base,
      type: "assistant",
      message: {
        content: [{
          type: "tool_use",
          id: "wait1",
          name: "mcp__tachyon_bridge__wait_for_agent",
          input: { name: "child", until: "idle", timeoutSec: 45 },
        }],
      },
    });
    const timeout = line({
      ...base,
      type: "user",
      message: {
        content: [{
          type: "tool_result",
          tool_use_id: "wait1",
          is_error: true,
          content: JSON.stringify({ met: false, state: "working", waitedMs: 45000 }),
        }],
      },
    });
    const evs = normalizeClaude([start, timeout]);

    expect(firstOf(evs, "tool.failed")).toBeUndefined();
    expect(firstOf(evs, "tool.completed")?.payload).toMatchObject({
      toolUseId: "wait1",
      name: "mcp__tachyon_bridge__wait_for_agent",
      summary: "wait timed out",
    });
  });

  it("keeps terminal wait_for_agent failures classified as failed", () => {
    const start = line({
      ...base,
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "wait2", name: "mcp__tachyon_bridge__wait_for_agent", input: { name: "child", until: "idle" } }] },
    });
    const dead = line({
      ...base,
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "wait2", is_error: true, content: JSON.stringify({ met: false, state: "dead", exitCode: 1, waitedMs: 1000 }) }] },
    });

    expect(firstOf(normalizeClaude([start, dead]), "tool.failed")?.payload).toMatchObject({
      toolUseId: "wait2",
      name: "mcp__tachyon_bridge__wait_for_agent",
    });
  });

  it("surfaces a model refusal as error, other system lines as raw", () => {
    expect(firstOf(normalizeClaude([sysRefusal]), "error")?.payload).toMatchObject({ message: "nope", category: "policy" });
    const other = normalizeClaude([sysOther]);
    expect(other).toHaveLength(1);
    expect(other[0].type).toBe("raw");
  });

  it("maps an in-file compact_boundary to compaction.boundary with trigger + token deltas (spec 239 inc 1)", () => {
    const compact = line({ ...base, type: "system", subtype: "compact_boundary", compactMetadata: { trigger: "auto", preTokens: 1002519, postTokens: 17671 } });
    const e = firstOf(normalizeClaude([compact]), "compaction.boundary");
    expect(e?.payload).toEqual({ trigger: "auto", preTokens: 1002519, postTokens: 17671 });
    // a manual /compact with no metadata still maps (best-effort fields)
    const manual = line({ ...base, type: "system", subtype: "compact_boundary", compactMetadata: { trigger: "manual" } });
    expect(firstOf(normalizeClaude([manual]), "compaction.boundary")?.payload).toMatchObject({ trigger: "manual" });
  });

  it("does NOT render synthetic user records as human messages (compaction summary / slash command / local stdout)", () => {
    // the post-compaction recap claude injects as an isCompactSummary user record
    const summary = line({ ...base, type: "user", isCompactSummary: true, message: { role: "user", content: "This session is being continued from a previous conversation…" } });
    let evs = normalizeClaude([summary]);
    expect(evs.map((e) => e.type)).toEqual(["compaction.summary"]);
    expect(firstOf(evs, "user.message.completed")).toBeUndefined();
    // a slash command → user.command with the extracted name, not a bubble
    const cmd = line({ ...base, type: "user", message: { role: "user", content: "<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args></command-args>" } });
    evs = normalizeClaude([cmd]);
    expect(firstOf(evs, "user.command")?.payload).toEqual({ command: "/compact" });
    expect(firstOf(evs, "user.message.completed")).toBeUndefined();
    // local command output → dropped entirely
    const out = line({ ...base, type: "user", message: { role: "user", content: "<local-command-stdout>Compacted (ctrl+o to see full summary)</local-command-stdout>" } });
    expect(normalizeClaude([out])).toHaveLength(0);
    // a background task-notification (harness-injected user record) → NOT a human bubble
    const taskNote = line({ ...base, type: "user", message: { role: "user", content: "<task-notification>\n<task-id>b9gi51vl1</task-id>\n<status>completed</status>\n</task-notification>" } });
    expect(firstOf(normalizeClaude([taskNote]), "user.message.completed")).toBeUndefined();
    // a Tachyon-injected nudge ([tachyon] …) → a system.nudge, NOT a human bubble
    const nudge = line({ ...base, type: "user", message: { role: "user", content: "[tachyon] If your recent work changed PROJECT-level state, append a handoff note." } });
    const nudgeEvs = normalizeClaude([nudge]);
    expect(firstOf(nudgeEvs, "user.message.completed")).toBeUndefined();
    expect(firstOf(nudgeEvs, "system.nudge")?.payload).toEqual({ text: "[tachyon] If your recent work changed PROJECT-level state, append a handoff note." });
    // a real human message is still a message
    const human = line({ ...base, type: "user", message: { role: "user", content: "pode comitar e pushar" } });
    expect(firstOf(normalizeClaude([human]), "user.message.completed")?.payload).toEqual({ text: "pode comitar e pushar" });
  });

  it("degrades gracefully on an orphan tool_result whose tool_use is before the window (inc 2 tail cut)", () => {
    // when the EOF-bounded window starts mid-stream, a tool_result can arrive with no pending tool_use
    const orphanOk = line({ ...base, type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "gone" }] } });
    const orphanErr = line({ ...base, type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "gone2", is_error: true }] } });
    expect(() => normalizeClaude([orphanOk, orphanErr])).not.toThrow();
    const evs = normalizeClaude([orphanOk, orphanErr]);
    expect(firstOf(evs, "user.message.completed")).toBeUndefined(); // never a human bubble
    expect(firstOf(evs, "tool.completed")).toBeDefined();
    expect(firstOf(evs, "tool.failed")).toBeDefined(); // standalone failed item, name undefined — no crash
  });

  it("stamps recordId from the source record uuid (provenance for the durable log, spec 239 inc 3)", () => {
    const rec = line({ ...base, uuid: "rec-uuid-1", type: "assistant", message: { content: [{ type: "text", text: "hi" }] } });
    const e = firstOf(normalizeClaude([rec]), "assistant.message.completed");
    expect(e?.recordId).toBe("rec-uuid-1");
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

  it("strips cat -n line numbers from a Read tool result (polish)", () => {
    const start = line({ ...base, type: "assistant", message: { content: [{ type: "tool_use", id: "r1", name: "Read", input: { file_path: "/repo/x.ts" } }] } });
    const result = line({ ...base, type: "user", message: { content: [{ type: "tool_result", tool_use_id: "r1", content: "     1\timport x from 'y';\n     2\tconst a = 1;" }] } });
    const done = firstOf(normalizeClaude([start, result]), "tool.completed");
    expect(done?.payload).toMatchObject({ name: "Read", summary: "import x from 'y';" });
    expect((done?.payload as { full: string }).full).not.toContain("\t");
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

  it("spec 323 — promotes hook_additional_context to context.injected (one event, items joined, uuid recordId)", () => {
    const att = line({ ...base, type: "attachment", uuid: "u-att-1", attachment: { type: "hook_additional_context", hookEvent: "SessionStart", content: ["A shared PROJECT HANDOFF exists…", "A continuity brief exists…"] } });
    const evs = normalizeClaude([att]);
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({
      type: "context.injected",
      recordId: "u-att-1",
      payload: { source: "hook", hookEvent: "SessionStart", text: "A shared PROJECT HANDOFF exists…\nA continuity brief exists…" },
    });
  });

  it("spec 323 — other attachment types (and empty-content hook records) stay raw (log-filtered)", () => {
    const evs = normalizeClaude([
      line({ ...base, type: "attachment", attachment: { type: "hook_success", hookEvent: "SessionStart", content: "" } }),
      line({ ...base, type: "attachment", attachment: { type: "task_reminder", content: ["use tasks"] } }),
      line({ ...base, type: "attachment", attachment: { type: "hook_additional_context", content: [] } }),
    ]);
    expect(evs.map((e) => e.type)).toEqual(["raw", "raw", "raw"]);
    expect(evs.map((e) => (e.payload as { note?: string }).note)).toEqual(["attachment:hook_success", "attachment:task_reminder", "attachment:hook_additional_context"]);
  });

  it("spec 323 — a pathological hook payload is capped with truncated + originalLength", () => {
    const big = "x".repeat(6000);
    const evs = normalizeClaude([line({ ...base, type: "attachment", attachment: { type: "hook_additional_context", content: [big] } })]);
    const p = evs[0].payload as { text: string; truncated?: boolean; originalLength?: number };
    expect(evs[0].type).toBe("context.injected");
    expect(p.text).toHaveLength(4000);
    expect(p.truncated).toBe(true);
    expect(p.originalLength).toBe(6000);
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

  describe("spec 378 — live model latch", () => {
    it("latches message.model from a primary-agent assistant record", () => {
      const rec = line({
        ...base,
        type: "assistant",
        isSidechain: false,
        message: { role: "assistant", model: "claude-sonnet-5", content: [{ type: "text", text: "hi" }] },
      });
      const e = firstOf(normalizeClaude([rec]), "assistant.message.completed");
      expect(e?.model).toBe("claude-sonnet-5");
    });

    it("does NOT latch a subagent's isSidechain:true record, even with a different model", () => {
      const primary = line({
        ...base,
        type: "assistant",
        isSidechain: false,
        message: { role: "assistant", model: "claude-sonnet-5", content: [{ type: "text", text: "primary" }] },
      });
      const sidechain = line({
        ...base,
        type: "assistant",
        isSidechain: true,
        message: { role: "assistant", model: "claude-haiku-4-5-20251001", content: [{ type: "text", text: "sub-agent turn" }] },
      });
      const evs = normalizeClaude([primary, sidechain]);
      const messages = evs.filter((e) => e.type === "assistant.message.completed");
      expect(messages).toHaveLength(2);
      expect(messages[0].model).toBe("claude-sonnet-5");
      expect(messages[1].model).toBeUndefined(); // sidechain — never relabels the primary agent
    });

    it("does NOT latch the \"<synthetic>\" model placeholder", () => {
      const rec = line({
        ...base,
        type: "assistant",
        isSidechain: false,
        message: { role: "assistant", model: "<synthetic>", content: [{ type: "text", text: "placeholder turn" }] },
      });
      const e = firstOf(normalizeClaude([rec]), "assistant.message.completed");
      expect(e?.model).toBeUndefined();
    });

    it("a multi-model session latches the LATEST assistant record's model (in-TUI /model switch)", () => {
      const first = line({
        ...base,
        type: "assistant",
        isSidechain: false,
        message: { role: "assistant", model: "claude-sonnet-5", content: [{ type: "text", text: "a" }] },
      });
      const second = line({
        ...base,
        type: "assistant",
        isSidechain: false,
        message: { role: "assistant", model: "claude-opus-4-8", content: [{ type: "text", text: "b" }] },
      });
      const evs = normalizeClaude([first, second]);
      const messages = evs.filter((e) => e.type === "assistant.message.completed");
      expect(messages.map((e) => e.model)).toEqual(["claude-sonnet-5", "claude-opus-4-8"]);
    });

    it("non-assistant records (user/system) never carry a model", () => {
      const evs = normalizeClaude([userOk, sysOther]);
      for (const e of evs) expect(e.model).toBeUndefined();
    });
  });
});
