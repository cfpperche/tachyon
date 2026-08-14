import { describe, expect, it } from "vitest";
import fs from "node:fs";
import { AgentManager } from "@tachyon/engine/agents/AgentManager.js";
import { TmuxService, workspaceHash, type ExecResult } from "@tachyon/engine/tmux/TmuxService.js";
import { parseConfig, type TachyonConfig } from "@tachyon/engine/config/loadConfig.js";
import { BRIEF_FILE_THRESHOLD, briefFilePath, deliverableBody } from "@tachyon/engine/agents/briefFile.js";
import { composeSpawnContractBrief, type SpawnContract } from "@tachyon/engine/bridge/spawnContract.js";
import { makeTempDir } from "../helpers/tempDir.js";

function configOf(yaml: string): TachyonConfig {
  const { config, errors } = parseConfig(yaml);
  if (!config) throw new Error(errors.join("; "));
  return config;
}

/** Real fs, real temp workspaceRoot (deliverableBody writes to disk) — captures the exact
 *  `new-session` cmd argument tmux would receive, mirroring agentManager.test.ts's captureSpawnCmd. */
async function spawnAndCapture(
  name: string,
  opts: { instructions?: string; taskBrief?: string; contract?: SpawnContract; parent?: string },
): Promise<{ cmd: string; workspaceRoot: string }> {
  const workspaceRoot = makeTempDir("sn-brief-");
  const calls: string[][] = [];
  const tmux = new TmuxService(async (args) => {
    calls.push(args);
    if (args[2] === "has-session" || args[2] === "list-panes") throw new Error("none");
    return { stdout: "", stderr: "" } satisfies ExecResult;
  });
  const manager = new AgentManager({
    tmux,
    wsHash: workspaceHash(workspaceRoot),
    workspaceRoot,
    getConfig: () => configOf("agents:\n  a:\n    cmd: x\n"),
  });
  await manager.spawn(name, {
    cmd: "claude",
    instructions: opts.instructions,
    taskBrief: opts.taskBrief,
    contract: opts.contract,
    parent: opts.parent,
  });
  const spawnArgs = calls.find((c) => c.includes("new-session"))!;
  return { cmd: spawnArgs[spawnArgs.length - 1], workspaceRoot };
}

describe("container-generated delegation behavior", () => {
  it("a long spawn contract is delivered in full via brief file while the pane payload stays short", async () => {
    const contract = `TASK: ${"paste the literal string exactly as written below ".repeat(80)}DONE_WHEN: it matches byte for byte.`;
    expect(contract.length).toBeGreaterThan(BRIEF_FILE_THRESHOLD);

    // No `parent` — keeps the composed body exactly equal to `contract` (no Bridge-guidance tail
    // appended on top), so the file-on-disk equality check below is exact.
    const structured: SpawnContract = {
      task: "Preserve the literal contract",
      context: "The transport is under test",
      constraints: "Do not truncate any bytes",
      doneWhen: "The bytes match exactly",
    };
    const { cmd, workspaceRoot } = await spawnAndCapture("longbrief", { taskBrief: contract, contract: structured });

    // The pane payload never carries the full contract text.
    expect(cmd).not.toContain(contract);
    // ...but it does point at the file that does, and still carries the primer/before-finishing framing.
    const file = briefFilePath(workspaceRoot, "longbrief");
    expect(cmd).toContain(file);
    expect(cmd).toContain("── TACHYON PRIMER ──");
    expect(cmd).toContain("── BEFORE FINISHING ──");
    expect(cmd).toContain("startup brief");
    expect(cmd).toContain("task contract (DONE_WHEN)");
    // The pane payload as a whole stays small relative to the contract it's standing in for.
    expect(cmd.length).toBeLessThan(contract.length);

    // The file inventory is followed by the contract in full, byte for byte.
    const onDisk = fs.readFileSync(file, "utf8");
    expect(onDisk).toContain("── STARTUP BRIEF CONTENTS ──");
    expect(onDisk.endsWith(contract)).toBe(true);
  });

  it("a short spawn contract stays inline, byte-identical, with no brief file written", async () => {
    const contract = "TASK: review the PR. DONE_WHEN: comments posted.";
    expect(contract.length).toBeLessThanOrEqual(BRIEF_FILE_THRESHOLD);

    const { cmd, workspaceRoot } = await spawnAndCapture("shortbrief", {
      taskBrief: contract,
      contract: {
        task: "Review the pull request",
        context: "The review is delegated",
        constraints: "Post findings only",
        doneWhen: "Comments are posted",
      },
      parent: "coordinator",
    });

    expect(cmd).toContain(contract);
    expect(fs.existsSync(briefFilePath(workspaceRoot, "shortbrief"))).toBe(false);
  });

  it("a realistic multi-KB coordinator spawn contract reaches the child losslessly via the brief file (t-11a2d1)", async () => {
    // Coordinator contracts in the wild run 2-6KB — composeSpawnContractBrief used to silently clip
    // each slot; now it's lossless, so a contract this size must survive whole into the brief file.
    const contract: SpawnContract = {
      task: "Investigate and fix the flaky upload-retry integration test on CI".repeat(3),
      context: "src/upload/client.ts times out under load; the last 20 CI runs show intermittent failures ".repeat(20),
      constraints: "no new deps; keep the public signature; do not touch unrelated modules ".repeat(15),
      deliverable: "a committed fix plus evidence that the target test passes 20/20 consecutive CI runs",
    };
    const brief = composeSpawnContractBrief("coordinator-child", contract, undefined, "coordinator");
    expect(brief.length).toBeGreaterThan(BRIEF_FILE_THRESHOLD);
    expect(brief).not.toMatch(/…/); // no ellipsis anywhere — nothing was truncated
    expect(brief).toContain(contract.context.trim().replace(/\s+/g, " "));
    expect(brief).toContain(contract.constraints.trim().replace(/\s+/g, " "));

    const { cmd, workspaceRoot } = await spawnAndCapture("coordinator-child", { taskBrief: brief, contract, parent: "coordinator" });

    // The pane payload never carries the full contract text...
    expect(cmd).not.toContain(contract.context.trim().replace(/\s+/g, " "));
    // ...but the file it points at does, byte for byte, still uncut.
    const file = briefFilePath(workspaceRoot, "coordinator-child");
    expect(cmd).toContain(file);
    expect(cmd).toContain("task contract (DELIVERABLE)");
    // AgentManager layers its own Bridge-coordination guidance on top of the composed contract
    // (spec 216, orthogonal to this test), so assert containment rather than exact equality —
    // the point is that the CONTRACT itself, embedded within, survives whole and uncut.
    const onDisk = fs.readFileSync(file, "utf8");
    expect(onDisk).toContain(brief);
  });

  it("deliverableBody: pure threshold + pointer behavior", () => {
    const workspaceRoot = makeTempDir("sn-brief-pure-");

    const short = "x".repeat(BRIEF_FILE_THRESHOLD);
    expect(deliverableBody(workspaceRoot, "agent", short)).toBe(short);
    expect(fs.existsSync(briefFilePath(workspaceRoot, "agent"))).toBe(false);

    const long = "y".repeat(BRIEF_FILE_THRESHOLD + 1);
    const pointer = deliverableBody(workspaceRoot, "agent", long);
    expect(pointer).not.toBe(long);
    expect(pointer).toContain(briefFilePath(workspaceRoot, "agent"));
    expect(fs.readFileSync(briefFilePath(workspaceRoot, "agent"), "utf8")).toBe(long);
  });
});
