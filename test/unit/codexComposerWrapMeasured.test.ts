import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { composeBoundedAgentNotice } from "@tachyon/bridge/notifyAgent.js";
import { classifyComposerSubmission, composerText, isComposerOccupied } from "@tachyon/shared/runtime/composerRegion.js";
import { runtimeProfile } from "@tachyon/shared/runtime/runtimeProfile.js";

/**
 * t-7a297f — the Codex composer wraps, and the wrap used to make every submit report success.
 *
 * `incident-wrapped-staged.pane.txt` is not a constructed example: it is the pane of the `grokauth`
 * agent on 2026-08-09, holding the 433-char notice that was typed into it and never submitted, while
 * `notify_agent` answered `notified`. `incident-summary.txt` is that notice's summary, straight from
 * the doorbell log, so the test composes the delivered line through the real bridge composer instead
 * of a transcription of it.
 *
 * The other four panes are `capture-pane` output from codex-cli 0.146.1 driven in a real 220-column
 * tmux pane through the SAME gesture production uses (load-buffer + bracketed paste + `C-m`).
 *
 * The failure this pins is a false POSITIVE about delivery: before `continuationLine` the reader saw
 * only the first rendered row, so a wrapped draft never matched what we typed and `cleared` — the one
 * proof of delivery the product accepts — came back for a pane that still held the text. Same verdict
 * for opposite realities, which is why the assertions below are paired: the staged pane and the
 * submitted pane must disagree.
 */

const FIXTURES = path.resolve(__dirname, "../fixtures/codex-composer");
const read = (name: string): string => fs.readFileSync(path.join(FIXTURES, name), "utf8").replace(/\s+$/, "");

const codex = runtimeProfile("codex")!.composer!;
const opencode = runtimeProfile("opencode")!.composer!;

const incidentPane = read("incident-wrapped-staged.pane.txt");
const incidentLine = composeBoundedAgentNotice("claude", "grokauth", read("incident-summary.txt"), "t-5dcf47");
const wrappedPane = read("wrapped-staged.pane.txt");
const wrappedText = read("wrapped-staged.text.txt");
const shortPane = read("short-staged.pane.txt");
const shortText = read("short-staged.text.txt");
const submittedPane = read("submitted-mid-turn.pane.txt");
const emptyPane = read("empty-after-turn.pane.txt");

describe("Codex composer wrap — measured on codex-cli 0.146.1 (t-7a297f)", () => {
  it("reads back the whole wrapped draft, not just the first rendered row", () => {
    // 433 chars typed, rendered over four rows; the pre-fix reader recovered 120.
    expect(incidentLine.length).toBe(433);
    expect(composerText(incidentPane, codex)).toBe(incidentLine);
    expect(composerText(wrappedPane, codex)).toBe(wrappedText);
  });

  it("stops the draft at the runtime's own status furniture", () => {
    // The furniture below the composer is indented exactly like a continuation row; only the blank
    // line between them separates the two, which is what the consecutive-run rule keys on.
    expect(composerText(wrappedPane, codex)).not.toContain("gpt-5.6-sol default");
    expect(composerText(emptyPane, codex)).not.toContain("gpt-5.6-sol default");
  });

  it("tells a staged wrapped line apart from a submitted one — the whole defect, both directions", () => {
    // The incident: the pane STILL HELD the notice. This is the assertion that was `cleared`.
    expect(classifyComposerSubmission(incidentPane, codex, incidentLine)).toBe("holds-text");
    expect(classifyComposerSubmission(wrappedPane, codex, wrappedText)).toBe("holds-text");
    // Same runtime, same profile, 200ms later: the Enter landed and the composer is back to its
    // placeholder. `cleared` here has to survive the fix, or the retry loop never terminates.
    expect(classifyComposerSubmission(submittedPane, codex, wrappedText)).toBe("cleared");
  });

  it("keeps working for a draft that never wrapped", () => {
    expect(composerText(shortPane, codex)).toBe(shortText);
    expect(classifyComposerSubmission(shortPane, codex, shortText)).toBe("holds-text");
  });

  it("reaches `diverged` for wrapped content — the state that protects a human's draft", () => {
    // Our line plus something else in the same region: pressing Enter would submit the other text.
    // The span deliberately CROSSES the wrap boundary (the first rendered row ends at 215 chars), so
    // it is only findable once the rows are rejoined — before the fix this same call said `cleared`.
    const ours = wrappedText.slice(150, 280);
    expect(ours.length).toBeGreaterThan(0);
    expect(classifyComposerSubmission(wrappedPane, codex, ours)).toBe("diverged");
  });

  it("does not change what the human-draft guard answers", () => {
    // Pinned to the values measured on these exact bytes BEFORE `continuationLine` existed. The fix
    // is allowed to teach the reader to read; it is not allowed to move the guard.
    expect(isComposerOccupied(incidentPane, codex)).toBe(true);
    expect(isComposerOccupied(wrappedPane, codex)).toBe(true);
    expect(isComposerOccupied(shortPane, codex)).toBe(true);
    expect(isComposerOccupied(submittedPane, codex)).toBe(true);
    // The only unoccupied state, and only through an escaped capture: the dim placeholder.
    expect(isComposerOccupied(emptyPane, codex)).toBe(false);
  });

  it("does not leak the Codex rule into a runtime that has not been measured", () => {
    // OpenCode declares no `continuationLine`, so it must keep the first-row-only reading it had —
    // a wrap rule is per-runtime and measured, never inherited by shape similarity.
    expect(opencode.continuationLine).toBeUndefined();
    const seen = composerText(wrappedPane, opencode);
    expect(seen).not.toBe(wrappedText);
    expect(wrappedText.startsWith(seen!)).toBe(true);
  });
});
