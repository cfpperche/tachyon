/**
 * t-e085bc / t-ca31c2 — no webview stylesheet may style bare LAYOUT elements (html/body/main/
 * aside/header/footer/nav/section/article) unless it is an allowlisted owner of that element.
 *
 * Why this exists: Control lazily co-loads section/studio stylesheets and NEVER unloads them
 * (lazySectionStyles is additive by design). A bare `main { display: grid; ... 260px }` in
 * rich-doc.css therefore leaked into `main.ck-main` after any Task/Pin Studio visit and shredded
 * every NATIVE cockpit section (the embeds survived only because `.ck-main--embed` sets its own
 * display) — the exact "CSS breaks after leaving Pin Studio" field report. Class selectors are
 * already conventionally prefixed per-surface; ELEMENT selectors are the invisible leak this
 * guard closes.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const WEBVIEW_ROOT = path.resolve("src/webview");

/** Sheets that legitimately own bare layout elements, with the reason. */
const BARE_ELEMENT_OWNERS: Record<string, string> = {
  "shared/design-system.css": "the ONE base sheet every webview links first — owns body defaults by contract",
  "shared/vscode-theme.css": "theme token bridge — may restyle base elements for vendor parity",
  "cockpit/cockpit.css": "the Control shell owner — pins html/body with !important, linked last by contract",
  "sidebar/sidebar.css": "standalone sidebar app — sole stylesheet of its own document",
  "shared/mermaid-block.css": "read-only rendered-markdown region — scopes via :where() internally where needed",
  "pin-preview/pin-preview.css": "standalone-by-standing-exception (SDD 410: static preview, never co-loaded into Control) — owns its own document",
};

const LAYOUT_ELEMENTS = ["html", "body", "main", "aside", "header", "footer", "nav", "section", "article"];

function cssFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) return cssFiles(abs);
    return entry.isFile() && entry.name.endsWith(".css") ? [abs] : [];
  });
}

/** Strip comments, then yield every selector list in the sheet (including inside @media blocks). */
function selectorLists(css: string): string[] {
  const noComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const selectors: string[] = [];
  // Walk rule-by-rule: a selector is the text between a boundary ({ } or ;) and the next "{",
  // excluding at-rule preludes (@media/@supports/@keyframes headers).
  const re = /(?:^|[{};])\s*([^{};@][^{}]*?)\s*\{/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(noComments)) !== null) {
    selectors.push(match[1]!.trim());
  }
  return selectors;
}

/** Does any compound in the selector list target a bare layout element (no class/id/attr qualifier)? */
function bareLayoutOffenders(selectorList: string): string[] {
  return selectorList
    .split(",")
    .map((s) => s.trim())
    .filter((sel) => {
      // Only the FINAL compound of each complex selector actually receives the styles.
      const finalCompound = sel.split(/[\s>+~]+/).filter(Boolean).at(-1) ?? "";
      const element = finalCompound.match(/^([a-zA-Z][a-zA-Z0-9-]*)/)?.[1]?.toLowerCase();
      if (!element || !LAYOUT_ELEMENTS.includes(element)) return false;
      // Qualified (main.ck-main, body[data-x], main:has(...)) is scoped enough; bare is the leak.
      const rest = finalCompound.slice(element.length);
      return rest === "" || /^::?[a-zA-Z-]+$/.test(rest); // bare, or bare + pseudo only
    });
}

describe("webview CSS scope guard (t-e085bc)", () => {
  it("no co-loadable webview sheet styles bare layout elements", () => {
    const offenders: string[] = [];
    for (const file of cssFiles(WEBVIEW_ROOT)) {
      const rel = path.relative(WEBVIEW_ROOT, file).split(path.sep).join("/");
      if (rel in BARE_ELEMENT_OWNERS) continue;
      const css = fs.readFileSync(file, "utf8");
      for (const list of selectorLists(css)) {
        for (const bare of bareLayoutOffenders(list)) {
          offenders.push(`${rel}: "${bare}" (in "${list}")`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("every allowlist entry still exists and has a reason", () => {
    for (const [rel, reason] of Object.entries(BARE_ELEMENT_OWNERS)) {
      expect(reason.length, `${rel} needs a non-empty reason`).toBeGreaterThan(10);
      expect(fs.existsSync(path.join(WEBVIEW_ROOT, rel)), `${rel} listed but missing`).toBe(true);
    }
  });
});
