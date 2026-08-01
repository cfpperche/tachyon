import { describe, it, expect } from "vitest";
import { NoticeQueue } from "../../src/bridge/NoticeQueue.js";

describe("NoticeQueue", () => {
  it("keeps per-target FIFO order", () => {
    let now = 1000;
    const q = new NoticeQueue({ now: () => now });
    q.enqueue("a", "one");
    now += 1;
    q.enqueue("a", "two");
    q.enqueue("b", "other");
    expect(q.dequeue("a")?.line).toBe("one");
    expect(q.dequeue("a")?.line).toBe("two");
    expect(q.dequeue("b")?.line).toBe("other");
  });

  it("drops oldest notices on overflow", () => {
    const q = new NoticeQueue({ maxPerTarget: 2 });
    expect(q.enqueue("a", "one")).toEqual({ queued: 1, dropped: 0 });
    expect(q.enqueue("a", "two")).toEqual({ queued: 2, dropped: 0 });
    expect(q.enqueue("a", "three")).toEqual({ queued: 2, dropped: 1 });
    expect(q.dequeue("a")?.line).toBe("two");
    expect(q.dequeue("a")?.line).toBe("three");
  });

  it("expires stale notices and clears target queues", () => {
    let now = 0;
    const q = new NoticeQueue({ ttlMs: 10, now: () => now });
    q.enqueue("a", "old");
    now = 11;
    expect(q.count("a")).toBe(0);
    q.enqueue("a", "fresh");
    q.enqueue("a", "fresh2");
    expect(q.clear("a")).toBe(2);
    expect(q.dequeue("a")).toBeUndefined();
  });

  // t-fb1453 — expiry was the only drop path with no witness, whichever operation triggered the sweep.
  it("hands every TTL-expired item to onExpired, from whatever operation sweeps", () => {
    let now = 0;
    const expired: string[] = [];
    const q = new NoticeQueue({ ttlMs: 10, now: () => now, onExpired: (items) => expired.push(...items.map((i) => i.line)) });
    q.enqueue("a", "doomed", { origin: "agent-authored", sourceChild: "child", sourceIncarnation: 1 });
    q.enqueue("b", "also-doomed");
    now = 11;
    expect(q.peek("a")).toBeUndefined();
    expect(q.count("b")).toBe(0);
    expect(expired).toEqual(["doomed", "also-doomed"]);
  });

  // t-fb1453 — same text, same child, different survival rules: one slot each, never merged.
  it("keeps a host poke and an authored doorbell about the same child in separate slots", () => {
    const q = new NoticeQueue();
    q.enqueue("parent", "same text", { origin: "host-poke", sourceChild: "kid", sourceIncarnation: 1 });
    q.enqueue("parent", "same text", { origin: "agent-authored", sourceChild: "kid", sourceIncarnation: 1 });
    expect(q.count("parent")).toBe(2);
    expect(q.dequeue("parent")?.origin).toBe("host-poke");
    expect(q.dequeue("parent")?.origin).toBe("agent-authored");
  });

  // t-fb1453 — peek/dropFront exist so an unobserved submit cannot consume the only copy (t-b4a799).
  it("peek leaves the head in place until dropFront takes it", () => {
    const q = new NoticeQueue();
    q.enqueue("a", "one");
    q.enqueue("a", "two");
    expect(q.peek("a")?.line).toBe("one");
    expect(q.peek("a")?.line).toBe("one");
    expect(q.count("a")).toBe(2);
    expect(q.dropFront("a")?.line).toBe("one");
    expect(q.peek("a")?.line).toBe("two");
  });
});
