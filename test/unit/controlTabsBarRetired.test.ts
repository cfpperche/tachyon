import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { loadWebviewModule, renderStatic } from "../helpers/staticPreact.js";
import { CONTROL_SECTION_NAV } from "../../src/cockpit/sectionNav.js";
import { SAMPLE, type FleetVM } from "../../src/sidebar/types.js";

const read = (file: string): string => readFileSync(file, "utf8");
const SIDEBAR_TSX = "src/webview/sidebar/App.tsx";

describe("t-aa2780 — the engine log-error dot has a destination", () => {
  let SidebarApp: (props: { fleets?: FleetVM[]; initialTab?: string }) => unknown;
  beforeAll(async () => {
    SidebarApp = (await loadWebviewModule(SIDEBAR_TSX)).App as typeof SidebarApp;
  });

  const clean: FleetVM = { ...SAMPLE, folder: { hash: "ws", name: "Project" } };
  const erroring: FleetVM = { ...clean, engineLogHasError: true };

  it("Control's own tab dot is gone with the shell", () => {
    expect(() => read("src/webview/cockpit/App.tsx")).toThrow();
  });

  it("lights the sidebar's Control tab — visible from EVERY tab, not only the launcher", () => {
    // Rendered on ATTENTIONS, a tab that is not Control: the dot is on the strip, so it survives
    // whichever panel the human is actually reading.
    const html = renderStatic(SidebarApp({ fleets: [erroring], initialTab: "Attentions" }));
    expect(html).toContain('data-testid="tab-control-engine-dot"');
    // and it says so to a screen reader, on the button itself — the glyph is decorative.
    expect(html).toContain('aria-label="Control, errors in engine log"');
  });

  it("lights the Engine TILE, so the alarm has an address", () => {
    const html = renderStatic(SidebarApp({ fleets: [erroring], initialTab: "Control" }));
    expect(html).toContain('data-testid="control-tile-engine-dot"');
    expect(html).toContain('aria-label="Engine, errors in engine log"');
    // exactly one tile lights: eleven other sections are not the engine.
    expect((html.match(/class="ds-btn ctl-tile has-err"/g) ?? []).length).toBe(1);
  });

  it("stays dark when no root reports errors, and when no root MEASURED them", () => {
    for (const fleets of [[clean], [{ ...clean, engineLogHasError: false }]]) {
      const html = renderStatic(SidebarApp({ fleets, initialTab: "Control" }));
      expect(html).not.toContain("engine-dot");
      expect(html).not.toContain("has-err");
    }
  });

  /**
   * t-72ff5a — multi-root FOLLOWS THE SELECTION, where it used to fold every root with `some()`.
   *
   * The fold predates the selection: with no project in focus, a window-level dot was the only
   * honest summary available. Now the tile this dot lights opens Control on the SELECTED project's
   * Engine section, so a dot lit by another project's log ring would send the reader to a log with
   * nothing wrong in it — an alarm whose address is wrong, which is what the tile exists to fix.
   *
   * Nothing is hidden that the reader cannot reach: switching project in the sidebar chrome lights
   * it, and this has never been a health check — it reports that the ring holds error lines.
   */
  it("multi-root follows the selected project rather than folding every root", () => {
    const fleets = [
      { ...clean, folder: { hash: "a", name: "Alpha" } },
      { ...erroring, folder: { hash: "b", name: "Beta" } },
    ];
    const onErroring = renderStatic(SidebarApp({ fleets, initialTab: "Attentions", selectedWsHash: "b" } as never));
    expect(onErroring).toContain('data-testid="tab-control-engine-dot"');

    const onClean = renderStatic(SidebarApp({ fleets, initialTab: "Attentions", selectedWsHash: "a" } as never));
    expect(onClean).not.toContain('data-testid="tab-control-engine-dot"');
  });

  it("sidebar.css declares both dots", () => {
    const css = read("src/webview/sidebar/sidebar.css");
    expect(css).toContain(".tab-dot");
    expect(css).toContain(".ctl-tile-dot");
  });
});

describe("t-aa2780 — navigation semantics did not regress", () => {
  let SidebarApp: (props: { fleets?: FleetVM[]; initialTab?: string }) => unknown;
  beforeAll(async () => {
    SidebarApp = (await loadWebviewModule(SIDEBAR_TSX)).App as typeof SidebarApp;
  });

  // The serializer emits attributes in NAME order, so the grid opens with its aria-label, not its class.
  const grid = (): string => {
    const html = renderStatic(SidebarApp({ fleets: [{ ...SAMPLE, folder: { hash: "ws", name: "Project" } }], initialTab: "Control" }));
    const marker = html.indexOf('data-testid="control-grid"');
    expect(marker, "the launcher grid did not render").toBeGreaterThan(-1);
    const start = html.lastIndexOf("<div", marker);
    const end = html.indexOf("</div>", html.indexOf('data-testid="control-tile-settings"'));
    return html.slice(start, end);
  };

  it("every one of the twelve destinations is a real keyboard-operable button", () => {
    const html = grid();
    // Twelve <button>s: reachable with Tab, actuated with Enter/Space, exactly like the twelve
    // role="tab" buttons the strip had (which carried no roving tabindex or arrow keys either).
    expect((html.match(/<button/g) ?? []).length).toBe(CONTROL_SECTION_NAV.length);
    expect(html).not.toContain("tabindex=\"-1\"");
    for (const tile of CONTROL_SECTION_NAV) expect(html).toContain(tile.label);
  });

  it("is a LABELLED group, not an unannounced div of icons", () => {
    const html = grid();
    expect(html).toContain('role="group"');
    expect(html).toContain('aria-label="Control sections"');
  });

  it("deliberately claims NO selection: the sidebar cannot observe Control's live section", () => {
    const html = grid();
    expect(html).not.toContain("aria-selected");
    expect(html).not.toContain('role="tab"');
    expect(html).not.toContain("aria-current");
    // the decision is argued where a reader of the code will meet it, not only here.
    expect(read("src/webview/sidebar/App.tsx")).toContain("WHY THIS IS NOT A `tablist`");
  });
});
