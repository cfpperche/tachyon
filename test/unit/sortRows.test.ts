import { describe, it, expect } from "vitest";
import { sortStatusRows, asSortMode, type SortMode } from "../../src/sidebar/sortRows.js";
import type { AgentStatus } from "../../src/sidebar/types.js";

type Row = { name: string; status: AgentStatus };
const rows: Row[] = [
  { name: "zeta", status: "idle" },
  { name: "Alpha", status: "stopped" },
  { name: "mid", status: "running" },
  { name: "beta", status: "needs" },
  { name: "crash", status: "crashed" },
];
const names = (rs: Row[]): string[] => rs.map((r) => r.name);
const sort = (mode: SortMode): Row[] => sortStatusRows(rows, mode, (r) => r.name, (r) => r.status);

describe("sortStatusRows (spec 242)", () => {
  it("name-asc: case-insensitive A→Z (the stable default)", () => {
    expect(names(sort("name-asc"))).toEqual(["Alpha", "beta", "crash", "mid", "zeta"]);
  });

  it("name-desc: Z→A", () => {
    expect(names(sort("name-desc"))).toEqual(["zeta", "mid", "crash", "beta", "Alpha"]);
  });

  it("status: running → needs → idle → stopped → crashed", () => {
    expect(names(sort("status"))).toEqual(["mid", "beta", "zeta", "Alpha", "crash"]);
  });

  it("status: name tiebreak within the same status", () => {
    const same: Row[] = [
      { name: "delta", status: "running" },
      { name: "bravo", status: "running" },
      { name: "alpha", status: "running" },
    ];
    expect(names(sortStatusRows(same, "status", (r) => r.name, (r) => r.status))).toEqual(["alpha", "bravo", "delta"]);
  });

  it("numeric-aware name compare (claude-2 before claude-10)", () => {
    const n: Row[] = [
      { name: "claude-10", status: "idle" },
      { name: "claude-2", status: "idle" },
    ];
    expect(names(sortStatusRows(n, "name-asc", (r) => r.name, (r) => r.status))).toEqual(["claude-2", "claude-10"]);
  });

  it("does not mutate the input array", () => {
    const before = names(rows);
    sort("status");
    expect(names(rows)).toEqual(before);
  });

  it("asSortMode coerces unknown/persisted values to name-asc", () => {
    expect(asSortMode("status")).toBe("status");
    expect(asSortMode("name-desc")).toBe("name-desc");
    expect(asSortMode("garbage")).toBe("name-asc");
    expect(asSortMode(undefined)).toBe("name-asc");
  });
});
