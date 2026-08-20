import { afterAll, beforeAll, describe, expect, it } from "vitest";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { resolveChromeExecutable } from "./support/chrome";
import { startGateServer, type GateServer } from "./support/gateServer";
import { openPreview } from "./support/preview";

/**
 * t-505f13 (devhost validation) — the status badge is a COLUMN, not a follower.
 *
 * The defect, measured by the owner in this harness at 880: the four Environment badges sat flush
 * right (edge 847) while the Workspace row's badge floated wherever the button left room (615 with
 * "not initialized", 698 with "tachyon.yml present") — the badge's edge MOVED with its own text and
 * with the presence of a button, because `margin-left: auto` pushes it only as far as the next
 * occupied slot. A status that changes position per row is a status you cannot scan vertically.
 *
 * The contract this pins: in EVERY row of both sections — with a button, without one, disabled or
 * not — the badge's right edge is the same constant at a given width, and any action sits AFTER it.
 * Measured as geometry (getBoundingClientRect), at the repo's 880 and 360 pair, through the same
 * ?width= door an operator uses.
 */

const OPERATOR_VIEWPORT = { width: 1280, height: 900 } as const;

interface RowGeometry {
  edges: number[];
  rowsWithButton: number;
  rowsWithoutButton: number;
  /** t-505f13 round 3 — the label cell's own typography, which the badge measurement cannot see. */
  labelTypography: Array<{ weight: string; display: string; gap: string; hasIcon: boolean }>;
}

async function badgeGeometry(page: Page, server: GateServer, fixture: string, width: number): Promise<RowGeometry> {
  const surface = await openPreview(page, server.origin, {
    query: { view: "onboarding", fixture },
    width,
    height: 900,
    waitFor: '[data-testid="onb-root"]',
  });
  return surface.evaluate(() => {
    const rows = [...document.querySelectorAll<HTMLElement>(".onb-env-head")];
    const edges = rows.map((row) => {
      const badge = row.querySelector<HTMLElement>(".ds-badge");
      return badge ? Math.round(badge.getBoundingClientRect().right * 2) / 2 : NaN;
    });
    const labelTypography = rows.map((row) => {
      const label = row.querySelector<HTMLElement>(".onb-env-label");
      if (!label) return { weight: "absent", display: "absent", gap: "absent", hasIcon: false };
      const style = getComputedStyle(label);
      return {
        weight: style.fontWeight,
        display: style.display,
        gap: style.gap,
        hasIcon: label.querySelector(".codicon") !== null,
      };
    });
    return {
      edges,
      labelTypography,
      rowsWithButton: rows.filter((row) => row.querySelector("button") !== null).length,
      rowsWithoutButton: rows.filter((row) => row.querySelector("button") === null).length,
    };
  });
}

describe("t-505f13 — the onboarding status badge keeps one constant column", () => {
  let server: GateServer;
  let browser: Browser;

  beforeAll(async () => {
    server = await startGateServer();
    browser = await puppeteer.launch({ executablePath: resolveChromeExecutable(), headless: true });
  }, 60_000);

  afterAll(async () => {
    await browser.close();
    await server.close();
  });

  for (const width of [880, 360]) {
    for (const fixture of ["fresh", "first-agent", "missing-cli"]) {
      it(`every row's badge shares one right edge — ${fixture} @ ${width}`, async () => {
        const page = await browser.newPage();
        await page.setViewport({ ...OPERATOR_VIEWPORT });
        try {
          const geometry = await badgeGeometry(page, server, fixture, width);
          // Both sections render rows; fewer than 5 means the page did not mount what we measure.
          expect(geometry.edges.length, `expected the environment + workspace rows, got ${geometry.edges.length}`).toBeGreaterThanOrEqual(5);
          expect(geometry.edges.every((edge) => Number.isFinite(edge))).toBe(true);
          const distinct = new Set(geometry.edges);
          expect(
            distinct.size,
            `badge right edges diverge across rows (${[...distinct].join(", ")} px) — the status column must be constant whether or not the row carries a button`,
          ).toBe(1);
        } finally {
          await page.close();
        }
      }, 30_000);
    }
  }

  it("the measurement is not vacuous: some rows carry a button and some do not (fresh @ 880)", async () => {
    const page = await browser.newPage();
    await page.setViewport({ ...OPERATOR_VIEWPORT });
    try {
      const geometry = await badgeGeometry(page, server, "fresh", 880);
      expect(geometry.rowsWithButton).toBeGreaterThan(0);
      expect(geometry.rowsWithoutButton).toBeGreaterThan(0);
    } finally {
      await page.close();
    }
  }, 30_000);

  /**
   * t-505f13 round 3 — the LABEL cell keeps its own typography. A CSS edit that reshapes the head
   * grid silently deleted `.onb-env-label`'s rule (owner-measured: weight 400 not 600, display
   * block not inline-flex): the row labels lost their bold, and the workspace row's folder icon
   * lost its alignment and breathing room next to the text. The badge-column assertions above were
   * green throughout, because geometry of the badge says nothing about typography of the label —
   * so this pins exactly what that edit dropped, on the row that carries the icon.
   */
  it("row labels stay bold and the label cell aligns icon with text (fresh @ 880)", async () => {
    const page = await browser.newPage();
    await page.setViewport({ ...OPERATOR_VIEWPORT });
    try {
      const geometry = await badgeGeometry(page, server, "fresh", 880);
      expect(geometry.labelTypography.length).toBeGreaterThanOrEqual(5);
      for (const label of geometry.labelTypography) {
        expect(label.weight, "`.onb-env-label` lost font-weight: 600 — the rule was deleted by a head-grid edit").toBe("600");
        // Computed display is "flex", not "inline-flex": a grid child is blockified. The claim that
        // matters is that the cell IS a flex container — that is what centers the folder icon.
        expect(label.display, "`.onb-env-label` must be a flex container: that is what centers the folder icon against the text").toContain("flex");
        expect(label.gap, "`.onb-env-label` needs a real gap — 'normal' means the var(--ds-1) rule is gone").not.toBe("normal");
      }
      // The workspace row is the one that HAS an icon; if it stops carrying one the alignment
      // assertion above becomes vacuous for exactly the row it exists for.
      expect(geometry.labelTypography.some((label) => label.hasIcon)).toBe(true);
    } finally {
      await page.close();
    }
  }, 30_000);
});
