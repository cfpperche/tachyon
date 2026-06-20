import { describe, it, expect } from "vitest";
import type { ActivityItem } from "../../src/activity/activityView.js";
import { buildSearchIndex, filterIndex, isCapped, tailFromSequence, SEARCH_BODY_CAP, TAIL_LIVE } from "../../src/webview/activity/feedModel.js";

const item = (seq: number, over: Partial<ActivityItem> = {}): ActivityItem => ({ sequence: seq, kind: "message", role: "agent", title: `msg ${seq}`, ...over });

describe("feedModel (spec 238 perf + Tier 2)", () => {
  describe("search index + filter (inc 3)", () => {
    it("matches case-insensitively across title/detail/result/resultFull", () => {
      const items = [
        item(1, { title: "Hello WORLD" }),
        item(2, { kind: "tool", title: "Bash", detail: "npm RUN test" }),
        item(3, { kind: "tool", title: "Edit", result: "+2 −1 in Server.ts" }),
        item(4, { kind: "tool", title: "Read", resultFull: "export function handler() {}" }),
      ];
      const idx = buildSearchIndex(items);
      expect(filterIndex(idx, "world").map((i) => i.sequence)).toEqual([1]);
      expect(filterIndex(idx, "RUN").map((i) => i.sequence)).toEqual([2]); // detail, case-insensitive
      expect(filterIndex(idx, "server.ts").map((i) => i.sequence)).toEqual([3]); // result
      expect(filterIndex(idx, "handler").map((i) => i.sequence)).toEqual([4]); // resultFull
    });

    it("an empty/whitespace query returns every item (no filtering)", () => {
      const idx = buildSearchIndex([item(1), item(2), item(3)]);
      expect(filterIndex(idx, "").map((i) => i.sequence)).toEqual([1, 2, 3]);
      expect(filterIndex(idx, "   ").map((i) => i.sequence)).toEqual([1, 2, 3]);
    });

    it("caps a huge tool body at SEARCH_BODY_CAP so search stays bounded (MAJOR fold)", () => {
      const big = "a".repeat(10_000) + "NEEDLE";
      const idx = buildSearchIndex([item(1, { kind: "tool", title: "Read", resultFull: big })]);
      expect(idx[0].hay.length).toBeLessThan(SEARCH_BODY_CAP + 100); // title/detail/result prefix only
      expect(filterIndex(idx, "needle")).toHaveLength(0); // the needle past the cap is NOT indexed
    });
  });

  describe("content-visibility tail boundary (inc 2)", () => {
    it("returns -Infinity when there are TAIL_LIVE or fewer items (whole feed is live)", () => {
      expect(tailFromSequence([item(1), item(2)])).toBe(-Infinity);
      const exactly = Array.from({ length: TAIL_LIVE }, (_, i) => item(i + 1));
      expect(tailFromSequence(exactly)).toBe(-Infinity);
    });

    it("excludes exactly TAIL_LIVE items from content-visibility, in sequence space", () => {
      const items = Array.from({ length: TAIL_LIVE + 5 }, (_, i) => item((i + 1) * 10)); // sequences 10,20,...
      const threshold = tailFromSequence(items);
      const live = items.filter((it) => it.sequence >= threshold);
      const cv = items.filter((it) => it.sequence < threshold);
      expect(live).toHaveLength(TAIL_LIVE);
      expect(cv).toHaveLength(5);
      // sequence-based, so it is independent of any interleaved (non-item) day separators in the render list
      expect(threshold).toBe(items[items.length - TAIL_LIVE].sequence);
    });
  });

  describe("cap notice condition (inc 1)", () => {
    it("is true only when the host trimmed items AND no search is active", () => {
      expect(isCapped(1000, 600, "")).toBe(true);
      expect(isCapped(1000, 600, "needle")).toBe(false); // suppressed during search
      expect(isCapped(600, 600, "")).toBe(false); // nothing trimmed
      expect(isCapped(undefined, 600, "")).toBe(false); // no total reported
    });
  });
});
