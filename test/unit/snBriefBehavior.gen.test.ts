import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentManager } from "../../src/agents/AgentManager.js";
import { TmuxService, workspaceHash, type ExecResult } from "../../src/tmux/TmuxService.js";
import { parseConfig, type TachyonConfig } from "../../src/config/loadConfig.js";
import { BRIEF_FILE_THRESHOLD, briefFilePath, deliverableBody } from "../../src/agents/briefFile.js";
import { composeSpawnContractBrief, type SpawnContract } from "../../src/bridge/spawnContract.js";

function configOf(yaml: string): TachyonConfig {
  const { config, errors } = parseConfig(yaml);
  if (!config) throw new Error(errors.join("; "));
  return config;
}

/** Real fs, real temp workspaceRoot (deliverableBody writes to disk) — captures the exact
 *  `new-session` cmd argument tmux would receive, mirroring agentManager.test.ts's captureSpawnCmd. */
async function spawnAndCapture(
  name: string,
  opts: { instructions: string; parent?: string },
): Promise<{ cmd: string; workspaceRoot: string }> {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sn-brief-"));
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
    getMaxAgents: () => 8,
  });
  await manager.spawn(name, { cmd: "claude", instructions: opts.instructions, parent: opts.parent });
  const spawnArgs = calls.find((c) => c.includes("new-session"))!;
  return { cmd: spawnArgs[spawnArgs.length - 1], workspaceRoot };
}

describe("container-generated delegation behavior", () => {
  it("a long spawn contract is delivered in full via brief file while the pane payload stays short", async () => {
    const contract = `TASK: ${"paste the literal string exactly as written below ".repeat(80)}DONE_WHEN: it matches byte for byte.`;
    expect(contract.length).toBeGreaterThan(BRIEF_FILE_THRESHOLD);

    // No `parent` — keeps the composed body exactly equal to `contract` (no Bridge-guidance tail
    // appended on top), so the file-on-disk equality check below is exact.
    const { cmd, workspaceRoot } = await spawnAndCapture("longbrief", { instructions: contract });

    // The pane payload never carries the full contract text.
    expect(cmd).not.toContain(contract);
    // ...but it does point at the file that does, and still carries the primer/before-finishing framing.
    const file = briefFilePath(workspaceRoot, "longbrief");
    expect(cmd).toContain(file);
    expect(cmd).toContain("── TACHYON PRIMER ──");
    expect(cmd).toContain("── BEFORE FINISHING ──");
    // The pane payload as a whole stays small relative to the contract it's standing in for.
    expect(cmd.length).toBeLessThan(contract.length);

    // The file on disk carries the contract in full, byte for byte.
    expect(fs.readFileSync(file, "utf8")).toBe(contract);
  });

  it("a short spawn contract stays inline, byte-identical, with no brief file written", async () => {
    const contract = "TASK: review the PR. DONE_WHEN: comments posted.";
    expect(contract.length).toBeLessThanOrEqual(BRIEF_FILE_THRESHOLD);

    const { cmd, workspaceRoot } = await spawnAndCapture("shortbrief", { instructions: contract, parent: "coordinator" });

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
      doneWhen: "the target test passes 20/20 consecutive CI runs and the fix is committed",
    };
    const brief = composeSpawnContractBrief("coordinator-child", contract, undefined, "coordinator");
    expect(brief.length).toBeGreaterThan(BRIEF_FILE_THRESHOLD);
    expect(brief).not.toMatch(/…/); // no ellipsis anywhere — nothing was truncated
    expect(brief).toContain(contract.context.trim().replace(/\s+/g, " "));
    expect(brief).toContain(contract.constraints.trim().replace(/\s+/g, " "));

    const { cmd, workspaceRoot } = await spawnAndCapture("coordinator-child", { instructions: brief, parent: "coordinator" });

    // The pane payload never carries the full contract text...
    expect(cmd).not.toContain(contract.context.trim().replace(/\s+/g, " "));
    // ...but the file it points at does, byte for byte, still uncut.
    const file = briefFilePath(workspaceRoot, "coordinator-child");
    expect(cmd).toContain(file);
    // AgentManager layers its own Bridge-coordination guidance on top of the composed contract
    // (spec 216, orthogonal to this test), so assert containment rather than exact equality —
    // the point is that the CONTRACT itself, embedded within, survives whole and uncut.
    const onDisk = fs.readFileSync(file, "utf8");
    expect(onDisk).toContain(brief);
  });

  it("deliverableBody: pure threshold + pointer behavior", () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sn-brief-pure-"));

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
