import { describe, it, expect } from "vitest";
import { buildActivityView } from "../../src/activity/activityView.js";
import { normalizeClaude } from "../../src/activity/claudeNormalizer.js";

const base = { sessionId: "s1", cwd: "/repo", timestamp: "2026-06-20T00:00:00Z", version: "2.1.183" };
const line = (o: unknown): string => JSON.stringify(o);

const transcript = [
  line({ ...base, type: "assistant", message: { content: [{ type: "text", text: "Looking into it." }] } }),
  line({ ...base, type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Write", input: { file_path: "/repo/a.ts" } }] } }),
  line({ ...base, type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1" }] } }), // t1 write SUCCEEDS → a.ts changed
  line({ ...base, type: "assistant", message: { content: [{ type: "tool_use", id: "t2", name: "Read", input: { file_path: "/repo/b.ts" } }] } }),
  line({ ...base, type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t2" }] } }),
  line({ ...base, type: "assistant", message: { content: [{ type: "tool_use", id: "t3", name: "Bash" }], usage: { input_tokens: 100, output_tokens: 40 } } }),
  line({ ...base, type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t3", is_error: true }] } }),
  line({ ...base, type: "assistant", message: { content: [{ type: "tool_use", id: "t4", name: "Write", input: { file_path: "/repo/a.ts" } }] } }), // started, NO result → still running, NOT changed
];

describe("buildActivityView", () => {
  const vm = buildActivityView(normalizeClaude(transcript, "/x/sess.jsonl"));

  it("answers 'which files changed' with unique paths (not double-counting a.ts)", () => {
    expect(vm.summary.filesChanged).toEqual(["/repo/a.ts"]);
    expect(vm.summary.filesReferenced).toEqual(["/repo/b.ts"]);
  });

  it("answers 'what is running now' — started tools without a matching result", () => {
    // t1 completed, t2 completed, t3 failed; only t4 (Write) is still in flight.
    expect(vm.summary.toolsRunning).toBe(1);
    expect(vm.summary.toolsFailed).toBe(1);
  });

  it("counts a file changed only once its write SUCCEEDS (t4 in-flight write is not counted)", () => {
    // a.ts is changed via t1's success; t4 wrote a.ts but has no result yet → still just the one unique path.
    expect(vm.summary.filesChanged).toEqual(["/repo/a.ts"]);
  });

  it("answers 'what did it cost' by summing usage", () => {
    expect(vm.summary.tokens).toEqual({ input: 100, output: 40 });
  });

  it("counts assistant messages and tracks last activity", () => {
    expect(vm.summary.messages).toBe(1);
    expect(vm.summary.lastActivity).toBe("2026-06-20T00:00:00Z");
  });

  it("emits clickable file items with a path", () => {
    const fileItems = vm.items.filter((i) => i.kind === "file");
    expect(fileItems.every((i) => !!i.path)).toBe(true);
    expect(fileItems.find((i) => i.detail?.startsWith("changed"))?.path).toBe("/repo/a.ts");
  });

  it("stamps runtime/version/source and defaults tier to structured", () => {
    expect(vm.runtime).toBe("claude");
    expect(vm.runtimeVersion).toBe("2.1.183");
    expect(vm.sourcePath).toBe("/x/sess.jsonl");
    expect(vm.tier).toBe("structured");
  });

  it("carries the freshness-degraded flag through", () => {
    expect(buildActivityView([], { tier: "raw-only", degradedFreshness: true })).toMatchObject({
      tier: "raw-only",
      degradedFreshness: true,
      summary: { messages: 0, toolsRunning: 0, filesChanged: [] },
    });
  });

  it("surfaces a failed tool in the feed", () => {
    const failed = vm.items.find((i) => i.kind === "tool" && i.failed);
    expect(failed?.title).toBe("Bash");
  });
});
