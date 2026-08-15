import { describe, expect, it } from "vitest";
import {
  AGENT_NOTICE_LINE_CAP,
  AGENT_SUMMARY_CAP,
  agentSummaryRefusal,
  composeAgentNotice,
  composeBoundedAgentNotice,
  formatNoticePointer,
  prepareAgentSummary,
} from "@tachyon/bridge/notifyAgent.js";
import { truncateByCodePoint } from "@tachyon/engine/utils/truncateByCodePoint.js";
import { truncateFocusText } from "@tachyon/engine/sidebar/agentFocus.js";

/**
 * t-b15872 — a bounded envelope is right; silently eating the tail of a delivery is not.
 *
 * The coordination symptom was recurring on 2026-07-27: completion notices arrived ending in `…`
 * (t-25a908, t-05097f, t-4a4d30) with no way to reach what had been cut. The schema accepted 4000
 * characters and delivery kept 500, so up to 3500 disappeared behind one ellipsis — and an ellipsis
 * is indistinguishable from one the author typed, which is exactly how a truncated delivery reads as
 * a complete one.
 *
 * Measured across the three layers before changing any of them: the Bridge truncated at 500, the
 * sidebar truncated again at 240, and the notice inbox — the only durable one — truncates nothing at
 * all. So the full record already survived; nothing pointed at it.
 */

/** A cut that lands mid-emoji is the case `slice` gets wrong; `\u{1F600}` is two UTF-16 units. */
const wellFormed = (s: string) => !Array.from(s).some((ch) => {
  const cp = ch.codePointAt(0)!;
  return cp >= 0xD800 && cp <= 0xDFFF;
});

describe("t-b15872 — truncation never splits a character", () => {
  it("keeps a surrogate pair whole where the old UTF-16 slice broke it", () => {
    // Position the astral char so a unit-based cut would land INSIDE it.
    const text = `${"x".repeat(AGENT_SUMMARY_CAP - 2)}\u{1F600}${"tail".repeat(200)}`;

    expect(wellFormed(`${text.slice(0, AGENT_SUMMARY_CAP - 1)}…`)).toBe(false); // the old behaviour
    expect(wellFormed(prepareAgentSummary(text))).toBe(true);                    // the new one
  });

  it("holds for every cut position across a run of astral characters", () => {
    // One offset would be a coincidence; the property is that NO boundary can split a pair.
    for (let pad = 0; pad < 8; pad++) {
      const text = `${"x".repeat(AGENT_SUMMARY_CAP - pad)}${"\u{1F600}".repeat(20)}`;
      expect(wellFormed(prepareAgentSummary(text)), `pad=${pad}`).toBe(true);
    }
  });

  it("shortens the sidebar focus label by code point too", () => {
    const label = `${"x".repeat(59)}\u{1F600}more`;
    expect(wellFormed(truncateFocusText(label))).toBe(true);
    expect(Array.from(truncateFocusText(label)).length).toBeLessThanOrEqual(60);
  });
});

describe("t-b15872 — the boundary itself", () => {
  it("delivers exactly at the cap untouched, and marks the first character over", () => {
    const exact = "B".repeat(AGENT_SUMMARY_CAP);
    expect(prepareAgentSummary(exact)).toBe(exact);
    expect(prepareAgentSummary(exact)).not.toContain("…");

    const over = "C".repeat(AGENT_SUMMARY_CAP + 1);
    expect(Array.from(prepareAgentSummary(over)).length).toBeLessThanOrEqual(AGENT_SUMMARY_CAP);
    expect(prepareAgentSummary(over)).toContain("…");
  });

  it("says how much was cut instead of only that something was", () => {
    // The bare `…` was the whole defect: it carries no signal that anything is missing, let alone
    // how much. A reader must be able to tell a truncated line from a terse one.
    const marked = truncateByCodePoint("y".repeat(1000), 100);
    expect(marked).toMatch(/…\[\+\d+ chars\]$/);
    expect(Array.from(marked).length).toBeLessThanOrEqual(100);
  });

  it("stays within the cap even when the marker is nearly the whole budget", () => {
    for (const cap of [12, 20, 40]) {
      expect(Array.from(truncateByCodePoint("z".repeat(500), cap)).length, `cap=${cap}`)
        .toBeLessThanOrEqual(cap);
    }
  });
});

describe("t-b15872 — an oversized delivery is refused, not quietly shortened", () => {
  it("accepts at the cap and refuses one character past it", () => {
    expect(agentSummaryRefusal("B".repeat(AGENT_SUMMARY_CAP))).toBeUndefined();
    expect(agentSummaryRefusal("B".repeat(AGENT_SUMMARY_CAP + 1))).toBeDefined();
  });

  it("measures what WOULD have been delivered, so sanitizing can bring a summary under the cap", () => {
    // Newlines collapse to spaces and controls vanish, so raw length is the wrong thing to judge:
    // a caller must not be refused for characters that were never going to be delivered.
    expect(agentSummaryRefusal(`${"A".repeat(AGENT_SUMMARY_CAP)}\u0000\u0007`)).toBeUndefined();
    expect(agentSummaryRefusal("A".repeat(AGENT_SUMMARY_CAP - 4) + "   \n\n  ")).toBeUndefined();
  });

  it("names the limit, the actual size, and the remedy — not just the rule", () => {
    const refusal = agentSummaryRefusal("D".repeat(1234))!;
    expect(refusal).toContain("1234");
    expect(refusal).toContain(String(AGENT_SUMMARY_CAP));
    expect(refusal).toMatch(/append_task_note|attach_evidence/);
    expect(refusal).toContain("pointer");
  });
});

describe("t-b15872 — the durable pointer reaches the recipient", () => {
  it("rides in the delivered line so the record can be opened without reading the sender's pane", () => {
    const line = composeAgentNotice("worker", "boss", "M8 landed", "t-a31844");
    expect(line).toContain("[details: t-a31844]");
    expect(line.startsWith("[tachyon] worker → boss: M8 landed")).toBe(true);
  });

  it("is sanitized and bounded like every other payload", () => {
    expect(formatNoticePointer("t-abc123\nsecond line")).toBe("[details: t-abc123 second line]");
    expect(Array.from(formatNoticePointer("p".repeat(400))).length).toBeLessThanOrEqual(132);
  });

  it("is omitted entirely when absent, leaving the line as it was", () => {
    expect(composeAgentNotice("a", "b", "done")).toBe("[tachyon] a → b: done");
  });
});

describe("t-b15872 — the delivered LINE is bounded, not only its payload", () => {
  it("bounds an envelope built from unbounded agent names", () => {
    // AGENT_NAME constrains the charset but carries no max length, so the header could grow without
    // limit while the module's own doc claimed "one bounded line".
    const line = composeBoundedAgentNotice("a".repeat(600), "b".repeat(600), "short summary", "t-abc123");
    expect(Array.from(line).length).toBeLessThanOrEqual(AGENT_NOTICE_LINE_CAP);
    expect(wellFormed(line)).toBe(true);
  });

  it("leaves an ordinary notice untouched", () => {
    const line = composeBoundedAgentNotice("worker", "boss", "done", "t-abc123");
    expect(line).toBe("[tachyon] worker → boss: done [details: t-abc123]");
  });
});
