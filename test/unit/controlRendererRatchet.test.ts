import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * SDD 485 Phase E — the ratchet that finishes the spec.
 *
 * The reason this file exists is a mistake, and the mistake is worth keeping written down: Phase E was
 * planned as "delete Control" on the belief that the launcher's twelve tiles were the list of things
 * Control renders. They are not. When the last two SECTIONS died (D16, approvals and validations),
 * `COCKPIT_SECTION_ORDER` went empty and Control still mounted four product surfaces — activity,
 * probes, handoff and the pin studio. Every one of them escaped sixteen migrations for the same
 * reason: no tile points at it, so no migration was ever handed one. An inventory built from what a
 * surface DECLARES cannot see what it RENDERS, which is this spec's recurring finding in a third
 * costume (the first two were the Phase A consumption check and the class guard's base-vs-descendant
 * hole).
 *
 * So the inventory is taken from the only thing that cannot lie about it: the `lazy()` calls in
 * Control's client. Preact requires those to be static top-level calls (see cockpit/App.tsx's own note
 * at the dispatch registry), so a renderer cannot hide behind a dynamic import.
 *
 * This is a RATCHET, deliberately, not an equality check. Shrinking is the goal and must never fail —
 * D17..D20 each strike one line, and two of them are in flight while this is written. Growing fails:
 * a surface added back to Control is a reversal of the whole spec and should have to argue for itself
 * in a diff to this list, not slip in beside an existing branch.
 */

const root = path.resolve(__dirname, "../..");
const COCKPIT_APP = "src/webview/cockpit/App.tsx";

/**
 * The four still mounted when the Phase E premise was corrected, each with the task that removes it.
 * Names are the lazy binding, matched against `const <name> = lazy(`.
 */
const REMAINING = {
  // EMPTY, as of D18 (2026-08-04) — and that is the finish line this file was written to detect.
  // Twenty migrations emptied it: D1 tmux, D2 Plugins, D3 Runtime Ops, D4 Human Inbox, D5 Engine,
  // D6 Worktrees, D7 Fleet, D8 Runtime Config, D9 Execution, D10 Settings, D11 Overview, D12-D14 the
  // studios and pins, D16 approvals/validations (which DIED rather than migrated), and the four this
  // file exists because of — D17 Activity, D18 Probes, D19 Handoff, D20 the last pin-studio door.
  //
  // The ratchet does not retire with the list. It now guards the opposite direction: Control is being
  // DELETED (E1), and until that lands, a renderer put back would silently give the host a reason to
  // survive. After E1 deletes `cockpit/App.tsx` this file's first two cases become vacuous and it
  // should be replaced by whatever guards "the host is gone" — decided in E1, not assumed here.
} as const;

function lazyRenderers(source: string): string[] {
  return [...source.matchAll(/const\s+(\w+)\s*=\s*lazy\(/g)].map((m) => m[1]).sort();
}

describe("SDD 485 Phase E — Control's renderer inventory only ever shrinks", () => {
  const source = fs.readFileSync(path.resolve(root, COCKPIT_APP), "utf8");
  const mounted = lazyRenderers(source);

  it("mounts no product surface that is not on the Phase E removal list", () => {
    const unknown = mounted.filter((name) => !(name in REMAINING));
    expect(
      unknown,
      `${COCKPIT_APP} mounts ${unknown.join(", ")}, which SDD 485 has no removal task for. ` +
      "Control is being emptied, not extended: put the surface in its own app (see any of D1-D19), " +
      "or add it here with the task that removes it and say in the spec why it went back in.",
    ).toEqual([]);
  });

  it("names, for each renderer still mounted, the task that removes it", () => {
    // The list is the finish line in machine-readable form: when this is empty, E1 can delete the host.
    for (const name of mounted) {
      expect(REMAINING[name as keyof typeof REMAINING]).toBeTruthy();
    }
    expect(mounted.length, "renderers still inside Control").toBeLessThanOrEqual(Object.keys(REMAINING).length);
  });

  it("still agrees with the fact that made Phase E's premise wrong: zero SECTIONS, non-zero renderers", () => {
    // If this ever reads as "sections exist again", the D-series was reverted and the ratchet above is
    // measuring the wrong thing — the two facts are only independent while the section list is empty.
    const model = fs.readFileSync(path.resolve(root, "src/cockpit/model.ts"), "utf8");
    const order = /COCKPIT_SECTION_ORDER:\s*CockpitSectionId\[\]\s*=\s*\[([^\]]*)\]/.exec(model);
    expect(order, "COCKPIT_SECTION_ORDER not found in src/cockpit/model.ts").not.toBeNull();
    expect(order?.[1].replace(/\s|\/\/.*$/gm, ""), "Control renders a section again").toBe("");
  });
});
