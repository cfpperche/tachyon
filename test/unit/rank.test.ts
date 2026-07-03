import { describe, expect, it } from "vitest";
import { between, MAX_RANK_LENGTH, rebalancedRanks } from "../../src/tasks/rank.js";

describe("between — append/prepend edges", () => {
  it("mints a default first-ever rank when neither neighbor exists", () => {
    const mid = between(undefined, undefined);
    expect(mid).toBeDefined();
    // must leave room to both append after it and prepend before it later
    expect(between(undefined, mid)).toBeDefined();
    expect(between(mid, undefined)).toBeDefined();
  });

  it("mints something greater than lo when appending (hi undefined)", () => {
    const mid = between("m", undefined);
    expect(mid).toBeDefined();
    expect(mid! > "m").toBe(true);
  });

  it("mints something less than hi when prepending (lo undefined)", () => {
    const mid = between(undefined, "m");
    expect(mid).toBeDefined();
    expect(mid! < "m").toBe(true);
  });

  it("chains repeated appends, each strictly greater than the last", () => {
    let prev: string | undefined = "a";
    for (let i = 0; i < 20; i++) {
      const next = between(prev, undefined);
      expect(next).toBeDefined();
      expect(next! > prev!).toBe(true);
      prev = next;
    }
  });

  it("chains repeated prepends, each strictly less than the last, until the floor is reached", () => {
    let next: string | undefined = "z";
    let steps = 0;
    for (; steps < 200; steps++) {
      const mid = between(undefined, next);
      if (mid === undefined) break;
      expect(mid < next!).toBe(true);
      next = mid;
    }
    // the alphabet floor ("0") is reachable in a bounded number of prepends, and one more prepend past it fails
    expect(steps).toBeLessThan(200);
    expect(between(undefined, next)).toBeUndefined();
  });
});

describe("between — midpoint minting", () => {
  it("picks an exact midpoint digit when there's room at the first position", () => {
    expect(between("b", "f")).toBe("d");
  });

  it("extends length for single-char adjacent values with no digit room", () => {
    const mid = between("5", "6");
    expect(mid).toBeDefined();
    expect(mid! > "5" && mid! < "6").toBe(true);
    expect(mid).toBe("5i");
  });

  it("extends length for tied multi-char prefixes", () => {
    expect(between("50", "52")).toBe("51");
  });

  it("finds room for values with a long shared prefix and one differing trailing digit", () => {
    const lo = "aaaaaaaa0";
    const hi = "aaaaaaaa2";
    const mid = between(lo, hi);
    expect(mid).toBeDefined();
    expect(mid! > lo && mid! < hi).toBe(true);
  });
});

describe("between — no midpoint (rebalance trigger)", () => {
  it("returns undefined prepending before the absolute alphabet floor", () => {
    expect(between(undefined, "0")).toBeUndefined();
  });

  it("returns undefined prepending before a floor-padded multi-char minimum", () => {
    expect(between(undefined, "00")).toBeUndefined();
    expect(between(undefined, "000")).toBeUndefined();
  });

  it("returns undefined when two values only diverge past MAX_RANK_LENGTH digits", () => {
    const lo = "0".repeat(MAX_RANK_LENGTH);
    const hi = "0".repeat(MAX_RANK_LENGTH - 1) + "1";
    expect(lo < hi).toBe(true);
    expect(between(lo, hi)).toBeUndefined();
  });

  it("throws when lo does not sort strictly before hi", () => {
    expect(() => between("b", "a")).toThrow(/must sort before/);
    expect(() => between("a", "a")).toThrow(/must sort before/);
  });
});

describe("between — exhaustive pairwise invariant", () => {
  const SAMPLE = ["0", "00", "01", "0z", "1", "5", "50", "52", "6", "9", "a", "az", "m", "y", "z", "zz"];

  it("for every ordered pair in a representative sample, the result (if any) sorts strictly between", () => {
    let checked = 0;
    for (const lo of SAMPLE) {
      for (const hi of SAMPLE) {
        if (!(lo < hi)) continue;
        const mid = between(lo, hi);
        if (mid !== undefined) {
          expect(mid > lo, `between(${lo}, ${hi}) = ${mid} should be > ${lo}`).toBe(true);
          expect(mid < hi, `between(${lo}, ${hi}) = ${mid} should be < ${hi}`).toBe(true);
        }
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(50);
  });

  it("for every sample value, append (undefined hi) and prepend (undefined lo) both stay in bounds", () => {
    for (const v of SAMPLE) {
      const appended = between(v, undefined);
      expect(appended === undefined || appended > v).toBe(true);
      const prepended = between(undefined, v);
      expect(prepended === undefined || prepended < v).toBe(true);
    }
  });
});

describe("rebalancedRanks", () => {
  it("returns an empty array for zero", () => {
    expect(rebalancedRanks(0)).toEqual([]);
  });

  it("returns one rank with headroom on both sides for a single task", () => {
    const [only] = rebalancedRanks(1);
    expect(only).toBeDefined();
    expect(between(undefined, only)).toBeDefined();
    expect(between(only, undefined)).toBeDefined();
  });

  it("returns n strictly increasing ranks, each with an insertable midpoint to its neighbor", () => {
    const n = 25;
    const ranks = rebalancedRanks(n);
    expect(ranks).toHaveLength(n);
    for (let i = 0; i < n - 1; i++) {
      expect(ranks[i]! < ranks[i + 1]!).toBe(true);
      expect(between(ranks[i], ranks[i + 1])).toBeDefined();
    }
    expect(between(undefined, ranks[0])).toBeDefined();
    expect(between(ranks[n - 1], undefined)).toBeDefined();
  });

  it("still spaces out ranks with headroom at the 500-task scale envelope (dueto F10)", () => {
    const ranks = rebalancedRanks(500);
    expect(ranks).toHaveLength(500);
    for (let i = 0; i < ranks.length - 1; i++) {
      expect(ranks[i]! < ranks[i + 1]!).toBe(true);
      expect(between(ranks[i], ranks[i + 1])).toBeDefined();
    }
  });
});
