import { describe, expect, it } from "vitest";
import {
  applyLauncherOrder,
  encodeLauncherCustom,
  isPersistedLauncherMode,
  moveLauncherTile,
  orderLauncherTiles,
  parseLauncherPref,
} from "@tachyon/webview-ui/sidebar/launcherOrder";

const catalog = [
  { id: "system", label: "System" },
  { id: "inbox", label: "Inbox" },
  { id: "mission", label: "Board" },
  { id: "keys", label: "Keys" },
];
const ids = (tiles: { id: string }[]): string[] => tiles.map((t) => t.id);

describe("t-539851 launcher order", () => {
  it("absent pref is product order — SDD 500 positions, never a silent A–Z", () => {
    expect(parseLauncherPref(undefined).kind).toBe("product");
    expect(parseLauncherPref(null).kind).toBe("product");
    expect(ids(orderLauncherTiles(catalog, parseLauncherPref(undefined)))).toEqual(ids(catalog));
  });

  it("name-asc / name-desc still sort by LABEL, and garbage still coerces to name-asc", () => {
    expect(parseLauncherPref("name-asc")).toEqual({ kind: "name", mode: "name-asc" });
    expect(parseLauncherPref("name-desc")).toEqual({ kind: "name", mode: "name-desc" });
    expect(parseLauncherPref("garbage")).toEqual({ kind: "name", mode: "name-asc" });
    expect(ids(orderLauncherTiles(catalog, parseLauncherPref("name-asc")))).toEqual(["mission", "inbox", "keys", "system"]);
  });

  it("custom:id,… is the third mode of the same pref string", () => {
    const encoded = encodeLauncherCustom(["keys", "system", "inbox", "mission"]);
    expect(encoded).toBe("custom:keys,system,inbox,mission");
    expect(parseLauncherPref(encoded)).toEqual({ kind: "custom", ids: ["keys", "system", "inbox", "mission"] });
    expect(ids(orderLauncherTiles(catalog, parseLauncherPref(encoded)))).toEqual(["keys", "system", "inbox", "mission"]);
  });

  it("isPersistedLauncherMode is the host write-guard: names, well-formed custom, nothing else", () => {
    expect(isPersistedLauncherMode("name-asc")).toBe(true);
    expect(isPersistedLauncherMode("name-desc")).toBe(true);
    expect(isPersistedLauncherMode("custom:system,inbox")).toBe(true);
    expect(isPersistedLauncherMode("custom:runtime-config")).toBe(true);
    expect(isPersistedLauncherMode("custom:")).toBe(false);
    expect(isPersistedLauncherMode("custom:NOT_VALID")).toBe(false);
    expect(isPersistedLauncherMode("custom:../etc")).toBe(false);
    expect(isPersistedLauncherMode("custom")).toBe(false);
    expect(isPersistedLauncherMode("garbage")).toBe(false);
  });

  /**
   * Unknown id rule (written, not inferred): a catalog id the saved list does not name is appended
   * at the END, in catalog (product) order. A newly installed app must not insert into an
   * arrangement the user already made. This project gained two apps in one day.
   */
  it("unknown catalog id appends at the end, in product order among the unknowns", () => {
    const saved = ["keys", "mission"];
    // catalog has system, inbox, mission, keys — system and inbox are unknown to the saved list.
    // They append in catalog order: system then inbox, after the saved arrangement.
    expect(ids(applyLauncherOrder(catalog, saved))).toEqual(["keys", "mission", "system", "inbox"]);
  });

  /**
   * Orphan id rule (written, not inferred): a saved id the catalog no longer has is dropped at
   * apply time. Painting does not rewrite the memento; the next user reorder persists the cleaned list.
   */
  it("orphan saved id is dropped at apply time, remaining ids keep their saved positions", () => {
    const saved = ["keys", "fleet", "mission", "overview"];
    expect(ids(applyLauncherOrder(catalog, saved))).toEqual(["keys", "mission", "system", "inbox"]);
  });

  it("unknown and orphan compose: drop gone ids, then append new ones at the end", () => {
    const saved = ["fleet", "keys", "overview", "mission"];
    expect(ids(applyLauncherOrder(catalog, saved))).toEqual(["keys", "mission", "system", "inbox"]);
  });

  it("duplicate saved ids keep the first occurrence", () => {
    expect(ids(applyLauncherOrder(catalog, ["keys", "keys", "mission"]))).toEqual(["keys", "mission", "system", "inbox"]);
  });

  it("moveLauncherTile: dragged id takes the index of the tile it was dropped on", () => {
    const order = ["A", "B", "C", "D"];
    expect(moveLauncherTile(order, "A", "C")).toEqual(["B", "C", "A", "D"]);
    expect(moveLauncherTile(order, "D", "B")).toEqual(["A", "D", "B", "C"]);
    expect(moveLauncherTile(order, "A", "A")).toEqual(["A", "B", "C", "D"]);
    expect(moveLauncherTile(order, "missing", "B")).toEqual(["A", "B", "C", "D"]);
    expect(order).toEqual(["A", "B", "C", "D"]);
  });
});
