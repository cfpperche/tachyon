import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { appendDoorbellEvent, readDoorbellEvents, hasDoorbellRung, DOORBELLS_REL_PATH } from "../../src/bridge/doorbell.js";

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
});
