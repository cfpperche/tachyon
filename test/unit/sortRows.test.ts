import { describe, it, expect } from "vitest";
import { sortRows, groupByParent, asSortMode, type SortMode } from "@tachyon/webview-ui/sidebar/sortRows";

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

type Node = { name: string; parent?: string };
const group = (ns: Node[], mode: SortMode = "name-asc"): string[] => {
  const sorted = sortRows(ns, mode, (n) => n.name);
  return groupByParent(sorted, (n) => n.name, (n) => n.parent).map((n) => n.name);
};

describe("groupByParent (spec 304)", () => {
  it("a child sorts immediately after its parent, ahead of alphabetically-earlier unrelated rows", () => {
    const ns: Node[] = [{ name: "taxonomy-review", parent: "codex" }, { name: "claude" }, { name: "codex" }, { name: "review" }];
    expect(group(ns)).toEqual(["claude", "codex", "taxonomy-review", "review"]);
  });

  it("multiple children under one parent keep their existing sorted relative order", () => {
    const ns: Node[] = [{ name: "zeta", parent: "root" }, { name: "alpha", parent: "root" }, { name: "root" }];
    expect(group(ns)).toEqual(["root", "alpha", "zeta"]);
  });

  it("holds under name-desc too", () => {
    const ns: Node[] = [{ name: "alpha", parent: "root" }, { name: "root" }, { name: "zeta" }];
    expect(group(ns, "name-desc")).toEqual(["zeta", "root", "alpha"]);
  });

  it("an orphaned child (parent not present) stays in its normal sorted position", () => {
    const ns: Node[] = [{ name: "alpha", parent: "ghost" }, { name: "beta" }];
    expect(group(ns)).toEqual(["alpha", "beta"]);
  });

  it("does not mutate the input array", () => {
    const ns: Node[] = [{ name: "b", parent: "a" }, { name: "a" }];
    const before = [...ns];
    group(ns);
    expect(ns).toEqual(before);
  });

  it("a lineage cycle renders every row exactly once — no infinite loop, no dropped row", () => {
    const ns: Node[] = [{ name: "a", parent: "b" }, { name: "b", parent: "a" }, { name: "c" }];
    const out = group(ns);
    expect(out).toHaveLength(3);
    expect(new Set(out)).toEqual(new Set(["a", "b", "c"]));
  });

  it("a depth-2 chain groups under its grandparent (defensive coverage, not an acceptance promise)", () => {
    const ns: Node[] = [{ name: "grandchild", parent: "child" }, { name: "child", parent: "root" }, { name: "root" }];
    expect(group(ns)).toEqual(["root", "child", "grandchild"]);
  });
});
