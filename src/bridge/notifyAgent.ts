/**
 * spec 332 — the agent→agent notice envelope: pure composition, no imports from bridge/manager so it
 * stays table-testable (same posture as spawnContract.ts). The Bridge tool (`notify_agent`) owns policy
 * (target resolution, kind gate, self-notify rejection); this owns the SHAPE and the security-critical
 * sanitizer (dueto F2).
 */

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

/** Sanitize → collapse repeated spaces → trim → cap at 500 (ellipsis on truncation, never dropped). */
export function prepareAgentSummary(raw: string): string {
  const cleaned = sanitizeAgentSummary(raw).replace(MULTI_SPACE, " ").trim();
  return cleaned.length <= SUMMARY_CAP ? cleaned : `${cleaned.slice(0, SUMMARY_CAP - 1).trimEnd()}…`;
}

/**
 * Compose the host-owned envelope. `summary` is payload only, after the colon — a hostile summary
 * cannot fake a different sender line since newlines collapse to space. But `from`/`to` are NOT
 * verified provenance: they are self-declared params like every other Bridge tool's caller field (auth
 * is one shared bearer token, so the Bridge cannot distinguish who is actually calling — t-d7b3a9). The
 * only real defense against a wrong `from` is the caller reading its own name off $TACHYON_AGENT_NAME
 * instead of guessing it (spawnContract.ts's identityLine + the tool descriptions now say so).
 */
export function composeAgentNotice(from: string, to: string, summary: string): string {
  return `[tachyon] ${from} → ${to}: ${prepareAgentSummary(summary)}`;
}
