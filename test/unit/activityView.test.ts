import { describe, it, expect } from "vitest";
import { buildActivityView, createActivityBuilder } from "../../src/activity/activityView.js";
import { normalizeClaude } from "../../src/activity/claudeNormalizer.js";

const base = { sessionId: "s1", cwd: "/repo", timestamp: "2026-06-20T00:00:00Z", version: "2.1.183" };
const line = (o: unknown): string => JSON.stringify(o);

const transcript = [
  line({ ...base, type: "user", message: { role: "user", content: "Count the cities, please." } }), // human prompt
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

  it("puts the clickable path on the file-op tool chip (one chip per tool, no separate file item)", () => {
    expect(vm.items.some((i) => i.kind === "file")).toBe(false); // file.* feed the summary only
    const paths = vm.items.filter((i) => i.kind === "tool" && i.path).map((i) => i.path);
    expect(paths).toEqual(expect.arrayContaining(["/repo/a.ts", "/repo/b.ts"]));
  });

  it("shows the tool args on the chip (#2) and attaches the result summary (#4)", () => {
    const evs = [
      line({ ...base, type: "assistant", message: { content: [{ type: "tool_use", id: "b1", name: "Bash", input: { command: "npm run build" } }] } }),
      line({ ...base, type: "user", message: { content: [{ type: "tool_result", tool_use_id: "b1", content: "Done in 60ms\n…" }] } }),
    ];
    const chip = buildActivityView(normalizeClaude(evs)).items.find((i) => i.kind === "tool" && i.title === "Bash");
    expect(chip?.detail).toBe("npm run build"); // #2 — the command
    expect(chip?.result).toBe("Done in 60ms"); // #4 — first line of the result
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

  it("renders the human prompt as a user-role message and agent text as agent-role (chat sides)", () => {
    const msgs = vm.items.filter((i) => i.kind === "message");
    expect(msgs.find((i) => i.role === "user")?.title).toBe("Count the cities, please.");
    expect(msgs.find((i) => i.role === "agent")?.title).toBe("Looking into it.");
  });

  it("hides duplicate Codex message mirrors already persisted in the durable log", () => {
    const built = buildActivityView([
      { type: "user.message.completed", runtime: "codex", sequence: 1, timestamp: "2026-07-01T16:56:37.482Z", payload: { text: "ola" }, raw: null },
      { type: "user.message.completed", runtime: "codex", sequence: 2, timestamp: "2026-07-01T16:56:37.486Z", payload: { text: "ola" }, raw: null },
      { type: "assistant.message.completed", runtime: "codex", sequence: 3, timestamp: "2026-07-01T16:56:40.000Z", payload: { text: "Olá. Como posso ajudar?" }, raw: null },
      { type: "assistant.message.completed", runtime: "codex", sequence: 4, timestamp: "2026-07-01T16:56:40.003Z", payload: { text: "Olá. Como posso ajudar?" }, raw: null },
      { type: "user.message.completed", runtime: "codex", sequence: 5, timestamp: "2026-07-01T16:56:45.000Z", payload: { text: "<image name=[Image #1] path=\"/tmp/s.png\">\n</image>\n[Image #1] instalei o patch" }, raw: null },
      { type: "user.message.completed", runtime: "codex", sequence: 6, timestamp: "2026-07-01T16:56:45.002Z", payload: { text: "[Image #1] instalei o patch" }, raw: null },
    ]);

    expect(built.items.filter((i) => i.kind === "message").map((i) => [i.role, i.title])).toEqual([
      ["user", "ola"],
      ["agent", "Olá. Como posso ajudar?"],
      ["user", "<image name=[Image #1] path=\"/tmp/s.png\">\n</image>\n[Image #1] instalei o patch"],
    ]);
    expect(built.summary.messages).toBe(1);
  });

  it("renders thinking + image items with the right kind/role/refs (#8/#10)", () => {
    const evs = [
      line({ ...base, type: "assistant", message: { content: [{ type: "thinking", thinking: "reasoning here" }] } }),
      line({ ...base, type: "user", message: { content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "QUJD" } }] } }),
    ];
    const built = buildActivityView(normalizeClaude(evs));
    const think = built.items.find((i) => i.kind === "thinking");
    expect(think).toMatchObject({ role: "agent", title: "reasoning here" });
    const img = built.items.find((i) => i.kind === "image");
    expect(img?.role).toBe("user");
    expect(img?.imageId).toMatch(/^img_/);
  });

  it("attaches the expandable diff body to the tool chip (#9)", () => {
    const evs = [
      line({ ...base, type: "assistant", message: { content: [{ type: "tool_use", id: "e1", name: "Edit", input: { file_path: "/repo/x.ts" } }] } }),
      line({ ...base, type: "user", toolUseResult: { structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: [" k", "-a", "+b"] }] }, message: { content: [{ type: "tool_result", tool_use_id: "e1", content: "ok" }] } }),
    ];
    const chip = buildActivityView(normalizeClaude(evs)).items.find((i) => i.kind === "tool" && i.title === "Edit");
    expect(chip?.result).toBe("+1 −1");
    expect(chip?.resultFull).toContain("@@");
  });

  it("incremental builder (fed in chunks) matches batch buildActivityView (#perf)", () => {
    const evs = normalizeClaude(transcript, "/x/sess.jsonl");
    const batch = buildActivityView(evs);
    const b = createActivityBuilder();
    b.push(evs.slice(0, 3)); b.push(evs.slice(3, 5)); b.push(evs.slice(5)); // arbitrary chunk boundaries
    const inc = b.view();
    expect(inc.summary).toEqual(batch.summary);
    const shape = (vm: typeof inc) => vm.items.map((i) => [i.kind, i.role, i.title, i.result, i.path]);
    expect(shape(inc)).toEqual(shape(batch));
  });

  it("reports totalItems == items.length so the host can surface a 'recent N of M' cap notice (spec 238 inc 1)", () => {
    const built = buildActivityView(normalizeClaude(transcript, "/x/sess.jsonl"));
    expect(built.totalItems).toBe(built.items.length);
    expect(built.totalItems).toBeGreaterThan(0);
  });

  it("renders a compaction.boundary as a boundary item with a compact token-delta detail (spec 239 inc 1)", () => {
    const evs = normalizeClaude([
      line({ ...base, type: "system", subtype: "compact_boundary", compactMetadata: { trigger: "auto", preTokens: 1002519, postTokens: 17671 } }),
    ]);
    const item = buildActivityView(evs).items.find((i) => i.kind === "boundary");
    expect(item?.title).toBe("context compacted");
    expect(item?.detail).toBe("1.0M → 18k tokens");
  });

  it("renders session.boundary reasons with human labels (lifecycle + inferred)", () => {
    const ev = (reason: string) => ({ type: "session.boundary", runtime: "claude", sequence: 0, payload: { toSession: "x", reason }, raw: null });
    const label = (reason: string) => buildActivityView([ev(reason)] as never).items.find((i) => i.kind === "boundary")?.title;
    expect(label("restarted")).toBe("restarted session");
    expect(label("resumed")).toBe("resumed session");
    expect(label("forked")).toBe("forked session");
    expect(label("started")).toBe("new session");
    expect(label("new")).toBe("new session");
    expect(label("resume")).toBe("resumed session"); // inferred in-TUI resume
  });

  it("folds the post-compaction summary into the boundary (not a human bubble) + maps slash commands", () => {
    const evs = normalizeClaude([
      line({ ...base, type: "system", subtype: "compact_boundary", compactMetadata: { trigger: "manual", preTokens: 33000, postTokens: 5000 } }),
      line({ ...base, type: "user", isCompactSummary: true, message: { role: "user", content: "This session is being continued…" } }),
      line({ ...base, type: "user", message: { role: "user", content: "<command-name>/compact</command-name>\n<command-args></command-args>" } }),
    ]);
    const vm = buildActivityView(evs);
    // NO human message bubble produced by any of the three synthetic records
    expect(vm.items.filter((i) => i.kind === "message")).toHaveLength(0);
    const boundary = vm.items.find((i) => i.kind === "boundary");
    expect(boundary?.title).toBe("context compacted · manual");
    expect(boundary?.resultFull).toContain("This session is being continued");
    expect(vm.items.find((i) => i.kind === "command")?.title).toBe("/compact");
  });

  it("does NOT fold an orphan summary into a STALE boundary once a real turn intervened (codex fold)", () => {
    const vm = buildActivityView(normalizeClaude([
      line({ ...base, type: "system", subtype: "compact_boundary", compactMetadata: { trigger: "auto", preTokens: 1000, postTokens: 100 } }),
      line({ ...base, type: "assistant", message: { content: [{ type: "text", text: "a real turn after the boundary" }] } }),
      line({ ...base, type: "user", isCompactSummary: true, message: { role: "user", content: "orphan summary" } }),
    ]));
    const boundaries = vm.items.filter((i) => i.kind === "boundary");
    expect(boundaries[0].resultFull).toBeUndefined(); // the first boundary is NOT mutated by the orphan
    expect(boundaries).toHaveLength(2); // the orphan summary became its own standalone boundary
  });

  it("filters the 'No response requested.' turn marker out of the chat (#3)", () => {
    const noise = [line({ ...base, type: "assistant", message: { content: [{ type: "text", text: "No response requested." }] } })];
    const built = buildActivityView(normalizeClaude(noise));
    expect(built.items.filter((i) => i.kind === "message")).toHaveLength(0);
    expect(built.summary.messages).toBe(0);
  });
});
