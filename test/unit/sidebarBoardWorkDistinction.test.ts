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

/**
 * t-195a6c — the t-9eacf9 glance is still imprecise in two places: a triaged
 * card reads as in-progress work, and a dead agent's leftover brief reads as
 * current work. Both halves fail this file if they regress.
 */
describe("t-195a6c — assignment state vs current work", () => {
  let AgentRow: (props: unknown) => unknown;

  beforeAll(async () => {
    const mod = await loadWebviewModule(APP_TSX);
    AgentRow = mod.AgentRow as typeof AgentRow;
  });

  it("renders a triaged assignment as triaged, not as in-progress work", () => {
    const html = renderStatic(AgentRow({
      a: agent({
        name: "claude",
        attention: "idle",
        focus: {
          source: "task",
          taskId: "t-b928fc",
          taskStatus: "triaged",
          text: "Registrar o processo",
          full: "t-b928fc  Registrar o processo",
        },
      }),
      flash: false,
    }));
    expect(html).toContain('data-testid="agent-board-line"');
    expect(html).toContain("t-b928fc");
    expect(html).toContain("triaged");
    // The source label the human reads must be the board state, not `task`.
    expect(html).not.toMatch(/focus-src src-task[^>]*>task</);
    expect(html).toMatch(/data-board-status="triaged"/);
  });

  it("keeps an active assignment as in-progress work", () => {
    const html = renderStatic(AgentRow({
      a: agent({
        name: "worker",
        attention: "working",
        focus: {
          source: "task",
          taskId: "t-195a6c",
          taskStatus: "active",
          text: "sidebar card precision",
          full: "t-195a6c  sidebar card precision",
        },
      }),
      flash: false,
    }));
    expect(html).toContain("t-195a6c");
    expect(html).toMatch(/focus-src src-task[^>]*>task</);
    expect(html).toMatch(/data-board-status="active"/);
    expect(html).not.toContain("triaged");
  });

  it("does not claim current work from a leftover brief on a stopped agent", () => {
    const html = renderStatic(AgentRow({
      a: agent({
        name: "syspromptcodex",
        status: "stopped",
        resumable: true,
        focus: {
          source: "brief",
          text: "FATIA 1, e ela e so MEDIC",
          full: "FATIA 1, e ela e so MEDIC — delivered hours ago",
        },
      }),
      flash: false,
    }));
    expect(html).not.toContain("FATIA 1");
    expect(html).not.toContain("src-brief");
    expect(html).not.toContain('data-testid="agent-board-line"');
    expect(html).not.toContain('data-testid="agent-board-none"');
    // The card may still exist and may still say resumable. It must not
    // present the leftover brief as what the agent is doing now.
    expect(html).toContain("resumable");
  });

  it("does not claim current work from leftover continuity on a crashed agent", () => {
    const html = renderStatic(AgentRow({
      a: agent({
        name: "dead-goal",
        status: "crashed",
        focus: { source: "continuity", text: "ship the already-landed slice", full: "ship the already-landed slice" },
      }),
      flash: false,
    }));
    expect(html).not.toContain("ship the already-landed slice");
    expect(html).not.toContain("src-continuity");
  });

  it("still shows a parked assignment on a stopped agent as triaged, not as current work", () => {
    const html = renderStatic(AgentRow({
      a: agent({
        name: "parked-owner",
        status: "stopped",
        resumable: true,
        focus: {
          source: "task",
          taskId: "t-b928fc",
          taskStatus: "triaged",
          text: "Registrar o processo",
          full: "t-b928fc  Registrar o processo",
        },
      }),
      flash: false,
    }));
    expect(html).toContain("t-b928fc");
    expect(html).toContain("triaged");
    expect(html).toMatch(/data-board-status="triaged"/);
    expect(html).not.toMatch(/focus-src src-task[^>]*>task</);
  });
});
