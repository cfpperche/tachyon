import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";

/**
 * t-77607a — a panel host stays readable, checked instead of asked for.
 *
 * Twice in this migration series a panel arrived minified: `EnginePanel.ts` from D5 (18 lines, one of
 * 1014 chars — became t-f89c4c, which spawned t-002658 for three more files), and `FleetPanel.ts` from
 * D7, whose brief said in as many words not to do it and named D5 as the example. The second time is the
 * evidence that matters: the instruction was given, read, and did not hold.
 *
 * That is a mechanism problem, not a diligence problem. "Write readable code" cannot be checked, so it
 * degrades to a preference that survives exactly as long as whoever remembers it is reviewing. A line
 * budget CAN be checked, and it is a weak proxy for readability that happens to catch the one failure
 * this series actually produces: a whole config object, or a whole strings table, collapsed onto one
 * line.
 *
 * Why it is worth catching at all, when the code runs fine either way: these files are where this repo
 * keeps its DECISIONS. `HumanInboxPanel.ts` explains why its cardinality is what it is; `EnginePanel.ts`
 * (after repair) explains why its viewType is new and why its sheet is linked rather than copied. A
 * panel written as one line has nowhere to put that, so the reasoning goes to a task journal that the
 * next reader will not know to open.
 *
 * The threshold is measured, not guessed: 24 of the 25 panel hosts sit at 168 chars or less, and the two
 * minified ones were 884 and 1014. 200 separates them with room to spare, and does not ask anyone to
 * reformat working code.
 */
describe("t-77607a — panel hosts stay line-broken enough to hold their reasons", () => {
  const MAX_LINE = 200;

  /**
   * Pre-existing, and NOT grandfathered silently — the entry is the record. `PluginsPanel.ts` predates
   * this migration series (SDD 485 D2 migrated the plugins APP; this host is older), and reformatting it
   * inside a guard that exists for new work would mix an unrelated diff into the change that introduces
   * the rule. It is a real candidate for the same treatment as t-f89c4c, whenever someone touches it.
   */
  const GRANDFATHERED: ReadonlySet<string> = new Set(["PluginsPanel.ts"]);

  const panels = readdirSync("src/webview").filter((n) => n.endsWith("Panel.ts"));

  it("there are panel hosts to check — the guard is not vacuous", () => {
    expect(panels.length, "no *Panel.ts under src/webview — did the naming convention change?").toBeGreaterThan(5);
  });

  it("no panel host collapses a config object or a strings table onto one line", () => {
    const offenders: string[] = [];
    for (const name of panels) {
      if (GRANDFATHERED.has(name)) continue;
      const lines = readFileSync(`src/webview/${name}`, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (line.length > MAX_LINE) offenders.push(`${name}:${i + 1} (${line.length} chars)`);
      });
    }
    expect(
      offenders,
      `panel hosts with a line over ${MAX_LINE} chars — break it up so the decision can be written beside ` +
      `the code, which is where this repo keeps it: ${offenders.join(", ")}`,
    ).toEqual([]);
  });

  it("every grandfathered name still exists — a stale exemption is a hole", () => {
    // An exemption for a file that was renamed or deleted silently widens the guard's blind spot.
    for (const name of GRANDFATHERED) {
      expect(panels, `${name} is exempted but no longer exists — drop it from GRANDFATHERED`).toContain(name);
    }
  });
});
