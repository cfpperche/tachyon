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
});
