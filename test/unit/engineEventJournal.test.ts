import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EngineEventJournal, pruneEngineEventJournals } from "../../src/engine-service/eventJournal.js";

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
    expect(journal.readAfter(0)).toMatchObject({ oldestSeq: 3, latestSeq: 3, resyncRequired: true, events: [] });
    expect(journal.readAfter(2)).toMatchObject({ resyncRequired: false, events: [{ seq: 3 }] });
    const reopened = new EngineEventJournal({ filePath, engineInstanceId: "engine-instance-1", maxEvents: 2 });
    expect(reopened.append("four", {}).seq).toBe(4);
  });

  it("amortizes compaction rewrites and returns to the low watermark", () => {
    const filePath = fixture();
    const journal = new EngineEventJournal({ filePath, engineInstanceId: "engine-instance-1", maxEvents: 4 });
    const write = vi.spyOn(fs, "writeFileSync");
    const rename = vi.spyOn(fs, "renameSync");
    const rewriteCount = () => write.mock.calls.filter((call) => call[2] && typeof call[2] === "object" && call[2].flag === "wx").length;
    try {
      for (const kind of ["one", "two", "three", "four"]) journal.append(kind, {});
      expect(rewriteCount()).toBe(0);
      expect(rename).not.toHaveBeenCalled();

      journal.append("five", {});
      expect(rewriteCount()).toBe(1);
      expect(rename).toHaveBeenCalledTimes(1);
      expect(fs.readFileSync(filePath, "utf8").trim().split("\n")).toHaveLength(3);

      journal.append("six", {});
      expect(rewriteCount()).toBe(1);
      expect(rename).toHaveBeenCalledTimes(1);
    } finally {
      write.mockRestore();
      rename.mockRestore();
    }
  });

  it("prunes abandoned instance journals but never the live instance", () => {
    const directory = path.dirname(fixture());
    fs.mkdirSync(directory, { recursive: true });
    const live = "00000000-0000-4000-8000-000000000001";
    const abandoned = [
      "00000000-0000-4000-8000-000000000002",
      "00000000-0000-4000-8000-000000000003",
      "00000000-0000-4000-8000-000000000004",
    ];
    for (const [index, id] of [live, ...abandoned].entries()) {
      const file = path.join(directory, `${id}.jsonl`);
      fs.writeFileSync(file, "");
      const modified = new Date(1_000 + index * 1_000);
      fs.utimesSync(file, modified, modified);
    }

    expect(pruneEngineEventJournals(directory, live, 1)).toBe(2);
    expect(fs.existsSync(path.join(directory, `${live}.jsonl`))).toBe(true);
    expect(fs.existsSync(path.join(directory, `${abandoned.at(-1)}.jsonl`))).toBe(true);
    expect(fs.existsSync(path.join(directory, `${abandoned[0]}.jsonl`))).toBe(false);
    expect(fs.existsSync(path.join(directory, `${abandoned[1]}.jsonl`))).toBe(false);
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
