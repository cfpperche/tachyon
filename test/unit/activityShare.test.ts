import { describe, expect, it } from "vitest";
import type { ActivityItem, ActivityViewModel } from "../../src/activity/activityView.js";
import {
  SHARE_TEXT_CAP,
  SHARE_URL_TEXT_CAP,
  activitySharePayload,
  internalSharePrompt,
  internalShareTargets,
  resolveActivityShare,
  withActivityShareKeys,
} from "../../src/activity/activityShare.js";
import type { AgentVM } from "../../src/sidebar/types.js";

const baseSummary = {
  messages: 0,
  toolsRunning: 0,
  toolsFailed: 0,
  filesChanged: [],
  filesReferenced: [],
  tokens: { input: 0, output: 0 },
};

function vm(items: ActivityItem[]): ActivityViewModel {
  return { tier: "structured", summary: baseSummary, items };
}

describe("activity share helpers", () => {
  it("formats a bounded payload with provenance for a text-bearing item", () => {
    const item: ActivityItem = {
      sequence: 7,
      kind: "message",
      role: "agent",
      title: "Implemented the fix.",
      timestamp: "2026-07-02T12:00:00Z",
    };

    const payload = activitySharePayload("codex", item);

    expect(payload?.text).toContain("Tachyon Activity");
    expect(payload?.text).toContain("Source agent: codex");
    expect(payload?.text).toContain("Item: message (agent)");
    expect(payload?.text).toContain("Timestamp: 2026-07-02T12:00:00Z");
    expect(payload?.text).toContain("Implemented the fix.");
    expect(payload?.key).toMatch(/^s_/);
  });

  it("does not share unsupported or empty items", () => {
    expect(activitySharePayload("codex", { sequence: 1, kind: "image", title: "screenshot", imageId: "img_1" })).toBeUndefined();
    expect(activitySharePayload("codex", { sequence: 2, kind: "tool", title: "   " })).toBeUndefined();
  });

  it("adds share keys only to shareable rendered items", () => {
    const model = withActivityShareKeys("codex", vm([
      { sequence: 1, kind: "message", role: "user", title: "hello" },
      { sequence: 2, kind: "image", role: "user", title: "screenshot", imageId: "img_1" },
    ]));

    expect(model.items[0].shareKey).toMatch(/^s_/);
    expect(model.items[1].shareKey).toBeUndefined();
  });

  it("refuses stale sequence/key pairs instead of resolving a changed item", () => {
    const item: ActivityItem = { sequence: 3, kind: "message", role: "user", title: "original" };
    const key = activitySharePayload("codex", item)!.key;

    expect(resolveActivityShare("codex", vm([item]), 3, key)).toMatchObject({ ok: true });
    expect(resolveActivityShare("codex", vm([{ ...item, title: "edited" }]), 3, key)).toEqual({ ok: false, reason: "stale" });
    expect(resolveActivityShare("codex", vm([item]), 4, key)).toEqual({ ok: false, reason: "stale" });
    expect(resolveActivityShare("codex", vm([item]), "3", key)).toEqual({ ok: false, reason: "invalid" });
  });

  it("caps full and URL share text independently", () => {
    const payload = activitySharePayload("codex", {
      sequence: 1,
      kind: "message",
      role: "agent",
      title: "x".repeat(SHARE_TEXT_CAP + 200),
    })!;

    expect(payload.truncated).toBe(true);
    expect(payload.text.length).toBeLessThanOrEqual(SHARE_TEXT_CAP + "\n\n[truncated]".length);
    expect(payload.urlText.length).toBeLessThanOrEqual(SHARE_URL_TEXT_CAP + "\n\n[truncated]\n\n[truncated for URL share; use Copy for the full bounded payload]".length);
    expect(payload.urlText).toContain("truncated for URL share");
  });

  it("builds internal prompts without literal newlines so paste does not submit", () => {
    const prompt = internalSharePrompt({
      key: "s_1",
      text: "line one\nline two\r\nline three",
      urlText: "line one",
      truncated: false,
    });

    expect(prompt).toContain("line one\\nline two\\nline three");
    expect(prompt).not.toMatch(/\r|\n/);
  });

  it("lists only other live AI agents as internal share targets", () => {
    const agents: AgentVM[] = [
      { name: "codex", status: "running", ai: true },
      { name: "claude", status: "running", ai: true },
      { name: "review", status: "throttled", ai: true },
      { name: "shell", status: "running", ai: false },
      { name: "stopped", status: "stopped", ai: true },
      { name: "crashed", status: "crashed", ai: true },
      { name: "stopping", status: "stopping", ai: true },
    ];

    expect(internalShareTargets(agents, "codex")).toEqual([
      { name: "claude", label: "claude" },
      { name: "review", label: "review (throttled)" },
    ]);
  });
});
