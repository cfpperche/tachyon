import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  appendDoorbellEvent,
  appendDoorbellOverflowEvent,
  readDoorbellEvents,
  readDoorbellEventsFor,
  readDoorbellTrailEvents,
  hasDoorbellRung,
  DOORBELLS_REL_PATH,
} from "@tachyon/engine/workspace/doorbell.js";

describe("doorbell", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
    roots.length = 0;
  });

  function root(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-doorbell-"));
    roots.push(dir);
    return dir;
  }

  it("readDoorbellEvents returns [] when no doorbells file exists yet", () => {
    expect(readDoorbellEvents(root())).toEqual([]);
  });

  it("appendDoorbellEvent appends one JSON line per call under .tachyon/", () => {
    const ws = root();
    appendDoorbellEvent(ws, { from: "worker", to: "boss", at: "2026-07-07T10:00:00.000Z" });
    appendDoorbellEvent(ws, { from: "worker", to: "boss", at: "2026-07-07T10:05:00.000Z" });

    const file = path.join(ws, DOORBELLS_REL_PATH);
    const lines = fs.readFileSync(file, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(readDoorbellEvents(ws)).toEqual([
      { from: "worker", to: "boss", at: "2026-07-07T10:00:00.000Z" },
      { from: "worker", to: "boss", at: "2026-07-07T10:05:00.000Z" },
    ]);
  });

  it("readDoorbellEvents skips malformed lines without throwing", () => {
    const ws = root();
    fs.mkdirSync(path.join(ws, ".tachyon"), { recursive: true });
    fs.writeFileSync(
      path.join(ws, DOORBELLS_REL_PATH),
      ['not json', JSON.stringify({ from: "worker", to: "boss", at: "2026-07-07T10:00:00.000Z" }), JSON.stringify({ from: "worker" })].join("\n") + "\n",
      "utf8",
    );

    expect(readDoorbellEvents(ws)).toEqual([{ from: "worker", to: "boss", at: "2026-07-07T10:00:00.000Z" }]);
  });

  it("hasDoorbellRung matches from -> delegator at/after the since timestamp", () => {
    const ws = root();
    appendDoorbellEvent(ws, { from: "worker", to: "boss", at: "2026-07-07T10:00:00.000Z" });

    expect(hasDoorbellRung(ws, "worker", "boss", "2026-07-07T09:00:00.000Z")).toBe(true);
    expect(hasDoorbellRung(ws, "worker", "boss", "2026-07-07T11:00:00.000Z")).toBe(false);
    expect(hasDoorbellRung(ws, "worker", "someone-else", "2026-07-07T09:00:00.000Z")).toBe(false);
    expect(hasDoorbellRung(ws, "other-agent", "boss", "2026-07-07T09:00:00.000Z")).toBe(false);
  });

  it("hasDoorbellRung falls back to any outgoing event when delegator is unknown", () => {
    const ws = root();
    appendDoorbellEvent(ws, { from: "worker", to: "sibling", at: "2026-07-07T10:00:00.000Z" });

    expect(hasDoorbellRung(ws, "worker", undefined, "2026-07-07T09:00:00.000Z")).toBe(true);
    expect(hasDoorbellRung(ws, "other-agent", undefined, "2026-07-07T09:00:00.000Z")).toBe(false);
  });

  // t-167b5c / spec 493 — the durable read door. `.tachyon/doorbells.jsonl` already witnessed
  // from/to/at; these cover the two fields it was missing (summary, pointer) and the reader that
  // lets a busy coordinator ask "what rang for me since X?" without depending on having been idle.
  it("appendDoorbellEvent carries optional summary/pointer through unchanged", () => {
    const ws = root();
    appendDoorbellEvent(ws, { from: "worker", to: "boss", at: "2026-07-07T10:00:00.000Z", summary: "t-abc done", pointer: "t-abc" });
    appendDoorbellEvent(ws, { from: "worker", to: "boss", at: "2026-07-07T10:05:00.000Z" });

    expect(readDoorbellEvents(ws)).toEqual([
      { from: "worker", to: "boss", at: "2026-07-07T10:00:00.000Z", summary: "t-abc done", pointer: "t-abc" },
      { from: "worker", to: "boss", at: "2026-07-07T10:05:00.000Z" },
    ]);
  });

  it("keeps overflow records in the durable trail but out of notice and completion readers (t-2153ae)", () => {
    const ws = root();
    appendDoorbellEvent(ws, { from: "worker", to: "boss", at: "2026-07-07T10:00:00.000Z", summary: "done" });
    appendDoorbellOverflowEvent(ws, {
      event: "overflow-drop",
      to: "boss",
      at: "2026-07-07T10:01:00.000Z",
      dropped: 1,
      queued: 20,
    });

    expect(readDoorbellTrailEvents(ws)).toHaveLength(2);
    expect(readDoorbellEventsFor(ws, "boss").notices.map((event) => event.summary)).toEqual(["done"]);
    expect(hasDoorbellRung(ws, "worker", "boss", "2026-07-07T09:00:00.000Z")).toBe(true);
  });

  it("readDoorbellEventsFor returns only events addressed to the given agent, oldest-first", () => {
    const ws = root();
    appendDoorbellEvent(ws, { from: "worker", to: "boss", at: "2026-07-07T10:05:00.000Z", summary: "second" });
    appendDoorbellEvent(ws, { from: "worker", to: "someone-else", at: "2026-07-07T10:02:00.000Z", summary: "not for boss" });
    appendDoorbellEvent(ws, { from: "worker", to: "boss", at: "2026-07-07T10:00:00.000Z", summary: "first" });

    const result = readDoorbellEventsFor(ws, "boss");
    expect(result.notices.map((n) => n.summary)).toEqual(["first", "second"]);
    expect(result.notices.every((n) => n.to === "boss")).toBe(true);
  });

  it("readDoorbellEventsFor filters strictly after `since`, giving a stateless cursor", () => {
    const ws = root();
    appendDoorbellEvent(ws, { from: "worker", to: "boss", at: "2026-07-07T10:00:00.000Z", summary: "first" });
    appendDoorbellEvent(ws, { from: "worker", to: "boss", at: "2026-07-07T10:05:00.000Z", summary: "second" });

    const fromFirst = readDoorbellEventsFor(ws, "boss", "2026-07-07T10:00:00.000Z");
    expect(fromFirst.notices.map((n) => n.summary)).toEqual(["second"]);
  });

  it("readDoorbellEventsFor caps returned items and reports truncation", () => {
    const ws = root();
    for (let i = 0; i < 210; i += 1) {
      appendDoorbellEvent(ws, { from: "worker", to: "boss", at: `2026-07-07T${String(10 + Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}:00.000Z`, summary: `n${i}` });
    }
    const result = readDoorbellEventsFor(ws, "boss");
    expect(result.notices).toHaveLength(200);
    expect(result.truncated).toBe(true);
    // truncation keeps the OLDEST 200 in the returned window when default-windowed at read time is
    // not in play here (no `since`); the cap itself must never silently drop without saying so.
  });

  it("readDoorbellEventsFor never returns another agent's notices", () => {
    const ws = root();
    appendDoorbellEvent(ws, { from: "worker", to: "boss", at: "2026-07-07T10:00:00.000Z", summary: "for boss" });
    appendDoorbellEvent(ws, { from: "worker", to: "someone-else", at: "2026-07-07T10:00:01.000Z", summary: "for someone-else" });

    expect(readDoorbellEventsFor(ws, "someone-else").notices.map((n) => n.summary)).toEqual(["for someone-else"]);
  });
});
