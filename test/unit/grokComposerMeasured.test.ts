import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { findComposerRegion, stripAnsi } from "@tachyon/shared/runtime/composerRegion.js";
import { runtimeProfile } from "@tachyon/shared/runtime/runtimeProfile.js";

/**
 * t-aafa10 — the Grok composer, measured instead of assumed.
 *
 * The profile shipped `source: "assumed"` with a Claude/Codex-shaped guess and an explicit note that
 * the real prompt shape still needed measurement. These fixtures ARE that measurement: real
 * `capture-pane` output from `grok 0.2.112` driven in a real tmux pane, one file per state. They are
 * bytes, not a description of bytes, so a future Grok release that moves the composer fails here
 * rather than silently degrading pane-injection safety.
 *
 * What the fixtures cover, and what they deliberately do not: empty, human draft, the pane right
 * after a turn ended, and a draft typed after a turn. The MID-TURN render is absent because
 * producing it needs a real model call, and the measurement ran without a usable credential — see
 * the runtime profile note and `docs/runtimes/parity.md`. That gap is named, not papered over.
 */

const FIXTURES = path.resolve(__dirname, "../fixtures/grok-composer");
const pane = (name: string): string[] =>
  fs.readFileSync(path.join(FIXTURES, `${name}.pane.txt`), "utf8").split("\n");

const composer = runtimeProfile("grok")!.composer!;

/** Exactly what `AttentionMonitor` asks: does a human own this composer right now? */
function occupied(lines: string[]): boolean {
  const region = findComposerRegion(lines, composer);
  if (!region) return true; // no region found is the fail-closed answer production also uses
  return lines.slice(region.start, region.end).some((line) => composer.occupiedLine!.test(stripAnsi(line)));
}

describe("Grok composer — measured against grok 0.2.112 (t-aafa10)", () => {
  it("resolves a composer region in every measured state", () => {
    for (const state of ["empty", "typed", "post-turn", "typed-after-turn"]) {
      expect(findComposerRegion(pane(state), composer), state).not.toBeNull();
    }
  });

  it("reads an empty composer as free, and a typed draft as owned by the human", () => {
    expect(occupied(pane("empty"))).toBe(false);
    expect(occupied(pane("typed"))).toBe(true);
  });

  it("returns to free after a turn ends — Grok leaves no suggestion text behind", () => {
    // The submitted line moves OUT of the composer into the transcript and the composer is empty
    // again. This is the state that would silently block every later injection if Grok rendered a
    // placeholder there, and it is why `ansiEmptyContentStyle` stays undeclared for this runtime.
    expect(occupied(pane("post-turn"))).toBe(false);
    expect(occupied(pane("typed-after-turn"))).toBe(true);
  });

  it("is not fooled by the transcript echoing a submitted prompt with the same glyph", () => {
    // Grok echoes the submitted prompt into its transcript as `❯ <text>`, which matches promptLine
    // exactly as the real composer does. Two measured facts keep that from reading as a draft: the
    // composer box is pinned to the BOTTOM of the pane, and `findComposerRegion` scans upward from
    // the bottom — so the echo can never be the match that wins.
    const lines = pane("post-turn");
    const echoes = lines.filter((line) => composer.promptLine!.test(stripAnsi(line)));
    expect(echoes.length).toBeGreaterThan(1); // the echo AND the composer both match
    const region = findComposerRegion(lines, composer)!;
    expect(stripAnsi(lines[region.start]!)).toContain("│ ❯"); // the boxed composer, not the echo
    expect(occupied(lines)).toBe(false);
  });

  it("stays free while a turn is actually streaming (t-d2a4dc)", () => {
    // The gap t-aafa10 could not close: a mid-turn pane needed a live model call. Measured against a
    // real canonical Grok agent — the composer box is still rendered and still EMPTY while the model
    // streams, so the guard does not false-positive and block injection for the length of a turn.
    // 20 consecutive live samples agreed; these are the bytes from the streaming one.
    const lines = pane("mid-turn");
    expect(findComposerRegion(lines, composer)).not.toBeNull();
    expect(occupied(lines)).toBe(false);
    // The streaming signal itself, so a release that drops it is visible here rather than silently
    // costing Attention its only mid-turn evidence.
    const flat = lines.map(stripAnsi).join("\n");
    expect(flat).toMatch(/Waiting for response/);
    expect(flat).toMatch(/Esc:cancel/);
  });

  it("keeps the measured evidence attached to the profile", () => {
    expect(composer.source).toBe("measured");
    expect(composer.verified).toBe(true);
    expect(composer.verifiedAt).toBe("2026-07-28");
  });
});
