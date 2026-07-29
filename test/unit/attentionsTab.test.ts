import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { loadWebviewModule, renderStatic } from "../helpers/staticPreact.js";
import { SAMPLE, TABS, type FleetVM, type NoticeVM, type TabId } from "../../src/sidebar/types.js";
import { attentionRows } from "../../src/sidebar/attentionStack.js";

/**
 * t-37f554 — Attentions is its own sidebar tab; Agents no longer hosts the permanent stack.
 * Composition-only: the notice store/ordering/actions are unchanged (pinned in attentionStack.dogfood).
 *
 * Note: Agents/folder rendering wraps `DispatchCtx.Provider`, which staticPreact cannot invoke
 * (preact context Provider needs getChildContext). Attentions tab content is Provider-free and is
 * proven by render; Agents exclusion is proven by composition structure + the default initialTab.
 */

function notice(index: number): NoticeVM {
  return {
    id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    message: `Attention ${index}`,
    level: "info",
    at: new Date(Date.UTC(2026, 6, 29, 12, index)).toISOString(),
    collapsedCount: 1,
    actions: index === 1 ? [{ id: "a1", label: "Open" }] : [],
    read: false,
    actionsLive: true,
  };
}

function fleetWithNotices(count: number): FleetVM {
  return {
    ...SAMPLE,
    folder: { hash: "ws", name: "Project" },
    notices: Array.from({ length: count }, (_, i) => notice(i + 1)),
  };
}

async function loadApp() {
  const mod = await loadWebviewModule(path.resolve(__dirname, "../../src/webview/sidebar/App.tsx"));
  return mod.App as (props: {
    fleets?: FleetVM[];
    initialTab?: TabId;
    dispatch?: unknown;
  }) => unknown;
}

describe("t-37f554 — Attentions tab composition", () => {
  it("declares Attentions as a first-class tab without changing the Agents default id", () => {
    expect(TABS.map((t) => t.id)).toContain("Attentions");
    expect(TABS[0]?.id).toBe("Attentions");
    expect(TABS.find((t) => t.id === "Attentions")?.icon).toBe("bell-dot");
    // Agents remains available and is still the cold-open default (App initialTab).
    expect(TABS.map((t) => t.id)).toContain("Agents");
  });

  it("composition: stack only mounts under the Attentions panel, never above the tab bar", () => {
    const app = fs.readFileSync(path.resolve(__dirname, "../../src/webview/sidebar/App.tsx"), "utf8");
    // Permanent placement above tabs is gone.
    const beforeTabs = app.split('class="tabs"')[0] ?? "";
    expect(beforeTabs).not.toContain("<AttentionStack");
    // Single mount site: Attentions branch of the tabpanel.
    expect(app).toMatch(/tab === "Attentions"\s*\?\s*\([\s\S]*?<AttentionStack/);
    expect(app.match(/<AttentionStack/g)?.length).toBe(1);
    // Cold open stays on Agents — no auto-switch when notices arrive.
    expect(app).toMatch(/initialTab\s*=\s*"Agents"/);
    expect(app).not.toMatch(/setTab\(\s*"Attentions"\s*\)/);
  });

  it("Attentions tab renders the full list, count, clear, open actions, and tab badge", async () => {
    const App = await loadApp();
    const fleet = fleetWithNotices(3);
    const html = renderStatic(App({ fleets: [fleet], initialTab: "Attentions" }));
    expect(html).toContain('data-testid="attention-stack"');
    expect(html).toContain('data-testid="attention-count"');
    expect(html).toMatch(/data-testid="attention-count"[^>]*>3</);
    expect(html).toContain('data-testid="attention-clear"');
    expect(html).toContain("Clear");
    // Three cards in emission order.
    const cards = html.match(/data-testid="attention-card"/g) ?? [];
    expect(cards).toHaveLength(3);
    expect(html).toContain("Attention 1");
    expect(html).toContain("Attention 3");
    // Existing Open action still rendered (same notice:invoke path).
    expect(html).toContain("Open");
    // Tab badge mirrors the open count without requiring a tab switch (present on the tab strip).
    expect(html).toContain('data-testid="tab-attentions-badge"');
    expect(html).toMatch(/data-testid="tab-attentions-badge"[^>]*>3</);
    expect(html).toMatch(/aria-selected="true"[^>]*id="tab-Attentions"|id="tab-Attentions"[^>]*aria-selected="true"/);
    expect(html).toContain('id="sidebar-panel"');
  });

  it("Attentions empty state is explicit and compact", async () => {
    const App = await loadApp();
    const empty: FleetVM = { ...SAMPLE, agents: [], notices: [] };
    const html = renderStatic(App({ fleets: [empty], initialTab: "Attentions" }));
    expect(html).toContain('data-testid="attention-stack-empty"');
    expect(html).toContain("No open attentions");
    expect(html).not.toContain('data-testid="attention-clear"');
    expect(html).not.toContain('data-testid="tab-attentions-badge"');
  });

  it("attentionRows stays the single ordering authority for the tab content", () => {
    const fleet = fleetWithNotices(5);
    expect(attentionRows([fleet]).map((r) => r.n.message)).toEqual([
      "Attention 1", "Attention 2", "Attention 3", "Attention 4", "Attention 5",
    ]);
  });
});
