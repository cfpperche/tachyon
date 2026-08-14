import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TaskAttemptStore } from "@tachyon/engine/tasks/TaskAttemptStore.js";

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-task-attempt-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("TaskAttemptStore", () => {
  it("appends two attempts to a per-task JSONL ledger and reads them back", () => {
    const store = new TaskAttemptStore(root);
    const first = store.claim("t-123456", { agent: "ada", evidence: "first claim", now: "2026-08-09T10:00:00.000Z" });
    store.end("t-123456", { type: "released", attemptId: first.attemptId, agent: "ada", evidence: "agent exited", now: "2026-08-09T10:01:00.000Z" });
    const second = store.claim("t-123456", { agent: "grace", evidence: "replacement claim", now: "2026-08-09T10:02:00.000Z" });

    expect(store.read("t-123456")).toEqual([
      first,
      expect.objectContaining({ type: "released", attemptId: first.attemptId, agent: "ada" }),
      second,
    ]);
    expect(store.pathFor("t-123456")).toBe(path.join(root, ".tachyon", "tasks", "t-123456.attempts"));
  });

  it("refuses a second claim while an attempt is open and names it", () => {
    const store = new TaskAttemptStore(root);
    const open = store.claim("t-123456", { agent: "ada", evidence: "claim" });
    expect(() => store.claim("t-123456", { agent: "grace", evidence: "replacement" }))
      .toThrow(new RegExp(`open attempt '${open.attemptId}'.*ada`));
  });

  it("backfill is idempotent and never touches a ledger that already exists", () => {
    const store = new TaskAttemptStore(root);
    const event = {
      type: "delivered" as const,
      attemptId: "a-backfill-123456",
      agent: "ada",
      ts: "2026-08-09T10:00:00.000Z",
      evidence: "backfill inferred from legacy assignee",
      origin: "backfill" as const,
      inferredFromUpdatedAt: "2026-08-09T10:00:00.000Z",
    };
    store.appendBackfill("t-123456", event);
    store.appendBackfill("t-123456", event);
    expect(store.read("t-123456")).toEqual([event]);
  });
});
