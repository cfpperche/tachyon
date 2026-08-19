import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentOccupancyVerdict } from "@tachyon/engine/agents/AgentManager.js";
import { removeAgentWorktree, type AgentWorktreeRemovalPorts } from "@tachyon/engine/agents/agentRemovalCascade.js";
import { closeAgentToolSessions } from "@tachyon/engine/agents/closeAgentToolSessions.js";
import { toolSessionNameForAgent } from "@tachyon/engine/agents/toolSession.js";
import type { WorktreeRecord } from "@tachyon/engine/worktree/worktreeRecord.js";

/**
 * t-ba0d68 — agent teardown must close the tool sessions THAT agent opened, through the
 * tool's own close port, before the worktree is deleted. It must not close another agent's
 * session and must not use `close --all`.
 */

const RECORD: WorktreeRecord = {
  path: "/checkouts/pincodex",
  branch: "tachyon/pincodex",
  tachyonCreatedBranch: true,
  baseRef: "0f0f0f0",
  createdAt: "2026-08-19T00:00:00.000Z",
};

function ports(opts: {
  closeToolSessions?: (agent: string) => void;
  onRemove?: () => void;
}): AgentWorktreeRemovalPorts & { events: string[] } {
  const events: string[] = [];
  const bundle: AgentWorktreeRemovalPorts & { events: string[] } = {
    events,
    manager: {
      liveDescendants: async () => [],
      probeAgentOccupancy: async (): Promise<AgentOccupancyVerdict> => ({ state: "free" }),
      kill: async () => { events.push("kill"); },
      releaseOwnedWorktreeForRemoval: async () => { events.push("release"); },
    },
    ledger: {
      get: () => ({ worktree: RECORD }),
      clearWorktree: () => { events.push("ledger-clear"); },
    },
    worktrees: {
      remove: async () => {
        events.push("git-remove");
        opts.onRemove?.();
        return { removed: true, branchDeleted: true };
      },
    },
    managedWorktrees: { syncAgentRecord: () => { events.push("registry-sync"); } },
    closeToolSessions: (agent: string) => {
      events.push(`close:${agent}`);
      opts.closeToolSessions?.(agent);
    },
  };
  return bundle;
}

describe("t-ba0d68 — teardown closes the dismissed agent's tool sessions", () => {
  it("positive: dismissing an agent that opened a tool session closes that session before worktree removal", async () => {
    const closed: string[] = [];
    const p = ports({ closeToolSessions: (agent) => closed.push(agent) });

    await removeAgentWorktree(p, "pincodex", true);

    expect(closed).toEqual(["pincodex"]);
    const closeAt = p.events.indexOf("close:pincodex");
    const removeAt = p.events.indexOf("git-remove");
    expect(closeAt).toBeGreaterThanOrEqual(0);
    expect(removeAt).toBeGreaterThan(closeAt);
  });

  it("negative: a session belonging to another agent is not closed", async () => {
    const sessions = new Set(["pincodex", "otheragent"]);
    const p = ports({
      closeToolSessions: (agent) => {
        sessions.delete(agent);
      },
    });

    await removeAgentWorktree(p, "pincodex", true);

    expect(sessions.has("pincodex")).toBe(false);
    expect(sessions.has("otheragent")).toBe(true);
    expect(p.events.filter((e) => e.startsWith("close:"))).toEqual(["close:pincodex"]);
    expect(p.events.join("\n")).not.toMatch(/--all|otheragent/);
  });

  it("a close that fails does not trap dismiss — worktree removal still runs", async () => {
    const p = ports({
      closeToolSessions: () => {
        throw new Error("tool did not answer close");
      },
    });

    await expect(removeAgentWorktree(p, "pincodex", true)).resolves.toMatchObject({ removed: true });
    expect(p.events).toContain("git-remove");
    expect(p.events).toContain("ledger-clear");
  });
});

describe("t-ba0d68 — closeAgentToolSessions talks to the tool's own close port", () => {
  it("invokes the launcher close for the stamped session and never passes --all", async () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "t-ba0d68-close-"));
    fs.mkdirSync(path.join(ws, ".tachyon", "bin"), { recursive: true });
    fs.writeFileSync(path.join(ws, ".tachyon", "bin", "_tachyon-tool"), "#!/bin/sh\n", { mode: 0o755 });
    const calls: Array<{ cmd: string; argv: readonly string[] }> = [];
    try {
      await closeAgentToolSessions({
        agent: "pincodex",
        workspaceRoot: ws,
        spawn: (cmd, argv) => {
          calls.push({ cmd, argv });
          return {
            once: (event, cb) => {
              if (event === "exit") queueMicrotask(cb);
            },
            unref: () => undefined,
          };
        },
      });
      expect(calls).toHaveLength(1);
      expect(calls[0]!.argv).toEqual(["agent-browser", "agent-browser", "--session", toolSessionNameForAgent("pincodex"), "close"]);
      expect(calls[0]!.argv).not.toContain("--all");
      expect(calls[0]!.argv).not.toContain("tachyon-otheragent");
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });

  it("does not throw when the tool is absent or the spawn fails", async () => {
    await expect(closeAgentToolSessions({ agent: "pincodex", workspaceRoot: "/no/such/workspace" })).resolves.toBeUndefined();
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "t-ba0d68-close-fail-"));
    fs.mkdirSync(path.join(ws, ".tachyon", "bin"), { recursive: true });
    fs.writeFileSync(path.join(ws, ".tachyon", "bin", "_tachyon-tool"), "#!/bin/sh\n", { mode: 0o755 });
    try {
      await expect(closeAgentToolSessions({
        agent: "pincodex",
        workspaceRoot: ws,
        spawn: () => { throw new Error("timeout"); },
      })).resolves.toBeUndefined();
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });
});
