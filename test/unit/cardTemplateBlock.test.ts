import { describe, expect, it, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { loadWebviewModule, renderStatic } from "../helpers/staticPreact.js";
import { CARD_PREVIEW_ROWS } from "../../src/sidebar/cardPreviewRows.js";

/**
 * SDD 479 phase 4 — the Settings block, checked where it can be checked without a browser.
 *
 * The block's own body renders statically (composer, errors, YAML). The PREVIEW cannot: it lives in a
 * shadow root, and `attachShadow` needs a DOM this suite does not have. So this file proves the two
 * properties that would make the preview wrong, and leaves "does it look right" to the human dogfood:
 *
 *  - the preview renders the sidebar's OWN `AgentRow` and links the sidebar's OWN stylesheet;
 *  - that stylesheet never reaches the Cockpit page, where it would restyle Control.
 */
const BLOCK = path.join(__dirname, "../../src/webview/cockpit/CardTemplateBlock.tsx");
const blockSource = readFileSync(BLOCK, "utf8");
const cockpitHost = readFileSync(path.join(__dirname, "../../src/webview/Cockpit.ts"), "utf8");

const STRINGS = {
  cardTemplateTitle: "Agent card layout",
  cardTemplateHint: "hint",
  cardTemplateBody: "body",
  cardTemplateYamlHint: "yaml hint",
  cardTemplateCopy: "Copy YAML",
  cardTemplateReset: "Reset to default",
  cardTemplateCriticalNote: "shown anyway when a row is in this state",
  cardTemplateInlineNote: "renders inside another element",
  settingsOpenConfig: "Open workspace settings",
} as unknown;

describe("SDD 479 phase 4 — the card template Settings block", () => {
  let CardTemplateBlock: (props: unknown) => unknown;
  beforeAll(async () => {
    CardTemplateBlock = (await loadWebviewModule(BLOCK)).CardTemplateBlock as typeof CardTemplateBlock;
  });

  it("lists every catalog component, per region, with what it shows", () => {
    const html = renderStatic(CardTemplateBlock({ s: STRINGS, onOpenConfig: () => {}, onOpenSettings: () => {} }));
    for (const region of ["header", "meta", "footer"]) {
      expect(html).toContain(`card-template-region-${region}`);
    }
    expect(html).toContain("card-template-toggle-branch");
    expect(html).toContain("card-template-toggle-auth-required");
    // the catalog's own words, not a second description
    expect(html).toContain("Live HEAD branch and drift (spec 384)");
  });

  it("says which components come back on their own, and which travel inside another", () => {
    const html = renderStatic(CardTemplateBlock({ s: STRINGS, onOpenConfig: () => {}, onOpenSettings: () => {} }));
    expect(html).toContain("shown anyway when a row is in this state");
    expect(html).toContain("renders inside another element");
  });

  it("shows the YAML to paste, and starts with nothing to override", () => {
    const html = renderStatic(CardTemplateBlock({ s: STRINGS, onOpenConfig: () => {}, onOpenSettings: () => {} }));
    expect(html).toContain("card-template-yaml");
    expect(html).toContain("settings:");
    expect(html).toContain("cardTemplate:");
    expect(html).toContain("nothing to override yet");
  });

  it("renders no error list while the composed template is valid", () => {
    const html = renderStatic(CardTemplateBlock({ s: STRINGS, onOpenConfig: () => {}, onOpenSettings: () => {} }));
    expect(html).not.toContain("card-template-errors");
  });

  it("previews with the sidebar's own component and stylesheet, in a shadow root", () => {
    // The three claims that make the preview trustworthy. Asserted on the source because the shadow
    // root itself needs a DOM: what matters is that no SECOND renderer or stylesheet exists.
    expect(blockSource).toMatch(/import \{ AgentRow \} from "\.\.\/sidebar\/App"/);
    expect(blockSource).toContain("attachShadow");
    expect(blockSource).toMatch(/<link rel="stylesheet" href=\{href\} \/>/);
    // and it renders the FIXTURE rows: the block takes no fleet input at all, so it cannot depend on
    // (or mutate) a running agent. Checked on its imports and props rather than on prose.
    expect(blockSource).toContain("CARD_PREVIEW_ROWS");
    expect(blockSource).not.toMatch(/import[^\n]*(FleetVM|AgentVM|sidebarFleetService)/);
    // SDD 479 phase 5 — the prop list grew (`onOpenSettings`, `inEffect`) but the property this
    // asserts did not: no FLEET input. `inEffect` is folder names and booleans reported by the host,
    // never a row — so the block still cannot depend on, or mutate, a running agent. The import guard
    // above is what actually enforces that; this only pins the shape it enforces it on.
    expect(blockSource).toMatch(/export function CardTemplateBlock\(\{\s*\n\s*s,\s*\n\s*onOpenConfig,\s*\n\s*onOpenSettings,\s*\n\s*inEffect,/);
  });

  it("keeps sidebar.css off the Cockpit page — it is shipped for the shadow root only", () => {
    // The URI ships on its OWN bootstrap global, never as a `__tachyonSectionStyles` key: everything
    // in that map is injected into <head> by loadSectionStylesheet (and cockpitCssParity.test.ts
    // enforces the pairing), which is precisely the leak this design avoids.
    expect(cockpitHost).toContain("__tachyonCardPreviewCss: uri(\"sidebar.css\")");
    const styleLinks = cockpitHost.slice(cockpitHost.indexOf("uri(\"codicon.css\")"), cockpitHost.indexOf("bootstrapGlobals"));
    expect(styleLinks).not.toContain("sidebar.css");
    const sectionStyles = /__tachyonSectionStyles:\s*\{([\s\S]*?)\n\s*\},/.exec(cockpitHost);
    expect(sectionStyles?.[1] ?? "").not.toContain("sidebar.css");
    const clientSources = [blockSource, readFileSync(path.join(__dirname, "../../src/webview/cockpit/App.tsx"), "utf8")].join("\n");
    expect(clientSources).not.toContain("loadSectionStylesheet(\"card-preview\")");
  });

  it("previews the states the spec asks for", () => {
    // healthy / attention / error / long names / no model — the preview's job is to show the card in
    // the states where a hidden badge would matter, not to show a happy row.
    expect(CARD_PREVIEW_ROWS.map((r) => r.id)).toEqual(["healthy", "attention", "error", "no-model", "long"]);
  });
});
