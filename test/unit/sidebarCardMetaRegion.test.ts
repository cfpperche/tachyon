import { describe, expect, it, beforeAll } from "vitest";
import path from "node:path";
import { loadWebviewModule, renderStatic } from "../helpers/staticPreact.js";
import {
  CARD_TEMPLATE_VERSION,
  DEFAULT_CARD_TEMPLATE,
  topLevelComponents,
  type CardComponentId,
  type CardTemplate,
} from "../../src/sidebar/cardTemplate.js";
import type { AgentVM } from "../../src/sidebar/types.js";

/**
 * SDD 479 phase 2 — what a CONFIGURED card actually renders.
 *
 * Three properties, each of which broke something real while phase 2 was being written:
 *
 *  1. **Every meta component answers "nothing" with `null`.** `CardMetaRegion` decides whether
 *     `.row-meta` exists from what its components RETURN, and a component vnode that renders nothing
 *     internally is still a vnode. The first cut of `branch` returned `<BranchBadge/>` unconditionally
 *     and put an empty `.row-meta` on EVERY row.
 *  2. **The wrapper follows the content** — phase 2's answer to the question phase 1 left open.
 *  3. **A hidden failure state comes back** (ratified fork 3), and says why in its tooltip.
 */
const APP_TSX = path.join(__dirname, "../../src/webview/sidebar/App.tsx");

const agent = (overrides: Partial<AgentVM> = {}): AgentVM => ({ name: "a", status: "running", kind: "agent", ...overrides });

function templateOf(meta: CardComponentId[]): CardTemplate {
  return { version: CARD_TEMPLATE_VERSION, header: DEFAULT_CARD_TEMPLATE.header, meta, footer: DEFAULT_CARD_TEMPLATE.footer };
}

describe("SDD 479 phase 2 — the meta region and its wrapper", () => {
  let AgentRow: (props: unknown) => unknown;
  let CARD_COMPONENTS: Record<CardComponentId, (slot: unknown) => unknown>;

  beforeAll(async () => {
    const mod = await loadWebviewModule(APP_TSX);
    AgentRow = mod.AgentRow as typeof AgentRow;
    CARD_COMPONENTS = mod.CARD_COMPONENTS as typeof CARD_COMPONENTS;
  });

  it("every meta component returns null for a row that carries none of its fields", () => {
    // The invariant `CardMetaRegion` rests on. Asserted per component so a failure names the one that
    // regressed, rather than reporting "some row grew a div".
    const slot = {
      a: agent(),
      template: DEFAULT_CARD_TEMPLATE,
      d: { action: () => {}, section: () => {}, global: () => {}, pipeline: () => {}, openMore: () => {} },
      nested: false, hasChildren: false, collapsed: false, hiddenCount: 0, hiddenNeedsAttention: false,
      hasHidden: false, hasResources: false, metricsOpen: false, readmitted: [],
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

  it("renders only the components the template lists, in the order it lists them", () => {
    const a = agent({ name: "curated", liveBranch: "main", harness: true, verify: "pass", continuity: "missing" });
    const html = renderStatic(AgentRow({ a, flash: false, cardTemplate: { base: templateOf(["harness", "branch"]) } }));
    expect(html).toContain("⚙ harness");
    expect(html).toContain("⎇ main");
    // listed order wins over the default's (branch-first) order
    expect(html.indexOf("⚙ harness")).toBeLessThan(html.indexOf("⎇ main"));
    // omitted components are absent — not merely reordered
    expect(html).not.toContain("✓ verified");
    expect(html).not.toContain("no continuity");
  });

  it("hides every meta badge when the template says `meta: []`", () => {
    const a = agent({ name: "spartan", liveBranch: "main", harness: true, verify: "pass" });
    const html = renderStatic(AgentRow({ a, flash: false, cardTemplate: { base: templateOf([]) } }));
    expect(html).not.toContain("row-meta");
    expect(html).toContain('class="name"'); // the rest of the card is untouched
    expect(html).toContain("actions");
  });
});

describe("SDD 479 phase 2 — critical states are re-admitted, not overridable (ratified fork 3)", () => {
  let AgentRow: (props: unknown) => unknown;
  beforeAll(async () => {
    AgentRow = (await loadWebviewModule(APP_TSX)).AgentRow as typeof AgentRow;
  });

  const HIDE_EVERYTHING = templateOf([]);

  it("puts an omitted auth-required badge back, and says why", () => {
    const a = agent({ name: "locked", status: "idle", authRequired: { runtime: "claude", action: "run `claude login`" } });
    const html = renderStatic(AgentRow({ a, flash: false, cardTemplate: { base: HIDE_EVERYTHING } }));
    expect(html).toContain("◆ auth required");
    expect(html).toContain("Your card template omits this badge");
  });

  it("puts back awaiting-human, config-invalid and a FAILING verify gate", () => {
    for (const [row, needle] of [
      [agent({ name: "h", awaitingHuman: { reason: "review the diff" } }), "◆ needs you"],
      [agent({ name: "c", configInvalid: true }), "config invalid"],
      [agent({ name: "v", verify: "fail" }), "✗ verify"],
    ] as const) {
      const html = renderStatic(AgentRow({ a: row, flash: false, cardTemplate: { base: HIDE_EVERYTHING } }));
      expect(html, `${needle} must survive a template that omits it`).toContain(needle);
      expect(html).toContain("Your card template omits this badge");
    }
  });

  it("does NOT re-admit a passing or stale gate — critical means the row cannot recover, not 'important'", () => {
    for (const verify of ["pass", "stale"] as const) {
      const html = renderStatic(AgentRow({ a: agent({ name: verify, verify }), flash: false, cardTemplate: { base: HIDE_EVERYTHING } }));
      expect(html).not.toContain("row-meta");
    }
  });

  it("adds nothing when the template already lists the critical component", () => {
    const a = agent({ name: "listed", authRequired: { runtime: "codex", action: "run `codex login`" } });
    const html = renderStatic(AgentRow({ a, flash: false, cardTemplate: { base: templateOf(["auth-required"]) } }));
    expect(html).toContain("◆ auth required");
    // no re-admission note: the person asked for this badge, so nothing was overridden
    expect(html).not.toContain("Your card template omits this badge");
    expect(html.match(/auth required/g)?.length).toBe(1);
  });

  it("leaves terminal rows on the default card whatever the folder configured", () => {
    // The ratified V1 boundary, proven through the RENDERER and not only the resolver.
    const terminal: AgentVM = { name: "dev", kind: "terminal", status: "running", sub: "npm run dev", harness: true };
    const configured = renderStatic(AgentRow({ a: terminal, flash: false, cardTemplate: { base: HIDE_EVERYTHING } }));
    const untouched = renderStatic(AgentRow({ a: terminal, flash: false }));
    expect(configured).toBe(untouched);
    expect(configured).toContain("npm run dev");
  });
});
