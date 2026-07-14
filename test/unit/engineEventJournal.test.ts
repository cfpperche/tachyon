import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EngineEventJournal } from "../../src/engine-service/eventJournal.js";

const roots: string[] = [];
const fixture = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-engine-events-"));
  roots.push(root);
  return path.join(root, "events", "engine.jsonl");
};

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("EngineEventJournal", () => {
  it("persists cloned contiguous events and bounded cursor reads", () => {
    const filePath = fixture();
    const journal = new EngineEventJournal({ filePath, engineInstanceId: "engine-instance-1" });
    const payload = { view: "agents", nested: { count: 1 } };
    expect(journal.append("views-changed", payload)).toMatchObject({ seq: 1, kind: "views-changed" });
    payload.nested.count = 9;
    journal.append("notice", { message: "ready" });
    expect(journal.readAfter(0, 1)).toMatchObject({
      afterSeq: 0,
      oldestSeq: 1,
      latestSeq: 2,
      resyncRequired: false,
      events: [{ seq: 1, payload: { nested: { count: 1 } } }],
    });
    expect(new EngineEventJournal({ filePath, engineInstanceId: "engine-instance-1" }).readAfter(1, 10).events)
      .toMatchObject([{ seq: 2, kind: "notice" }]);
    expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
  });

  it("compacts to a bounded tail and requires resnapshot only for lost cursors", () => {
    const filePath = fixture();
    const journal = new EngineEventJournal({ filePath, engineInstanceId: "engine-instance-1", maxEvents: 2 });
    journal.append("one", {});
    journal.append("two", {});
    journal.append("three", {});
    expect(journal.readAfter(0)).toMatchObject({ oldestSeq: 2, latestSeq: 3, resyncRequired: true, events: [] });
    expect(journal.readAfter(1)).toMatchObject({ resyncRequired: false, events: [{ seq: 2 }, { seq: 3 }] });
    const reopened = new EngineEventJournal({ filePath, engineInstanceId: "engine-instance-1", maxEvents: 2 });
    expect(reopened.append("four", {}).seq).toBe(4);
  });

  it("recovers only a torn final line and refuses foreign/corrupt complete events", () => {
    const filePath = fixture();
    const journal = new EngineEventJournal({ filePath, engineInstanceId: "engine-instance-1" });
    journal.append("one", {});
    fs.appendFileSync(filePath, '{"partial"');
    expect(new EngineEventJournal({ filePath, engineInstanceId: "engine-instance-1" }).latestSeq).toBe(1);
    fs.appendFileSync(filePath, `${JSON.stringify({
      schemaVersion: 1,
      engineInstanceId: "foreign-instance",
      seq: 2,
      at: new Date().toISOString(),
      kind: "foreign",
      payload: {},
    })}\n`);
    expect(() => new EngineEventJournal({ filePath, engineInstanceId: "engine-instance-1" })).toThrow(/foreign/);
  });
});
