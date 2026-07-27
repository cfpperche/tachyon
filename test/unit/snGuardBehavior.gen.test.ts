import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentManager } from "../../src/agents/AgentManager.js";
import { asAgent, parseConfig } from "../../src/config/loadConfig.js";
import { SessionLedger } from "../../src/resume/SessionLedger.js";
import { TmuxService, workspaceHash, type ExecResult } from "../../src/tmux/TmuxService.js";
import type { WorktreeRecord } from "../../src/worktree/WorktreeManager.js";

/** t-ef19a1 — RULING: the trust asymmetry is INTENTIONAL (a tachyon.yml author already has full
 *  extension trust; a declared opencode agent with no `harness:` is allowed to run without isolation,
 *  same as before). This is an anti-footgun WARNING only — it never changes the allow/refuse decision.
 *  A declared opencode agent with neither a harness block nor an isolated worktree shares the global
 *  ~/.local/share opencode config/auth/session state with every other non-isolated opencode agent, so
 *  Tachyon warns once at spawn time via the same host.notify("warn") channel used elsewhere. */
describe("container-generated delegation behavior", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  function fakeTmux() {
    const newSessionArgs: string[][] = [];
    const exec = async (args: string[]): Promise<ExecResult> => {
      if (args.includes("new-session")) {
        newSessionArgs.push(args);
        return { stdout: "", stderr: "" };
      }
      switch (args[2]) {
        case "has-session":
          throw new Error("can't find session");
        case "list-sessions":
        case "list-panes":
          throw new Error("no server running");
        default:
          return { stdout: "", stderr: "" };
      }
    };
    return { newSessionArgs, tmux: new TmuxService(exec) };
  }

  it("a declared opencode agent without harness or worktree isolation emits a one-line footgun warning", async () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-snguard-"));
    dirs.push(ws);
    const { config, errors } = parseConfig(
      "agents:\n" +
        "  oc:\n" +
        "    cmd: opencode\n" +
        "  ocHarness:\n" +
        "    cmd: opencode\n" +
        "    harness: {}\n" +
        "  ocWorktree:\n" +
        "    cmd: opencode\n" +
        "    worktree: true\n" +
        "  cl:\n" +
        "    cmd: claude\n",
    );
    expect(errors).toEqual([]);
    const ledger = new SessionLedger(ws);
    const rec: WorktreeRecord = { path: path.join(ws, "..", "wt-ocWorktree"), branch: "tachyon/ocWorktree", tachyonCreatedBranch: true, baseRef: "base", createdAt: "t" };
    const notifications: { message: string; level: "warn" }[] = [];
    const { newSessionArgs, tmux } = fakeTmux();
    const manager = new AgentManager({
      tmux,
      wsHash: workspaceHash(ws),
      workspaceRoot: ws,
      getConfig: () => config,
      getMaxAgents: () => 8,
      ledger,
      notify: (message, level) => notifications.push({ message, level }),
      resolveSpawnCwd: async (ctx) => (asAgent(ctx.def)?.worktree ? { cwd: rec.path, worktree: rec } : null),
    });

    // 1. Declared opencode, no harness, no worktree isolation → exactly one footgun warning.
    await manager.spawn("oc");
    expect(notifications).toHaveLength(1);
    expect(notifications[0].level).toBe("warn");
    expect(notifications[0].message).toContain("'oc'");
    expect(notifications[0].message).toContain("harness: {}");
    expect(notifications[0].message.split("\n")).toHaveLength(1); // one line

    // 2. Same shape but WITH harness:{} → no additional warning (isolated via private-home XDG).
    await manager.spawn("ocHarness");
    expect(notifications).toHaveLength(1);

    // 3. Same shape but spawned into an isolated worktree → no additional warning.
    await manager.spawn("ocWorktree");
    expect(notifications).toHaveLength(1);

    // 4. A declared claude agent (no harness) never gets the opencode-specific warning.
    await manager.spawn("cl");
    expect(notifications).toHaveLength(1);

    expect(newSessionArgs).toHaveLength(4);
  });
});
