import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ActivityLogWriter } from "../../src/activity/logWriter.js";
import { ActivityLog } from "../../src/activity/logStore.js";
import { buildActivityView } from "../../src/activity/activityView.js";

const roots: string[] = [];
function freshRoot(): string { const d = fs.mkdtempSync(path.join(os.tmpdir(), "actint-")); roots.push(d); return d; }
afterEach(() => { while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true }); });

const clock = () => "2026-06-20T00:00:00Z";
const loc = (p: string, id: string) => ({ path: p, sessionId: id, runtime: "claude" });
const asst = (uuid: string, sid: string, text: string) =>
  JSON.stringify({ type: "assistant", uuid, sessionId: sid, timestamp: "2026-06-20T00:00:00Z", message: { content: [{ type: "text", text }] } });

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
    expect(boundaries).toContain("session changed");   // /clear → session boundary stitched
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
});
