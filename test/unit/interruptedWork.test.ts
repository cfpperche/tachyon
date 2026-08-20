import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { registerFleetTools } from "../../packages/bridge/src/tools/fleet.js";
import { makeTempDir } from "../helpers/tempDir.js";

describe("interrupted_work", () => {
  it("composes interrupted Temporary worktree state and reports missing dependencies in one read", async () => {
    const worktreePath = makeTempDir("tachyon-interrupted-work-");
    const handlers = new Map<string, (args: Record<string, never>) => Promise<{ content: Array<{ text: string }> }>>();
    const ledgerRecord = {
      worktree: {
        path: worktreePath,
        branch: "tachyon/tmp.worker",
        dependencies: { mode: "absent", reason: "install did not complete" },
      },
    };
    registerFleetTools({
      registerTool: (name: string, _schema: unknown, handler: unknown) => handlers.set(name, handler as never),
    } as never, {
      workspaceRoot: worktreePath,
      manager: {
        list: async () => [{
          name: "worker",
          session: "s-worker",
          running: false,
          lifetime: "temporary",
          resumePolicy: "restartable",
          dead: false,
          crashed: false,
          kind: "agent",
          parent: "coordinator",
          interruptedAtStartup: true,
        }],
        postmortemTail: () => undefined,
      },
      managedWorktrees: {
        listClassified: async () => [{
          agent: "worker",
          path: worktreePath,
          branch: "tachyon/tmp.worker",
          classification: { state: "needs-review", reasons: ["1 uncommitted change"] },
          ownerPresence: "stopped",
        }],
      },
      agentWorktrees: { ledger: { get: () => ledgerRecord } },
    } as never);

    expect(fs.existsSync(path.join(worktreePath, "node_modules"))).toBe(false);
    const result = await handlers.get("interrupted_work")!({});
    const report = JSON.parse(result.content[0]!.text);
    expect(report).toEqual({
      interrupted: 1,
      agents: [{
        agent: "worker",
        interruptedAtStartup: true,
        lifetime: "temporary",
        parent: "coordinator",
        actions: { resume: true, dismiss: true, redelegate: true },
        worktree: {
          path: worktreePath,
          branch: "tachyon/tmp.worker",
          classification: { state: "needs-review", reasons: ["1 uncommitted change"] },
          ownerPresence: "stopped",
          dependencies: {
            installed: false,
            recordedMode: "absent",
            recordedReason: "install did not complete",
          },
        },
      }],
    });
  });
});
