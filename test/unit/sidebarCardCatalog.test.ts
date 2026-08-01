import { describe, expect, it } from "vitest";
import {
  CARD_CATALOG,
  CARD_COMPONENT_IDS,
  CARD_REGIONS,
  CARD_TEMPLATE_VERSION,
  CRITICAL_CARD_COMPONENTS,
  DEFAULT_CARD_TEMPLATE,
  inlineMembers,
  isCardComponentId,
  resolveCardTemplate,
  templateRegion,
  topLevelComponents,
  type CardComponentId,
  type CardTemplate,
  type CardTemplateConfig,
} from "../../src/sidebar/cardTemplate.js";

/**
 * SDD 479 phase 1 — the catalog's own invariants.
 *
 * The equality proof (`sidebarCardTemplateEquality.test.ts`) shows the default template renders the
 * card that shipped. It cannot show that the CATALOG is well-formed, because a malformed catalog that
 * happens to render correctly today still breaks the moment a template is authorable — which is
 * exactly what phase 2 does. So the structural rules are pinned here, before that surface exists.
 */
describe("SDD 479 — the component catalog is closed and complete", () => {
  it("declares each id exactly once", () => {
    expect(new Set(CARD_COMPONENT_IDS).size).toBe(CARD_COMPONENT_IDS.length);
    expect(Object.keys(CARD_CATALOG).sort()).toEqual([...CARD_COMPONENT_IDS].sort());
  });

  it("refuses an id the product does not implement", () => {
    // An open catalog is a template language with extra steps; this is the boundary that keeps it shut.
    expect(isCardComponentId("branch")).toBe(true);
    expect(isCardComponentId("row-html")).toBe(false);
    expect(isCardComponentId("")).toBe(false);
    expect(isCardComponentId("__proto__")).toBe(false);
  });

  it("places every catalog component in the default template, exactly once, in its declared region", () => {
    const placed: CardComponentId[] = [...CARD_REGIONS.flatMap((region) => templateRegion(DEFAULT_CARD_TEMPLATE, region))];
    expect(new Set(placed).size).toBe(placed.length);
    expect([...placed].sort()).toEqual([...CARD_COMPONENT_IDS].sort());
    for (const region of CARD_REGIONS) {
      for (const id of templateRegion(DEFAULT_CARD_TEMPLATE, region)) {
        expect(CARD_CATALOG[id].region, `${id} is listed in the ${region} region`).toBe(region);
      }
    }
    expect(DEFAULT_CARD_TEMPLATE.version).toBe(CARD_TEMPLATE_VERSION);
  });

  it("keeps every inline run resolvable: a host that exists, in the same region, declared before it", () => {
    for (const id of CARD_COMPONENT_IDS) {
      const host = CARD_CATALOG[id].inlineWith;
      if (host === undefined) continue;
      expect(isCardComponentId(host)).toBe(true);
      expect(CARD_CATALOG[host].region).toBe(CARD_CATALOG[id].region);
      expect(host).not.toBe(id);
      const region = templateRegion(DEFAULT_CARD_TEMPLATE, CARD_CATALOG[id].region);
      // The host renders its inline members, so it must come first — otherwise the default template
      // would read in an order the DOM does not produce.
      expect(region.indexOf(host)).toBeLessThan(region.indexOf(id));
    }
  });

  it("splits a region into siblings and inline members with nothing lost", () => {
    for (const region of CARD_REGIONS) {
      const listed = templateRegion(DEFAULT_CARD_TEMPLATE, region);
      const top = topLevelComponents(DEFAULT_CARD_TEMPLATE, region);
      const inlined = listed.filter((id) => CARD_CATALOG[id].inlineWith !== undefined);
      expect([...top, ...inlined].sort()).toEqual([...listed].sort());
      for (const id of inlined) expect(top).not.toContain(id);
    }
    // The card's one nested run: `.name` hosts the model label, which hosts the provenance marker.
    expect(inlineMembers(DEFAULT_CARD_TEMPLATE, "name")).toEqual(["model"]);
    expect(inlineMembers(DEFAULT_CARD_TEMPLATE, "model")).toEqual(["model-provenance"]);
    expect(inlineMembers(DEFAULT_CARD_TEMPLATE, "branch")).toEqual([]);
    expect(topLevelComponents(DEFAULT_CARD_TEMPLATE, "header")).toEqual(["status-dot", "name", "metrics-pill"]);
  });

  it("keeps the branch badge first among the meta badges (spec 384) and `sub` ahead of the badge run", () => {
    // Moved here from a source-position assertion in agentLiveBranchBadge/agentLiveResourceMetrics:
    // after phase 1 the meta ORDER is decided by this array, not by the order fragments were typed.
    const meta = DEFAULT_CARD_TEMPLATE.meta;
    expect(meta.indexOf("sub")).toBe(0);
    expect(meta.indexOf("branch")).toBeLessThan(meta.indexOf("config-invalid"));
    expect(meta.indexOf("branch")).toBeLessThan(meta.indexOf("attention"));
    expect(meta.indexOf("branch")).toBeLessThan(meta.indexOf("verify"));
    expect(meta.indexOf("hidden-count")).toBeLessThan(meta.indexOf("branch"));
  });

  it("records exactly the failure states a template may not hide (ratified fork 3)", () => {
    // t-0ad300 adds `refused`. It qualifies on the same terms as the other four: the row exists ONLY
    // to report it, and hiding it would restore exactly the defect the row was added to fix — an
    // agent that vanishes from the sidebar, taking with it the route into Agent Studio where the
    // refusal is repaired. A template able to suppress it could make the agent unreachable again.
    expect([...CRITICAL_CARD_COMPONENTS].sort()).toEqual(
      ["auth-required", "awaiting-human", "config-invalid", "refused", "verify"],
    );
  });

  it("excludes the disclosure gutter, which is tree chrome rather than a card element", () => {
    // A template able to hide it would make collapsed child ROWS unreachable — a customization that
    // breaks navigation, not just appearance.
    expect(CARD_COMPONENT_IDS).not.toContain("children-toggle" as CardComponentId);
  });
});

describe("SDD 479 — V1 boundary: templates reach agent cards only", () => {
  const written: CardTemplate = { version: CARD_TEMPLATE_VERSION, header: ["name"], meta: [], footer: ["actions"] };
  const configured: CardTemplateConfig = { base: written };

  it("gives an agent row the configured template", () => {
    expect(resolveCardTemplate({ kind: "agent" }, configured)).toBe(written);
  });

  it("gives a terminal row the default template whatever is configured", () => {
    // The human ratified this boundary before any configuration surface exists. Encoding it in the
    // RESOLVER rather than in its callers is what keeps a later caller from quietly crossing it.
    expect(resolveCardTemplate({ kind: "terminal" }, configured)).toBe(DEFAULT_CARD_TEMPLATE);
  });

  it("falls back to the default when nothing is configured (every row, today)", () => {
    expect(resolveCardTemplate({ kind: "agent" })).toBe(DEFAULT_CARD_TEMPLATE);
    expect(resolveCardTemplate({ kind: "terminal" })).toBe(DEFAULT_CARD_TEMPLATE);
  });
});
