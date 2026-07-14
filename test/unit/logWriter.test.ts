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
const codexLoc = (p: string, id: string) => ({ path: p, sessionId: id, runtime: "codex" });
const codexLine = (payload: unknown, type = "response_item") =>
  JSON.stringify({ timestamp: "2026-06-30T12:00:00Z", type, payload });

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

  it("labels a switch to a KNOWN session as a /resume and an unseen one as new (distinct reasons)", () => {
    const root = freshRoot();
    const adir = path.join(root, "activity");
    const a = path.join(root, "A.jsonl");
    const b = path.join(root, "B.jsonl");
    fs.writeFileSync(a, `${rec("a1", "A", "a")}\n`);
    fs.writeFileSync(b, `${rec("b1", "B", "b")}\n`);
    const w = new ActivityLogWriter(adir, "claude", clock);
    w.poll(loc(a, "A"));
    w.poll(loc(b, "B")); // A→B: B unseen → "new"
    fs.appendFileSync(a, `${rec("a2", "A", "a2")}\n`);
    w.poll(loc(a, "A")); // B→A: A was seen → "resume"
    const reasons = new ActivityLog(adir, "claude").readTail(50)
      .filter((e) => e.type === "session.boundary").map((e) => (e.payload as { reason?: string }).reason);
    expect(reasons).toEqual(["new", "resume"]);
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

  it("rehydrates the Codex normalizer after restart when the session id did not change", () => {
    const root = freshRoot();
    const adir = path.join(root, "activity");
    const sess = path.join(root, "rollout-codex.jsonl");
    fs.writeFileSync(sess, [
      codexLine({ id: "codex-session", cwd: root, cli_version: "0.142.4" }, "session_meta"),
      codexLine({ type: "message", id: "a1", role: "assistant", content: [{ type: "output_text", text: "before restart" }] }),
    ].join("\n") + "\n");
    new ActivityLogWriter(adir, "codex", clock).poll(codexLoc(sess, "codex-session"));

    fs.appendFileSync(sess, codexLine({ type: "message", id: "a2", role: "assistant", content: [{ type: "output_text", text: "after restart" }] }) + "\n");
    expect(new ActivityLogWriter(adir, "codex", clock).poll(codexLoc(sess, "codex-session"))).toBe(1);
    expect(new ActivityLog(adir, "codex").readTail(10).map((e) => (e.payload as { text?: string }).text)).toEqual(["before restart", "after restart"]);
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

  it("a Tachyon resume on the SAME session emits a 'resumed' marker after the grace window (spec 239 lifecycle)", () => {
    const root = freshRoot();
    const adir = path.join(root, "activity");
    const a = path.join(root, "A.jsonl");
    fs.writeFileSync(a, `${rec("a1", "A", "hi")}\n`);
    const w = new ActivityLogWriter(adir, "claude", clock);
    w.poll(loc(a, "A")); // establish A
    w.noteLifecycle("resumed"); w.arm(); // noted before the action, armed after it settled
    for (let i = 0; i < 3; i++) w.poll(loc(a, "A")); // grace polls with no uuid change → standalone marker
    const reasons = new ActivityLog(adir, "claude").readTail(50)
      .filter((e) => e.type === "session.boundary").map((e) => (e.payload as { reason?: string }).reason);
    expect(reasons).toEqual(["resumed"]);
  });

  it("ignores a lifecycle note until armed — no premature marker during the async action (codex BLOCKER)", () => {
    const root = freshRoot();
    const adir = path.join(root, "activity");
    const a = path.join(root, "A.jsonl");
    fs.writeFileSync(a, `${rec("a1", "A", "hi")}\n`);
    const w = new ActivityLogWriter(adir, "claude", clock);
    w.poll(loc(a, "A"));
    w.noteLifecycle("resumed"); // NOT armed yet (action still in flight)
    for (let i = 0; i < 5; i++) w.poll(loc(a, "A")); // even past the grace window — must emit nothing
    const log = new ActivityLog(adir, "claude");
    expect(log.readTail(50).filter((e) => e.type === "session.boundary")).toHaveLength(0);
    w.arm(); // action settled
    for (let i = 0; i < 3; i++) w.poll(loc(a, "A"));
    expect(log.readTail(50).filter((e) => e.type === "session.boundary").map((e) => (e.payload as { reason?: string }).reason)).toEqual(["resumed"]);
  });

  it("a Tachyon restart labels the new-session boundary 'restarted' (not the inferred 'new')", () => {
    const root = freshRoot();
    const adir = path.join(root, "activity");
    const a = path.join(root, "A.jsonl");
    const b = path.join(root, "B.jsonl");
    fs.writeFileSync(a, `${rec("a1", "A", "a")}\n`);
    fs.writeFileSync(b, `${rec("b1", "B", "b")}\n`);
    const w = new ActivityLogWriter(adir, "claude", clock);
    w.poll(loc(a, "A"));
    w.noteLifecycle("restarted"); w.arm();
    w.poll(loc(b, "B")); // uuid change consumes the pending action → labeled "restarted"
    const reasons = new ActivityLog(adir, "claude").readTail(50)
      .filter((e) => e.type === "session.boundary").map((e) => (e.payload as { reason?: string }).reason);
    expect(reasons).toEqual(["restarted"]);
  });

  it("t-9f2641 MINOR fix: a pending not-yet-armed Tachyon action is not clobbered by a same-tick 'rotation-follow' note", () => {
    const root = freshRoot();
    const adir = path.join(root, "activity");
    const a = path.join(root, "A.jsonl");
    const b = path.join(root, "B.jsonl");
    fs.writeFileSync(a, `${rec("a1", "A", "a")}\n`);
    fs.writeFileSync(b, `${rec("b1", "B", "b")}\n`);
    const w = new ActivityLogWriter(adir, "claude", clock);
    w.poll(loc(a, "A"));
    w.noteLifecycle("restarted"); // in-flight Tachyon action, NOT armed yet
    w.noteLifecycle("rotation-follow", true); // must NOT clobber the in-flight "restarted" note
    w.arm(); // the ORIGINAL ("restarted") action settles
    w.poll(loc(b, "B")); // uuid change consumes the pending action
    const reasons = new ActivityLog(adir, "claude").readTail(50)
      .filter((e) => e.type === "session.boundary").map((e) => (e.payload as { reason?: string }).reason);
    expect(reasons).toEqual(["restarted"]); // NOT "rotation-follow"
  });

  it("rotation-follow labels the boundary normally when no other lifecycle action is pending", () => {
    const root = freshRoot();
    const adir = path.join(root, "activity");
    const a = path.join(root, "A.jsonl");
    const b = path.join(root, "B.jsonl");
    fs.writeFileSync(a, `${rec("a1", "A", "a")}\n`);
    fs.writeFileSync(b, `${rec("b1", "B", "b")}\n`);
    const w = new ActivityLogWriter(adir, "claude", clock);
    w.poll(loc(a, "A"));
    w.noteLifecycle("rotation-follow", true); // decided now, not in-flight — nothing to clobber
    w.poll(loc(b, "B"));
    const reasons = new ActivityLog(adir, "claude").readTail(50)
      .filter((e) => e.type === "session.boundary").map((e) => (e.payload as { reason?: string }).reason);
    expect(reasons).toEqual(["rotation-follow"]);
  });

  it("a fork marks its own (fresh) log with a 'forked' boundary at the start", () => {
    const root = freshRoot();
    const adir = path.join(root, "activity");
    const f = path.join(root, "F.jsonl");
    fs.writeFileSync(f, `${rec("f1", "F", "forked content")}\n`);
    const w = new ActivityLogWriter(adir, "forkagent", clock);
    w.noteLifecycle("forked", true); // a buffered note is born READY (the manager applies it on writer creation)
    w.poll(loc(f, "F"));
    const items = new ActivityLog(adir, "forkagent").readTail(50);
    expect(items.filter((e) => e.type === "session.boundary").map((e) => (e.payload as { reason?: string }).reason)).toEqual(["forked"]);
    expect(items.some((e) => e.type === "assistant.message.completed")).toBe(true);
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

  it("tails a Grok chat_history.jsonl and emits a session.boundary on uuid rotation (t-9874be)", () => {
    const root = freshRoot();
    const adir = path.join(root, "activity");
    const sessA = path.join(root, "sessA", "chat_history.jsonl");
    const sessB = path.join(root, "sessB", "chat_history.jsonl");
    fs.mkdirSync(path.dirname(sessA), { recursive: true });
    fs.mkdirSync(path.dirname(sessB), { recursive: true });
    const grokUser = (text: string) =>
      JSON.stringify({ type: "user", content: [{ type: "text", text: `<user_query>\n${text}\n</user_query>` }] });
    const grokAsst = (text: string) =>
      JSON.stringify({ type: "assistant", content: text, model_id: "grok-4.5" });
    fs.writeFileSync(sessA, `${grokUser("hi")}\n${grokAsst("ola")}\n`);
    fs.writeFileSync(sessB, `${grokUser("again")}\n`);
    const grokLoc = (p: string, id: string) => ({ path: p, sessionId: id, runtime: "grok" });
    const w = new ActivityLogWriter(adir, "grok", clock);
    expect(w.poll(grokLoc(sessA, "sessA"))).toBe(2);
    const n = w.poll(grokLoc(sessB, "sessB"));
    expect(n).toBe(2); // boundary + B user message
    const types = new ActivityLog(adir, "grok").readTail(20).map((e) => e.type);
    expect(types).toEqual([
      "user.message.completed",
      "assistant.message.completed",
      "session.boundary",
      "user.message.completed",
    ]);
    fs.appendFileSync(sessB, `${grokAsst("more")}\n`);
    expect(w.poll(grokLoc(sessB, "sessB"))).toBe(1);
    // restart rehydrates grok normalizer for the same session id
    fs.appendFileSync(sessB, `${grokAsst("after restart")}\n`);
    expect(new ActivityLogWriter(adir, "grok", clock).poll(grokLoc(sessB, "sessB"))).toBe(1);
    const texts = new ActivityLog(adir, "grok").readTail(20)
      .filter((e) => e.type === "assistant.message.completed")
      .map((e) => (e.payload as { text: string }).text);
    expect(texts).toEqual(["ola", "more", "after restart"]);
  });
});
