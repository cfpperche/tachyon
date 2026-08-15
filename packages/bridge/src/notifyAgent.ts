/**
 * spec 332 — the agent→agent notice envelope: pure composition, no imports from bridge/manager so it
 * stays table-testable (same posture as spawnContract.ts). The Bridge tool (`notify_agent`) owns policy
 * (target resolution, kind gate, self-notify rejection); this owns the SHAPE and the security-critical
 * sanitizer (dueto F2).
 */

import { truncateByCodePoint } from "@tachyon/engine/utils/truncateByCodePoint.js";

/** Cap on the delivered summary (after sanitize + collapse), so the envelope stays one bounded line. */
const SUMMARY_CAP = 500;

/** Line/record separators that would otherwise let a payload grow a second visual line or rewind the
 *  cursor (CR) — normalized to an ordinary space (not deleted) so words never glue together.
 *  Includes \u0085 (NEL), \u2028 (line separator), \u2029 (paragraph separator). */
const LINE_BREAKISH = /[\n\r\v\f\t\u0085\u2028\u2029]/g;

const MULTI_SPACE = / {2,}/g;

/** True for a printable scalar or the literal space — false for every control (\p{C}: Cc/Cf/Co/Cs/Cn,
 *  which covers C0/C1 controls incl. ESC/OSC introducers/backspace, and bidi format overrides like
 *  U+202A–E/U+2066–9) and every other separator (\p{Z}: Zs/Zl/Zp, which covers U+2028/U+2029 and
 *  non-ordinary spaces like NBSP). This is the allowlist: anything not explicitly rejected survives. */
function isAllowed(ch: string): boolean {
  return ch === " " || !/\p{C}|\p{Z}/u.test(ch);
}

/**
 * Allowlist sanitizer (dueto F2): strips/neutralizes every hostile character class so the delivered
 * text is provably printable-scalars-plus-ordinary-space. Iterates by CODE POINT (`Array.from`, not
 * index) so astral characters and surrogate pairs are never split.
 */
export function sanitizeAgentSummary(raw: string): string {
  const spaced = raw.replace(LINE_BREAKISH, " ");
  return Array.from(spaced)
    .filter(isAllowed)
    .join("");
}

/** The bound itself is legitimate and stays; what changes (t-b15872) is what happens at it. */
export const AGENT_SUMMARY_CAP = SUMMARY_CAP;

/**
 * Why the summary cannot be delivered as given, or undefined when it fits.
 *
 * A bounded envelope is right; silently dropping the tail of a structured delivery is not. The
 * caller is the only party that still HAS the full text at this point — the Bridge would be
 * discarding it — so the refusal hands the problem back to whoever can actually solve it, and names
 * the remedy rather than just the rule.
 */
export function agentSummaryRefusal(raw: string): string | undefined {
  const length = Array.from(prepareAgentSummary(raw, { truncate: false })).length;
  if (length <= SUMMARY_CAP) return undefined;
  return (
    `summary is ${length} chars; notify_agent delivers one bounded line of at most ${SUMMARY_CAP}. `
    + "Nothing is truncated for you, because the tail of a delivery is usually the part that matters: "
    + "write the detail where it survives (append_task_note / attach_evidence), then send a short "
    + "summary carrying task id, state, commit/tree or blocker, and `pointer` set to that durable record."
  );
}

/**
 * Sanitize → collapse repeated spaces → trim, and (by default) cap at 500 code points.
 *
 * `truncate: false` yields the cleaned text at full length — used to MEASURE before refusing, so the
 * length reported back to a caller is the one that would actually have been delivered.
 */
export function prepareAgentSummary(raw: string, opts: { truncate?: boolean } = {}): string {
  const cleaned = sanitizeAgentSummary(raw).replace(MULTI_SPACE, " ").trim();
  if (opts.truncate === false) return cleaned;
  return truncateByCodePoint(cleaned, SUMMARY_CAP);
}

/**
 * Durable pointer appended to a delivered notice (t-b15872): where the full record lives, in a form
 * the recipient can act on without reading the sender's pane. Bounded like everything else here.
 */
export function formatNoticePointer(pointer: string): string {
  return `[details: ${truncateByCodePoint(sanitizeAgentSummary(pointer).replace(MULTI_SPACE, " ").trim(), 120)}]`;
}

/**
 * Compose the host-owned envelope. `summary` is payload only, after the colon — a hostile summary
 * cannot fake a different sender line since newlines collapse to space. But `from`/`to` are NOT
 * verified provenance: they are self-declared params like every other Bridge tool's caller field (auth
 * is one shared bearer token, so the Bridge cannot distinguish who is actually calling — t-d7b3a9). The
 * only real defense against a wrong `from` is the caller reading its own name off $TACHYON_AGENT_NAME
 * instead of guessing it (spawnContract.ts's identityLine + the tool descriptions now say so).
 */
export function composeAgentNotice(from: string, to: string, summary: string, pointer?: string): string {
  const tail = pointer ? ` ${formatNoticePointer(pointer)}` : "";
  return `[tachyon] ${from} → ${to}: ${prepareAgentSummary(summary)}${tail}`;
}

/**
 * The whole delivered line, bounded (t-b15872).
 *
 * The payload was capped but the LINE never was: `AGENT_NAME` carries no max length, only a charset
 * regex, so two long names could push the envelope past any bound the module claimed to hold. This
 * is the claim in this file's header ("stays one bounded line") made true rather than asserted.
 */
export const AGENT_NOTICE_LINE_CAP = 900;

export function composeBoundedAgentNotice(from: string, to: string, summary: string, pointer?: string): string {
  return truncateByCodePoint(composeAgentNotice(from, to, summary, pointer), AGENT_NOTICE_LINE_CAP);
}
