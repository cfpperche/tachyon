/**
 * 514 — the four places an installed app has to be a first-class tile, and each one is a place the
 * adversarial review of this spec found it would NOT have been.
 *
 * The launcher machine already existed whole — ordering, drag, keyboard, the persisted `custom:` list,
 * the tile icon. The spec's bet is that an app joins it instead of growing a parallel grid, and these
 * are the four seams where that bet is either true or silently false: the catalog concatenation, the
 * id shape, the persisted-order token, and the route.
 */
import { describe, expect, it } from "vitest";
import { controlSectionNavWith, CONTROL_SECTION_NAV } from "@tachyon/webview-ui/webview/sidebar/sectionNav";
import { encodeLauncherCustom, isPersistedLauncherMode, parseLauncherPref } from "@tachyon/webview-ui/sidebar/launcherOrder";
import { appIdOfSection, isSectionId, resolveSection } from "../../apps/vscode-extension/src/sections/resolveSection.js";

const TILE = { id: "notes", title: "Notes", iconUri: "https://vscode-webview.example/icon.png" };

describe("the launcher catalog is the twelve plus what is installed", () => {
  it("appends an installed app after the built-in tiles, keeping product order in front", () => {
    const nav = controlSectionNavWith([TILE]);
    expect(nav.length).toBe(CONTROL_SECTION_NAV.length + 1);
    expect(nav.slice(0, CONTROL_SECTION_NAV.length).map((entry) => entry.id))
      .toEqual(CONTROL_SECTION_NAV.map((entry) => entry.id));
    const row = nav[nav.length - 1]!;
    expect(row.id).toBe("app:notes");
    expect(row.label).toBe("Notes");
    // The icon is the app's own file, which is what makes an installed tile look installed.
    expect(row.iconImage).toBe(TILE.iconUri);
    expect(row.standalone).toBe(true);
  });

  it("falls back to the id when an app declares an empty title, rather than drawing a nameless tile", () => {
    const nav = controlSectionNavWith([{ ...TILE, title: "" }]);
    expect(nav[nav.length - 1]!.label).toBe("notes");
  });

  it("drops a duplicate id instead of drawing the same tile twice", () => {
    const nav = controlSectionNavWith([TILE, TILE]);
    expect(nav.filter((entry) => entry.id === "app:notes").length).toBe(1);
  });

  it("never lets a disk row throw — a broken catalog degrades the grid, it does not blank the sidebar", () => {
    // The three `throw`s in this module guard the COMPILED twelve, where a miss is a typo at boot.
    // A row that came from disk gets the product's other rule: config that is wrong warns.
    expect(() => controlSectionNavWith([{ id: "", title: "", iconUri: "" }])).not.toThrow();
    expect(controlSectionNavWith([{ id: "", title: "", iconUri: "" }]).length).toBe(CONTROL_SECTION_NAV.length);
  });
});

describe("an app id survives the round trips a tile makes", () => {
  it("is a section id, and names the app behind it", () => {
    expect(isSectionId("app:notes")).toBe(true);
    expect(resolveSection("app:notes")).toBe("app:notes");
    expect(appIdOfSection("app:notes")).toBe("notes");
    // A built-in is not an app, and a malformed one is not a section: `openControl` must not route
    // either of them to a panel that would then look for a directory.
    expect(appIdOfSection("settings")).toBeUndefined();
    expect(isSectionId("app:Notes")).toBe(false);
    expect(isSectionId("app:")).toBe(false);
    expect(resolveSection("app:notes/../secrets")).toBe("overview");
  });

  it("persists inside a custom launcher order (achado 4 — the optimistic update hid this)", () => {
    // Without the colon in the token, the encoded order is rejected on the way to the memento while
    // the grid still shows it: correct until the next reload, then silently thrown away.
    const encoded = encodeLauncherCustom(["system", "app:notes", "settings"]);
    expect(isPersistedLauncherMode(encoded)).toBe(true);
    const parsed = parseLauncherPref(encoded);
    expect(parsed.kind === "custom" && parsed.ids).toEqual(["system", "app:notes", "settings"]);
  });

  it("still refuses a token that is not an id at all", () => {
    expect(isPersistedLauncherMode(encodeLauncherCustom(["system", "Notes"]))).toBe(false);
    expect(isPersistedLauncherMode(encodeLauncherCustom(["system", "app:notes:extra"]))).toBe(false);
  });
});
