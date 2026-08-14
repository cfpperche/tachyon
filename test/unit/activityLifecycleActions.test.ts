import { describe, expect, it } from "vitest";
import {
  restartAgentWithActivity,
  resumeAgentWithActivity,
  startAgentWithActivity,
  type ActivityLifecycleRecorder,
  type ActivityLifecycleWorkspace,
} from "@tachyon/engine/activity/ActivityLogManager.js";

describe("persistent engine activity lifecycle actions", () => {
  it("preserves the complete manual restart order before executing in the engine", async () => {
    const events: string[] = [];
    const workspace = fakeWorkspace(events);
    await restartAgentWithActivity(workspace, recorder(events), "codex");
    expect(events).toEqual([
      "reset:codex",
      "checkpoint:codex",
      "note:hash:codex:restarted",
      "restart:codex",
      "arm:hash:codex",
    ]);
  });

  it("clears an uncommitted Activity boundary when a start fails", async () => {
    const events: string[] = [];
    const workspace = fakeWorkspace(events, { failStart: true });
    await expect(startAgentWithActivity(workspace, recorder(events), "codex")).rejects.toThrow("start failed");
    expect(events).toEqual([
      "note:hash:codex:started",
      "spawn:codex",
      "clear:hash:codex",
    ]);
  });

  it("resets backoff and arms the durable boundary only after resume succeeds", async () => {
    const events: string[] = [];
    const workspace = fakeWorkspace(events);
    await resumeAgentWithActivity(workspace, recorder(events), "codex");
    expect(events).toEqual([
      "reset:codex",
      "note:hash:codex:resumed",
      "resume:codex",
      "arm:hash:codex",
    ]);
  });
});

function fakeWorkspace(events: string[], options: { failStart?: boolean } = {}): ActivityLifecycleWorkspace {
  return {
    wsHash: "hash",
    manager: {
      spawn: async (agent) => {
        events.push(`spawn:${agent}`);
        if (options.failStart) throw new Error("start failed");
      },
      restart: async (agent) => { events.push(`restart:${agent}`); },
    },
    lifecycle: { resetBackoff: (agent) => { events.push(`reset:${agent}`); } },
    checkpointBeforeTeardown: async (agent) => { events.push(`checkpoint:${agent}`); },
    resumeAgent: async (agent) => { events.push(`resume:${agent}`); },
  };
}

function recorder(events: string[]): ActivityLifecycleRecorder {
  return {
    noteLifecycle: (hash, agent, action) => { events.push(`note:${hash}:${agent}:${action}`); },
    armLifecycle: (hash, agent) => { events.push(`arm:${hash}:${agent}`); },
    clearLifecycle: (hash, agent) => { events.push(`clear:${hash}:${agent}`); },
  };
}
