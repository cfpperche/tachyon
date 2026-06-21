import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ActivityLogWriter } from "../../src/activity/logWriter.js";
import { ActivityLog } from "../../src/activity/logStore.js";

const roots: string[] = [];
function freshRoot(): string { const d = fs.mkdtempSync(path.join(os.tmpdir(), "logw-")); roots.push(d); return d; }
afterEach(() => { while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true }); });

const rec = (uuid: string, sessionId: string, text: string): string =>
  JSON.stringify({ type: "assistant", uuid, sessionId, version: "2.1", timestamp: "2026-06-20T00:00:00Z", message: { content: [{ type: "text", text }] } });
const clock = () => "2026-06-20T00:00:00Z";
const loc = (p: string, id: string) => ({ path: p, sessionId: id, runtime: "claude" });

describe("ActivityLogWriter (spec 239 inc 3b)", () => {
  it("tails the current session forward into the per-agent log (incremental, no dup)", () => {
    const root = freshRoot();
    const adir = path.join(root, "activity");
    const sessA = path.join(root, "A.jsonl");
    fs.writeFileSync(sessA, `${rec("u1", "A", "hello")}\n`);
    const w = new ActivityLogWriter(adir, "claude", clock);
    expect(w.poll(loc(sessA, "A"))).toBe(1);
    fs.appendFileSync(sessA, `${rec("u2", "A", "world")}\n`);
    expect(w.poll(loc(sessA, "A"))).toBe(1); // only the NEW record
    expect(w.poll(loc(sessA, "A"))).toBe(0); // nothing new
    const tail = new ActivityLog(adir, "claude").readTail(10);
    expect(tail.map((e) => (e.payload as { text: string }).text)).toEqual(["hello", "world"]);
  });

  it("emits ONE session.boundary on a uuid change and continues in the SAME log (stitching)", () => {
    const root = freshRoot();
    const adir = path.join(root, "activity");
    const sessA = path.join(root, "A.jsonl");
    const sessB = path.join(root, "B.jsonl");
    fs.writeFileSync(sessA, `${rec("u1", "A", "in A")}\n`);
    fs.writeFileSync(sessB, `${rec("v1", "B", "in B")}\n`);
    const w = new ActivityLogWriter(adir, "claude", clock);
    w.poll(loc(sessA, "A"));
    expect(w.poll(loc(sessB, "B"))).toBe(2); // boundary + the B message
    const types = new ActivityLog(adir, "claude").readTail(10).map((e) => e.type);
    expect(types).toEqual(["assistant.message.completed", "session.boundary", "assistant.message.completed"]);
  });

  it("resumes from the persisted offset after a restart — no re-read, no duplicate", () => {
    const root = freshRoot();
    const adir = path.join(root, "activity");
    const sessA = path.join(root, "A.jsonl");
    fs.writeFileSync(sessA, `${rec("u1", "A", "a")}\n${rec("u2", "A", "b")}\n`);
    new ActivityLogWriter(adir, "claude", clock).poll(loc(sessA, "A")); // ingest both
    // a fresh writer (process restart) over the same dir
    const w2 = new ActivityLogWriter(adir, "claude", clock);
    expect(w2.poll(loc(sessA, "A"))).toBe(0); // already ingested — resumes from the saved offset
    expect(new ActivityLog(adir, "claude").readTail(10)).toHaveLength(2); // not duplicated
  });

  it("emits a DISTINCT boundary on each toggle (A→B→A→B), not suppressed by a repeated key (codex MAJOR fold)", () => {
    const root = freshRoot();
    const adir = path.join(root, "activity");
    const a = path.join(root, "A.jsonl");
    const b = path.join(root, "B.jsonl");
    fs.writeFileSync(a, `${rec("a1", "A", "a")}\n`);
    fs.writeFileSync(b, `${rec("b1", "B", "b")}\n`);
    const w = new ActivityLogWriter(adir, "claude", clock);
    w.poll(loc(a, "A"));
    w.poll(loc(b, "B")); // boundary #1 A→B
    fs.appendFileSync(a, `${rec("a2", "A", "a2")}\n`);
    w.poll(loc(a, "A")); // boundary #2 B→A
    fs.appendFileSync(b, `${rec("b2", "B", "b2")}\n`);
    w.poll(loc(b, "B")); // boundary #3 A→B — must NOT be suppressed by a repeated from:to key
    const boundaries = new ActivityLog(adir, "claude").readTail(50).filter((e) => e.type === "session.boundary");
    expect(boundaries).toHaveLength(3);
  });

  it("does not drop a record that was mid-write at save time, across a restart (codex durability fold)", () => {
    const root = freshRoot();
    const adir = path.join(root, "activity");
    const a = path.join(root, "A.jsonl");
    const a2 = rec("a2", "A", "second");
    const split = Math.floor(a2.length / 2);
    fs.writeFileSync(a, `${rec("a1", "A", "first")}\n${a2.slice(0, split)}`); // a1 complete + a2 PARTIAL (no newline yet)
    new ActivityLogWriter(adir, "claude", clock).poll(loc(a, "A")); // ingests a1; a2 is incomplete → offset stays line-aligned
    expect(new ActivityLog(adir, "claude").readTail(10).map((e) => (e.payload as { text: string }).text)).toEqual(["first"]);
    // a fresh writer (restart) — the record then completes
    const w2 = new ActivityLogWriter(adir, "claude", clock);
    fs.appendFileSync(a, `${a2.slice(split)}\n`);
    w2.poll(loc(a, "A"));
    expect(new ActivityLog(adir, "claude").readTail(10).map((e) => (e.payload as { text: string }).text)).toEqual(["first", "second"]); // a2 NOT dropped
  });

  it("treats an unresolved/ambiguous session as a GAP — writes nothing, never guesses (shared cwd)", () => {
    const root = freshRoot();
    const adir = path.join(root, "activity");
    const w = new ActivityLogWriter(adir, "claude", clock);
    expect(w.poll(undefined)).toBe(0);
    expect(new ActivityLog(adir, "claude").readTail(10)).toEqual([]);
  });

  it("does not log raw/sidecar-only records (the log stays normalized, not a raw clone)", () => {
    const root = freshRoot();
    const adir = path.join(root, "activity");
    const sessA = path.join(root, "A.jsonl");
    // a sidecar record that normalizes to `raw` only
    fs.writeFileSync(sessA, `${JSON.stringify({ type: "queue-operation", uuid: "q1", sessionId: "A" })}\n`);
    const w = new ActivityLogWriter(adir, "claude", clock);
    expect(w.poll(loc(sessA, "A"))).toBe(0);
    expect(new ActivityLog(adir, "claude").readTail(10)).toEqual([]);
  });
});
