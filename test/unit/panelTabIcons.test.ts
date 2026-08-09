import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { CONTROL_SECTION_NAV, controlSectionIcon } from "../../src/webview/sidebar/sectionNav.js";
import { WEBVIEW_APPS, sectionAppIconName } from "../../src/webview/webviewApps.js";

/**
 * t-icon — an editor tab's icon exists, and it is the SAME icon as the sidebar tile that opened it.
 *
 * The bug this file is written from: Runtime Ops shipped with NO tab icon. `RuntimeOpsPanel` declared
 * `iconName: "graph"`, `media/icons/{light,dark}/graph.svg` did not exist, and `panelIcon` does not read
 * the file — it builds a Uri and hands it to VS Code, for whom a miss is not an error but the generic
 * webview icon. Three migrations went past it. Nothing could have caught it, because the name being
 * resolved was never compared against anything: not against the tile's name, and not against the disk.
 *
 * So there are two properties here, and they are different properties:
 *
 *   1. DERIVATION — an app a launcher tile opens takes that tile's icon, and cannot declare its own.
 *      Enforced in `sectionAppIconName`; checked here including the refusal, because a guarantee whose
 *      failing branch is never exercised is a guarantee nobody has seen fail.
 *   2. MATERIALIZATION — every name the product can resolve has BOTH theme files on disk, with the right
 *      fill. Checked across ALL of `CONTROL_SECTION_NAV`, not only the migrated four: Phase D has seven
 *      sections left, and the point is that the eighth cannot repeat the first.
 *
 * `fill` is part of (2) rather than cosmetics. `WebviewPanel.iconPath` renders the SVG literally with no
 * theme context, so a `currentColor` fill collapses to near-black and the icon is INVISIBLE on a dark
 * theme — a failure that looks exactly like the missing file this test was written for (`panelIcon.ts`).
 */
describe("t-icon — editor-tab icons are materialized, and derived from the launcher tile", () => {
  /** the two colors `scripts/panel-icon.mjs` substitutes, and the reason it exists. */
  const THEME_FILL: Record<string, string> = { light: "#424242", dark: "#C5C5C5" };

  const expectMaterialized = (name: string, why: string): void => {
    for (const [theme, fill] of Object.entries(THEME_FILL)) {
      const path = `media/icons/${theme}/${name}.svg`;
      expect(
        existsSync(path),
        `${why} resolves the tab icon "${name}", but ${path} does not exist — VS Code silently falls back to ` +
        `the generic webview icon. Run: node scripts/panel-icon.mjs ${name}`,
      ).toBe(true);
      const svg = readFileSync(path, "utf8");
      expect(
        svg.includes(`fill="${fill}"`),
        `${path} does not carry fill="${fill}". A tab icon is rendered with no theme context, so an ` +
        `inherited or currentColor fill is invisible on a ${theme === "dark" ? "dark" : "light"} theme. ` +
        `Regenerate it: node scripts/panel-icon.mjs ${name}`,
      ).toBe(true);
    }
  };

  it("every launcher tile's icon exists in both themes — including the sections Phase D has not migrated", () => {
    // Deliberately the WHOLE launcher, not just the apps that exist today. A migration's last step is
    // giving the app a tab, and the icon it will ask for is already named here — so the asset is a
    // precondition this test states now rather than a discovery the next migration makes in production.
    for (const tile of CONTROL_SECTION_NAV) expectMaterialized(tile.icon, `the "${tile.label}" launcher tile`);
  });

  it("every standalone app resolves an icon that exists", () => {
    for (const app of WEBVIEW_APPS) {
      if (app.host !== "section") continue;
      const name = sectionAppIconName(app, app.view === "task-detail" ? "note" : undefined);
      if (name === undefined) continue; // the dev fixture declares none — a tab with no icon is its own answer
      expectMaterialized(name, `the ${app.view} app`);
    }
  });

  it("an app the launcher opens wears the TILE's icon", () => {
    const backed = WEBVIEW_APPS.filter((a) => a.section !== undefined);
    // If this ever reaches zero the two assertions below pass vacuously and the derivation is unguarded.
    expect(backed.length, "no app declares a section — the derivation this file guards has no subject").toBeGreaterThan(0);
    for (const app of backed) {
      expect(sectionAppIconName(app)).toBe(controlSectionIcon(app.section!));
    }
  });

  it("declaring a second icon beside the tile's is REFUSED, not silently preferred", () => {
    const app = WEBVIEW_APPS.find((a) => a.section !== undefined)!;
    // The failing branch, exercised. A precedence rule ("the declared one wins", or "the tile wins") would
    // let the two drift again and only differ in which one you see — the defect either way.
    expect(() => sectionAppIconName(app, "hubot")).toThrow(/tab icon is the tile's/);
  });

  it("no launcher-backed panel declares an icon of its own", () => {
    // The refusal in `sectionAppIconName` is real, but it fires when a PANEL IS OPENED — so a panel that
    // re-declares its icon ships green and throws in front of a human. This is the same check against the
    // text that actually ships: each panel names its manifest row with a literal `webviewApp("<view>")`,
    // and a row with a `section` has no business also carrying an `iconName`.
    const sectioned = new Set(WEBVIEW_APPS.filter((a) => a.section !== undefined).map((a) => a.view));
    const offenders: string[] = [];
    for (const file of readdirSync("src/webview").filter((f) => f.endsWith("Panel.ts"))) {
      const text = readFileSync(`src/webview/${file}`, "utf8");
      const view = /webviewApp\("([a-z0-9-]+)"\)/.exec(text)?.[1];
      if (view === undefined || !sectioned.has(view)) continue;
      if (/\biconName:/.test(text)) offenders.push(`${file} (${view})`);
    }
    expect(
      offenders,
      "these panels back a launcher tile AND declare their own iconName — opening one throws. Delete the " +
      `line; the icon comes from CONTROL_SECTION_NAV: ${offenders.join(", ")}`,
    ).toEqual([]);
  });

  it("no panel resolves an icon name that has no file", () => {
    // The other doors into `panelIcon` — the panels this manifest does not drive (`AgentPanePanel`,
    // `SidebarPrototype`, Control itself, the plugin host). They pass a literal, so a text scan sees
    // exactly what ships; a name built at runtime would escape this, and none is.
    const scan = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? scan(`${dir}/${e.name}`) : e.name.endsWith(".ts") ? [`${dir}/${e.name}`] : []);

    const literals = new Map<string, string>();
    for (const file of scan("src")) {
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(/panelIcon\([^,)]+,\s*"([a-z0-9-]+)"\s*\)/g)) literals.set(m[1], file);
      for (const m of text.matchAll(/\biconName:\s*"([a-z0-9-]+)"/g)) literals.set(m[1], file);
    }
    expect(literals.size, "no literal icon name found in src — did panelIcon get renamed?").toBeGreaterThan(0);
    for (const [name, file] of literals) expectMaterialized(name, file);
  });
});
