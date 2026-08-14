import { describe, expect, it } from "vitest";
import type { ActivityItem } from "@tachyon/webview-ui/activity/activityView";
import {
  DEFAULT_ACTIVITY_FILTERS,
  activityCategory,
  buildSearchIndex,
  filterByActivityTypes,
  filterIndex,
  hiddenByActivityTypes,
  normalizeActivityFilters,
  toggleActivityFilter,
} from "../../packages/webview-ui/src/webview/activity/feedModel.js";

const item = (sequence: number, kind: ActivityItem["kind"], title: string): ActivityItem => ({ sequence, kind, title });

describe("activity feed type filters", () => {
  it("maps render kinds into stable user-facing categories", () => {
    expect(activityCategory("message")).toBe("chat");
    expect(activityCategory("command")).toBe("chat");
    expect(activityCategory("tool")).toBe("tools");
    expect(activityCategory("file")).toBe("tools");
    expect(activityCategory("usage")).toBe("tools");
    expect(activityCategory("error")).toBe("tools");
    expect(activityCategory("nudge")).toBe("system");
    expect(activityCategory("injected")).toBe("system");
    expect(activityCategory("session")).toBe("system");
    expect(activityCategory("boundary")).toBe("system");
    expect(activityCategory("thinking")).toBe("thinking");
    expect(activityCategory("image")).toBe("media");
  });

  it("combines recent search results with enabled type categories", () => {
    const items = [
      item(1, "message", "migration finished"),
      item(2, "tool", "migration command"),
      item(3, "thinking", "migration reasoning"),
      item(4, "nudge", "other system note"),
    ];
    const searched = filterIndex(buildSearchIndex(items), "migration");
    const filters = { ...DEFAULT_ACTIVITY_FILTERS, tools: false, thinking: false };
    expect(filterByActivityTypes(searched, filters).map((it) => it.sequence)).toEqual([1]);
    expect(hiddenByActivityTypes(searched, filters)).toBe(2);
  });

  it("normalizes invalid saved filters and prevents disabling every category", () => {
    expect(normalizeActivityFilters({ chat: false, tools: false, system: false, thinking: false, media: false })).toEqual(DEFAULT_ACTIVITY_FILTERS);
    const onlyChat = { chat: true, tools: false, system: false, thinking: false, media: false };
    expect(toggleActivityFilter(onlyChat, "chat")).toEqual(onlyChat);
  });
});
