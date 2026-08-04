import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * t-dc9f64 / t-0739f7 — each standalone app owns its own page pad, and two Validations layout
 * contracts that a real visual defect paid for.
 *
 * WHY THIS FILE IS NAMED FOR APPS AND NOT FOR EMBEDS. It began as `embedPagePad.test.ts`, guarding
 * surfaces EMBEDDED IN CONTROL: `cockpit.css` stated the contract ("embed hosts stay pad-free; each
 * product root applies --ds-page-pad-*") and zeroed `.ck-embed-host > main` so a host would not
 * double-pad the div-rooted surfaces that already owned their pad. Validations and Runtime Ops root
 * their pages on <main> rather than <div>, so that guard stripped the very pad it existed to
 * preserve: both rendered flush at x=0 and at the right frame edge (.ds-page-chrome measured 0..1099
 * against Approvals' 16..1083).
 *
 * SDD 485 E1 deleted Control, and this file was deleted with it — which dropped SIX live guards to
 * retire ONE. The embed-host case is genuinely gone (there is no host to double-pad any more); the
 * rest are about apps that still ship, so they are restored here under a name that matches what they
 * actually assert. The lesson is the series' own: a file named for the vehicle looks disposable when
 * the vehicle goes, whatever it happens to cover.
 *
 * The two Validations cases are the ones worth not losing. Control co-loaded mission-control.css,
 * whose board strip declares UNSCOPED `.validation-list { display: flex }` and `.validation-summary
 * { white-space: nowrap }`. Those names collided with the Validations surface at equal specificity,
 * so the winner came down to stylesheet order — and losing it laid the pending cards out as
 * horizontal columns that clipped at the frame edge and collapsed `.validation-primary`'s grid,
 * gluing the id onto the title ("…non-empty queuev-8f1a02"). The collision source is gone, the
 * SHAPE those rules depend on is not, and it is what these assert.
 *
 * Static CSS-contract checks in the style of approvalCssScope.test.ts: they assert the shape the
 * rendered layout depends on, not a snapshot of the current pixels.
 */

const root = path.resolve(__dirname, "../..");
const read = (rel: string) => fs.readFileSync(path.resolve(root, rel), "utf8");

const VALIDATIONS_CSS = "src/webview/validations/validations.css";
const RUNTIME_OPS_CSS = "src/webview/runtime-ops/runtime-ops.css";
const HUMAN_INBOX_CSS = "src/webview/human-inbox/human-inbox.css";
const VALIDATIONS_APP = "src/webview/validations/App.tsx";
const DESIGN_SYSTEM_CSS = "src/webview/shared/design-system.css";

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

describe("Plugins owns its own page pad now that it is a standalone app (SDD 485 D2)", () => {
  it("the Plugins root consumes the shared Fleet page pad", () => {
    expect(read("src/webview/plugins/App.tsx")).toMatch(/class="ck-plugins-root ds-page"/);
    expectPagePad(read(DESIGN_SYSTEM_CSS), ".ds-page");
  });



  it("PluginsApp still owns exactly one .ck-plugins-root as its own render root", () => {
    const app = read("src/webview/plugins/App.tsx");
    expect(app.match(/class="ck-plugins-root ds-page"/g)?.length).toBe(2); // loading branch + loaded branch, each a single root
  });
});

/**
 * SDD 485 D3 — the same page-pad contract for Runtime Ops, and it is the INVERSE of D2's.
 *
 * D2 found the pad rule living in `cockpit.css` — the sheet a standalone app does not link — so the rule
 * had to MOVE or Plugins shipped flush against the tab edge at every width. The first thing this task did
 * was run D2's parting instruction (`grep -n "<root class>" src/webview/cockpit/cockpit.css`) and the
 * answer came back different: `.runtime-ops`'s `--ds-page-pad-*` rule was always in `runtime-ops.css`.
 * What `cockpit.css` provided was only embed-context NEUTRALIZATION — `.ck-embed-host > .runtime-ops`
 * with `flex`/`min-height`/`width`/`margin` — and this sheet answered it with a `!important` re-assert of
 * its own pad (t-0739f7), because `.ck-embed-host > main { padding: 0 !important }` outranked the bare
 * root rule.
 *
 * Both of those are dead the moment there is no embed host, and BOTH SIDES are asserted here rather than
 * one: a leftover in `cockpit.css` would be a rule with no element to match and would make the real owner
 * ambiguous for the next reader, and a leftover here would be a rule keyed to a host that no longer wraps
 * this surface. The grep is worth ten seconds on every remaining Phase D migration, and the answer can be
 * "a rule to delete" as readily as "a rule to move".
 */
describe("Runtime Ops owns its own page pad now that it is a standalone app (SDD 485 D3)", () => {
  const runtimeOps = read(RUNTIME_OPS_CSS);


  it("runtime-ops.css no longer re-asserts the pad for an embed host that cannot exist", () => {
    // The other half of the same deletion. Keeping it would be harmless CSS and a live lie about where
    // this surface renders — exactly the residue t-17d885 was about, one sheet over.
    expect(rulesFor(runtimeOps, ".ck-embed-host > main.runtime-ops")).toHaveLength(0);
  });


  it("the app links the sheet that owns the pad, and no page frame it does not anchor to", () => {
    // The pad is only real if the app actually LINKS the sheet carrying it — the Phase A consumption
    // check reads `#root` height chains and cannot see a pad, which is why this is asserted here.
    const host = read("src/webview/RuntimeOpsPanel.ts");
    const block = /\bstyleFiles:\s*\[([\s\S]*?)\]/.exec(host);
    expect(block, "src/webview/RuntimeOpsPanel.ts: no `styleFiles: [...]` array found").not.toBeNull();
    const linked = [...block![1].matchAll(/["'`]([^"'`]+\.css)["'`]/g)].map((m) => m[1]);
    expect(linked).toContain("runtime-ops.css");
    // and NOT page-frame.css: runtime-ops.css anchors `#root` to nothing, so linking the frame would
    // fail webviewConvention's mirror rule and put a scrolling document inside `overflow: hidden`.
    expect(linked).not.toContain("page-frame.css");
  });
});

describe("the Human Inbox owns its own page pad, and always did (SDD 485 D4)", () => {
  const inbox = read(HUMAN_INBOX_CSS);

  /**
   * D2's parting instruction — grep `cockpit.css` for your surface's root class before anything else —
   * has now produced three DIFFERENT answers in three migrations, and that is the fact worth recording
   * here rather than the outcome:
   *
   *   D2 Plugins     `.ck-plugins-root`'s pad LIVED in cockpit.css        → a rule to MOVE
   *   D3 Runtime Ops `.runtime-ops` had embed neutralization + a re-assert → two rules to DELETE
   *   D4 Human Inbox `.hi-root` appears in cockpit.css NOWHERE            → nothing to do
   *
   * The third answer is the one a future migration is most likely to get wrong, because "the grep came
   * back empty" reads like the check did not run. It did: `.hi-root` is a `div`, and cockpit.css's embed
   * neutralization is `.ck-embed-host > main`, which reaches `<main>`-rooted surfaces only. So this
   * surface never consumed anything from the sheet it was about to stop linking — which is what the pad
   * MEASUREMENT in the visual pass confirms, since a static test cannot.
   */
  it("the Inbox root consumes the shared Fleet page pad", () => {
    expect(read("src/webview/human-inbox/App.tsx")).toContain("hi-root ds-page");
    expectPagePad(read(DESIGN_SYSTEM_CSS), ".ds-page");
  });


  it("human-inbox.css carries no embed re-assert for a host that cannot exist", () => {
    // The mirror of D3's deletion, asserted even though there was nothing to delete: if a future edit
    // adds one it is dead CSS and a live lie about where this surface renders.
    expect(rulesFor(inbox, ".ck-embed-host > main.hi-root")).toHaveLength(0);
    expect(rulesFor(inbox, ".ck-embed-host > .hi-root")).toHaveLength(0);
  });


  it("the app links the sheet that owns the pad, and no page frame it does not anchor to", () => {
    const host = read("src/webview/HumanInboxPanel.ts");
    const block = /\bstyleFiles:\s*\[([\s\S]*?)\]/.exec(host);
    expect(block, "src/webview/HumanInboxPanel.ts: no `styleFiles: [...]` array found").not.toBeNull();
    const linked = [...block![1].matchAll(/["\'`]([^"\'`]+\.css)["\'`]/g)].map((m) => m[1]);
    expect(linked).toContain("human-inbox.css");
    // and NOT page-frame.css. For THIS surface that is not merely the default: the detail route renders
    // evidence a human did not choose the dimensions of, and `overflow: hidden` would put it out of reach.
    expect(linked).not.toContain("page-frame.css");
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
