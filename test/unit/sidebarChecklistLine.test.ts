/**
 * t-281339 — the sidebar card shows one plan line. `no-channel` must not
 * appear. `absent` is a discrete --ds-warn mark. A long step is one
 * clipped line — the card does not grow.
 */
import { describe, expect, it, beforeAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { loadWebviewModule, renderStatic } from "../helpers/staticPreact.js";
import type { AgentVM } from "@tachyon/shared/sidebar/types.js";

const APP_TSX = path.join(__dirname, "../../packages/webview-ui/src/webview/sidebar/App.tsx");
const SIDEBAR_CSS = path.join(__dirname, "../../packages/webview-ui/src/webview/sidebar/sidebar.css");

const agent = (overrides: Partial<AgentVM> = {}): AgentVM => ({
  name: "a",
  status: "running",
  kind: "agent",
  ...overrides,
});

describe("t-281339 — sidebar card plan line", () => {
  let AgentRow: (props: unknown) => unknown;

  beforeAll(async () => {
    const mod = await loadWebviewModule(APP_TSX);
    AgentRow = mod.AgentRow as typeof AgentRow;
  });

  it("shows the current step text", () => {
    const html = renderStatic(AgentRow({
      a: agent({ name: "claude", checklist: { kind: "step", text: "write the sidebar line" } }),
      flash: false,
    }));
    expect(html).toContain('data-testid="agent-checklist-line"');
    expect(html).toContain('data-checklist="step"');
    expect(html).toContain("write the sidebar line");
    expect(html).not.toContain("absent");
    expect(html).not.toContain("no-channel");
  });

  it("paints English 'No checklist' — the human never reads the verdict enum", () => {
    const marked = renderStatic(AgentRow({
      a: agent({ name: "grok", checklist: { kind: "absent" } }),
      flash: false,
    }));
    expect(marked).toContain('data-testid="agent-checklist-line"');
    expect(marked).toContain('data-checklist="absent"');
    expect(marked).toContain(">No checklist<");
    expect(marked).not.toMatch(/<span class="checklist-mark">absent<\/span>/);
    expect(marked).not.toContain("no-channel");

    const invisible = renderStatic(AgentRow({
      a: agent({ name: "pi", runtime: "pi" }),
      flash: false,
    }));
    expect(invisible).not.toContain('data-testid="agent-checklist-line"');
    expect(invisible).not.toContain("No checklist");
    expect(invisible).not.toContain("no-channel");
  });

  it("no-channel is invisible — the field is omitted, the word is never painted", () => {
    const html = renderStatic(AgentRow({
      a: agent({ name: "pi", runtime: "pi" }),
      flash: false,
    }));
    expect(html).not.toMatch(/no-channel/);
    expect(html).not.toContain("agent-checklist-line");
  });

  it("the surface uses operator tokens, --ds-warn, and one-line clip — no hex", () => {
    const css = fs.readFileSync(SIDEBAR_CSS, "utf8");
    const start = css.indexOf(".row-checklist {");
    const end = css.indexOf(".msub {", start);
    const block = css.slice(start, end);
    expect(block).toContain("--ds-operator-label2");
    expect(block).toContain("--ds-operator-label1");
    expect(block).toContain("--ds-spacing-size");
    expect(block).toContain("--ds-warn");
    expect(block).toContain("white-space: nowrap");
    expect(block).toContain("text-overflow: ellipsis");
    expect(block).not.toMatch(/#[0-9a-fA-F]{3,8}/);
  });
});
