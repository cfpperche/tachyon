import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { makeTempDir } from "../helpers/tempDir.js";
import type { DoorbellEvent } from "@tachyon/engine/workspace/doorbell.js";
import { doorbellTrailTail, planNoticeReconstitution } from "@tachyon/engine/workspace/noticeReconstitution.js";
import {
  advanceNoticeCursor,
  ensureNoticeCursorFile,
  noticeCursorFor,
  noticeCursorPath,
  parseNoticeCursorFile,
  readNoticeCursorFile,
  type NoticeCursorFile,
} from "@tachyon/engine/workspace/noticeCursor.js";
import { composeBoundedAgentNotice } from "@tachyon/engine/notify/agentNotice.js";

/**
 * t-b47fb2 fatia 2 — the decision table for reconstituting the queue from the durable witness.
 *
 * The positive case is the easy half and it is not the one that matters. Fatia 1 measured a LOSS
 * (three doorbells destroyed by an instance swap); the way to fix a loss badly is to trade it for a
 * flood, and every positive test still passes when you do. So every row below that says "not
 * restored" is load-bearing, and the file is organised around them.
 */

const AT = (iso: string) => iso;
const ring = (from: string, to: string, at: string, summary?: string, pointer?: string): DoorbellEvent => ({
  from,
  to,
  at: AT(at),
  ...(summary === undefined ? {} : { summary }),
  ...(pointer === undefined ? {} : { pointer }),
});

const cursorFile = (baseline: string, cursors: Record<string, string> = {}): NoticeCursorFile => ({
  version: 1,
  baseline,
  cursors,
});

describe("t-b47fb2 — planNoticeReconstitution", () => {
  it("restores a doorbell that rang after the cursor, with the line the pane would have received", () => {
    const events = [ring("child", "coord", "2026-08-18T11:30:00.000Z", "t-83d04e done, tree clean", "t-83d04e")];
    const plan = planNoticeReconstitution({
      events,
      agents: ["coord"],
      cursors: cursorFile("2026-08-18T10:00:00.000Z"),
      maxPerTarget: 20,
    });

    expect(plan.restore).toHaveLength(1);
    // Byte-identical to `notify_agent`'s own delivery: the queue's dedup key and the staged-retry
    // comparison are exact line matches, so a second composer that drifted would turn a retry into a
    // duplicate. This is why `agentNotice.ts` moved into the engine instead of being copied.
    expect(plan.restore[0]!.line).toBe(composeBoundedAgentNotice("child", "coord", "t-83d04e done, tree clean", "t-83d04e"));
    // The ORIGINAL ring time, not now: `delayedSenderMarker` reads `createdAt` to label the delivery
    // as late. Stamping the boot clock would present a twenty-minute-old report as fresh news.
    expect(plan.restore[0]!.createdAt).toBe(Date.parse("2026-08-18T11:30:00.000Z"));
    expect(plan.restore[0]!.at).toBe("2026-08-18T11:30:00.000Z");
  });

  it("NEGATIVE CONTROL: a doorbell already handed over is NOT restored", () => {
    // Without this the fix is not a fix. A boot that re-enqueues everything the previous instance
    // already delivered turns each restart into a flood, and the positive test above cannot see it.
    const events = [
      ring("child", "coord", "2026-08-18T11:00:00.000Z", "already delivered"),
      ring("child", "coord", "2026-08-18T11:30:00.000Z", "still pending"),
    ];
    const plan = planNoticeReconstitution({
      events,
      agents: ["coord"],
      cursors: cursorFile("2026-08-18T10:00:00.000Z", { coord: "2026-08-18T11:00:00.000Z" }),
      maxPerTarget: 20,
    });

    expect(plan.restore.map((notice) => notice.at)).toEqual(["2026-08-18T11:30:00.000Z"]);
  });

  it("NEGATIVE CONTROL: the cursor boundary is exclusive — the row the cursor names is not replayed", () => {
    const events = [ring("child", "coord", "2026-08-18T11:00:00.000Z", "the row the cursor names")];
    const plan = planNoticeReconstitution({
      events,
      agents: ["coord"],
      cursors: cursorFile("2026-08-18T09:00:00.000Z", { coord: "2026-08-18T11:00:00.000Z" }),
      maxPerTarget: 20,
    });

    expect(plan.restore).toEqual([]);
  });

  it("NEGATIVE CONTROL: with no cursor file at all, nothing is restored", () => {
    // Absent/corrupt is the fail-OPEN direction the card names: back to today's behaviour, never a
    // boot that replays a 3,283-row trail because it could not read one small JSON file.
    const events = [ring("child", "coord", "2026-08-18T11:30:00.000Z", "pending")];
    expect(planNoticeReconstitution({ events, agents: ["coord"], cursors: undefined, maxPerTarget: 20 }).restore).toEqual([]);
  });

  it("NEGATIVE CONTROL: an agent with no live session is not restored for", () => {
    const events = [ring("child", "ghost", "2026-08-18T11:30:00.000Z", "pending")];
    const plan = planNoticeReconstitution({
      events,
      agents: ["coord"],
      cursors: cursorFile("2026-08-18T10:00:00.000Z"),
      maxPerTarget: 20,
    });
    expect(plan.restore).toEqual([]);
  });

  it("an agent with no cursor of its own is measured from the workspace baseline, not from the trail's start", () => {
    const events = [
      ring("child", "fresh", "2026-08-17T18:41:30.000Z", "the 2026-08-17 loss — history by the time this ships"),
      ring("child", "fresh", "2026-08-18T11:30:00.000Z", "genuinely pending"),
    ];
    const plan = planNoticeReconstitution({
      events,
      agents: ["fresh"],
      cursors: cursorFile("2026-08-18T10:00:00.000Z"),
      maxPerTarget: 20,
    });
    expect(plan.restore.map((notice) => notice.at)).toEqual(["2026-08-18T11:30:00.000Z"]);
  });

  it("a cursor BEHIND the baseline never re-opens history the baseline already closed", () => {
    const events = [ring("child", "coord", "2026-08-18T09:30:00.000Z", "before the baseline")];
    const plan = planNoticeReconstitution({
      events,
      agents: ["coord"],
      cursors: cursorFile("2026-08-18T10:00:00.000Z", { coord: "2026-08-18T09:00:00.000Z" }),
      maxPerTarget: 20,
    });
    expect(plan.restore).toEqual([]);
  });

  it("keeps only the newest maxPerTarget per agent, oldest-first", () => {
    const events = Array.from({ length: 25 }, (_unused, index) =>
      ring("child", "coord", `2026-08-18T12:${String(index).padStart(2, "0")}:00.000Z`, `notice ${index}`));
    const plan = planNoticeReconstitution({
      events,
      agents: ["coord"],
      cursors: cursorFile("2026-08-18T10:00:00.000Z"),
      maxPerTarget: 20,
    });
    expect(plan.restore).toHaveLength(20);
    expect(plan.restore[0]!.at).toBe("2026-08-18T12:05:00.000Z");
    expect(plan.restore.at(-1)!.at).toBe("2026-08-18T12:24:00.000Z");
  });

  it("counts a pending row with no witnessed summary instead of inventing an envelope for it", () => {
    // 2,091 of this workspace's 3,291 rows predate spec 493's `summary` field. Their content was never
    // recorded, so it cannot be reproduced — but a silent skip is exactly the defect class this task
    // exists to remove, so the caller is handed a number to report.
    const events = [
      ring("child", "coord", "2026-08-18T11:30:00.000Z"),
      ring("child", "coord", "2026-08-18T11:31:00.000Z", "   "),
      ring("child", "coord", "2026-08-18T11:32:00.000Z", "has content"),
    ];
    const plan = planNoticeReconstitution({
      events,
      agents: ["coord"],
      cursors: cursorFile("2026-08-18T10:00:00.000Z"),
      maxPerTarget: 20,
    });
    expect(plan.restore).toHaveLength(1);
    expect(plan.contentless).toBe(2);
  });

  it("orders a multi-agent plan oldest-first across every target", () => {
    const events = [
      ring("a", "one", "2026-08-18T11:30:00.000Z", "second"),
      ring("b", "two", "2026-08-18T11:00:00.000Z", "first"),
      ring("c", "one", "2026-08-18T11:45:00.000Z", "third"),
    ];
    const plan = planNoticeReconstitution({
      events,
      agents: ["one", "two"],
      cursors: cursorFile("2026-08-18T10:00:00.000Z"),
      maxPerTarget: 20,
    });
    expect(plan.restore.map((notice) => notice.at)).toEqual([
      "2026-08-18T11:00:00.000Z",
      "2026-08-18T11:30:00.000Z",
      "2026-08-18T11:45:00.000Z",
    ]);
  });

  it("doorbellTrailTail names the newest row regardless of file order", () => {
    expect(doorbellTrailTail([
      ring("a", "b", "2026-08-18T11:30:00.000Z"),
      ring("a", "b", "2026-08-18T09:30:00.000Z"),
    ])).toBe("2026-08-18T11:30:00.000Z");
    expect(doorbellTrailTail([])).toBeUndefined();
  });
});

describe("t-b47fb2 — the cursor file beside the witness", () => {
  it("a first boot seeds the baseline at the trail's tail, so nothing is pending for anybody", () => {
    const root = makeTempDir("notice-cursor-");
    const events = [
      ring("child", "coord", "2026-08-17T18:41:30.000Z", "the loss that started this"),
      ring("child", "coord", "2026-08-18T11:30:00.000Z", "and the one after it"),
    ];

    const file = ensureNoticeCursorFile(root, doorbellTrailTail(events));

    expect(file?.baseline).toBe("2026-08-18T11:30:00.000Z");
    expect(planNoticeReconstitution({ events, agents: ["coord"], cursors: file, maxPerTarget: 20 }).restore).toEqual([]);
  });

  it("an established file is never re-seeded, so a later boot still restores what is genuinely pending", () => {
    const root = makeTempDir("notice-cursor-");
    ensureNoticeCursorFile(root, "2026-08-18T10:00:00.000Z");
    const again = ensureNoticeCursorFile(root, "2026-08-18T23:59:00.000Z");
    expect(again?.baseline).toBe("2026-08-18T10:00:00.000Z");
  });

  it("advances monotonically and never rewinds", () => {
    const root = makeTempDir("notice-cursor-");
    ensureNoticeCursorFile(root, "2026-08-18T10:00:00.000Z");
    advanceNoticeCursor(root, "coord", "2026-08-18T11:00:00.000Z");
    advanceNoticeCursor(root, "coord", "2026-08-18T10:30:00.000Z");
    expect(readNoticeCursorFile(root)?.cursors.coord).toBe("2026-08-18T11:00:00.000Z");
    advanceNoticeCursor(root, "coord", "2026-08-18T12:00:00.000Z");
    expect(readNoticeCursorFile(root)?.cursors.coord).toBe("2026-08-18T12:00:00.000Z");
  });

  it("advancing for one agent leaves every other agent's cursor alone", () => {
    const root = makeTempDir("notice-cursor-");
    ensureNoticeCursorFile(root, "2026-08-18T10:00:00.000Z");
    advanceNoticeCursor(root, "coord", "2026-08-18T11:00:00.000Z");
    advanceNoticeCursor(root, "other", "2026-08-18T12:00:00.000Z");
    expect(readNoticeCursorFile(root)?.cursors).toEqual({
      coord: "2026-08-18T11:00:00.000Z",
      other: "2026-08-18T12:00:00.000Z",
    });
  });

  it("FAIL OPEN: a corrupt file reads as absent, which restores nothing rather than everything", () => {
    const root = makeTempDir("notice-cursor-");
    fs.mkdirSync(path.dirname(noticeCursorPath(root)), { recursive: true });
    for (const corruption of ["{ not json", "[]", '{"version":2,"baseline":"x","cursors":{}}', '{"version":1,"cursors":{}}', '{"version":1,"baseline":"x","cursors":[]}']) {
      fs.writeFileSync(noticeCursorPath(root), corruption, "utf8");
      expect(readNoticeCursorFile(root), corruption).toBeUndefined();
      expect(planNoticeReconstitution({
        events: [ring("child", "coord", "2026-08-18T11:30:00.000Z", "pending")],
        agents: ["coord"],
        cursors: readNoticeCursorFile(root),
        maxPerTarget: 20,
      }).restore).toEqual([]);
    }
  });

  it("one damaged cursor entry drops to the baseline instead of discarding the whole file", () => {
    const parsed = parseNoticeCursorFile(JSON.stringify({
      version: 1,
      baseline: "2026-08-18T10:00:00.000Z",
      cursors: { coord: "2026-08-18T11:00:00.000Z", broken: 17 },
    }));
    expect(parsed?.cursors).toEqual({ coord: "2026-08-18T11:00:00.000Z" });
    expect(noticeCursorFor(parsed, "broken")).toBe("2026-08-18T10:00:00.000Z");
    expect(noticeCursorFor(parsed, "coord")).toBe("2026-08-18T11:00:00.000Z");
  });

  it("noticeCursorFor with no file answers undefined — there is nothing to be pending against", () => {
    expect(noticeCursorFor(undefined, "coord")).toBeUndefined();
  });
});
