/**
 * t-9eacf9 — a live sidebar card must show whether the agent has an open board
 * assignment. The human inferred "has work" from a live pane; the board was
 * empty. If the board line disappears, or a live agent without a card looks
 * like one with a card, this file goes red.
 */
import { describe, expect, it, beforeAll } from "vitest";
import path from "node:path";
import { loadWebviewModule, renderStatic } from "../helpers/staticPreact.js";
import type { AgentVM } from "@tachyon/shared/sidebar/types.js";

const APP_TSX = path.join(__dirname, "../../packages/webview-ui/src/webview/sidebar/App.tsx");

const agent = (overrides: Partial<AgentVM> = {}): AgentVM => ({
  name: "a",
  status: "running",
  kind: "agent",
  ...overrides,
});

describe("t-9eacf9 — sidebar card board-work distinction", () => {
  let AgentRow: (props: unknown) => unknown;

  beforeAll(async () => {
    const mod = await loadWebviewModule(APP_TSX);
    AgentRow = mod.AgentRow as typeof AgentRow;
  });

  it("shows the open board task id on the card", () => {
    const html = renderStatic(AgentRow({
      a: agent({
        name: "busy",
        attention: "working",
        focus: { source: "task", taskId: "t-9eacf9", text: "sidebar live vs work", full: "sidebar live vs work" },
      }),
      flash: false,
    }));
    expect(html).toContain('data-testid="agent-board-line"');
    expect(html).toContain("t-9eacf9");
    expect(html).not.toContain("no board task");
  });

  it("marks a live agent with no open card — brief fallback is not board work", () => {
    const html = renderStatic(AgentRow({
      a: agent({
        name: "idle-temp",
        status: "idle",
        attention: "idle",
        focus: { source: "brief", text: "the spawn brief still looks like work", full: "the spawn brief still looks like work" },
      }),
      flash: false,
    }));
    expect(html).toContain('data-testid="agent-board-none"');
    expect(html).toContain("no board task");
    expect(html).not.toContain('data-testid="agent-board-line"');
  });

  it("marks a live agent with no focus line at all", () => {
    const html = renderStatic(AgentRow({
      a: agent({ name: "empty-live", status: "running", attention: "working" }),
      flash: false,
    }));
    expect(html).toContain('data-testid="agent-board-none"');
    expect(html).toContain("no board task");
  });

  it("does not invent a board-work line on a stopped agent", () => {
    const html = renderStatic(AgentRow({
      a: agent({ name: "dead", status: "stopped" }),
      flash: false,
    }));
    expect(html).not.toContain("no board task");
    expect(html).not.toContain('data-testid="agent-board-line"');
    expect(html).not.toContain('data-testid="agent-board-none"');
  });

  it("does not invent a board-work line on a live terminal", () => {
    const html = renderStatic(AgentRow({
      a: agent({ name: "shell", kind: "terminal", status: "running" }),
      flash: false,
    }));
    expect(html).not.toContain("no board task");
    expect(html).not.toContain('data-testid="agent-board-none"');
  });
});
