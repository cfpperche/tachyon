import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * `t-61189b` — `rich-doc.css` may not declare a class selector that can match another surface.
 *
 * The sheet is lazily co-loaded into the Control panel and NEVER unloaded, so one Task/Pin Studio
 * visit leaves every rule live for the rest of the session. t-e085bc/t-ca31c2 already learned this
 * with a bare `main` that shredded the cockpit's native sections, and fixed the ELEMENT selectors.
 * The generic CLASS selectors stayed, and did it again: `.err { position: fixed }` matched
 * `.ds-badge.err` and tore Task Detail's missing-dependency badge out of its list to pin it at the
 * window bottom, while `.actions` reached 14 other surfaces and `.ds-degrade` — a design-system
 * class this sheet had no business redefining — dropped every Control loading state by 20vh.
 *
 * The rule checked here is the narrow one that prevents all of that: every class this sheet declares
 * carries an owned prefix. It is deliberately a property of the SHEET, not a list of known-bad names,
 * because the next collision will be a name nobody has thought of yet — `.card`, `.row`, `.panel`.
 */

const repoRoot = process.cwd();
const SHEET = "packages/webview-ui/src/webview/rich-doc/rich-doc.css";
const css = fs.readFileSync(path.join(repoRoot, ...SHEET.split("/")), "utf8");

/** Prefixes this sheet owns. `rd-` is the namespace; the other two are tiptap's own element classes. */
const OWNED = ["rd-", "rich-doc-", "tachyon-sketch-"];

/**
 * Third-party classes allowed ONLY as a descendant of an owned element, never as the leftmost
 * (matching) part of a selector — `.rd-att-annotated-badge .codicon` cannot escape the sheet's
 * elements, whereas a standalone `.codicon` would restyle every icon in the Control.
 */
const DESCENDANT_ONLY = ["codicon"];

/** Strip comments first: the header discusses `.err` and `.ds-degrade` by name on purpose. */
function declarations(): { selector: string; classes: string[] }[] {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: { selector: string; classes: string[] }[] = [];
  for (const match of withoutComments.matchAll(/(^|[}{])([^{}]+)\{/g)) {
    const selector = match[2].trim();
    if (!selector || selector.startsWith("@")) continue;
    const classes = [...selector.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1]);
    if (classes.length > 0) out.push({ selector, classes });
  }
  return out;
}

describe("t-61189b — rich-doc.css cannot reach outside its own surface", () => {
  it("finds real declarations, so the checks below cannot pass on an empty parse", () => {
    const found = declarations();
    expect(found.length).toBeGreaterThan(20);
    expect(found.some((d) => d.classes.includes("rd-err"))).toBe(true);
  });

  it("namespaces every class it declares", () => {
    const offences = declarations().flatMap(({ selector, classes }) =>
      classes
        .filter((name) => !OWNED.some((prefix) => name.startsWith(prefix)))
        // A descendant-only class is fine when something owned already anchors the selector.
        .filter((name) => !(DESCENDANT_ONLY.includes(name) && classes.some((c) => OWNED.some((p) => c.startsWith(p)))))
        .map((name) => `${selector}  →  .${name}`),
    );
    expect(offences, `${SHEET} must namespace these; an un-prefixed class leaks into all of Control`).toEqual([]);
  });

  it("never redefines a design-system class", () => {
    // `.ds-*` belongs to design-system.css. A surface sheet restyling one is the same leak wearing a
    // namespaced-looking name, so the prefix check above would not catch it on its own.
    const dsRules = declarations().filter((d) => d.classes.some((c) => c.startsWith("ds-")));
    expect(dsRules.map((d) => d.selector)).toEqual([]);
  });

  it("keeps the dead `.studio` root from coming back", () => {
    // It styled nothing (`class="studio"` exists nowhere in src/) and existed only to be inherited
    // by accident — the shape a namespace guard would otherwise wave through once renamed.
    expect(declarations().some((d) => d.classes.includes("studio"))).toBe(false);
  });

  it("leaves no owner markup still asking for a name the sheet no longer declares", () => {
    /**
     * The half a CSS-only guard cannot see. Renaming `.att-sketch-preview` in the sheet while some
     * markup still writes the old token leaves an element silently unstyled — the sheet is clean, the
     * guard above is green, and only a human looking at the pixels notices. This caught exactly that:
     * a class inside a JS expression rather than a `class="…"` literal survived the rename.
     */
    const LEGACY = ["studio", "bar", "eyebrow", "title", "actions", "toolbar", "slash", "drop", "att",
      "err", "missing", "editor-shell", "att-head", "att-thumb", "att-name", "att-actions",
      "att-sketch-preview", "att-annotated-badge", "sketch-modal", "sketch-bar", "sketch-host", "sketch-fail"];
    const owners = ["rich-doc", "task-studio", "pin-studio"];

    const offences: string[] = [];
    for (const owner of owners) {
      const dir = path.join(repoRoot, "src", "webview", owner);
      for (const entry of fs.readdirSync(dir)) {
        if (!entry.endsWith(".tsx") && !entry.endsWith(".ts")) continue;
        const source = fs.readFileSync(path.join(dir, entry), "utf8");
        // Literal `class="…"` AND every string inside a `class={…}` expression. Reading only the
        // first string of an expression is what let the original miss through: in
        // `class={a.kind === "excalidraw" ? "att-sketch-preview" : undefined}` the class is second.
        for (const match of source.matchAll(/class=(?:"([^"]*)"|\{([^}]*)\})/g)) {
          const literals = match[1] !== undefined
            ? [match[1]]
            : [...(match[2] ?? "").matchAll(/["'`]([^"'`]*)["'`]/g)].map((m) => m[1]);
          for (const token of literals.flatMap((value) => value.split(/\s+/)).filter(Boolean)) {
            if (LEGACY.includes(token)) offences.push(`${owner}/${entry}: "${token}"`);
          }
        }
      }
    }
    expect(offences, "these markup classes lost their styles when the sheet was namespaced").toEqual([]);
  });

  it("leaves Task Detail with no local defense against this sheet", () => {
    // The mitigation from t-5564b4 must not outlive its cause: a defense nobody can trace back to a
    // live bug is the thing that makes the next reader afraid to touch the CSS.
    const taskDetail = fs.readFileSync(path.join(repoRoot, "packages", "webview-ui", "src", "webview", "task-detail", "task-detail.css"), "utf8");
    expect(taskDetail).not.toContain(".ds-badge.err");
  });
});
