import { describe, expect, it, beforeAll } from "vitest";
import path from "node:path";
import { loadWebviewModule, renderStatic } from "../helpers/staticPreact.js";
import { DEFAULT_CARD_TEMPLATE, topLevelComponents, type CardComponentId } from "@tachyon/shared/sidebar/cardTemplate.js";
import type { AgentVM } from "@tachyon/shared/sidebar/types.js";

/**
 * What the meta region actually renders.
 *
 * Every meta component answers "nothing" with `null`. `CardMetaRegion` decides whether `.row-meta`
 * exists from what its components RETURN, and a component vnode that renders nothing internally
 * is still a vnode. The first cut of `branch` returned `<BranchBadge/>` unconditionally and put
 * an empty `.row-meta` on EVERY row.
 */
const APP_TSX = path.join(__dirname, "../../packages/webview-ui/src/webview/sidebar/App.tsx");

const agent = (overrides: Partial<AgentVM> = {}): AgentVM => ({ name: "a", status: "running", kind: "agent", ...overrides });

describe("the agent-card meta region and its wrapper", () => {
  let AgentRow: (props: unknown) => unknown;
  let CARD_COMPONENTS: Record<CardComponentId, (slot: unknown) => unknown>;

  beforeAll(async () => {
    const mod = await loadWebviewModule(APP_TSX);
    AgentRow = mod.AgentRow as typeof AgentRow;
    CARD_COMPONENTS = mod.CARD_COMPONENTS as typeof CARD_COMPONENTS;
  });

  it("every meta component returns null for a row that carries none of its fields", () => {
    const slot = {
      a: agent(),
      template: DEFAULT_CARD_TEMPLATE,
      d: { action: () => {}, section: () => {}, global: () => {}, pipeline: () => {}, openMore: () => {} },
      nested: false, hasChildren: false, collapsed: false, hiddenCount: 0, hiddenNeedsAttention: false,
      hasHidden: false, hasResources: false, metricsOpen: false,
    };
    for (const id of topLevelComponents(DEFAULT_CARD_TEMPLATE, "meta")) {
      expect(CARD_COMPONENTS[id](slot), `meta component '${id}' must return null when it has nothing to show`).toBeNull();
    }
  });

  it("omits `.row-meta` entirely when nothing in it renders", () => {
    const html = renderStatic(AgentRow({ a: agent({ name: "bare" }), flash: false }));
    expect(html).not.toContain("row-meta");
  });

  it("keeps `.row-meta` when a component in it renders", () => {
    const html = renderStatic(AgentRow({ a: agent({ name: "branchy", liveBranch: "main" }), flash: false }));
    expect(html).toContain('class="row-meta"');
    expect(html).toContain("⎇ main");
  });
});
