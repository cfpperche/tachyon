/**
 * `t-5564b4` — how a long artifact ref is shown without escaping the reading column.
 *
 * The refs a task carries are commit shas, absolute paths and URLs. Their information sits at BOTH
 * ends — a sha is recognised by its head, a path by its tail — so the usual `text-overflow: ellipsis`
 * is the wrong tool twice over: it keeps only the head, and it needs a fixed width to act on, which is
 * exactly what a wrapping layout does not have.
 *
 * CSS cannot truncate in the middle, so this does it in the string, deterministically. Character
 * budget rather than measured pixels on purpose: it is testable without a layout engine, it renders
 * identically in the preview harness and the editor, and it cannot depend on a font that failed to
 * load. The full value always stays available through `title` and copy — this only decides what is
 * painted.
 */

/** Keeps the head and tail of a value, collapsing the middle. Returns the input when it already fits. */
export function middleTruncate(value: string, max: number): string {
  if (max <= 1) return value.length <= max ? value : "…";
  if (value.length <= max) return value;
  // One character goes to the ellipsis; the head keeps the odd one, because a sha or an id is
  // recognised from its start and readers scan left first.
  const budget = max - 1;
  const head = Math.ceil(budget / 2);
  const tail = budget - head;
  return tail === 0 ? `${value.slice(0, head)}…` : `${value.slice(0, head)}…${value.slice(value.length - tail)}`;
}

/** Widest ref rendered inline before the middle is collapsed. Tuned to the 760px reading column. */
export const REF_DISPLAY_MAX = 48;

/** The painted form of one artifact ref. `full` is what a tooltip and copy must carry. */
export function refDisplay(ref: string, max = REF_DISPLAY_MAX): { text: string; full: string; truncated: boolean } {
  const text = middleTruncate(ref, max);
  return { text, full: ref, truncated: text !== ref };
}
