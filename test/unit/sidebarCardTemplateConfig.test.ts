import { describe, expect, it } from "vitest";
import { parseConfig } from "../../src/config/loadConfig.js";
import { CARD_TEMPLATE_VERSION, DEFAULT_CARD_TEMPLATE, parseCardTemplate } from "../../src/sidebar/cardTemplate.js";

/**
 * SDD 479 phase 2 — writing a card template in `tachyon.yml`.
 *
 * The load-bearing claim here is about SEVERITY, not just shape. In this loader any `errors` entry
 * refuses the WHOLE file (`if (errors.length > 0) return { errors, warnings }`), which drops the
 * workspace to ledger/last-known-good and makes spawning read-only. A cosmetic layout typo must not do
 * that — so a malformed template is refused whole, reported by name, and the card falls back to the
 * default while everything else in the file keeps working. Both halves are asserted: the template is
 * gone AND the agents are still there.
 */
// A minimal roster that loads clean, so every error in these cases comes from the template alone.
const BASE = `terminals:\n  dev:\n    cmd: bash\n`;

function load(settings: string) {
  return parseConfig(`${BASE}${settings}`);
}

describe("SDD 479 phase 2 — settings.sidebar.cardTemplate", () => {
  it("accepts a template and hands it to the sidebar", () => {
    const result = load(`settings:
  sidebar:
    cardTemplate:
      version: 1
      meta: [branch, verify, harness]
`);
    expect(result.errors).toEqual([]);
    expect(result.config?.settings.sidebar?.cardTemplate?.base.meta).toEqual(["branch", "verify", "harness"]);
    // A region the template does not mention keeps the default, so a person reordering badges does not
    // silently lose their actions row.
    expect(result.config?.settings.sidebar?.cardTemplate?.base.footer).toEqual(DEFAULT_CARD_TEMPLATE.footer);
    expect(result.config?.settings.sidebar?.cardTemplate?.base.header).toEqual(DEFAULT_CARD_TEMPLATE.header);
  });

  it("honors an explicitly empty region — `[]` is a sentence, silence is not", () => {
    const result = load(`settings:
  sidebar:
    cardTemplate:
      version: 1
      meta: []
`);
    expect(result.errors).toEqual([]);
    expect(result.config?.settings.sidebar?.cardTemplate?.base.meta).toEqual([]);
  });

  it("refuses an unknown component BY NAME, lists the catalog, and keeps the rest of the file working", () => {
    const result = load(`settings:
  sidebar:
    cardTemplate:
      version: 1
      meta: [branch, cpu-graph]
`);
    // the file still LOADS: the roster and everything else in it are untouched
    expect(result.errors).toEqual([]);
    expect(result.config?.agents.dev).toBeDefined();
    // …and the template is gone WHOLE, not half-applied to the ids that parsed
    expect(result.config?.settings.sidebar?.cardTemplate).toBeUndefined();
    const refusal = result.config?.settings.sidebar?.cardTemplateRefusal ?? [];
    expect(refusal.join("\n")).toContain("cpu-graph");
    expect(refusal.join("\n")).toContain("settings.sidebar.cardTemplate.meta[1]");
    expect(refusal.join("\n")).toContain("the catalog is");
    // and the human is told, with the fallback spelled out
    expect(result.warnings.join("\n")).toContain("the sidebar is using the default card layout");
  });

  it("refuses a component placed in the wrong region", () => {
    const result = load(`settings:
  sidebar:
    cardTemplate:
      version: 1
      header: [status-dot, branch]
`);
    expect(result.config?.settings.sidebar?.cardTemplateRefusal?.join("\n")).toContain("belongs to the meta region");
  });

  it("refuses a duplicate id in one region", () => {
    const result = load(`settings:
  sidebar:
    cardTemplate:
      version: 1
      meta: [branch, verify, branch]
`);
    expect(result.config?.settings.sidebar?.cardTemplateRefusal?.join("\n")).toContain("duplicate component 'branch'");
  });

  it("refuses an unknown schema version instead of guessing what its author meant", () => {
    const result = load(`settings:
  sidebar:
    cardTemplate:
      version: 7
      meta: [branch]
`);
    expect(result.config?.settings.sidebar?.cardTemplateRefusal?.join("\n")).toContain("unknown template version 7");
  });

  it("refuses a template with no version at all", () => {
    const result = load(`settings:
  sidebar:
    cardTemplate:
      meta: [branch]
`);
    expect(result.config?.settings.sidebar?.cardTemplateRefusal?.join("\n")).toContain("version: required");
  });

  it("refuses an inline member whose host the template omits", () => {
    // `model-provenance` renders inside `model`; listing it alone would be a line that can never show.
    const result = load(`settings:
  sidebar:
    cardTemplate:
      version: 1
      header: [status-dot, name, model-provenance]
`);
    expect(result.config?.settings.sidebar?.cardTemplateRefusal?.join("\n")).toContain("renders inside 'model'");
  });

  // t-045d44 — `options` is implemented now, but INSIDE `cardTemplate`, where the ratified sketch puts
  // it (plan.md § 2). At `settings.sidebar` level it is still an unknown key, for the original reason:
  // nothing reads it there. The refusal is unchanged; only the reason it is unknown has narrowed.
  it("refuses an unknown key under settings.sidebar, naming it — `options` belongs inside cardTemplate", () => {
    const result = load(`settings:
  sidebar:
    cardTemplate:
      version: 1
      meta: [branch]
    options:
      model: { maxChars: 24 }
`);
    // This one DOES go to errors: an unknown settings key is the loader's existing contract, and unlike
    // a malformed template it means the file says something Tachyon does not understand at all.
    expect(result.errors.join("\n")).toContain("settings.sidebar: unknown key 'options'");
  });

  it("refuses an unknown key inside the template, listing what is allowed", () => {
    const result = load(`settings:
  sidebar:
    cardTemplate:
      version: 1
      sidebarWidth: 400
`);
    expect(result.config?.settings.sidebar?.cardTemplateRefusal?.join("\n")).toContain("unknown key 'sidebarWidth'");
  });

  it("reports every problem at once, so one save shows the whole list", () => {
    const parsed = parseCardTemplate({ version: 9, meta: ["nope", "branch", "branch"], footer: 12 });
    expect(parsed.config).toBeUndefined();
    expect(parsed.errors.length).toBeGreaterThanOrEqual(4);
    expect(parsed.errors.join("\n")).toContain("unknown template version");
    expect(parsed.errors.join("\n")).toContain("unknown component 'nope'");
    expect(parsed.errors.join("\n")).toContain("duplicate component 'branch'");
    expect(parsed.errors.join("\n")).toContain("must be a list of component ids");
  });

  it("is one validator, reusable by the personal override phase 5 adds", () => {
    // Same function, a different key path — so two homes for the same document cannot disagree.
    const parsed = parseCardTemplate({ version: CARD_TEMPLATE_VERSION, meta: ["oops"] }, "sidebar.cardTemplate");
    expect(parsed.errors[0]).toContain("sidebar.cardTemplate.meta[0]");
  });

  it("leaves the sidebar settings absent when nothing is configured", () => {
    const result = load("");
    expect(result.errors).toEqual([]);
    expect(result.config?.settings.sidebar).toBeUndefined();
  });
});
