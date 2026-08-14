import { describe, it, expect } from "vitest";
import { NoticeQueue } from "@tachyon/engine/workspace/NoticeQueue.js";

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

  // t-44ae02 — the queued receipt can name oldest age only if enqueue reports it.
  it("reports the oldest createdAt across later enqueues", () => {
    let now = 1_000;
    const q = new NoticeQueue({ now: () => now });
    expect(q.enqueue("a", "first")).toEqual({ queued: 1, dropped: 0, oldestCreatedAt: 1_000 });
    now = 5_000;
    expect(q.enqueue("a", "second")).toEqual({ queued: 2, dropped: 0, oldestCreatedAt: 1_000 });
  });

  it("drops the oldest notice when item 21 exceeds the per-target bound", () => {
    let now = 0;
    const q = new NoticeQueue({ now: () => now });
    for (let item = 1; item <= 20; item += 1) {
      now = item * 1000;
      expect(q.enqueue("a", `item ${item}`).dropped).toBe(0);
    }
    now = 21_000;
    // item 1 (createdAt 1000) was dropped; the receipt's oldest is now item 2.
    expect(q.enqueue("a", "item 21")).toEqual({ queued: 20, dropped: 1, oldestCreatedAt: 2000 });
    expect(q.dequeue("a")?.line).toBe("item 2");
    for (let item = 3; item <= 21; item += 1) expect(q.dequeue("a")?.line).toBe(`item ${item}`);
  });

  it("keeps agent-authored reports beyond the TTL while host pokes expire", () => {
    let now = 0;
    const expired: string[] = [];
    const q = new NoticeQueue({ ttlMs: 10, now: () => now, onExpired: (items) => expired.push(...items.map((i) => i.line)) });
    q.enqueue("parent", "finished report", { origin: "agent-authored", sourceChild: "worker", sourceIncarnation: 1 });
    q.enqueue("parent", "worker is waiting", { origin: "host-poke", sourceChild: "worker", sourceIncarnation: 1 });

    now = 11;

    expect(q.count("parent")).toBe(1);
    expect(q.dequeue("parent")?.line).toBe("finished report");
    expect(expired).toEqual(["worker is waiting"]);
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
    q.enqueue("a", "doomed", { origin: "host-poke", sourceChild: "child", sourceIncarnation: 1 });
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
