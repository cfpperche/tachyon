/**
 * t-bd9fb8 / SDD 512 fatia 2 — the status notice is a fixed sidebar footer, outside the tabs.
 *
 * Reads `fleet.statusNotice`. No timer. Level is a field. The full message stays in the markup;
 * `<details>` is the path when a one-line row cannot show it.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadWebviewModule, renderStatic } from "../helpers/staticPreact.js";
import { SAMPLE, TABS, type FleetVM, type StatusNoticeVM, type TabId } from "@tachyon/shared/sidebar/types.js";

const APP_TSX = path.resolve(__dirname, "../../packages/webview-ui/src/webview/sidebar/App.tsx");
const SIDEBAR_CSS = path.resolve(__dirname, "../../packages/webview-ui/src/webview/sidebar/sidebar.css");

const SHORT: StatusNoticeVM = {
  message: "Nothing to review",
  level: "info",
  at: "2026-08-17T12:00:00.000Z",
};

const MISLEADING: StatusNoticeVM = {
  message: "error: something failed",
  level: "info",
  at: "2026-08-17T12:00:00.000Z",
};

const LONG: StatusNoticeVM = {
  message: "an action-less notice is precisely the branch that routes to setStatusBarMessage — clipped by width, erased on a timer, no button. That is where the owner's run grok login first went.",
  level: "error",
  at: "2026-08-17T12:00:00.000Z",
};

function fleetWith(notice?: StatusNoticeVM): FleetVM {
  return {
    ...SAMPLE,
    folder: { hash: "ws", name: "Project" },
    ...(notice ? { statusNotice: notice } : {}),
  };
}

async function loadApp() {
  const mod = await loadWebviewModule(APP_TSX);
  return mod.App as (props: { fleets?: FleetVM[]; initialTab?: TabId }) => unknown;
}

describe("t-bd9fb8 — sidebar status footer", () => {
  it("is composed outside the tab panel, not inside any tab branch", () => {
    const src = readFileSync(APP_TSX, "utf8");
    const mount = src.indexOf("<StatusNoticeFooter notice=");
    const panel = src.indexOf('id="sidebar-panel"');
    expect(mount).toBeGreaterThan(panel);
    expect(src.slice(src.lastIndexOf("</div>", mount), mount)).toMatch(/<\/div>\s*\{selected/);
    expect(src.match(/function StatusNoticeFooter/g)?.length).toBe(1);
    expect(src.match(/<StatusNoticeFooter/g)?.length).toBe(1);
  });

  it("renders on every tab with the same message — switching tabs cannot hide it", async () => {
    const App = await loadApp();
    const fleets = [fleetWith(SHORT)];
    for (const { id } of TABS) {
      const html = renderStatic(App({ fleets, initialTab: id }));
      expect(html, id).toContain('data-testid="sidebar-status-footer"');
      expect(html, id).toContain("Nothing to review");
      expect(html, id).toMatch(/id="sidebar-panel"[\s\S]*<\/div>\s*<footer[^>]*data-testid="sidebar-status-footer"/);
    }
  });

  it("does not disappear on a timer — the footer has no timer primitive", () => {
    const src = readFileSync(APP_TSX, "utf8");
    const start = src.indexOf("function StatusNoticeFooter");
    const end = src.indexOf("export function App(");
    const footer = src.slice(start, end);
    expect(footer.length).toBeGreaterThan(200);
    expect(footer).not.toMatch(/setTimeout|setInterval|expiresAt|\bttl\b|8_000|8000/);
    expect(footer).not.toMatch(/Date\.now|performance\.now/);
  });

  it("paints level from the field, never from the message text", async () => {
    const App = await loadApp();
    const html = renderStatic(App({ fleets: [fleetWith(MISLEADING)], initialTab: "Agents" }));
    expect(html).toContain('data-level="info"');
    expect(html).toMatch(/class="notice-level l-info">info</);
    expect(html).toContain("error: something failed");
    expect(html).not.toMatch(/data-level="error"/);
    expect(html).not.toMatch(/class="notice-level l-error"/);
  });

  it("keeps the entire message in the markup and exposes a details path to the rest", async () => {
    const App = await loadApp();
    const html = renderStatic(App({ fleets: [fleetWith(LONG)], initialTab: "Agents" }));
    expect(html).toContain(LONG.message);
    expect(html).toContain("<details>");
    expect(html).toContain("<summary");
    expect(html).toContain('data-level="error"');
    expect(html).toMatch(/role="alert"/);
  });

  it("is gone when the selected project has no current notice", async () => {
    const App = await loadApp();
    const html = renderStatic(App({ fleets: [fleetWith()], initialTab: "Agents" }));
    expect(html).not.toContain('data-testid="sidebar-status-footer"');
    expect(html).not.toContain("class=\"status-footer");
  });

  it("uses host scale tokens — no chosen px on the footer row", () => {
    const css = readFileSync(SIDEBAR_CSS, "utf8");
    const footer = css.slice(css.indexOf(".status-footer"));
    expect(footer).toContain("var(--ds-spacing-size40)");
    expect(footer).toContain("var(--ds-spacing-size80)");
    expect(footer).toContain("var(--ds-operator-label2)");
    expect(footer).toContain("var(--ds-operator-label3)");
    expect(footer).toContain("var(--ds-border)");
    expect(footer).toContain("var(--ds-warn)");
    expect(footer).toContain("var(--ds-err)");
    expect(footer).not.toMatch(/padding:\s*\d+px/);
    expect(footer).not.toMatch(/font-size:\s*\d+px/);
  });
});
