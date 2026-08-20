import { afterAll, beforeAll, describe, expect, it } from "vitest";
import puppeteer, { type Browser } from "puppeteer-core";
import { resolveChromeExecutable } from "./support/chrome";
import { startGateServer, type GateServer } from "./support/gateServer";
import { openPreview } from "./support/preview";

type IconHostMeasurement = {
  selector: string;
  centerOffset: number;
  hostFontSize: number;
  iconFontSize: number;
  canonicalIconSize: number;
};

/**
 * t-383621 — the shared icon contract through the production preview door.
 *
 * This starts from Plugins' real icon Badge, rendered by the shipped bundle in the preview harness,
 * then asks the same DOM/content and shared stylesheet to lay it out as each of the four Kit hosts.
 * Keeping the four selectors together is the guard: spec 282 originally listed only three, which let
 * Badge retain codicon's 16px default and baseline alignment unnoticed.
 */
describe("Kit icon hosts align their codicon with the label (t-383621)", () => {
  let server: GateServer;
  let browser: Browser;

  beforeAll(async () => {
    server = await startGateServer();
    browser = await puppeteer.launch({ executablePath: resolveChromeExecutable(), headless: true });
  });

  afterAll(async () => {
    await browser.close();
    await server.close();
  });

  it("centres and canonically sizes icons in .ds-btn, .ds-tab, .ds-chip, and .ds-badge", async () => {
    const page = await browser.newPage();
    const surface = await openPreview(page, server.origin, {
      query: { view: "plugins", fixture: "mcp-apply" },
      width: 880,
      waitFor: ".ds-badge .codicon",
    });

    const measurements = await surface.evaluate(() => {
      const source = document.querySelector<HTMLElement>(".ds-badge:has(.codicon)");
      if (!source) throw new Error("Plugins preview rendered no icon Badge");

      const fixture = document.createElement("div");
      fixture.style.cssText = "position:fixed;left:0;top:0;display:flex;align-items:flex-start;gap:16px;z-index:-1";
      document.body.append(fixture);

      const selectors = ["ds-btn", "ds-tab", "ds-chip", "ds-badge"];
      const values = selectors.map((className) => {
        const host = document.createElement(className === "ds-btn" ? "button" : "span");
        host.className = className;
        host.innerHTML = source.innerHTML;
        fixture.append(host);

        const icon = host.querySelector<HTMLElement>(".codicon");
        if (!icon) throw new Error(`${className} fixture rendered no codicon`);
        const hostRect = host.getBoundingClientRect();
        const iconRect = icon.getBoundingClientRect();
        return {
          selector: `.${className}`,
          // Centre against the host's content box: `.ds-tab` deliberately has a one-sided 2px
          // active underline, which is decoration rather than vertical space for its label.
          centerOffset: Math.round(((iconRect.top + iconRect.height / 2) - (hostRect.top + host.clientTop + host.clientHeight / 2)) * 10) / 10,
          hostFontSize: Number.parseFloat(getComputedStyle(host).fontSize),
          iconFontSize: Number.parseFloat(getComputedStyle(icon).fontSize),
          canonicalIconSize: Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--ds-small")),
        };
      });
      fixture.remove();
      return values;
    }) as IconHostMeasurement[];

    expect(measurements.map(({ selector }) => selector)).toEqual([".ds-btn", ".ds-tab", ".ds-chip", ".ds-badge"]);
    for (const measurement of measurements) {
      expect(
        Math.abs(measurement.centerOffset),
        `${measurement.selector}: vertical center offset ${measurement.centerOffset}px`,
      ).toBeLessThanOrEqual(0.5);
      expect(measurement.iconFontSize, `${measurement.selector}: icon must use --ds-small`).toBe(measurement.canonicalIconSize);
      expect(
        Math.abs(measurement.iconFontSize - measurement.hostFontSize),
        `${measurement.selector}: icon and host font sizes must stay in the same scale step`,
      ).toBeLessThanOrEqual(1);
    }

    await page.close();
  });
});
