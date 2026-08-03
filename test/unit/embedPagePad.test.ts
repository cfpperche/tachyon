import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * t-dc9f64 / t-0739f7 — Control-embedded surfaces must match the Fleet/Approvals page baseline.
 *
 * cockpit.css states the contract: "Embed hosts stay pad-free; each product root applies
 * --ds-page-pad-*". To keep a host from double-padding the div-rooted surfaces that already own that
 * pad (.approval-root / .insp-root), cockpit.css also zeroes `.ck-embed-host > main { padding: 0
 * !important }`. Validations and Runtime Ops root their pages on <main> rather than <div>, so that
 * guard stripped the very pad it exists to preserve: both rendered flush at x=0 and at the right frame
 * edge (.ds-page-chrome measured 0..1099 against Approvals' 16..1083).
 *
 * Separately, Control co-loads mission-control.css, whose board strip declares UNSCOPED
 * `.validation-list { display: flex }` and `.validation-summary { white-space: nowrap }`. Those class
 * names collide with the Validations surface at equal specificity, so the winner came down to
 * stylesheet order — and losing it laid the pending cards out as horizontal columns that clipped at the
 * frame edge and collapsed `.validation-primary`'s grid, gluing the validation id onto the title
 * ("…non-empty queuev-8f1a02").
 *
 * These are static CSS-contract checks in the style of approvalCssScope.test.ts: they assert the shape
 * the rendered layout depends on, not a snapshot of the current pixels.
 */

const root = path.resolve(__dirname, "../..");
const read = (rel: string) => fs.readFileSync(path.resolve(root, rel), "utf8");

const VALIDATIONS_CSS = "src/webview/validations/validations.css";
const RUNTIME_OPS_CSS = "src/webview/runtime-ops/runtime-ops.css";
const VALIDATIONS_APP = "src/webview/validations/App.tsx";
const COCKPIT_APP = "src/webview/cockpit/App.tsx";

/** strip comments, then collect every `selector { declarations }` block (nested at-rule inner rules included). */
function rules(css: string): { selector: string; body: string }[] {
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: { selector: string; body: string }[] = [];
  for (const m of bare.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    out.push({ selector: m[1].trim().replace(/\s+/g, " "), body: m[2] });
  }
  return out;
}

/** every rule whose selector list contains `selector` as one of its comma-separated parts. */
function rulesFor(css: string, selector: string): { selector: string; body: string }[] {
  return rules(css).filter((r) => r.selector.split(",").some((part) => part.trim().replace(/\s+/g, " ") === selector));
}

function declaration(body: string, prop: string): string | undefined {
  const m = body.match(new RegExp(`(?:^|;)\\s*${prop}\\s*:([^;]*)`, "i"));
  return m?.[1].trim();
}

const PAD_VARS = ["--ds-page-pad-y", "--ds-page-pad-x", "--ds-page-pad-bottom"];

/** the page pad is three distinct tokens (top / inline / bottom) — a rule that names only some of them
 *  is not the Fleet baseline, so all three are required rather than "mentions --ds-page-pad". */
function expectPagePad(css: string, selector: string, opts: { important?: boolean } = {}) {
  const matched = rulesFor(css, selector);
  expect(matched, `no rule found for \`${selector}\``).not.toHaveLength(0);
  const padding = matched.map((r) => declaration(r.body, "padding")).find((v) => v !== undefined);
  expect(padding, `\`${selector}\` declares no padding`).toBeDefined();
  for (const v of PAD_VARS) expect(padding).toContain(`var(${v})`);
  if (opts.important) expect(padding).toMatch(/!\s*important/);
}

describe("Control embed page padding (t-dc9f64, t-0739f7)", () => {
  const validations = read(VALIDATIONS_CSS);
  const runtimeOps = read(RUNTIME_OPS_CSS);

  it("the Validations root applies the Fleet page pad standalone", () => {
    expectPagePad(validations, ".validations-main");
  });

  it("the Runtime Ops root applies the Fleet page pad standalone", () => {
    expectPagePad(runtimeOps, ".runtime-ops");
  });

  // `.ck-embed-host > main { padding: 0 !important }` (cockpit.css) outranks the bare root rule above on
  // both specificity and !important, so each <main>-rooted surface must re-assert its own pad in the
  // embedded context. Matching !important at higher specificity is what actually wins the cascade.
  it("the Validations root re-asserts the page pad inside a Control embed host", () => {
    expectPagePad(validations, ".ck-embed-host > main.validations-main", { important: true });
  });

  it("the Runtime Ops root re-asserts the page pad inside a Control embed host", () => {
    expectPagePad(runtimeOps, ".ck-embed-host > main.runtime-ops", { important: true });
  });

  // the host owning no padding is the other half of the contract: if a surface ever re-added a pad on
  // .ck-embed-host itself, both layers would apply and the embed would sit at 32px, not 16px.
  it("neither surface pads the embed host itself", () => {
    for (const css of [validations, runtimeOps]) {
      for (const r of rules(css)) {
        const padsHost = r.selector
          .split(",")
          .some((part) => /(^|\s)\.ck-embed-host\s*$/.test(part.trim()));
        if (padsHost) expect(declaration(r.body, "padding")).toBeUndefined();
      }
    }
  });
});

/**
 * SDD 485 D2 — the same page-pad contract, RETARGETED, because the surface it is about moved.
 *
 * Until this migration the claim was about Control: `cockpit/App.tsx` once wrapped <PluginsApp> in its own
 * extra `<div class="ck-plugins-root">` while plugins/App.tsx already rooted ITS render on that class, so
 * the pad applied twice (maintainer dogfood, 2026-07-23). There is no Control branch to double-pad any
 * more — Plugins is a standalone app.
 *
 * What replaced it is the failure this migration could actually have shipped, and nearly did: the pad
 * rule lived in `cockpit.css` (`.ck-embed-host > .ck-plugins-root, .ck-plugins-root { padding:
 * var(--ds-page-pad-*) }`), and a standalone app does not link `cockpit.css`. Without moving the rule the
 * whole surface renders flush against the tab edge, at every width, on every fixture.
 *
 * This is t-32c872's shape one property over — a surface CONSUMING page chrome another sheet provides —
 * and the Phase A consumption check in `webviewConvention.test.ts` cannot see it: that check reads `#root`
 * percentage-height chains, and a missing pad is neither a height nor a chain. So it is asserted here,
 * beside the identical claim this file already makes for Validations and Runtime Ops, which is where a
 * reader looking for "who owns this surface's page pad" already looks.
 */
describe("Plugins owns its own page pad now that it is a standalone app (SDD 485 D2)", () => {
  const plugins = read("src/webview/plugins/plugins.css");

  it("the Plugins root applies the Fleet page pad from its OWN stylesheet", () => {
    expectPagePad(plugins, ".ck-plugins-root");
  });

  it("cockpit.css no longer pads it — a rule with no element left to match", () => {
    // The other half of the move: a copy left behind would be dead in Control and would make the real
    // owner ambiguous the next time someone reads for it.
    const cockpit = read("src/webview/cockpit/cockpit.css");
    for (const r of rules(cockpit)) {
      expect(
        r.selector.split(",").some((part) => part.trim().endsWith(".ck-plugins-root")),
        `cockpit.css still styles .ck-plugins-root (\`${r.selector}\`) — Plugins left Control in SDD 485 D2`,
      ).toBe(false);
    }
  });

  it("Control renders no Plugins section to pad in the first place", () => {
    // The cutover half: two live renderers is what spec.md forbids, and a surviving branch here is how
    // one would come back without any test noticing.
    expect(read(COCKPIT_APP)).not.toContain('section === "plugins"');
  });

  it("PluginsApp still owns exactly one .ck-plugins-root as its own render root", () => {
    const app = read("src/webview/plugins/App.tsx");
    expect(app.match(/class="ck-plugins-root"/g)?.length).toBe(2); // loading branch + loaded branch, each a single root
  });
});

describe("Validations pending list flows vertically (t-dc9f64)", () => {
  const css = read(VALIDATIONS_CSS);

  it("the pending list is a single full-width column, not a horizontal flow", () => {
    const matched = rulesFor(css, ".validations-main .validation-list");
    expect(matched, "no root-scoped rule for the validation list").not.toHaveLength(0);
    const body = matched.map((r) => r.body).join(";");
    expect(declaration(body, "display")).toBe("grid");
    expect(declaration(body, "grid-auto-flow")).toBe("row");
    // one column: a multi-column template would reintroduce the side-by-side cards.
    expect(declaration(body, "grid-template-columns")).toBe("minmax(0, 1fr)");
    // and it must not be the flex row mission-control.css declares for its board strip.
    expect(declaration(body, "display")).not.toBe("flex");
    expect(declaration(body, "flex-direction")).toBeUndefined();
  });

  it("no unscoped .validation-* rule is left to lose a load-order coin flip with mission-control.css", () => {
    // mission-control.css declares `.validation-list` and `.validation-summary` globally. Any rule here
    // that is not rooted under .validations-main ties it on specificity and is decided by link order.
    const unscoped = rules(css)
      .flatMap((r) => r.selector.split(","))
      .map((part) => part.trim())
      .filter((part) => /(^|\s|>)\.validation-/.test(part))
      .filter((part) => !part.includes(".validations-main"));
    expect(unscoped).toEqual([]);
  });

  it("mission-control.css still owns the unscoped names this scoping defends against", () => {
    // guards the premise: if mission-control.css ever scopes its own board rules, this test's rationale
    // changes and should be revisited rather than silently protecting against nothing.
    const mc = read("src/webview/mission-control/mission-control.css");
    expect(rulesFor(mc, ".validation-list")).not.toHaveLength(0);
    expect(rulesFor(mc, ".validation-summary")).not.toHaveLength(0);
  });
});

describe("Validations title and id stay visually separate (t-dc9f64)", () => {
  const css = read(VALIDATIONS_CSS);
  const app = read(VALIDATIONS_APP);

  it("the row renders the id in its own element, a sibling of the title element", () => {
    // The separation is structural, not a text node: `<strong>{item.title}</strong>` followed by
    // `<span class="validation-id">{item.id}</span>`. Adjacent text nodes would render glued no matter
    // what the stylesheet says.
    expect(app).toMatch(/<strong>\{item\.title\}<\/strong>\s*<span class="validation-id">\{item\.id\}<\/span>/);
  });

  it("the title/id container stacks its children with a gap", () => {
    const matched = rulesFor(css, ".validations-main .validation-primary");
    expect(matched, "no root-scoped rule for .validation-primary").not.toHaveLength(0);
    const body = matched.map((r) => r.body).join(";");
    expect(declaration(body, "display")).toBe("grid");
    // grid + a gap is what puts the id on its own line under the title; without both they run together.
    expect(declaration(body, "gap")).toBeDefined();
    expect(declaration(body, "gap")).not.toBe("0");
  });
});
