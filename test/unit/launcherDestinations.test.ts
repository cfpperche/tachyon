import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { CONTROL_SECTION_NAV } from "@tachyon/webview-ui/webview/sidebar/sectionNav.js";
import { COCKPIT_SECTION_ORDER } from "@tachyon/webview-ui/sections/model";
import { WEBVIEW_APPS } from "../../apps/vscode-extension/src/webview/webviewApps.js";

/**
 * SDD 485 C8 — every launcher tile lands somewhere LIVE, and no `tachyon.*` open command is left
 * pointing at a section nothing renders.
 *
 * The wiring exists (C4/C5 built it) but nothing guarded it, and Phase D flips ten more ids through
 * the same line in `extension.ts`'s `tachyon.openControl`. The failure it prevents is silent by
 * nature: a tile whose destination stopped rendering does not throw — it opens Control on a section
 * with no body, which reads as "the product is broken" rather than "someone forgot a line".
 *
 * The property, stated so a Phase D migration keeps it true by construction: the launcher lists what
 * a human can OPEN; `COCKPIT_SECTION_ORDER` lists what Control still RENDERS. A migration moves an id
 * from the second list into `WEBVIEW_APPS` without touching the first. So every tile must be backed
 * by exactly one of the two, and a tile backed by NEITHER is the dead path.
 */
describe("SDD 485 C8 — every launcher tile has a live destination", () => {
  const appSections = new Set(WEBVIEW_APPS.filter((a) => a.host === "section").map((a) => a.view));
  // t-53f20d owner dogfood: this tile is deliberately neither a Control section nor an app. The
  // existing launcher command hands it to the host, which opens highlighted Settings or arms and
  // opens the Integrated Browser depending on the gate.
  const HOST_ACTIONS = new Set(["design-mode"]);
  /**
   * `mission` (the Board) is the app whose bundle dir is `board`; the manifest keys on the
   * bundle dir, the launcher on the section id, so the seam needs an explicit mapping rather than a
   * guessed transform — two of the four migrated so far do not match, and no transform predicts which.
   *
   * t-icon — this map used to be WRITTEN HERE, one hand-added line per migration. It is now DERIVED: the
   * manifest row declares the `section` its tile opens, because a second consumer appeared that needed the
   * same fact (`sectionAppIconName`, resolving the editor-tab icon from the tile's). A fact two places
   * need is a fact that must be declared once, and the test is the wrong place to declare it — a mapping
   * only the test knows cannot be read by the product it describes.
   */
  const SECTION_TO_APP_VIEW: Record<string, string> = Object.fromEntries(
    WEBVIEW_APPS.filter((a) => a.section !== undefined).map((a) => [a.section!, a.view]),
  );
  const COMPATIBILITY_VIEW: Record<string, string> = {
    approvals: "human-inbox",
    validations: "human-inbox",
  };
  // SectionPanelManager hosts both launcher apps and document apps. The latter have a direct
  // command/action door instead of a launcher tile; keep that inventory explicit so a new section
  // app cannot silently omit both kinds of door. The fixture is the sole dev-only exception.
  const DIRECT_DOOR_APPS = new Set([
    "task-detail",
    "pin-preview",
    "terminal-studio-shell",
    "schedule-studio-shell",
    "agent-studio-shell",
    "handoff",
    "activity",
    "review",
    "probes",
    // t-505f13 — no launcher tile: the sidebar's unconfigured state and `tachyon.openOnboarding`
    // are this app's doors, which is what a direct-command port means here.
    "onboarding",
  ]);

  it("each tile is rendered by Control or backed by a standalone app — never neither", () => {
    const rendered = new Set<string>(COCKPIT_SECTION_ORDER);
    const dead = CONTROL_SECTION_NAV
      .filter((tile) => {
        if (HOST_ACTIONS.has(tile.id)) return false;
        if (rendered.has(tile.id)) return false;
        const view = SECTION_TO_APP_VIEW[tile.id] ?? tile.id;
        return !appSections.has(view);
      })
      .map((tile) => `${tile.id} ("${tile.label}")`);

    expect(dead, `launcher tiles with no destination — Control no longer renders them and no app in WEBVIEW_APPS claims them: ${dead.join(", ")}`).toEqual([]);
  });

  it("each tile is backed by exactly ONE of the two — a section in both places has two live renderers", () => {
    const rendered = new Set<string>(COCKPIT_SECTION_ORDER);
    const both = CONTROL_SECTION_NAV
      .filter((tile) => rendered.has(tile.id) && appSections.has(SECTION_TO_APP_VIEW[tile.id] ?? tile.id))
      .map((tile) => tile.id);

    // The spec's atomic-cutover rule, checked instead of remembered: Control's host state is global,
    // so a section living in both places means two subscriptions and two possible answers to one command.
    expect(both, `sections rendered by Control AND claimed by an app — the migration left both paths live: ${both.join(", ")}`).toEqual([]);
  });

  it("the section ids the open command routes to apps are the ones the manifest actually declares", () => {
    // extension.ts's `tachyon.openControl` branches on resolved section ids before falling through to
    // Control. A branch naming an id the manifest does not back is a redirect into nothing.
    const extension = readFileSync("apps/vscode-extension/src/extension.ts", "utf8");
    const open = /registerCommand\("tachyon\.openControl",[\s\S]*?\n    \}\)/.exec(extension)?.[0] ?? "";
    expect(open, "tachyon.openControl not found — did it move or get renamed?").not.toBe("");

    const routed = [...open.matchAll(/resolved === "([a-z-]+)"/g)].map((m) => m[1]);
    expect(routed.length, "no section is routed to an app — either the branch shape changed or C5's wiring is gone").toBeGreaterThan(0);

    // A section app's `view` is not its launcher door: the explicit `section` declaration is the
    // inventory that ties the app to the tile and lets the host route the id. Falling back to the
    // view name here would let an app (such as Keys) be present in the bundle while remaining
    // unreachable.
    const unbacked = routed.filter((id) => !HOST_ACTIONS.has(id) && !appSections.has(COMPATIBILITY_VIEW[id] ?? SECTION_TO_APP_VIEW[id] ?? ""));
    expect(unbacked, `tachyon.openControl routes these ids to an app, but WEBVIEW_APPS declares no such app: ${unbacked.join(", ")}`).toEqual([]);

    // and the other direction: an id moved to an app but never routed still opens Control, silently.
    const appBacked = CONTROL_SECTION_NAV
      .map((tile) => tile.id)
      .filter((id) => SECTION_TO_APP_VIEW[id] !== undefined);
    const unrouted = appBacked.filter((id) => !routed.includes(id));
    expect(unrouted, `these tiles are backed by an app but tachyon.openControl still falls through to Control for them: ${unrouted.join(", ")}`).toEqual([]);
  });

  it("gives every section-hosted app an explicit launcher or direct-command port", () => {
    const extension = readFileSync("apps/vscode-extension/src/extension.ts", "utf8");
    const open = /registerCommand\("tachyon\.openControl",[\s\S]*?\n    \}\)/.exec(extension)?.[0] ?? "";
    const sectionApps = WEBVIEW_APPS.filter((app) => app.host === "section");
    const missingPort = sectionApps.filter((app) =>
      app.view !== "section-app-fixture" && app.section === undefined && !DIRECT_DOOR_APPS.has(app.view),
    );
    expect(missingPort.map((app) => app.view), "every section app must have a launcher or direct-command door").toEqual([]);

    const routedApps = sectionApps.filter((app) => app.section !== undefined);
    const missingLauncherPort = routedApps.filter((app) => !CONTROL_SECTION_NAV.some((tile) => tile.id === app.section));
    expect(missingLauncherPort.map((app) => app.view), "launcher-backed section apps must point at a launcher tile").toEqual([]);

    const routedSectionIds = new Set(
      [...open.matchAll(/resolved === "([a-z-]+)"/g)].map((match) => match[1]),
    );
    const missingRoute = routedApps
      .filter((app) => app.section !== undefined && !routedSectionIds.has(app.section))
      .map((app) => `${app.view} (${app.section})`);
    expect(missingRoute, "every launcher-backed section app must be reachable through tachyon.openControl").toEqual([]);
  });
});
