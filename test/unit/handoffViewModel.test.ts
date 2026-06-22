import { describe, it, expect } from "vitest";
import { stalenessLabel, noteGlyph, relativeTime } from "../../src/webview/handoff/handoffViewModel.js";

// spec 245 inc D — the PURE Project Handoff view-model helpers (the CI-covered part; the Preact render + the
// panel host plumbing are EDH-validated). "logic in the vscode layer escapes CI" → these stay outside it.

describe("handoffViewModel — stalenessLabel (spec 245)", () => {
  it("maps each of the four states to {glyph, label, tone}", () => {
    expect(stalenessLabel("fresh")).toEqual({ glyph: "○", label: "Fresh", tone: "muted" });
    expect(stalenessLabel("needs_distill")).toEqual({ glyph: "◆", label: "Needs distill", tone: "warn" });
    expect(stalenessLabel("possibly_stale")).toEqual({ glyph: "◷", label: "Possibly stale", tone: "info" });
    expect(stalenessLabel("old")).toEqual({ glyph: "✗", label: "Old", tone: "err" });
  });

  it("falls back to Fresh for an unexpected state", () => {
    // defensive: an out-of-band value (shouldn't happen via the typed engine) reads as fresh, never throws.
    expect(stalenessLabel("bogus" as never)).toEqual({ glyph: "○", label: "Fresh", tone: "muted" });
  });
});

describe("handoffViewModel — noteGlyph (spec 245)", () => {
  it("maps every kind to its glyph", () => {
    expect(noteGlyph("completed")).toBe("✓");
    expect(noteGlyph("blocked")).toBe("⊘");
    expect(noteGlyph("decision")).toBe("◆");
    expect(noteGlyph("gotcha")).toBe("⚠");
    expect(noteGlyph("next")).toBe("→");
  });

  it("coerces an unknown kind to the 'next' arrow", () => {
    expect(noteGlyph("whatever")).toBe("→");
    expect(noteGlyph("")).toBe("→");
  });
});

describe("handoffViewModel — relativeTime (spec 245)", () => {
  const now = new Date("2026-06-22T12:00:00Z");

  it("renders sub-minute as 'just now'", () => {
    expect(relativeTime("2026-06-22T11:59:30Z", now)).toBe("just now");
    expect(relativeTime("2026-06-22T12:00:00Z", now)).toBe("just now");
  });

  it("renders minutes / hours / days", () => {
    expect(relativeTime("2026-06-22T11:55:00Z", now)).toBe("5m ago");
    expect(relativeTime("2026-06-22T09:00:00Z", now)).toBe("3h ago");
    expect(relativeTime("2026-06-20T12:00:00Z", now)).toBe("2d ago");
  });

  it("treats a clock-skewed future stamp as 'just now', never negative", () => {
    expect(relativeTime("2026-06-22T12:05:00Z", now)).toBe("just now");
  });

  it("returns '' for empty / unparseable input", () => {
    expect(relativeTime("", now)).toBe("");
    expect(relativeTime("not-a-date", now)).toBe("");
  });
});
