import { describe, expect, it, beforeAll } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadWebviewModule, renderStatic } from "../helpers/staticPreact.js";
import { AGENT_CARD_FIXTURES, scrubLocaleTimestamps } from "../fixtures/sidebar/agentCardFixtures.js";

/**
 * SDD 479 phase 1 — the proof obligation the plan named: *the default template IS today's card, not a
 * re-implementation that happens to look similar.*
 *
 * The golden file was captured from `AgentRow` as it stood at `76546c4d`, BEFORE the renderer was
 * moved onto the component catalog (`npm run test -- sidebarCardTemplateEquality` with
 * `UPDATE_SIDEBAR_CARD_GOLDEN=1`). That ordering is the whole point: the file is evidence about the
 * PRIOR renderer, so a diff here means the template changed the card.
 *
 * Therefore: **do not regenerate this golden to make a failing test pass.** Regenerate it only when a
 * change is *meant* to alter the card, and then read the diff — it is the visual review, in text.
 *
 * Terminal rows are in the matrix on purpose. They render through the same component, and SDD 479 v1
 * is scoped to agent cards: if a terminal row moves, the boundary was crossed.
 */
const GOLDEN_PATH = path.join(__dirname, "../fixtures/sidebar/agentCardGolden.txt");
const APP_TSX = path.join(__dirname, "../../src/webview/sidebar/App.tsx");
const HEADER = [
  "# SDD 479 phase 1 — agent card golden",
  "#",
  "# Captured from src/webview/sidebar/App.tsx at 76546c4d, BEFORE the component-catalog refactor.",
  "# Regenerate ONLY for an intentional card change: UPDATE_SIDEBAR_CARD_GOLDEN=1 npx vitest run test/unit/sidebarCardTemplateEquality.test.ts",
  "# Serialized by test/helpers/staticPreact.ts; fixtures in test/fixtures/sidebar/agentCardFixtures.ts.",
  "",
].join("\n");

function renderAll(AgentRow: (props: unknown) => unknown): string {
  const blocks = AGENT_CARD_FIXTURES.map((fixture) => {
    const html = scrubLocaleTimestamps(renderStatic(AgentRow(fixture.props)));
    return `## ${fixture.name}\n${html}\n`;
  });
  return `${HEADER}${blocks.join("\n")}`;
}

describe("SDD 479 — the default card template renders today's card", () => {
  let rendered: string;

  beforeAll(async () => {
    const mod = await loadWebviewModule(APP_TSX);
    const AgentRow = mod.AgentRow as (props: unknown) => unknown;
    expect(typeof AgentRow).toBe("function");
    rendered = renderAll(AgentRow);
    if (process.env.UPDATE_SIDEBAR_CARD_GOLDEN === "1") writeFileSync(GOLDEN_PATH, rendered, "utf8");
  });

  it("reproduces the pre-template card byte for byte across the fixture matrix", () => {
    const golden = readFileSync(GOLDEN_PATH, "utf8");
    // Compared per fixture first: a whole-file diff of 60 cards names nothing useful, while a failing
    // block names the row and the state that moved.
    const split = (text: string) =>
      new Map(
        text
          .split(/^## /m)
          .slice(1)
          .map((block) => {
            const newline = block.indexOf("\n");
            return [block.slice(0, newline), block.slice(newline + 1).trimEnd()] as const;
          }),
      );
    const goldenBlocks = split(golden);
    const renderedBlocks = split(rendered);
    expect([...renderedBlocks.keys()]).toEqual([...goldenBlocks.keys()]);
    for (const [name, html] of renderedBlocks) {
      expect(html, `card "${name}" differs from the pre-template renderer`).toBe(goldenBlocks.get(name));
    }
    expect(rendered).toBe(golden);
  });

  it("covers every fixture exactly once, and enough of them to be a matrix", () => {
    const names = AGENT_CARD_FIXTURES.map((f) => f.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names.length).toBeGreaterThanOrEqual(50);
  });

  it("proves the serializer can see a change (a matrix that cannot fail is not a proof)", () => {
    const a = renderStatic({ type: "span", props: { class: "x", children: "one" } });
    const b = renderStatic({ type: "span", props: { class: "x", children: "two" } });
    expect(a).not.toBe(b);
    // handlers are part of the comparison, not stripped from it
    expect(renderStatic({ type: "button", props: { onClick: () => {}, children: null } })).toContain('onClick="[fn]"');
  });
});
