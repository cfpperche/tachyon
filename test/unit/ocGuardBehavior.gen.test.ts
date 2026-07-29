import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentManager } from "../../src/agents/AgentManager.js";
import { hermeticLaunchPreflight } from "../helpers/hermeticLaunchPreflight.js";
import { asAgent, parseConfig } from "../../src/config/loadConfig.js";
import { SessionLedger } from "../../src/resume/SessionLedger.js";
import { TmuxService, workspaceHash, type ExecResult } from "../../src/tmux/TmuxService.js";
import type { WorktreeRecord } from "../../src/worktree/WorktreeManager.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("container-generated delegation behavior", () => {
  it("parented worktree opt-in spawn passes the conditional isolation guard", async () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-ocguard-"));
    dirs.push(ws);
    const config = parseConfig("agents:\n  boss:\n    cmd: claude\n").config!;
    const ledger = new SessionLedger(ws);
    const rec: WorktreeRecord = { path: path.join(ws, "..", "wt-helper"), branch: "tachyon/helper", tachyonCreatedBranch: true, baseRef: "base", createdAt: "t" };
    const newSessionArgs: string[][] = [];
    const exec = async (args: string[]): Promise<ExecResult> => {
      if (args.includes("new-session")) {
        newSessionArgs.push(args);
        return { stdout: "", stderr: "" };
      }
      if (args[2] === "has-session") throw new Error("can't find session");
      if (args[2] === "list-sessions") throw new Error("no server running");
      if (args[2] === "list-panes") throw new Error("no server running");
      return { stdout: "", stderr: "" };
    };
    const manager = new AgentManager({
      tmux: new TmuxService(exec),
      wsHash: workspaceHash(ws),
      workspaceRoot: ws,
      getConfig: () => config,
      ledger,
      launchPreflight: hermeticLaunchPreflight(),
      resolveSpawnCwd: async (ctx) => {
        expect(ctx.parent).toBe("boss");
        expect(asAgent(ctx.def)?.worktree).toBe(true);
        return { cwd: rec.path, worktree: rec };
      },
    });

    await expect(manager.spawn("helper", { cmd: "opencode", parent: "boss", worktree: true })).resolves.toBeUndefined();
    expect(newSessionArgs[0][newSessionArgs[0].indexOf("-c") + 1]).toBe(rec.path);
    expect(ledger.get("helper")?.worktree).toEqual(rec);
  });
});
