import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { cx } from "../../src/webview/shared/ui/cx.js";

// spec 282 — the component-kit ENFORCEMENT guard (the product, not a nice-to-have): a MIGRATED view's *.tsx may not
// hand-apply the design-system component classes the kit owns (ds-btn*/ds-tab/ds-chip/chip) — use <Button>/<Tabs>/
// <Chip>. Scoped to a migrated-view MANIFEST (never fails an un-migrated panel); the kit (shared/ui/**) is the only
// place that legitimately applies the classes (it's outside the scan). Grows as later lanes migrate more panels.

/** views migrated to the kit in spec 282 (grows per lane). Handoff/inspector/activity/pin-studio/plugins use the kit Button/Tabs; probes/pin-preview/sidebar are kit-compliant
 *  (bespoke tree/read-only controls, zero banned tokens) and locked here against future ds-btn/ds-tab/chip drift. */
const MIGRATED_VIEWS = [
  "handoff",
  "inspector",
  "activity",
  "pin-studio",
  "plugins",
  "probes",
  "pin-preview",
  "sidebar",
  "cockpit",
  "approval",
  "validations",
  "runtime-ops",
  "mission-control",
  "task-detail",
  "pipeline-studio",
];

/** a class TOKEN the kit owns — banned in a migrated view's authoring code (`chips`/`ds-tabs` containers are fine). */
const BANNED = /\b(ds-btn|ds-tab|ds-chip|chip)\b/;

/** extract the class-attribute / cx() literal contents from a .tsx, where a banned token would be a bypass. */
function classLiterals(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/class=(?:"([^"]*)"|\{`([^`]*)`\})|cx\(([^)]*)\)/g)) {
    out.push(m[1] ?? m[2] ?? m[3] ?? "");
  }
  return out;
}

describe("component-kit enforcement guard (spec 282)", () => {
  it("no migrated view hand-applies a kit-owned class (ds-btn/ds-tab/ds-chip/chip) — use the component", () => {
    const violations: string[] = [];
    for (const view of MIGRATED_VIEWS) {
      const dir = `src/webview/${view}`;
      expect(existsSync(dir), `migrated view ${view} missing`).toBe(true);
      for (const f of readdirSync(dir).filter((x) => x.endsWith(".tsx"))) {
        for (const lit of classLiterals(readFileSync(`${dir}/${f}`, "utf8"))) {
          if (BANNED.test(lit)) violations.push(`${view}/${f}: class literal "${lit.slice(0, 40)}" — use the kit component`);
        }
      }
    }
    expect(violations, violations.join("\n")).toEqual([]);
  });

  it("the detector CATCHES a bypass (negative fixture)", () => {
    expect(classLiterals('<button class="ds-btn ds-btn-primary">x</button>').some((l) => BANNED.test(l))).toBe(true);
    expect(classLiterals('<span class={`chip${a ? " active" : ""}`}>x</span>').some((l) => BANNED.test(l))).toBe(true);
    expect(classLiterals('<button class={cx("ds-tab", on && "active")}>x</button>').some((l) => BANNED.test(l))).toBe(true);
    // containers + non-kit classes are NOT flagged
    expect(classLiterals('<div class="chips"><div class="ds-tabs"><span class="ds-badge ok">x</span>').some((l) => BANNED.test(l))).toBe(false);
  });
});

describe("cx (spec 282 — frozen)", () => {
  it("joins truthy strings in order, drops falsey", () => {
    expect(cx("a", false, "b", null, undefined, "c")).toBe("a b c");
    expect(cx("ds-btn", true && "ds-btn-primary")).toBe("ds-btn ds-btn-primary");
    expect(cx("ds-tab", false && "active")).toBe("ds-tab");
    expect(cx()).toBe("");
  });
});
