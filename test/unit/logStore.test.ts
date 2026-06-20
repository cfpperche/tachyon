import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { ActivityLog, LOG_SCHEMA_VERSION } from "../../src/activity/logStore.js";
import type { NormalizedEvent } from "../../src/activity/types.js";

const dirs: string[] = [];
function freshDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "actlog-"));
  dirs.push(d);
  return d;
}
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true }); });

const ev = (type: string, over: Partial<NormalizedEvent> = {}): NormalizedEvent =>
  ({ type, runtime: "claude", sequence: 0, sessionId: "s1", payload: { text: "x" }, raw: { huge: "RAW" }, ...over } as NormalizedEvent);
const src = (recordId: string) => ({ runtime: "claude", sessionId: "s1", recordId, sourcePath: "/x.jsonl" });

describe("ActivityLog (spec 239 inc 3)", () => {
  it("persists normalized events with schemaVersion + provenance and DROPS raw", () => {
    const log = new ActivityLog(freshDir(), "claude");
    const n = log.appendRecord([ev("assistant.message.completed", { payload: { text: "hi" } })], src("r1"), "2026-06-20T00:00:00Z");
    expect(n).toBe(1);
    const [line] = log.readTail(10);
    expect(line.schemaVersion).toBe(LOG_SCHEMA_VERSION);
    expect(line.type).toBe("assistant.message.completed");
    expect(line.source).toMatchObject({ runtime: "claude", recordId: "r1" });
    expect(line.loggedAt).toBe("2026-06-20T00:00:00Z");
    expect((line as unknown as { raw?: unknown }).raw).toBeUndefined(); // raw is NOT cloned
  });

  it("is idempotent per source record — re-appending the same record is a no-op (R5)", () => {
    const dir = freshDir();
    const log = new ActivityLog(dir, "claude");
    expect(log.appendRecord([ev("assistant.message.completed")], src("r1"), "t")).toBe(1);
    expect(log.appendRecord([ev("assistant.message.completed")], src("r1"), "t")).toBe(0); // dup
    // a fresh instance (simulating a restart) hydrates the seen-set from disk and still dedups
    const log2 = new ActivityLog(dir, "claude");
    expect(log2.hasRecord(src("r1"))).toBe(true);
    expect(log2.appendRecord([ev("assistant.message.completed")], src("r1"), "t")).toBe(0);
    expect(log2.readTail(10)).toHaveLength(1); // exactly one line survives the restart-mid-backfill race
  });

  it("appends all events of one record atomically and reads them back oldest→newest", () => {
    const log = new ActivityLog(freshDir(), "claude");
    log.appendRecord([
      ev("assistant.message.completed", { payload: { text: "a" } }),
      ev("tool.started", { payload: { name: "Bash" } }),
    ], src("r1"), "t");
    log.appendRecord([ev("assistant.message.completed", { payload: { text: "b" } })], src("r2"), "t");
    const all = log.readTail(10);
    expect(all.map((e) => (e.payload as { text?: string; name?: string }).text ?? (e.payload as { name?: string }).name))
      .toEqual(["a", "Bash", "b"]);
  });

  it("copies a rendered image blob once, content-addressed by sha256, and references the digest", () => {
    const log = new ActivityLog(freshDir(), "claude");
    const bytes = Buffer.from([1, 2, 3, 4]);
    const digest = createHash("sha256").update(bytes).digest("hex");
    const blobs = new Map([["img_abc", bytes]]);
    log.appendRecord([ev("image.attached", { payload: { id: "img_abc", mediaType: "image/png", from: "user" } })], src("r1"), "t", blobs);
    const [line] = log.readTail(10);
    expect(line.blobRef).toBe(digest); // sha256, not the render-side id
    expect(fs.readFileSync(log.blobPath(digest))).toEqual(bytes);
    expect(fs.existsSync(`${log.blobPath(digest)}.tmp`)).toBe(false); // temp+rename left no stray temp
    // a second record with the same bytes does not rewrite the blob (content-addressed dedup)
    const before = fs.statSync(log.blobPath(digest)).mtimeMs;
    log.appendRecord([ev("image.attached", { payload: { id: "img_abc", mediaType: "image/png", from: "agent" } })], src("r2"), "t", blobs);
    expect(fs.statSync(log.blobPath(digest)).mtimeMs).toBe(before);
  });

  it("a crash mid-append (torn final line) loses nothing: the record is re-appended, not suppressed (codex BLOCKER fold)", () => {
    const dir = freshDir();
    const log = new ActivityLog(dir, "claude");
    log.appendRecord([ev("assistant.message.completed", { payload: { text: "complete" } })], src("r1"), "t"); // one good record
    // simulate a crash that wrote only a PARTIAL line for the next (multi-event) record
    fs.appendFileSync(log.file, '{"schemaVersion":1,"source":{"runtime":"claude","sessionId":"s1","recordId":"r2"},"events":[{"type":"ass');
    // a fresh writer (restart) must NOT consider r2 logged (its line is unparseable)
    const log2 = new ActivityLog(dir, "claude");
    expect(log2.hasRecord(src("r2"))).toBe(false);
    expect(log2.readTail(10)).toHaveLength(1); // only the intact r1 reads back
    // r2 re-appends cleanly (no permanent loss of its events)
    expect(log2.appendRecord([ev("assistant.message.completed", { payload: { text: "r2-recovered" } })], src("r2"), "t")).toBe(1);
    expect(log2.readTail(10).some((e) => (e.payload as { text?: string }).text === "r2-recovered")).toBe(true);
  });

  it("survives a simulated runtime prune — the log still reads after the source file is gone", () => {
    const dir = freshDir();
    const log = new ActivityLog(dir, "claude");
    log.appendRecord([ev("assistant.message.completed", { payload: { text: "kept" }, sourcePath: "/gone.jsonl" })], src("r1"), "t");
    // (no source file exists at all here) — the normalized copy is self-contained
    expect(log.readTail(10)[0].payload).toEqual({ text: "kept" });
  });

  it("readTail returns [] when no log exists yet", () => {
    expect(new ActivityLog(freshDir(), "claude").readTail(10)).toEqual([]);
  });
});
