import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ActivityLogWriter } from "@tachyon/engine/activity/logWriter.js";
import { ActivityLog } from "@tachyon/engine/activity/logStore.js";
import { buildActivityView } from "../../apps/vscode-extension/src/activity/activityView";

const roots: string[] = [];
function freshRoot(): string { const d = fs.mkdtempSync(path.join(os.tmpdir(), "actint-")); roots.push(d); return d; }
afterEach(() => { while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true }); });

const clock = () => "2026-06-20T00:00:00Z";
const loc = (p: string, id: string) => ({ path: p, sessionId: id, runtime: "claude" });
const codexLoc = (p: string, id: string) => ({ path: p, sessionId: id, runtime: "codex" });
const asst = (uuid: string, sid: string, text: string) =>
  JSON.stringify({ type: "assistant", uuid, sessionId: sid, timestamp: "2026-06-20T00:00:00Z", message: { content: [{ type: "text", text }] } });
const codexLine = (payload: unknown, type = "response_item") =>
  JSON.stringify({ timestamp: "2026-06-30T12:00:00Z", type, payload });

describe("activity log end-to-end (writer → log → render, spec 239 inc 3b+4)", () => {
  it("stitches two sessions with a boundary, keeps compaction markers, and renders from the log only", () => {
    const root = freshRoot();
    const adir = path.join(root, "activity");
    const sessA = path.join(root, "A.jsonl");
    const sessB = path.join(root, "B.jsonl");

    // session A: a message, an in-file compaction, then a post-compaction message
    fs.writeFileSync(sessA, [
      asst("a1", "A", "first in A"),
      JSON.stringify({ type: "system", uuid: "a2", sessionId: "A", subtype: "compact_boundary", compactMetadata: { trigger: "auto", preTokens: 1000000, postTokens: 20000 } }),
      asst("a3", "A", "after compaction"),
    ].join("\n") + "\n");
    // session B (a /clear later): one message
    fs.writeFileSync(sessB, asst("b1", "B", "fresh in B") + "\n");

    const writer = new ActivityLogWriter(adir, "claude", clock);
    expect(writer.poll(loc(sessA, "A"))).toBeGreaterThan(0); // ingest A
    fs.appendFileSync(sessA, asst("a4", "A", "more in A") + "\n");
    writer.poll(loc(sessA, "A")); // incremental append
    writer.poll(loc(sessB, "B")); // session switch → boundary + B

    // RENDER strictly from the durable log (no runtime transcript involved)
    const events = new ActivityLog(adir, "claude").readTail(100);
    const vm = buildActivityView(events.map((e, i) => ({
      type: e.type, runtime: "claude", sequence: i, sessionId: e.sessionId, timestamp: e.timestamp,
      payload: e.payload, raw: undefined,
    })) as never);

    const messages = vm.items.filter((it) => it.kind === "message").map((it) => it.title);
    expect(messages).toEqual(["first in A", "after compaction", "more in A", "fresh in B"]);
    const boundaries = vm.items.filter((it) => it.kind === "boundary").map((it) => it.title);
    expect(boundaries).toContain("context compacted"); // in-file compaction preserved
    expect(boundaries).toContain("new session");       // switch to an unseen session (/clear or fresh) stitched
    // ordering: compaction boundary comes before the session boundary
    const kinds = vm.items.map((it) => it.kind);
    expect(kinds.indexOf("boundary")).toBeLessThan(kinds.lastIndexOf("boundary"));
  });

  it("persists a rendered image as a content-addressed blob the panel can load by blobRef", () => {
    const root = freshRoot();
    const adir = path.join(root, "activity");
    const sess = path.join(root, "A.jsonl");
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]); // fake PNG bytes
    fs.writeFileSync(sess, JSON.stringify({
      type: "user", uuid: "i1", sessionId: "A", timestamp: "2026-06-20T00:00:00Z",
      message: { content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: png.toString("base64") } }] },
    }) + "\n");

    new ActivityLogWriter(adir, "claude", clock).poll(loc(sess, "A"));
    const log = new ActivityLog(adir, "claude");
    const img = log.readTail(10).find((e) => e.type === "image.attached");
    expect(img?.blobRef).toBeTruthy();
    expect(fs.readFileSync(log.blobPath(img!.blobRef!))).toEqual(png); // the panel reads the blob by blobRef
  });

  it("spec 305: writes and renders structured Codex Activity from a rollout JSONL", () => {
    const root = freshRoot();
    const adir = path.join(root, "activity");
    const sess = path.join(root, "rollout-codex.jsonl");
    fs.writeFileSync(sess, [
      codexLine({ id: "codex-session", cwd: root, cli_version: "0.142.4" }, "session_meta"),
      codexLine({ type: "message", id: "u1", role: "user", content: [{ type: "input_text", text: "bom dia" }] }),
      codexLine({ type: "message", id: "a1", role: "assistant", content: [{ type: "output_text", text: "Bom dia." }] }),
      codexLine({ type: "function_call", id: "fc1", name: "exec_command", call_id: "call-1", arguments: "{\"cmd\":\"date\"}" }),
      codexLine({ type: "function_call_output", call_id: "call-1", output: "Tue Jun 30\n" }),
    ].join("\n") + "\n");

    expect(new ActivityLogWriter(adir, "codex", clock).poll(codexLoc(sess, "codex-session"))).toBeGreaterThan(0);
    const events = new ActivityLog(adir, "codex").readTail(100);
    expect(events.every((e) => e.source.runtime === "codex")).toBe(true);

    const vm = buildActivityView(events.map((e, i) => ({
      type: e.type, runtime: "codex", sequence: i, sessionId: e.sessionId, timestamp: e.timestamp,
      payload: e.payload, raw: undefined,
    })) as never);
    expect(vm.runtime).toBe("codex");
    expect(vm.items.filter((it) => it.kind === "message").map((it) => it.title)).toEqual(["bom dia", "Bom dia."]);
    expect(vm.items.find((it) => it.kind === "tool")).toMatchObject({ title: "exec_command", result: "Tue Jun 30" });
  });

  it("writes and renders Codex input_image blocks as durable image blobs", () => {
    const root = freshRoot();
    const adir = path.join(root, "activity");
    const sess = path.join(root, "rollout-codex-image.jsonl");
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    fs.writeFileSync(sess, [
      codexLine({ id: "codex-session", cwd: root, cli_version: "0.142.5" }, "session_meta"),
      codexLine({
        type: "message",
        id: "u1",
        role: "user",
        content: [
          { type: "input_text", text: "<image name=[Image #1] path=\"/tmp/s.png\">" },
          { type: "input_image", image_url: `data:image/png;base64,${png.toString("base64")}`, detail: "high" },
          { type: "input_text", text: "</image>" },
          { type: "input_text", text: "[Image #1] render test" },
        ],
      }),
    ].join("\n") + "\n");

    expect(new ActivityLogWriter(adir, "codex", clock).poll(codexLoc(sess, "codex-session"))).toBeGreaterThan(0);
    const log = new ActivityLog(adir, "codex");
    const events = log.readTail(100);
    const img = events.find((e) => e.type === "image.attached");
    expect(img?.blobRef).toBeTruthy();
    expect(fs.readFileSync(log.blobPath(img!.blobRef!))).toEqual(png);

    const vm = buildActivityView(events.map((e, i) => ({
      type: e.type, runtime: "codex", sequence: i, sessionId: e.sessionId, timestamp: e.timestamp,
      payload: e.payload, raw: undefined, runtimeVersion: e.runtimeVersion,
    })) as never);
    expect(vm.items.filter((it) => it.kind === "message").map((it) => it.title)).toEqual(["[Image #1] render test"]);
    expect(vm.items.find((it) => it.kind === "image")).toMatchObject({ role: "user", detail: "image/png", title: "image" });
  });

  it("SDD 402: writes and renders structured Pi Activity from its exact native JSONL", () => {
    const root = freshRoot();
    const adir = path.join(root, "activity");
    const sess = path.join(root, "2026_pi-session.jsonl");
    const piLine = (id: string, message: unknown) => JSON.stringify({ type: "message", id, parentId: null, timestamp: clock(), message });
    fs.writeFileSync(sess, [
      JSON.stringify({ type: "session", version: 3, id: "pi-session", timestamp: clock(), cwd: root }),
      piLine("u1", { role: "user", content: "inspect this" }),
      piLine("a1", { role: "assistant", model: "pi-model", content: [{ type: "text", text: "inspecting" }, { type: "toolCall", id: "tc1", name: "read", arguments: { path: "/repo/file.ts" } }], stopReason: "toolUse" }),
      piLine("r1", { role: "toolResult", toolCallId: "tc1", toolName: "read", content: [{ type: "text", text: "contents" }], isError: false }),
    ].join("\n") + "\n");

    expect(new ActivityLogWriter(adir, "pi", clock).poll({ path: sess, sessionId: "pi-session", runtime: "pi" })).toBeGreaterThan(0);
    const events = new ActivityLog(adir, "pi").readTail(100);
    expect(events.every((event) => event.source.runtime === "pi")).toBe(true);
    const vm = buildActivityView(events.map((event, index) => ({
      type: event.type, runtime: "pi", sequence: index, sessionId: event.sessionId, timestamp: event.timestamp,
      payload: event.payload, raw: undefined, model: event.model, effort: event.effort,
    })) as never);
    expect(vm.runtime).toBe("pi");
    expect(vm.items.filter((item) => item.kind === "message").map((item) => item.title)).toEqual(["inspect this", "inspecting"]);
    expect(vm.items.find((item) => item.kind === "tool")).toMatchObject({ title: "read", result: "contents" });
  });

  it("spec 305: unknown runtimes do not silently fall back to the Claude normalizer", () => {
    const root = freshRoot();
    const adir = path.join(root, "activity");
    const sess = path.join(root, "unknown.jsonl");
    fs.writeFileSync(sess, asst("a1", "A", "would render if parsed as claude") + "\n");

    expect(new ActivityLogWriter(adir, "unknown", clock).poll({ path: sess, sessionId: "A", runtime: "mystery" })).toBe(0);
    expect(new ActivityLog(adir, "unknown").readTail(100)).toEqual([]);
  });
});
