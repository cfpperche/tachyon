import { describe, expect, it } from "vitest";
import { attentionWindow, ATTENTION_VISIBLE_CAP } from "../../src/sidebar/attentionStack.js";
import { SAMPLE, type FleetVM, type NoticeVM } from "../../src/sidebar/types.js";
import { NOTICE_INBOX_CAP, restoreNoticeInbox } from "../../src/workspace/noticeInbox.js";

function notice(index: number, workspace = "a"): NoticeVM {
  return {
    id: `${workspace}-notice-${index}`,
    message: `Attention ${index}`,
    level: index % 3 === 0 ? "error" : index % 2 === 0 ? "warn" : "info",
    at: new Date(Date.UTC(2026, 6, 19, 20, index)).toISOString(),
    collapsedCount: 1,
    actions: [],
    read: false,
    actionsLive: false,
  };
}

function fleet(notices: NoticeVM[]): FleetVM {
  return { ...SAMPLE, folder: { hash: "a", name: "Alpha" }, notices };
}

describe("Attention Stack headless dogfood (spec 415)", () => {
  it("shows six oldest items together and keeps the seventh queued", () => {
    const result = attentionWindow([fleet(Array.from({ length: 7 }, (_, index) => notice(index + 1)))]);
    expect(ATTENTION_VISIBLE_CAP).toBe(6);
    expect(result.visible.map((row) => row.n.message)).toEqual([
      "Attention 1", "Attention 2", "Attention 3", "Attention 4", "Attention 5", "Attention 6",
    ]);
    expect(result.queued).toBe(1);
  });

  it("promotes the oldest queued item only after explicit removal", () => {
    const notices = Array.from({ length: 7 }, (_, index) => notice(index + 1));
    const before = attentionWindow([fleet(notices)]);
    const dismissed = before.visible[2]!.n.id;
    const after = attentionWindow([fleet(notices.filter((row) => row.id !== dismissed))]);
    expect(before.visible.some((row) => row.n.message === "Attention 7")).toBe(false);
    expect(after.visible.map((row) => row.n.message)).toEqual([
      "Attention 1", "Attention 2", "Attention 4", "Attention 5", "Attention 6", "Attention 7",
    ]);
    expect(after.queued).toBe(0);
  });

  it("merges multi-root attention into deterministic global FIFO order", () => {
    const alpha = fleet([notice(1, "a"), notice(3, "a")]);
    const beta = { ...fleet([notice(2, "b")]), folder: { hash: "b", name: "Beta" } };
    expect(attentionWindow([beta, alpha]).rows.map((row) => row.n.message)).toEqual([
      "Attention 1", "Attention 2", "Attention 3",
    ]);
  });

  it("restores only validated bounded rows and never restores executable callbacks", () => {
    const rows = Array.from({ length: NOTICE_INBOX_CAP + 5 }, (_, index) => notice(index + 1));
    const restored = restoreNoticeInbox([
      { nope: true },
      ...rows.map((row) => ({ ...row, actions: [{ id: `${row.id}-action`, label: "Open" }], actionsLive: true })),
    ]);
    expect(restored).toHaveLength(NOTICE_INBOX_CAP);
    expect(restored[0]?.message).toBe("Attention 1");
    expect(restored.every((row) => row.actionsLive === false && row.read === false)).toBe(true);
  });
});
