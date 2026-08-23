/**
 * The launcher tile's context menu: what it offers, and the keyboard grammar it has to speak.
 *
 * Two subjects, because they are the two halves of the same promise. The MENU is a table — adding an
 * action later must be a row, not a branch — and the COMPONENT is a benchmark pattern, which is a
 * closed list of behaviours a keyboard user is entitled to.
 */
import { describe, expect, it } from "vitest";
import { appTileMenuItems, isInstalledApp, BUILT_IN_TILE_ACTIONS } from "@tachyon/webview-ui/webview/sidebar/appTileActions";
import { focusableIndices, nextIndexForKey, placeMenu, type ContextMenuItem } from "@tachyon/webview-ui/webview/shared/ui/contextMenuModel";

describe("what a tile offers", () => {
  it("gives a built-in tile Open and its declared actions, and NEVER Uninstall", () => {
    const items = appTileMenuItems({ id: "mission", label: "Board" });
    expect(items.map((item) => item.id)).toEqual(["open", "new-task"]);
    // The rule is structural: a core screen is not a directory anyone installed, so there is nothing
    // to remove. Making it depend on the `app:` prefix means no call site can get it wrong.
    expect(items.some((item) => item.id === "uninstall")).toBe(false);
  });

  it("gives a tile with no declared actions exactly Open", () => {
    expect(appTileMenuItems({ id: "settings", label: "Settings" }).map((item) => item.id)).toEqual(["open"]);
  });

  it("gives an installed app Open, its own actions, and Uninstall last, separated and destructive", () => {
    const items = appTileMenuItems({
      id: "app:hello-fleet",
      label: "Hello Fleet",
      declared: [{ id: "refresh", label: "Refresh", icon: "sync" }],
    });
    expect(items.map((item) => item.id)).toEqual(["open", "refresh", "uninstall"]);
    const uninstall = items[items.length - 1]!;
    expect(uninstall.destructive).toBe(true);
    expect(uninstall.separatorBefore).toBe(true);
  });

  it("ignores actions an installed app did not declare, and never inherits a built-in's", () => {
    // `mission` has a table entry; an app that happens to be called the same must not pick it up.
    expect(appTileMenuItems({ id: "app:mission", label: "Mission" }).map((item) => item.id))
      .toEqual(["open", "uninstall"]);
    expect(BUILT_IN_TILE_ACTIONS.mission?.map((action) => action.id)).toEqual(["new-task"]);
  });

  it("knows which tiles came from disk", () => {
    expect(isInstalledApp("app:hello-fleet")).toBe(true);
    expect(isInstalledApp("mission")).toBe(false);
  });
});

describe("the keyboard grammar the menu pattern requires", () => {
  const items: ContextMenuItem[] = [
    { id: "open", label: "Open", icon: "arrow-right" },
    { id: "rename", label: "Rename", icon: "edit", disabled: true, disabledReason: "not yet" },
    { id: "reveal", label: "Reveal", icon: "folder" },
    { id: "uninstall", label: "Uninstall", icon: "trash", destructive: true },
  ];

  it("skips a disabled item when moving, but keeps it listed", () => {
    expect(focusableIndices(items)).toEqual([0, 2, 3]);
    expect(nextIndexForKey("ArrowDown", 0, items)).toBe(2);
    expect(nextIndexForKey("ArrowUp", 2, items)).toBe(0);
  });

  it("wraps at both ends, and Home/End jump to them", () => {
    expect(nextIndexForKey("ArrowDown", 3, items)).toBe(0);
    expect(nextIndexForKey("ArrowUp", 0, items)).toBe(3);
    expect(nextIndexForKey("Home", 3, items)).toBe(0);
    expect(nextIndexForKey("End", 0, items)).toBe(3);
  });

  it("jumps to the next item starting with a typed letter, cycling on repeats", () => {
    expect(nextIndexForKey("u", 0, items)).toBe(3);
    expect(nextIndexForKey("r", 0, items)).toBe(2); // `rename` is disabled, so `reveal` takes it
    expect(nextIndexForKey("o", 3, items)).toBe(0);
  });

  it("returns undefined for a key it does not own, so the page still gets it", () => {
    // A menu that swallows every key is a trap: Tab, F5 and the rest must reach whatever handles them.
    expect(nextIndexForKey("Tab", 0, items)).toBeUndefined();
    expect(nextIndexForKey("F5", 0, items)).toBeUndefined();
    expect(nextIndexForKey("ArrowDown", 0, [])).toBeUndefined();
  });
});

describe("where the panel lands", () => {
  const viewport = { width: 400, height: 300 };
  const menu = { width: 180, height: 120 };

  it("opens down-and-right of the pointer when there is room", () => {
    expect(placeMenu({ x: 40, y: 50 }, menu, viewport)).toEqual({ left: 40, top: 50 });
  });

  it("FLIPS rather than slides at an edge, so it stays attached to what was clicked", () => {
    // Sliding keeps the panel on screen and detaches it from its object — the one thing a contextual
    // menu must not do. Flipped, its corner still touches the pointer.
    expect(placeMenu({ x: 380, y: 50 }, menu, viewport).left).toBe(200);
    expect(placeMenu({ x: 40, y: 290 }, menu, viewport).top).toBe(170);
  });

  it("never touches an edge, even when the menu is larger than the space either way", () => {
    const placed = placeMenu({ x: 5, y: 5 }, { width: 900, height: 900 }, viewport);
    expect(placed.left).toBeGreaterThanOrEqual(6);
    expect(placed.top).toBeGreaterThanOrEqual(6);
  });
});

describe("the trigger advertises the menu", () => {
  it("every launcher tile says it has one", async () => {
    // Half of the pattern lives on the invoker: without `aria-haspopup` a screen-reader user has no
    // way to learn that the keyboard gesture does anything on this control.
    const { loadWebviewModule, renderStatic } = await import("../helpers/staticPreact.js");
    const { SAMPLE } = await import("../../scripts/webview-preview/fixtures/sidebar.js");
    const mod = await loadWebviewModule("packages/webview-ui/src/webview/sidebar/App.tsx");
    const SidebarApp = (mod as { App: (props: unknown) => unknown }).App;
    const html = renderStatic(SidebarApp({ fleets: [{ ...SAMPLE, folder: { hash: "ws", name: "Project" } }], initialTab: "Apps" }));
    expect(html).toContain('aria-haspopup="menu"');
  });
});
