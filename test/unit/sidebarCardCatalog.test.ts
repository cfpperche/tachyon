import { describe, expect, it } from "vitest";
import {
  CARD_CATALOG,
  CARD_COMPONENT_IDS,
  CARD_REGIONS,
  CARD_TEMPLATE_VERSION,
  DEFAULT_CARD_TEMPLATE,
  inlineMembers,
  isCardComponentId,
  templateRegion,
  topLevelComponents,
  type CardComponentId,
} from "@tachyon/shared/sidebar/cardTemplate.js";

/**
 * The catalog's own invariants. The equality proof (`sidebarCardTemplateEquality.test.ts`)
 * shows the default layout renders the card that shipped; this file shows the catalog is
 * well-formed.
 */
describe("the agent-card catalog is closed and complete", () => {
  it("declares each id exactly once", () => {
    expect(new Set(CARD_COMPONENT_IDS).size).toBe(CARD_COMPONENT_IDS.length);
    expect(Object.keys(CARD_CATALOG).sort()).toEqual([...CARD_COMPONENT_IDS].sort());
  });

  it("refuses an id the product does not implement", () => {
    expect(isCardComponentId("branch")).toBe(true);
    expect(isCardComponentId("row-html")).toBe(false);
    expect(isCardComponentId("")).toBe(false);
    expect(isCardComponentId("__proto__")).toBe(false);
  });

  it("places every catalog component in the default layout, exactly once, in its declared region", () => {
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
    expect(inlineMembers(DEFAULT_CARD_TEMPLATE, "name")).toEqual(["model"]);
    expect(inlineMembers(DEFAULT_CARD_TEMPLATE, "model")).toEqual(["model-provenance"]);
    expect(inlineMembers(DEFAULT_CARD_TEMPLATE, "branch")).toEqual([]);
    expect(topLevelComponents(DEFAULT_CARD_TEMPLATE, "header")).toEqual(["status-dot", "name", "metrics-pill"]);
  });

  it("keeps the branch badge first among the meta badges (spec 384) and `sub` ahead of the badge run", () => {
    const meta = DEFAULT_CARD_TEMPLATE.meta;
    expect(meta.indexOf("sub")).toBe(0);
    expect(meta.indexOf("branch")).toBeLessThan(meta.indexOf("config-invalid"));
    expect(meta.indexOf("branch")).toBeLessThan(meta.indexOf("attention"));
    expect(meta.indexOf("hidden-count")).toBeLessThan(meta.indexOf("branch"));
  });

  it("keeps the checklist line in the footer (t-281339)", () => {
    expect(DEFAULT_CARD_TEMPLATE.footer).toContain("checklist");
    expect(DEFAULT_CARD_TEMPLATE.footer.indexOf("focus")).toBeLessThan(DEFAULT_CARD_TEMPLATE.footer.indexOf("checklist"));
    expect(DEFAULT_CARD_TEMPLATE.footer.indexOf("checklist")).toBeLessThan(DEFAULT_CARD_TEMPLATE.footer.indexOf("metrics-lanes"));
  });

  it("excludes the disclosure gutter, which is tree chrome rather than a card element", () => {
    expect(CARD_COMPONENT_IDS).not.toContain("children-toggle" as CardComponentId);
  });
});
