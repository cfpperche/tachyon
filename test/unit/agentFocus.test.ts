import { describe, it, expect } from "vitest";
import {
  briefFromLedger,
  parseContinuityCurrentGoal,
  pickFocusTask,
  resolveAgentFocus,
  truncateFocusText,
} from "@tachyon/engine/sidebar/agentFocus.js";

describe("agentFocus (spec 390)", () => {
  it("truncates with ellipsis", () => {
    expect(truncateFocusText("short")).toBe("short");
    expect(truncateFocusText("x".repeat(60))).toHaveLength(60);
    expect(truncateFocusText("x".repeat(61)).endsWith("…")).toBe(true);
    expect(truncateFocusText("x".repeat(61)).length).toBe(60);
  });

  it("parses Current Goal from continuity body", () => {
    const body = `# Current Goal\nLand focus line\n\n# Next Steps\n- dogfood\n`;
    expect(parseContinuityCurrentGoal(body)).toBe("Land focus line");
    expect(parseContinuityCurrentGoal("## Current Goal\n  - do the thing\n")).toBe("do the thing");
    expect(parseContinuityCurrentGoal("# Other\nnope")).toBeUndefined();
    expect(parseContinuityCurrentGoal(null)).toBeUndefined();
  });

  it("picks active task over triaged, then newest", () => {
    const tasks = [
      { id: "t-000001", title: "old active", status: "active", assignee: "codex", updatedAt: "2026-01-01T00:00:00Z" },
      { id: "t-000002", title: "new triaged", status: "triaged", assignee: "codex", updatedAt: "2026-07-01T00:00:00Z" },
      { id: "t-000003", title: "new active", status: "active", assignee: "codex", updatedAt: "2026-06-01T00:00:00Z" },
      { id: "t-000004", title: "other", status: "active", assignee: "claude", updatedAt: "2026-07-01T00:00:00Z" },
      { id: "t-000005", title: "done", status: "done", assignee: "codex", updatedAt: "2026-07-02T00:00:00Z" },
    ];
    expect(pickFocusTask("codex", tasks)?.id).toBe("t-000003");
    expect(pickFocusTask("nobody", tasks)).toBeUndefined();
  });

  it("brief prefers contract.task over taskBrief", () => {
    expect(briefFromLedger({ contractTask: "Implement X", taskBrief: "long file pointer" })).toBe("Implement X");
    expect(briefFromLedger({ taskBrief: "  only brief  " })).toBe("only brief");
    expect(briefFromLedger({})).toBeUndefined();
  });

  it("priority: task > brief > continuity > omit", () => {
    const tasks = [
      { id: "t-aaaaaa", title: "Fix rebind", status: "active", assignee: "codex", updatedAt: "2026-07-01T00:00:00Z" },
    ];
    const taskWin = resolveAgentFocus({
      agent: "codex",
      kind: "agent",
      tasks,
      ledger: { contractTask: "should lose" },
      continuityBody: "# Current Goal\nshould lose",
    });
    expect(taskWin).toMatchObject({ source: "task", taskId: "t-aaaaaa", text: "Fix rebind" });

    const briefWin = resolveAgentFocus({
      agent: "worker",
      kind: "agent",
      tasks,
      ledger: { contractTask: "Implement salvage recovery" },
      continuityBody: "# Current Goal\nignore me",
    });
    expect(briefWin).toMatchObject({ source: "brief", text: "Implement salvage recovery" });

    const goalWin = resolveAgentFocus({
      agent: "grok",
      kind: "agent",
      continuityBody: "# Current Goal\nProduct design for focus line",
    });
    expect(goalWin).toMatchObject({ source: "continuity", text: "Product design for focus line" });

    expect(resolveAgentFocus({ agent: "empty", kind: "agent" })).toBeUndefined();
    expect(resolveAgentFocus({ agent: "shell", kind: "terminal", continuityBody: "# Current Goal\nx" })).toBeUndefined();
  });
});
