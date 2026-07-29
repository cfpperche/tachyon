import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { attentionRows, type AttentionRow } from "../../src/sidebar/attentionStack.js";
import { SAMPLE, type FleetVM, type NoticeVM } from "../../src/sidebar/types.js";
import { NOTICE_INBOX_CAP, restoreNoticeInbox } from "../../src/workspace/noticeInbox.js";

function notice(index: number, workspace = "a"): NoticeVM {
  return {
    id: `00000000-0000-4000-${workspace === "a" ? "8" : "9"}000-${String(index).padStart(12, "0")}`,
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
  // t-fde5b6 — the panel used to render six rows and report the rest as `+N queued`, a second state
  // the human had to drain. Every open item is now handed to the list; the panel's height and scroll
  // are unchanged because the CSS container was already bounded and scrollable.
  it("renders a burst well past the old six-row cap, in emission order", () => {
    const burst = Array.from({ length: 25 }, (_, index) => notice(index + 1));

    const rows = attentionRows([fleet(burst)]);

    expect(rows).toHaveLength(25);
    expect(rows.map((row) => row.n.message)).toEqual(burst.map((row) => row.message));
  });

  it("keeps an item emitted after the burst, without draining anything first", () => {
    const burst = Array.from({ length: 9 }, (_, index) => notice(index + 1));

    const rows = attentionRows([fleet([...burst, notice(10)])]);

    expect(rows.at(-1)?.n.message).toBe("Attention 10");
    expect(rows).toHaveLength(10);
  });

  it("dismisses one item without reordering or promoting anything", () => {
    const notices = Array.from({ length: 9 }, (_, index) => notice(index + 1));
    const before = attentionRows([fleet(notices)]);
    const dismissed = before[2]!.n.id;

    const after = attentionRows([fleet(notices.filter((row) => row.id !== dismissed))]);

    expect(before.map((row) => row.n.message)).toContain("Attention 9");
    expect(after.map((row) => row.n.message)).toEqual([
      "Attention 1", "Attention 2", "Attention 4", "Attention 5",
      "Attention 6", "Attention 7", "Attention 8", "Attention 9",
    ]);
  });

  it("clears globally by marking every open item read", () => {
    const notices = Array.from({ length: 9 }, (_, index) => notice(index + 1));

    expect(attentionRows([fleet(notices)])).toHaveLength(9);
    expect(attentionRows([fleet(notices.map((row) => ({ ...row, read: true })))])).toEqual([]);
  });

  it("survives reload: a restored inbox renders every row it restored", () => {
    const persisted = Array.from({ length: 12 }, (_, index) => notice(index + 1));
    const restored = restoreNoticeInbox(persisted);

    const rows = attentionRows([fleet(restored)]);

    expect(rows).toHaveLength(restored.length);
    expect(rows.map((row) => row.n.message)).toEqual(restored.map((row) => row.message));
  });

  it("keeps deduplication intact — a collapsed item is still one row", () => {
    const collapsed: NoticeVM = { ...notice(1), collapsedCount: 4 };

    const rows = attentionRows([fleet([collapsed, notice(2)])]);

    expect(rows).toHaveLength(2);
    expect(rows[0]?.n.collapsedCount).toBe(4);
  });

  it("merges multi-root attention into deterministic global FIFO order", () => {
    const alpha = fleet([notice(1, "a"), notice(3, "a")]);
    const beta = { ...fleet([notice(2, "b")]), folder: { hash: "b", name: "Beta" } };
    expect(attentionRows([beta, alpha]).map((row: AttentionRow) => row.n.message)).toEqual([
      "Attention 1", "Attention 2", "Attention 3",
    ]);
  });

  it("leaves no `queued` surface behind", () => {
    // Structural: a behavioural test cannot see a counter that is only ever rendered.
    const root = path.resolve(__dirname, "..", "..");
    const app = fs.readFileSync(path.join(root, "src/webview/sidebar/App.tsx"), "utf8");
    const css = fs.readFileSync(path.join(root, "src/webview/sidebar/sidebar.css"), "utf8");
    const stack = fs.readFileSync(path.join(root, "src/sidebar/attentionStack.ts"), "utf8");

    expect(app).not.toContain("attention-queued");
    expect(app).not.toContain("queued");
    expect(css).not.toContain("attention-queued");
    expect(stack.replace(/\/\*[\s\S]*?\*\//g, "")).not.toContain("queued");
  });

  it("keeps the Attentions-tab panel scrollable (t-37f554 — no permanent max-height above Agents)", () => {
    const css = fs.readFileSync(path.resolve(__dirname, "..", "..", "src/webview/sidebar/sidebar.css"), "utf8");
    // Stack lives inside the tab panel and fills it; the list remains the scroll surface.
    expect(css).toContain(".panel .attention-stack");
    expect(css).toMatch(/\.panel \.attention-stack[\s\S]*?overflow:\s*hidden/);
    const listRule = css.split("\n").find((line) => line.includes(".attention-list {")) ?? "";
    expect(listRule).toContain("overflow: auto");
    expect(listRule).toContain("min-height: 0");
  });

  it("restores only validated bounded rows and never restores executable callbacks", () => {
    const rows = Array.from({ length: NOTICE_INBOX_CAP + 5 }, (_, index) => notice(index + 1));
    const restored = restoreNoticeInbox([
      { nope: true },
      ...rows.map((row, index) => ({
        ...row,
        actions: [{ id: `10000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`, label: "Open" }],
        actionsLive: true,
      })),
    ]);
    expect(restored).toHaveLength(NOTICE_INBOX_CAP);
    expect(restored[0]?.message).toBe("Attention 1");
    expect(restored.every((row) => row.actionsLive === false && row.read === false)).toBe(true);
  });
});
