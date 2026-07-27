import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { actionsFor } from "../../src/sidebar/actions.js";
import { isAgentRow, type AgentVM } from "../../src/sidebar/types.js";
import { toAgentVM } from "../../src/sidebar/agentModel.js";
import { resolveAgentFocus } from "../../src/sidebar/agentFocus.js";
import { internalShareTargets } from "../../src/activity/activityShare.js";

/**
 * SDD 478 M5 (`t-6ebdc8`) — the Agent/Terminal distinction had a SECOND copy living in the view
 * model (`AgentVM.ai?: boolean`) and a THIRD derived by negating unrelated studio kinds
 * (`!isScheduleOrCommandOrRunbook`). Both are gone; rows carry the union's arm.
 *
 * The old bit was optional, and its absence meant opposite things depending on who asked: the model
 * and focus code read `ai === false` (so undefined behaved like an agent) while the action gate read
 * `!!a.ai` (so undefined behaved like a terminal). A required arm cannot disagree with itself.
 */

const row = (over: Partial<AgentVM> & Pick<AgentVM, "name" | "status" | "kind">): AgentVM => ({ ...over });

describe("t-6ebdc8 — the sidebar reads the managed-entry arm", () => {
  it("offers transcript-shaped actions to an agent and withholds them from a terminal", () => {
    const agent = actionsFor(row({ name: "a", kind: "agent", status: "stopped", resumable: true }));
    const terminal = actionsFor(row({ name: "t", kind: "terminal", status: "stopped", resumable: true }));

    for (const action of ["activity", "probes", "resume"]) {
      expect(agent).toContain(action);
      expect(terminal).not.toContain(action);
    }
  });

  it("offers the live-pane operator ops only on the agent arm", () => {
    const agent = actionsFor(row({ name: "a", kind: "agent", status: "running" }));
    const terminal = actionsFor(row({ name: "t", kind: "terminal", status: "running" }));

    for (const action of ["reanchor", "reinjectContinuity", "injectPrompt"]) {
      expect(agent).toContain(action);
      expect(terminal).not.toContain(action);
    }
    // The shared lifecycle actions stay shared — a terminal is still a managed entry.
    for (const action of ["openPane", "stop", "kill", "restart"]) {
      expect(terminal).toContain(action);
    }
  });

  it("suppresses the model fact for a terminal and keeps it for an agent", () => {
    const live = { name: "x", running: true, dead: false, crashed: false, cmd: "claude --model claude-opus-5" };

    expect(toAgentVM(live, { kind: "terminal" }).model).toBeUndefined();
    expect(toAgentVM(live, { kind: "agent" }).model).toBeDefined();
  });

  it("carries the arm onto every row it builds", () => {
    expect(toAgentVM({ name: "x", running: true, dead: false, crashed: false, cmd: "bash" }, { kind: "terminal" }).kind).toBe("terminal");
    expect(toAgentVM({ name: "x", running: true, dead: false, crashed: false, cmd: "claude" }, { kind: "agent" }).kind).toBe("agent");
    // No caller-supplied arm still yields one, rather than a third "unknown" state downstream.
    expect(toAgentVM({ name: "x", running: true, dead: false, crashed: false, cmd: "claude" }, {}).kind).toBe("agent");
  });

  it("omits the focus line for a terminal", () => {
    const tasks = [{ id: "t-000001", title: "ship it", assignee: "x", status: "active" as const, updatedAt: "2026-07-27T00:00:00.000Z" }];

    expect(resolveAgentFocus({ agent: "x", kind: "terminal", tasks })).toBeUndefined();
    expect(resolveAgentFocus({ agent: "x", kind: "agent", tasks })).toBeDefined();
  });

  it("never offers a terminal as an activity-share target", () => {
    const targets = internalShareTargets(
      [row({ name: "peer", kind: "agent", status: "running" }), row({ name: "shell", kind: "terminal", status: "running" })],
      "source",
    );

    expect(targets.map((t) => t.name)).toEqual(["peer"]);
  });

  it("reads the arm through one narrowing", () => {
    expect(isAgentRow({ kind: "agent" })).toBe(true);
    expect(isAgentRow({ kind: "terminal" })).toBe(false);
  });

  it("leaves no parallel encoding behind", () => {
    // Structural, not behavioural: a behavioural test would keep passing if someone re-added the bit
    // beside the arm, which is exactly the state this milestone exists to end.
    const root = path.resolve(__dirname, "..", "..");
    const sources = [
      "src/sidebar/types.ts",
      "src/sidebar/actions.ts",
      "src/sidebar/agentModel.ts",
      "src/sidebar/agentFocus.ts",
      "src/sidebar/sidebarFleetService.ts",
      "src/activity/activityShare.ts",
    ];
    // Comments are stripped first: the doc that RECORDS the removal legitimately names the old bit.
    const stripComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    for (const rel of sources) {
      const code = stripComments(fs.readFileSync(path.join(root, rel), "utf8"));
      expect(code, `${rel} still declares or reads the parallel 'ai' bit`).not.toMatch(/\bai\?\s*:\s*boolean|\.ai\b/);
    }
    // And the third derivation, by negating unrelated studio kinds, is gone from the studio submit.
    const workspace = stripComments(fs.readFileSync(path.join(root, "src/workspace/Workspace.ts"), "utf8"));
    expect(workspace).not.toContain("isAgentKind");
    expect(workspace).not.toContain("!isScheduleOrCommandOrRunbook");
  });
});
