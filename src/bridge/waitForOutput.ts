/**
 * wait_for_output's content-matching engine (t-fe5dbe) — the governed analogue of herdr's
 * `wait output --match`. Unlike Waiters.ts (event-driven: an external monitor pushes attention/death
 * transitions into pending waiters), pane TEXT has no push channel, so this polls tmux directly on a
 * short bounded interval, clamped by the same timeout defaults wait_for_agent uses (45s default, 240s
 * max — see tools.ts's wait_for_agent registration).
 */

export const WAIT_OUTPUT_DEFAULT_TIMEOUT_SEC = 45;
export const WAIT_OUTPUT_MAX_TIMEOUT_SEC = 240;
export const WAIT_OUTPUT_MAX_PATTERN_LENGTH = 300;
/** Bounded capture window (both the baseline and every poll use this) — keeps regex worst-case
 *  input size, and the timeout tail, small regardless of how chatty the target pane is. */
export const WAIT_OUTPUT_CAPTURE_LINES = 2000;
export const WAIT_OUTPUT_EXCERPT_MAX_BYTES = 4000;
export const WAIT_OUTPUT_TAIL_MAX_BYTES = 4000;
export const WAIT_OUTPUT_CONTEXT_LINES = 3;
const DEFAULT_POLL_MS = 250;

export class GuardedRegexError extends Error {}

/**
 * Guards a caller-supplied regex source before it ever runs. Node has no cheap synchronous
 * regex-evaluation timeout, so the mitigation is the pair the task spec calls acceptable: a length
 * cap on the pattern (rejects the pathological patterns that need long alternations/nesting to build)
 * plus the bounded capture window above (worst-case catastrophic backtracking runs against at most
 * WAIT_OUTPUT_CAPTURE_LINES of text, never an unbounded scrollback).
 */
export function compileGuardedRegex(source: string): RegExp {
  if (source.length > WAIT_OUTPUT_MAX_PATTERN_LENGTH) {
    throw new GuardedRegexError(`regex pattern exceeds ${WAIT_OUTPUT_MAX_PATTERN_LENGTH} chars`);
  }
  try {
    return new RegExp(source);
  } catch (err) {
    throw new GuardedRegexError(`invalid regex: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Content beyond `baseline` — the "only NEW output counts" rule (herdr semantics: read_output/
 * read pane for what already exists, wait_for_output for what arrives after). Handles the common
 * append-only growth case exactly (`current` starts with `baseline`); falls back to a last-line
 * anchor when the bounded capture window has rolled the baseline itself out of view, and treats the
 * whole capture as new only when no anchor is found at all (the bounded window already limits how
 * much that fallback can ever return).
 */
export function newOutputSince(baseline: string, current: string): string {
  if (current === baseline) return "";
  if (current.startsWith(baseline)) return current.slice(baseline.length);
  // A trailing blank line (from a trailing newline) is not a useful anchor — walk back to the last
  // genuinely non-empty baseline line before anchoring.
  const baseLines = baseline.split("\n");
  let anchorIdx = baseLines.length - 1;
  while (anchorIdx >= 0 && baseLines[anchorIdx] === "") anchorIdx--;
  if (anchorIdx >= 0) {
    const anchor = baseLines[anchorIdx];
    const curLines = current.split("\n");
    const idx = curLines.lastIndexOf(anchor);
    if (idx >= 0) return curLines.slice(idx + 1).join("\n");
  }
  return current;
}

function boundBytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  return Buffer.from(text, "utf8").subarray(0, maxBytes).toString("utf8");
}

interface MatchHit {
  lineIndex: number;
  lines: string[];
}

function findMatch(text: string, matcher: string | RegExp): MatchHit | undefined {
  if (!text) return undefined;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const hit = typeof matcher === "string" ? lines[i].includes(matcher) : matcher.test(lines[i]);
    if (hit) return { lineIndex: i, lines };
  }
  return undefined;
}

/** The matching line ± WAIT_OUTPUT_CONTEXT_LINES, capped in bytes — never the whole screen. */
function boundedExcerpt(lines: string[], lineIndex: number): string {
  const from = Math.max(0, lineIndex - WAIT_OUTPUT_CONTEXT_LINES);
  const to = Math.min(lines.length, lineIndex + WAIT_OUTPUT_CONTEXT_LINES + 1);
  return boundBytes(lines.slice(from, to).join("\n"), WAIT_OUTPUT_EXCERPT_MAX_BYTES);
}

export interface WaitForOutputParams {
  match: string;
  regex?: boolean;
  timeoutSec?: number;
  /** test seam — defaults to 250ms */
  pollMs?: number;
  /** test seam — defaults to Date.now */
  now?: () => number;
  /** test seam — defaults to a real setTimeout sleep */
  sleep?: (ms: number) => Promise<void>;
}

export type WaitForOutputResult =
  | { met: true; excerpt: string; waitedMs: number }
  | { met: false; state: "timeout"; tail: string; waitedMs: number };

export interface WaitOutputCaptureSource {
  capturePane(session: string, opts: { lines: number; joinWrapped: true }): Promise<string>;
}

/** Blocks until NEW output (beyond a baseline snapshotted at call start) matches, or times out. */
export async function waitForOutput(
  tmux: WaitOutputCaptureSource,
  session: string,
  params: WaitForOutputParams,
): Promise<WaitForOutputResult> {
  const matcher = params.regex ? compileGuardedRegex(params.match) : params.match;
  const now = params.now ?? Date.now;
  const sleep = params.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const clampedTimeoutSec = Math.min(Math.max(params.timeoutSec ?? WAIT_OUTPUT_DEFAULT_TIMEOUT_SEC, 1), WAIT_OUTPUT_MAX_TIMEOUT_SEC);
  const pollMs = params.pollMs ?? DEFAULT_POLL_MS;
  const start = now();
  const deadline = start + clampedTimeoutSec * 1000;
  const capture = () => tmux.capturePane(session, { lines: WAIT_OUTPUT_CAPTURE_LINES, joinWrapped: true });

  const baseline = await capture();
  for (;;) {
    const current = await capture();
    const hit = findMatch(newOutputSince(baseline, current), matcher);
    if (hit) return { met: true, excerpt: boundedExcerpt(hit.lines, hit.lineIndex), waitedMs: now() - start };
    const remaining = deadline - now();
    if (remaining <= 0) {
      return { met: false, state: "timeout", tail: boundBytes(current, WAIT_OUTPUT_TAIL_MAX_BYTES), waitedMs: now() - start };
    }
    await sleep(Math.min(pollMs, remaining));
  }
}

export interface LineageSource {
  parentOf(name: string): string | undefined;
}

/**
 * t-fe5dbe governance (the part herdr lacks): a caller may wait_for_output only on itself, an agent
 * it directly spawned, or a sibling sharing its own parent — never an arbitrary fleet agent. Mirrors
 * the identity model write_input/notify_agent use for WHO is calling (Bridge-resolved caller, never
 * self-declared verbatim); this is the additional WHICH-TARGETS policy layered on top for this tool.
 */
export function inWaitOutputScope(caller: string, target: string, lineage: LineageSource): boolean {
  if (caller === target) return true;
  if (lineage.parentOf(target) === caller) return true;
  const callerParent = lineage.parentOf(caller);
  return callerParent !== undefined && callerParent === lineage.parentOf(target);
}
