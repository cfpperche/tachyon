import { describe, it, expect } from "vitest";
import { sortRows, asSortMode, type SortMode } from "../../src/sidebar/sortRows.js";

type Row = { name: string };
const rows: Row[] = [
  { name: "zeta" },
  { name: "Alpha" },
  { name: "mid" },
  { name: "beta" },
  { name: "crash" },
];
const names = (rs: Row[]): string[] => rs.map((r) => r.name);
const sort = (mode: SortMode): Row[] => sortRows(rows, mode, (r) => r.name);

describe("sortRows (spec 242)", () => {
  it("name-asc: case-insensitive A→Z (the stable default)", () => {
    expect(names(sort("name-asc"))).toEqual(["Alpha", "beta", "crash", "mid", "zeta"]);
  });

  it("name-desc: Z→A", () => {
    expect(names(sort("name-desc"))).toEqual(["zeta", "mid", "crash", "beta", "Alpha"]);
  });

  it("numeric-aware name compare (claude-2 before claude-10)", () => {
    const n: Row[] = [{ name: "claude-10" }, { name: "claude-2" }];
    expect(names(sortRows(n, "name-asc", (r) => r.name))).toEqual(["claude-2", "claude-10"]);
  });

  it("does not mutate the input array", () => {
    const before = names(rows);
    sort("name-desc");
    expect(names(rows)).toEqual(before);
  });

  it("asSortMode coerces unknown/persisted values (incl. the retired 'status') to name-asc", () => {
    expect(asSortMode("name-desc")).toBe("name-desc");
    expect(asSortMode("status")).toBe("name-asc"); // the live 'status' mode was retired
    expect(asSortMode("garbage")).toBe("name-asc");
    expect(asSortMode(undefined)).toBe("name-asc");
  });
});
