import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * t-cf477f — Task Detail must share Pin Detail's reading-column layout: bounded max-width,
 * auto horizontal margins, full width on narrow viewports. Fail-before was left-aligned
 * (`margin: 0` + `max-width: 82ch`) which parked the whole column on the left of wide Control
 * panes. Static CSS contract (same posture as embedPagePad / approvalCssScope).
 */

const root = path.resolve(__dirname, "../..");
const read = (rel: string) => fs.readFileSync(path.resolve(root, rel), "utf8");

function rules(css: string): { selector: string; body: string }[] {
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: { selector: string; body: string }[] = [];
  for (const m of bare.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    out.push({ selector: m[1].trim().replace(/\s+/g, " "), body: m[2] });
  }
  return out;
}

function rulesFor(css: string, selector: string): { selector: string; body: string }[] {
  return rules(css).filter((r) =>
    r.selector.split(",").some((part) => part.trim().replace(/\s+/g, " ") === selector),
  );
}

function declaration(body: string, prop: string): string | undefined {
  const m = body.match(new RegExp(`(?:^|;)\\s*${prop}\\s*:([^;]*)`, "i"));
  return m?.[1].trim();
}

function firstDecl(css: string, selector: string, prop: string): string | undefined {
  for (const r of rulesFor(css, selector)) {
    const v = declaration(r.body, prop);
    if (v !== undefined) return v;
  }
  return undefined;
}

describe("t-cf477f — Task Detail reading column matches Pin Detail centering", () => {
  const taskDetail = read("src/webview/task-detail/task-detail.css");
  const pinPreview = read("src/webview/pin-preview/pin-preview.css");

  it("Pin Detail (reference) centres its main column with max-width + auto margins", () => {
    // The human report names Pin Detail as the visual reference — lock that contract first so a
    // Task Detail change cannot "match" a broken reference.
    expect(firstDecl(pinPreview, "main", "max-width")).toBe("880px");
    expect(firstDecl(pinPreview, "main", "margin")).toMatch(/^0\s+auto$/);
  });

  it("Task Detail .td-root uses the same max-width measure as Pin Detail main", () => {
    expect(firstDecl(taskDetail, ".td-root", "max-width")).toBe(
      firstDecl(pinPreview, "main", "max-width"),
    );
  });

  it("Task Detail centres the column (auto horizontal margins), not left-parks it", () => {
    const margin = firstDecl(taskDetail, ".td-root", "margin");
    // Fail-before: `margin: 0` left a wide empty gutter on the right of Control at 1000/1400px.
    expect(margin).toMatch(/^0\s+auto$/);
    expect(margin).not.toBe("0");
  });

  it("stays responsive: width 100% + box-sizing so 760px viewports still fill", () => {
    expect(firstDecl(taskDetail, ".td-root", "width")).toBe("100%");
    expect(firstDecl(taskDetail, ".td-root", "box-sizing")).toBe("border-box");
  });

  it("keeps Fleet page pad tokens (does not invent a second pad system)", () => {
    const padding = firstDecl(taskDetail, ".td-root", "padding");
    expect(padding).toContain("var(--ds-page-pad-y)");
    expect(padding).toContain("var(--ds-page-pad-x)");
    expect(padding).toContain("var(--ds-page-pad-bottom)");
  });

  it("does not reintroduce a global layout rule — only .td-root is centred", () => {
    // Scope guard: a body/main { margin: 0 auto } would shift other Control embeds that co-load
    // sheets. The fix must stay on the Task Detail root.
    const bodies = rules(taskDetail).filter((r) =>
      r.selector.split(",").some((p) => {
        const s = p.trim();
        return s === "body" || s === "main" || s === ".ck-main" || s === ".ck-embed-host";
      }),
    );
    expect(bodies).toEqual([]);
  });

  it("App still mounts all sections under a single .td-root (shared axis/container)", () => {
    const app = read("src/webview/task-detail/App.tsx");
    expect(app).toMatch(/class=["']td-root["']/);
    // One root wrapper for metadata/body/notes/prototypes — not per-section recentering.
    const roots = app.match(/class=["']td-root["']/g) ?? [];
    expect(roots).toHaveLength(1);
  });
});
