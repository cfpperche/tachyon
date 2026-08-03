import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { CONTROL_SECTION_NAV } from "../../src/cockpit/sectionNav.js";
import { COCKPIT_SECTION_ORDER } from "../../src/cockpit/model.js";
import { WEBVIEW_APPS } from "../../src/webview/webviewApps.js";

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
  /** `mission` (the Board) is the app whose bundle dir is `mission-control`; the manifest keys on the
   *  bundle dir, the launcher on the section id, so the seam needs one explicit map rather than a
   *  guessed transform. Phase D adds a line here per migration — deliberately, so the mapping is read
   *  rather than inferred. */
  const SECTION_TO_APP_VIEW: Record<string, string> = {
    mission: "mission-control",
    // SDD 485 D1 — the tmux tile's section id is `tmux`; its bundle directory has always been `inspector`
    // (and stayed that way through the migration, because renaming a directory inside a cutover buys
    // nothing). The second line in this map, and the second migration — exactly as this file predicted.
    tmux: "inspector",
    // SDD 485 D3 — the Runtime Ops tile's section id is `runtime` (it always has been: `COCKPIT_SECTION_ORDER`
    // and `TAB_META` both spell it that way), and its bundle directory is `runtime-ops`. Third line, third
    // migration. D2's Plugins needed none because its two names already agreed — which is the reason this map
    // is written out rather than derived: two of the four so far do not match, and no transform predicts which.
    runtime: "runtime-ops",
    // SDD 485 D4 — the Inbox tile's section id is `inbox`; its bundle directory has always been
    // `human-inbox` (the surface's product name is the Human Inbox; the tile is short for the grid).
    // Fourth line, fourth migration — and the third of five whose two names disagree.
    inbox: "human-inbox",
  };

  it("each tile is rendered by Control or backed by a standalone app — never neither", () => {
    const rendered = new Set<string>(COCKPIT_SECTION_ORDER);
    const dead = CONTROL_SECTION_NAV
      .filter((tile) => {
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
    const extension = readFileSync("src/extension.ts", "utf8");
    const open = /registerCommand\("tachyon\.openControl",[\s\S]*?\n    \}\)/.exec(extension)?.[0] ?? "";
    expect(open, "tachyon.openControl not found — did it move or get renamed?").not.toBe("");

    const routed = [...open.matchAll(/resolved === "([a-z-]+)"/g)].map((m) => m[1]);
    expect(routed.length, "no section is routed to an app — either the branch shape changed or C5's wiring is gone").toBeGreaterThan(0);

    const unbacked = routed.filter((id) => !appSections.has(SECTION_TO_APP_VIEW[id] ?? id));
    expect(unbacked, `tachyon.openControl routes these ids to an app, but WEBVIEW_APPS declares no such app: ${unbacked.join(", ")}`).toEqual([]);

    // and the other direction: an id moved to an app but never routed still opens Control, silently.
    const appBacked = CONTROL_SECTION_NAV
      .map((tile) => tile.id)
      .filter((id) => appSections.has(SECTION_TO_APP_VIEW[id] ?? id));
    const unrouted = appBacked.filter((id) => !routed.includes(id));
    expect(unrouted, `these tiles are backed by an app but tachyon.openControl still falls through to Control for them: ${unrouted.join(", ")}`).toEqual([]);
  });
});
