import { describe, expect, it } from "vitest";
import { runtimeProfile } from "@tachyon/shared/runtime/runtimeProfile.js";

describe("t-3fe20f: claude composer prompt matches the measured '❯' glyph", () => {
  it("promptLine matches the measured '❯' glyph, not only ASCII '>'", () => {
    const profile = runtimeProfile("claude");
    // Measured 2026-07-19 against a live tachyon-b349073a-claude pane capture (raw bytes e2 9d af).
    expect(profile?.composer?.promptLine?.test("❯ ")).toBe(true);
    expect(profile?.composer?.promptLine?.test("❯ validei visualmente, problema corrigido")).toBe(true);
  });

  it("occupiedLine matches a drafted '❯' line but not a bare empty one", () => {
    const profile = runtimeProfile("claude");
    expect(profile?.composer?.occupiedLine.test("❯ some draft text")).toBe(true);
    expect(profile?.composer?.occupiedLine.test("❯ ")).toBe(false);
  });

  it("keeps the ASCII '>' prompt matching (superset fix, not a replacement)", () => {
    const profile = runtimeProfile("claude");
    expect(profile?.composer?.promptLine?.test("> ")).toBe(true);
    expect(profile?.composer?.promptLine?.test("> hello")).toBe(true);
    expect(profile?.composer?.occupiedLine.test("> hello")).toBe(true);
    expect(profile?.composer?.occupiedLine.test("> ")).toBe(false);
  });

  it("keeps the optional │/┃ pane-border prefix handling for the '❯' glyph", () => {
    const profile = runtimeProfile("claude");
    expect(profile?.composer?.promptLine?.test("│ ❯ text")).toBe(true);
    expect(profile?.composer?.occupiedLine.test("┃ ❯ text")).toBe(true);
  });

  it("codex-parity: claude's glyph set covers at least what codex's does", () => {
    const claude = runtimeProfile("claude");
    const codex = runtimeProfile("codex");
    const samples = ["❯ ", "❯ hello", "> ", "> hello", "› ", "› hello", "│ ❯ hello", "┃ › hello"];
    for (const sample of samples) {
      if (codex?.composer?.promptLine?.test(sample)) {
        expect(claude?.composer?.promptLine?.test(sample)).toBe(true);
      }
      if (codex?.composer?.occupiedLine.test(sample)) {
        expect(claude?.composer?.occupiedLine.test(sample)).toBe(true);
      }
    }
  });
});
