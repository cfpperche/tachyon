/**
 * spec 335 (Gated v1.1 — in-column rank reorder) — pure, DOM-free rank-minting helpers shared by the board's
 * drag-reorder decision (`resolveReorder` in mission-control/interactions.ts) and the store's rebalance
 * operation (`TaskStore.reorderLane`). No disk access, no store imports — mirrors boardModel's discipline.
 */

const RANK_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";
const RANK_BASE = RANK_ALPHABET.length; // 36 — digits sort before lowercase letters in plain codepoint order,
// so `rank` strings compare correctly via ordinary string `<` (the comparator nextTask.ts already uses).

/** mirrors TaskStore's `optionalStringField("rank", ..., 64)` cap — `between` never mints past it. */
export const MAX_RANK_LENGTH = 64;

function digitAt(value: string | undefined, i: number): number {
  if (value === undefined || i >= value.length) return 0; // past a real string's own length: treat as its floor digit
  return RANK_ALPHABET.indexOf(value[i]!);
}

/**
 * Mint a rank string that sorts strictly between `lo` and `hi` under plain codepoint (string `<`) comparison.
 * `lo`/`hi` undefined means "no neighbor on that side" — prepend-at-top / append-at-bottom / first-ever-rank
 * edges. Returns `undefined` when no such string exists within `MAX_RANK_LENGTH` characters (the true alphabet
 * floor with nothing below it, or two values so close they'd need an unbounded number of digits to separate) —
 * the caller must rebalance the lane instead of minting further.
 */
export function between(lo: string | undefined, hi: string | undefined): string | undefined {
  if (lo !== undefined && hi !== undefined && !(lo < hi)) {
    throw new Error(`between: lo ('${lo}') must sort before hi ('${hi}')`);
  }
  let prefix = "";
  let hiBound = hi !== undefined;
  for (let i = 0; i < MAX_RANK_LENGTH; i++) {
    const loDigit = lo === undefined ? -1 : digitAt(lo, i);
    const hiDigit = hiBound ? digitAt(hi, i) : RANK_BASE;
    if (loDigit + 1 < hiDigit) {
      const mid = Math.floor((loDigit + hiDigit) / 2);
      return prefix + RANK_ALPHABET[mid];
    }
    if (loDigit >= 0 && loDigit + 1 === hiDigit) {
      // adjacent at this digit: placing lo's own digit here already sorts below hi no matter what follows —
      // hi stops binding any deeper position (this is what lets "5"/"6" resolve to e.g. "5i" instead of
      // recursing forever).
      prefix += RANK_ALPHABET[loDigit];
      hiBound = false;
      continue;
    }
    // tied (equal digits so far), or lo is unbounded and hi is already at the alphabet floor — both bounds
    // still apply, descend one digit deeper.
    prefix += RANK_ALPHABET[Math.max(loDigit, 0)];
  }
  return undefined;
}

/**
 * `n` evenly-spaced, freshly-minted rank strings for a from-scratch lane rebalance (`TaskStore.reorderLane`).
 * Fixed-width base-36 encoding over a space far larger than any realistic lane (36^4 ≈ 1.68M slots against the
 * board's 500-task scale envelope — dueto F10), so every future `between()` insert has ample headroom on both
 * sides without an immediate second rebalance.
 */
export function rebalancedRanks(n: number): string[] {
  if (n <= 0) return [];
  const WIDTH = 4;
  const SPACE = RANK_BASE ** WIDTH;
  const gap = Math.floor(SPACE / (n + 1));
  const out: string[] = [];
  for (let i = 1; i <= n; i++) out.push(encodeBase36(i * gap, WIDTH));
  return out;
}

function encodeBase36(value: number, width: number): string {
  let v = value;
  let out = "";
  for (let i = 0; i < width; i++) {
    out = RANK_ALPHABET[v % RANK_BASE] + out;
    v = Math.floor(v / RANK_BASE);
  }
  return out;
}
