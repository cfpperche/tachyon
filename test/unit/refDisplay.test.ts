import { describe, expect, it } from "vitest";
import { REF_DISPLAY_MAX, middleTruncate, refDisplay } from "../../src/webview/task-detail/refDisplay.js";

/**
 * `t-5564b4` — a long artifact ref must be readable at both ends and must never widen its container.
 *
 * The route showed refs inside `.ds-badge`, which is `white-space: nowrap`, so a sha256 or an absolute
 * path made the badge as wide as the string and pushed a horizontal scrollbar onto the whole page.
 * Truncating in the MIDDLE is what keeps the two ends that identify a ref — a sha by its head, a path
 * by its tail — and doing it in the string rather than in CSS is what makes it assertable here.
 */

describe("t-5564b4 — middle truncation", () => {
  it("leaves a value that already fits completely alone", () => {
    expect(middleTruncate("t-50bbd4", 48)).toBe("t-50bbd4");
    expect(middleTruncate("", 48)).toBe("");
  });

  it("keeps both ends of a commit sha, which is how one is recognised", () => {
    const sha = "76546c4d9ca35d925485e1800946d8516f0fe8a7"; // 40 chars
    const shown = middleTruncate(sha, 20);
    expect(shown).toHaveLength(20);
    expect(shown.startsWith("76546c4d9c")).toBe(true);
    expect(shown.endsWith("6f0fe8a7")).toBe(true);
    expect(shown).toContain("…");
  });

  it("keeps the tail of a path, where the filename lives", () => {
    const p = "/home/goat/.cache/tachyon/worktrees/b349073a/claude-opus5-4/src/webview/task-detail/task-detail.css";
    const shown = middleTruncate(p, REF_DISPLAY_MAX);
    expect(shown).toHaveLength(REF_DISPLAY_MAX);
    expect(shown.endsWith("task-detail.css")).toBe(true);
  });

  it("never exceeds the budget, for any length at any budget", () => {
    // The property that matters for layout: the painted string cannot be wider than asked, ever.
    for (const max of [2, 3, 8, 17, 48]) {
      for (const length of [0, 1, 2, 7, 40, 41, 200]) {
        expect(middleTruncate("x".repeat(length), max).length).toBeLessThanOrEqual(Math.max(max, 0));
      }
    }
  });

  it("degenerates safely instead of producing nonsense at a tiny budget", () => {
    expect(middleTruncate("abcdef", 2)).toBe("a…");
    expect(middleTruncate("abcdef", 1)).toBe("…");
    expect(middleTruncate("a", 1)).toBe("a");
  });

  it("reports the full value and whether anything was hidden, so the tooltip is never a lie", () => {
    const short = refDisplay("t-50bbd4");
    expect(short).toEqual({ text: "t-50bbd4", full: "t-50bbd4", truncated: false });

    const long = refDisplay("https://github.com/architecture-decision-record/architecture-decision-record/blob/main/README.md");
    expect(long.truncated).toBe(true);
    expect(long.full).toContain("README.md");
    expect(long.text.length).toBeLessThanOrEqual(REF_DISPLAY_MAX);
  });
});
