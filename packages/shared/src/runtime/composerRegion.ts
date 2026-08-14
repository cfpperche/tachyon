import { runtimeOf } from "../resume/adapters.js";
import { runtimeProfile, type ComposerRegionProfile } from "./runtimeProfile.js";

/**
 * The runtime composer reader. Every rule here was MEASURED against a live pane and carries the task
 * that measured it; none of it keys on what a message SAYS.
 *
 * t-8d190f moved these out of AttentionMonitor (where they were module-private) so submission
 * confirmation can share the same authority instead of growing a second, drifting copy. Attention asks
 * "does a human own this composer?"; submit asks "did my line leave it?" — one region reader, two
 * questions. Duplicating it would mean a runtime measured once but fixed twice.
 */

const ANSI_SGR_RE = /\x1b\[([0-9;]*)m/g;
const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

/**
 * The measured composer profile for a launch command, or undefined when the runtime is unknown or
 * has none declared. Callers that get undefined must degrade honestly rather than assume a shape:
 * an undeclared runtime is exactly where a guessed composer would do damage.
 */
export function composerProfileFor(cmd: string | null | undefined): ComposerRegionProfile | undefined {
  if (!cmd) return undefined;
  const runtime = runtimeOf(cmd);
  return runtime ? runtimeProfile(runtime)?.composer : undefined;
}

export function isChangeConfinedToComposer(previous: string, next: string, composer: ComposerRegionProfile): boolean {
  const previousLines = previous.split("\n");
  const nextLines = next.split("\n");
  const previousRegion = findComposerRegion(previousLines, composer);
  const nextRegion = findComposerRegion(nextLines, composer);
  if (!previousRegion || !nextRegion) return false;

  return linesEqual(previousLines.slice(0, previousRegion.start), nextLines.slice(0, nextRegion.start))
    && linesEqual(previousLines.slice(previousRegion.end), nextLines.slice(nextRegion.end));
}

export function findComposerRegion(lines: string[], composer: ComposerRegionProfile): { start: number; end: number } | null {
  const first = Math.max(0, lines.length - composer.tailLines);
  if (composer.frameLine) {
    const frames: number[] = [];
    for (let i = first; i < lines.length; i++) if (composer.frameLine.test(stripAnsi(lines[i]))) frames.push(i);
    if (frames.length < 2) return null;
    const bottom = frames.at(-1)!;
    const top = frames.at(-2)!;
    return top < bottom ? { start: top + 1, end: bottom } : null;
  }
  if (composer.promptLine) {
    for (let i = lines.length - 1; i >= first; i--) {
      const plain = stripAnsi(lines[i]);
      if (!composer.promptLine.test(plain)) continue;
      // t-6ffa13 — a runtime that echoes submitted messages back into its transcript renders them
      // with the prompt glyph too, so `promptLine` alone cannot tell the editor from its own
      // history. Skipping the echo matters because the echo is usually TACHYON'S OWN notice:
      // notify_agent submits a line, the runtime echoes it, the echo is read as a human draft, and
      // every later notify_agent/write_input to that agent is queued or refused — a loop Tachyon
      // feeds itself, and one a quiet pane never leaves, because occupancy is only recomputed when
      // the pane content changes.
      if (composer.ansiHistoryEchoStyle === "prompt-background" && promptGlyphHasBackground(lines[i], plain)) continue;
      return { start: i, end: lines.length };
    }
  }
  return null;
}

export function isComposerOccupied(content: string, composer: ComposerRegionProfile): boolean {
  const lines = content.split("\n");
  const region = findComposerRegion(lines, composer);
  return (
    region !== null &&
    lines.slice(region.start, region.end).some((line) => {
      const plainLine = stripAnsi(line);
      if (!composer.occupiedLine.test(plainLine)) return false;
      return composer.ansiEmptyContentStyle === "all-dim" ? !hasOnlyDimComposerContent(line, plainLine) : true;
    })
  );
}

/**
 * t-6ffa13 — is this prompt glyph painted with a background colour? That is how the runtime renders
 * a message it has ALREADY accepted, echoed into its transcript; the live editor carries none.
 * Absent styling (a plain capture) yields false, so the caller keeps treating the line as the
 * composer and stays conservative.
 */
function promptGlyphHasBackground(rawLine: string, plainLine = stripAnsi(rawLine)): boolean {
  const prompt = /(?:❯|>|›)/.exec(plainLine);
  if (!prompt) return false;
  return visibleCharsWithStyle(rawLine)[prompt.index]?.bg === true;
}

function hasOnlyDimComposerContent(rawLine: string, plainLine = stripAnsi(rawLine)): boolean {
  const prompt = /(?:❯|>|›)\s?/.exec(plainLine);
  if (!prompt) return false;
  const contentStart = prompt.index + prompt[0].length;
  const styled = visibleCharsWithStyle(rawLine);
  const content = styled.slice(contentStart).filter((ch) => /\S/.test(ch.char));
  return content.length > 0 && content.every((ch) => ch.dim);
}

function visibleCharsWithStyle(text: string): Array<{ char: string; dim: boolean; bg: boolean }> {
  const chars: Array<{ char: string; dim: boolean; bg: boolean }> = [];
  let dim = false;
  let bg = false;
  let index = 0;
  for (const match of text.matchAll(ANSI_SGR_RE)) {
    for (const char of text.slice(index, match.index).replace(ANSI_RE, "")) chars.push({ char, dim, bg });
    const codes = (match[1] || "0").split(";").map((code) => (code === "" ? 0 : Number.parseInt(code, 10)));
    // t-3eaa8b — walk the parameters instead of scanning them as a set. SGR 38/48/58 carry an
    // extended colour whose SUB-parameters are ordinary numbers, so `38;2;r;g;b` (truecolor)
    // contains a literal 2 that a set-scan reads as "dim". Measured on grok 0.2.112, whose composer
    // is truecolor: a human's typed draft came out entirely "dim" and the composer therefore read as
    // EMPTY — the dangerous direction, since that is what lets injection overwrite typed text.
    for (let i = 0; i < codes.length; i++) {
      const code = codes[i]!;
      if (code === 38 || code === 48 || code === 58) {
        // 5;<n> = 256-colour, 2;<r>;<g>;<b> = truecolor. Anything else: stop trusting this run.
        const mode = codes[i + 1];
        // Only a WELL-FORMED extended colour counts as a background. A malformed run must not claim
        // one, because a claimed background is what dismisses a line as history (t-6ffa13).
        if (code === 48 && (mode === 5 || mode === 2)) bg = true;
        if (mode === 5) i += 2;
        else if (mode === 2) i += 4;
        else i = codes.length;
        continue;
      }
      if (code === 0) { dim = false; bg = false; }
      else if (code === 2) dim = true;
      else if (code === 22) dim = false;
      else if (code === 49) bg = false;
      else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) bg = true;
    }
    index = match.index + match[0].length;
  }
  for (const char of text.slice(index).replace(ANSI_RE, "")) chars.push({ char, dim, bg });
  return chars;
}

function collapseSpace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function linesEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((line, i) => line === b[i]);
}

/** Leading box border + prompt glyph + its separator. The separator is U+00A0 in Claude's live
 *  editor (t-6ffa13 measured it), which `\s` already covers — do not narrow this to a plain space. */
const COMPOSER_LINE_PREFIX = /^\s*(?:[│┃]\s*)?(?:❯|>|›)\s?/u;
/** Trailing box border of a framed editor. */
const COMPOSER_LINE_SUFFIX = /\s*[│┃]\s*$/u;

/**
 * The text a human (or Tachyon) currently has staged in the editable region — furniture excluded.
 * Only lines the profile calls `occupiedLine` count, because a prompt-glyph region runs to the bottom
 * of the pane and therefore swallows the runtime's status furniture ("⏵⏵ auto mode on", token
 * counters) that is never part of the draft.
 */
export function composerText(content: string, composer: ComposerRegionProfile): string | null {
  const lines = content.split("\n");
  const region = findComposerRegion(lines, composer);
  if (!region) return null;
  const rows = lines.slice(region.start, region.end).map((line) => stripAnsi(line));
  const strip = (plain: string) => plain.replace(COMPOSER_LINE_PREFIX, "").replace(COMPOSER_LINE_SUFFIX, "").trim();
  // A runtime with no measured wrap rule keeps exactly the first-row-only reading it had.
  if (!composer.continuationLine) {
    return rows.filter((plain) => composer.occupiedLine.test(plain)).map(strip).join(" ").trim();
  }
  // t-7a297f — a draft too wide for the pane is drawn by the runtime as several rows, and only the
  // first carries the glyph. Take the glyph row plus the UNBROKEN run of continuation rows after it;
  // the first row that is neither (a blank line, in every runtime measured) ends the draft and leaves
  // the status furniture below it out — furniture that is indented like a continuation row but is
  // always separated by that blank.
  const parts: string[] = [];
  let inDraft = false;
  for (const plain of rows) {
    if (composer.occupiedLine.test(plain)) {
      parts.push(strip(plain));
      inDraft = true;
      continue;
    }
    if (!inDraft) continue;
    if (!composer.continuationLine.test(plain)) break;
    parts.push(strip(plain));
  }
  return parts.join(" ").trim();
}

/**
 * What happened to a line Tachyon typed into the composer and pressed Enter on.
 *
 * `cleared` is the ONLY confirmation of delivery: the composer demonstrably no longer holds the text.
 * It is deliberately not "the pane looks busy" — a runtime can be busy for reasons unrelated to us,
 * and a fast turn can finish before the next capture.
 */
export type ComposerSubmissionState =
  /** The text is gone from the editable region: Enter was accepted. */
  | "cleared"
  /** The region still holds exactly our text and nothing else: Enter was lost, and re-pressing is safe. */
  | "holds-text"
  /** The region holds our text PLUS something else — someone typed while we were submitting. */
  | "diverged"
  /** No composer region in this capture, so this frame proves nothing either way. */
  | "unreadable";

/**
 * Classifies a post-Enter capture. Scoped to the composer REGION rather than the whole pane on
 * purpose: after a successful submit the runtime echoes the very same line into its transcript
 * (t-6ffa13), so a pane-wide search would find our own echo, conclude "still staged" and press Enter
 * forever — re-creating the self-feeding loop t-6ffa13 closed. `findComposerRegion` already steps
 * over that echo.
 */
export function classifyComposerSubmission(
  content: string,
  composer: ComposerRegionProfile,
  text: string,
): ComposerSubmissionState {
  const staged = composerText(content, composer);
  if (staged === null) return "unreadable";
  // t-7a297f — compare on collapsed whitespace. A wrapped draft is rejoined from rows the runtime
  // broke at a space, so the reconstruction can differ from what we typed by exactly that spacing.
  // The direction is safe: normalizing can only turn a `cleared` into `holds-text`/`diverged`, and
  // both of those retry a bare Enter or stop — neither ever types text over anything.
  const wanted = collapseSpace(text);
  const held = collapseSpace(staged);
  if (!wanted) return "cleared";
  if (held === wanted) return "holds-text";
  // Our text is provably still in the editor with other content around it. Pressing Enter now would
  // submit that other content — which may be a human's draft — so the caller must stop, not retry.
  if (held.includes(wanted)) return "diverged";
  // The region no longer contains what we typed. That is exactly the evidence of delivery; whatever
  // else is in there now arrived after our line left.
  return "cleared";
}
