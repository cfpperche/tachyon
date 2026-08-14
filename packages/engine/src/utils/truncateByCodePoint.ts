/**
 * Truncate by CODE POINT, never by UTF-16 unit (t-b15872).
 *
 * `slice` counts units, so a cut landing inside a surrogate pair emits a LONE SURROGATE — text that
 * is not well-formed UTF-16 and cannot be encoded as UTF-8. `sanitizeAgentSummary` iterates by code
 * point precisely to avoid that, and the old one-line `slice` right after it undid the care: a
 * summary whose 500th unit fell mid-emoji delivered `"…\ud83d…"`. Measured, not theorised.
 *
 * The marker says the text was cut and by how much. A bare `…` is indistinguishable from an author
 * who simply wrote one, which is exactly how a truncated delivery reads as a complete one.
 */
export function truncateByCodePoint(text: string, cap: number, note = ""): string {
  const points = Array.from(text);
  if (points.length <= cap) return text;
  const marker = `…[+${points.length - cap} chars${note ? ` ${note}` : ""}]`;
  // A cap too small to hold the marker must still be a cap: explaining the cut cannot be what
  // breaks the bound. Below that floor the honest result is a bare code-point cut.
  if (Array.from(marker).length >= cap) return points.slice(0, cap).join("");
  const room = cap - Array.from(marker).length;
  return `${points.slice(0, room).join("").trimEnd()}${marker}`;
}
