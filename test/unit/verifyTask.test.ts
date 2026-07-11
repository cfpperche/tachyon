import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { verifyTask, type VerifyTaskRecord } from "../../src/bridge/verifyTask.js";
import { delegationRecordFromSpawn, writeDelegationRecord } from "../../src/bridge/delegationRecord.js";
import { appendDoorbellEvent } from "../../src/bridge/doorbell.js";
import { registerTools, type BridgeDeps } from "../../src/bridge/tools.js";
import { DeliveryStore } from "../../src/delivery/store.js";
import { deliveryToVerificationRecord, resolveOperationalSegment } from "../../src/delivery/verifyAdapter.js";
import type { DelegationSegment, Delivery } from "../../src/delivery/types.js";

// t-7acc58 — wraps the real verifyTask in a vi.fn that call-throughs by default (every existing test in
// this file keeps exercising the real implementation), so the new verify_task Bridge-tool describe block
// below can swap in mockResolvedValueOnce/mockImplementationOnce for a handful of calls without ever
// hitting real git/npx/behavior-command execution through the tools.ts handler (which has no runner override).
vi.mock("../../src/bridge/verifyTask.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/bridge/verifyTask.js")>();
  return { ...actual, verifyTask: vi.fn(actual.verifyTask) };
});

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "tachyon-test",
  GIT_AUTHOR_EMAIL: "tachyon@example.test",
  GIT_COMMITTER_NAME: "tachyon-test",
  GIT_COMMITTER_EMAIL: "tachyon@example.test",
};

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: ENV }).trim();
}

function write(file: string, body: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, "utf8");
}

function makeRepo(initial = "old"): { repo: string; wt: string; baseSha: string } {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-vtask-repo-"));
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-vtask-wt-"));
  fs.rmSync(wt, { recursive: true, force: true });
  git(repo, ["init", "-q"]);
  write(path.join(repo, ".gitignore"), "node_modules/\n");
  write(path.join(repo, "src", "feature.txt"), `${initial}\n`);
  write(
    path.join(repo, "behavior.js"),
    "const fs = require('fs'); process.exit(fs.readFileSync('src/feature.txt', 'utf8').trim() === 'new' ? 0 : 1);\n",
  );
  write(path.join(repo, "package.json"), JSON.stringify({ scripts: { test: "node npm-behavior.js" } }, null, 2));
  write(
    path.join(repo, "npm-behavior.js"),
    [
      "const fs = require('fs');",
      "const args = process.argv.slice(2);",
      "const pattern = args[args.indexOf('-t') + 1];",
      "const feature = fs.readFileSync('src/feature.txt', 'utf8').trim();",
      "const report = (passed, failed, pending, name) => console.log(JSON.stringify({ numTotalTests: 1, numPassedTests: passed, numFailedTests: failed, numPendingTests: pending, testResults: [{ assertionResults: name ? [{ fullName: name, status: failed ? 'failed' : 'passed' }] : [] }] }));",
      "if (pattern !== 'quote \"x\" (case)' && pattern !== 'generated behavior stays canonical') { report(0, 0, 1); process.exit(0); }",
      "if (feature === 'new') { report(1, 0, 0, pattern); process.exit(0); }",
      "report(0, 1, 0, pattern); process.exit(1);",
      "",
    ].join("\n"),
  );
  git(repo, ["add", ".gitignore", "src/feature.txt", "behavior.js", "package.json", "npm-behavior.js"]);
  git(repo, ["commit", "-qm", "base"]);
  const baseSha = git(repo, ["rev-parse", "HEAD"]);
  git(repo, ["worktree", "add", "-q", "-b", "tachyon/worker", wt, "HEAD"]);
  return { repo, wt, baseSha };
}

function record(repo: string, baseSha: string, owns: string[] = ["src"], behaviorTest = "cmd:node behavior.js", delegator?: string, stubPath?: string): string {
  const createdAt = new Date().toISOString();
  writeDelegationRecord(
    repo,
    delegationRecordFromSpawn({
      agent: "worker",
      delegator,
      baseSha,
      taskRef: "tachyon/worker",
      gate: { behaviorTest, owns },
      ...(stubPath ? { stubPath } : {}),
      contract: { task: "ship behavior", context: "fixture", constraints: "none", doneWhen: "behavior passes" },
      createdAt,
    }),
  );
  return createdAt;
}

async function testRunner(cwd: string, argv: string[], _opts?: { timeout?: number }) {
  if (argv[0] === "npx" && argv[1] === "vitest" && argv[2] === "related") {
    return { command: argv.join(" "), argv, exitCode: 0, stdout: "related ok\n", stderr: "" };
  }
  try {
    const stdout = execFileSync(argv[0], argv.slice(1), { cwd, encoding: "utf8", env: ENV });
    return { command: argv.join(" "), argv, exitCode: 0, stdout, stderr: "" };
  } catch (err) {
    const e = err as Error & { status?: number; stdout?: Buffer | string; stderr?: Buffer | string };
    return {
      command: argv.join(" "),
      argv,
      exitCode: typeof e.status === "number" ? e.status : 1,
      stdout: e.stdout?.toString() ?? "",
      stderr: e.stderr?.toString() ?? e.message,
    };
  }
}

function runVerify(input: Parameters<typeof verifyTask>[0]) {
  return verifyTask({ runner: testRunner, ...input });
}

/** A fake MCP server that just captures tool handlers (mirrors probeBridge.test.ts's FakeMcp). */
type FakeToolResult = { content: { text: string }[]; isError?: boolean; structuredContent?: unknown };
class FakeMcp {
  handlers = new Map<string, (args: Record<string, unknown>) => Promise<FakeToolResult>>();
  registerTool(name: string, _def: unknown, handler: (args: Record<string, unknown>) => Promise<FakeToolResult>) {
    this.handlers.set(name, handler);
  }
}

function wireVerifyTaskTool(workspaceRoot: string, caller: BridgeDeps["caller"]): FakeMcp {
  const mcp = new FakeMcp();
  const deps = {
    workspaceRoot,
    manager: { agentStates: async () => new Map() },
    caller,
  } as unknown as BridgeDeps;
  registerTools(mcp as never, deps);
  return mcp;
}

async function callVerifyTaskTool(mcp: FakeMcp, args: Record<string, unknown>) {
  const handler = mcp.handlers.get("verify_task");
  if (!handler) throw new Error("verify_task not registered");
  return handler(args);
}

describe("verifyTask", () => {
  const roots: string[] = [];

  beforeEach(() => {
    roots.length = 0;
  });

  afterEach(() => {
    for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  });

  function fixture(initial?: string) {
    const f = makeRepo(initial);
    roots.push(f.repo, f.wt);
    return f;
  }

  it("accepts a clean scoped task commit whose behavior fails at base and passes at head", async () => {
    const { repo, wt, baseSha } = fixture();
    write(path.join(wt, "src", "feature.txt"), "new\n");
    git(wt, ["add", "src/feature.txt"]);
    git(wt, ["commit", "-qm", "t-123abc implement behavior"]);
    record(repo, baseSha);

    const result = await runVerify({ workspaceRoot: repo, agent: "worker" });

    expect(result.verdict).toBe("accept");
    expect(result.blockers).toEqual([]);
    expect(result.record.baseSha).toBe(baseSha);
    expect(result.record.refSha).toMatch(/^[0-9a-f]{40}$/);
    expect(result.record.integrityHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.record.commands.map((c) => c.name)).toEqual(["affected_tests", "behavior_head_expect_pass", "behavior_base_expect_fail"]);
    expect(result.record.commands[1]).toMatchObject({ argv: ["node", "behavior.js"] });
    expect(fs.existsSync(path.join(repo, ".tachyon", "verifications", `${result.record.refSha}.json`))).toBe(true);
  });

  it("resolves an explicit delivery_id through a transient verification adapter", async () => {
    const { repo, wt, baseSha } = fixture();
    write(path.join(wt, "src", "feature.txt"), "new\n");
    git(wt, ["add", "src/feature.txt"]);
    git(wt, ["commit", "-qm", "t-delivery implement behavior"]);
    const store = new DeliveryStore(repo);
    await store.create({
      id: "d-verify-explicit",
      workspaceId: "ws",
      createdBy: { kind: "agent", name: "coordinator" },
      contract: { taskId: "t-delivery", baseSha, behaviorTest: "cmd:node behavior.js", owns: ["src"], taskRef: "tachyon/worker" },
      segments: [{
        id: "seg-0", index: 0, role: "implementer", executionAgent: "worker",
        grantedBy: { kind: "agent", name: "coordinator" }, ownsSubset: ["src"],
        grantedHeadSha: baseSha, grantedAt: "2026-01-01T00:00:00.000Z",
      }],
    });

    const result = await runVerify({ workspaceRoot: repo, deliveryId: "d-verify-explicit", agent: "wrong-legacy-name" });

    expect(result.verdict).toBe("accept");
    expect(result.record.agent).toBe("worker");
    expect(result.record.identity).toMatchObject({ legacy: "worker", canonical: "worker", deliveryId: "d-verify-explicit", segmentId: "seg-0", segmentIndex: 0 });
    expect(fs.existsSync(path.join(repo, ".tachyon", "delegations"))).toBe(false);
  });

  /** Builds a Delivery on the fixture's taskRef. `segments` are given tail-last. */
  async function delivery(repo: string, id: string, baseSha: string, agents: string[]) {
    await new DeliveryStore(repo).create({
      id,
      workspaceId: "ws",
      createdBy: { kind: "agent", name: "coordinator" },
      contract: { taskId: "t-delivery", baseSha, behaviorTest: "cmd:node behavior.js", owns: ["src"], taskRef: "tachyon/worker" },
      segments: agents.map((executionAgent, index) => ({
        id: `seg-${index}`,
        index,
        role: index === 0 ? ("implementer" as const) : ("fixer" as const),
        executionAgent,
        grantedBy: { kind: "agent" as const, name: "coordinator" },
        ownsSubset: ["src"],
        grantedHeadSha: baseSha,
        grantedAt: "2026-01-01T00:00:00.000Z",
        // every segment but the tail is closed — the store's own invariant
        ...(index < agents.length - 1
          ? { releasedAt: "2026-01-02T00:00:00.000Z", releasedHeadSha: baseSha, outcome: "completed" as const }
          : {}),
      })),
    });
  }

  // t-0b5723 (F2) — the operational identity is the CURRENT occupant. Before this fix the adapter handed
  // the verifier segment zero, so a live tail (the fixer actually holding the worktree) went unnoticed and
  // verify_task would have mutated the worktree out from under it.
  it("treats the tail segment as the live occupant: a running fixer blocks, and is what gets recorded", async () => {
    const { repo, wt, baseSha } = fixture();
    write(path.join(wt, "src", "feature.txt"), "new\n");
    git(wt, ["add", "src/feature.txt"]);
    git(wt, ["commit", "-qm", "t-delivery implement behavior"]);
    await delivery(repo, "d-tail", baseSha, ["worker", "fixer"]);

    const asked: string[] = [];
    const locked: string[] = [];
    const result = await runVerify({
      workspaceRoot: repo,
      deliveryId: "d-tail",
      isAgentRunning: async (name) => (asked.push(name), name === "fixer"), // only the tail is still live
      withWorktreeLock: async (name, fn) => (locked.push(name), fn()),
    });

    expect(asked).toEqual(["fixer"]); // NOT "worker" (segment zero)
    expect(locked).toEqual(["fixer"]);
    expect(result.verdict).toBe("blocked");
    expect(result.blockers.map((b) => b.code)).toContain("agent_still_running");
    expect(result.blockers.find((b) => b.code === "agent_still_running")!.detail).toContain("'fixer'");
    expect(result.record.agent).toBe("fixer");
    expect(result.record.identity).toMatchObject({ legacy: "worker", canonical: "fixer", deliveryId: "d-tail", segmentId: "seg-1", segmentIndex: 1 });
  });

  // t-0b5723 (F3) — two Deliveries can land the same commit on the same ref. Their verification artifacts
  // must not be the same file, and must not hash the same.
  it("keeps verification records of two deliveries at the same refSha distinct", async () => {
    const { repo, wt, baseSha } = fixture();
    write(path.join(wt, "src", "feature.txt"), "new\n");
    git(wt, ["add", "src/feature.txt"]);
    git(wt, ["commit", "-qm", "t-delivery implement behavior"]);
    await delivery(repo, "d-alpha", baseSha, ["worker-a"]);
    await delivery(repo, "d-beta", baseSha, ["worker-b"]);

    const alpha = await runVerify({ workspaceRoot: repo, deliveryId: "d-alpha" });
    const beta = await runVerify({ workspaceRoot: repo, deliveryId: "d-beta" });

    expect(alpha.record.refSha).toBe(beta.record.refSha); // same commit...
    expect(alpha.recordPath).not.toBe(beta.recordPath); // ...different artifacts
    expect(alpha.record.integrityHash).not.toBe(beta.record.integrityHash);
    expect(fs.existsSync(alpha.recordPath)).toBe(true);
    expect(fs.existsSync(beta.recordPath)).toBe(true);
    // and each one still says which delivery/segment it is about
    expect(alpha.record.identity).toMatchObject({ deliveryId: "d-alpha", canonical: "worker-a" });
    expect(JSON.parse(fs.readFileSync(alpha.recordPath, "utf8"))).toMatchObject({ identity: { deliveryId: "d-alpha" } });
    expect(JSON.parse(fs.readFileSync(beta.recordPath, "utf8"))).toMatchObject({ identity: { deliveryId: "d-beta" } });
  });

  it("re-verifying the same delivery overwrites its own record rather than conflicting", async () => {
    const { repo, wt, baseSha } = fixture();
    write(path.join(wt, "src", "feature.txt"), "new\n");
    git(wt, ["add", "src/feature.txt"]);
    git(wt, ["commit", "-qm", "t-delivery implement behavior"]);
    await delivery(repo, "d-idem", baseSha, ["worker"]);

    const first = await runVerify({ workspaceRoot: repo, deliveryId: "d-idem" });
    const second = await runVerify({ workspaceRoot: repo, deliveryId: "d-idem" });

    expect(second.recordPath).toBe(first.recordPath);
    expect(second.verdict).toBe("accept");
  });

  // t-0b5723 (F3) — legacy delegations keep the historic <refSha>.json path, so two different ones landing
  // the same SHA still collide. They must be refused, never silently overwritten.
  it("refuses to overwrite another delegation's verification record at the same refSha", async () => {
    const { repo, wt, baseSha } = fixture();
    write(path.join(wt, "src", "feature.txt"), "new\n");
    git(wt, ["add", "src/feature.txt"]);
    git(wt, ["commit", "-qm", "t-123abc implement behavior"]);
    record(repo, baseSha);
    const first = await runVerify({ workspaceRoot: repo, agent: "worker" });

    // a second, different delegation over the same ref at the same SHA
    writeDelegationRecord(repo, delegationRecordFromSpawn({
      id: "d-other", agent: "other", baseSha, taskRef: "tachyon/worker",
      gate: { behaviorTest: "cmd:node behavior.js", owns: ["src"] },
      contract: { task: "ship behavior", context: "fixture", constraints: "none", doneWhen: "done" },
      createdAt: new Date().toISOString(),
    }));

    const err = await runVerify({ workspaceRoot: repo, agent: "other" }).catch((e) => e);

    expect(err).toMatchObject({ code: "VERIFICATION_RECORD_CONFLICT" });
    // the original record survived intact
    expect(JSON.parse(fs.readFileSync(first.recordPath, "utf8"))).toMatchObject({ agent: "worker", integrityHash: first.record.integrityHash });
  });

  // t-0b5723 (F1) — the guard resolves the delivery and compares the caller against the occupant it
  // proved, so neither a delivery_id nor a spoofed `agent` argument gets a self-waiver through.
  it("refuses a self-waiver even when the caller spoofs `agent` or routes around it with delivery_id", async () => {
    const { repo, wt, baseSha } = fixture();
    write(path.join(wt, "src", "feature.txt"), "new\n");
    git(wt, ["add", "src/feature.txt"]);
    git(wt, ["commit", "-qm", "t-delivery implement behavior"]);
    await delivery(repo, "d-spoof", baseSha, ["worker", "fixer"]);
    const waivers = [{ finding: "README.md", reason: "self-authored, trust me" }];

    // the live tail occupant, naming someone else in `agent` to dodge a caller.name === agent check
    const spoofed = await runVerify({
      workspaceRoot: repo, deliveryId: "d-spoof", agent: "somebody-else", waivers,
      verifierCaller: { kind: "agent", name: "fixer" },
    }).catch((e) => e);
    expect(spoofed).toMatchObject({ code: "SELF_WAIVER_FORBIDDEN" });

    // the original occupant is an occupant too — it cannot waive the work it started either
    const original = await runVerify({
      workspaceRoot: repo, deliveryId: "d-spoof", waivers,
      verifierCaller: { kind: "agent", name: "worker" },
    }).catch((e) => e);
    expect(original).toMatchObject({ code: "SELF_WAIVER_FORBIDDEN" });

    // no verification artifact was written for a refused waiver
    expect(fs.existsSync(path.join(repo, ".tachyon", "verifications"))).toBe(false);
  });

  it("accepts a coordinator's waiver, and a self-caller's waiver-free verification", async () => {
    const { repo, wt, baseSha } = fixture();
    write(path.join(wt, "src", "feature.txt"), "new\n");
    git(wt, ["add", "src/feature.txt"]);
    git(wt, ["commit", "-qm", "t-delivery implement behavior"]);
    await delivery(repo, "d-coord", baseSha, ["worker"]);

    const coordinator = await runVerify({
      workspaceRoot: repo, deliveryId: "d-coord",
      waivers: [{ finding: "protocol_doorbell_missed", reason: "notified out of band" }],
      verifierCaller: { kind: "agent", name: "coordinator" },
    });
    expect(coordinator.verdict).toBe("accept");
    expect(coordinator.record.verifierCaller).toEqual({ kind: "agent", name: "coordinator" });

    const self = await runVerify({
      workspaceRoot: repo, deliveryId: "d-coord",
      verifierCaller: { kind: "agent", name: "worker" },
    });
    expect(self.verdict).toBe("accept");
  });

  // t-0b5723 (G1) — a legacy DelegationRecord's `reuse_worktree` fixer round (t-815796) grants a NEW agent
  // name the worktree via `appendFixerAttempt`, which never rewrites `record.agent` (that stays the
  // original delegate's name for the life of the record). Before this fix `identity.canonical` stayed the
  // original agent forever on this path, so the fixer's own self-waiver went unchecked (F1 reopened) and
  // liveness/lock checks fired against the ORIGINAL agent — who has already exited, that's why the
  // worktree was handed off — never against the live fixer (F2 reopened).
  it("a legacy delegation's reuse_worktree fixer cannot self-waive, and liveness/lock checks use the fixer, not the original agent", async () => {
    const { repo, wt, baseSha } = fixture();
    write(path.join(wt, "src", "feature.txt"), "new\n");
    git(wt, ["add", "src/feature.txt"]);
    git(wt, ["commit", "-qm", "t-123abc fixer round"]);
    const createdAt = new Date().toISOString();
    writeDelegationRecord(repo, {
      ...delegationRecordFromSpawn({
        agent: "worker",
        baseSha,
        taskRef: "tachyon/worker",
        gate: { behaviorTest: "cmd:node behavior.js", owns: ["src"] },
        contract: { task: "ship behavior", context: "fixture", constraints: "none", doneWhen: "behavior passes" },
        createdAt,
      }),
      fixerAttempts: [{ occupantAgent: "fixer-1", requestedOwnsSubset: [], grantedAt: createdAt, branchHeadAtGrant: baseSha }],
    });

    // F1 reopened check: the fixer, calling as its own resolved identity (not spoofing `agent`, which
    // must stay "worker" — that's the lookup key), cannot waive findings on the work it alone authored.
    const selfWaive = await runVerify({
      workspaceRoot: repo, agent: "worker",
      waivers: [{ finding: "README.md", reason: "self-authored, trust me" }],
      verifierCaller: { kind: "agent", name: "fixer-1" },
    }).catch((e) => e);
    expect(selfWaive).toMatchObject({ code: "SELF_WAIVER_FORBIDDEN" });
    expect(fs.existsSync(path.join(repo, ".tachyon", "verifications"))).toBe(false);

    // F2 reopened check: liveness and the worktree lock must name the fixer, not the original agent.
    const asked: string[] = [];
    const locked: string[] = [];
    const result = await runVerify({
      workspaceRoot: repo, agent: "worker",
      isAgentRunning: async (name) => (asked.push(name), name === "fixer-1"),
      withWorktreeLock: async (name, fn) => (locked.push(name), fn()),
    });
    expect(asked).toEqual(["fixer-1"]); // NOT "worker" (the original, already-exited agent)
    expect(locked).toEqual(["fixer-1"]);
    expect(result.verdict).toBe("blocked");
    expect(result.blockers.map((b) => b.code)).toContain("agent_still_running");
    expect(result.record.agent).toBe("fixer-1");
    expect(result.record.identity).toMatchObject({ legacy: "worker", canonical: "fixer-1", occupants: ["worker", "fixer-1"] });
  });

  // t-0b5723 (G2) — a Delivery is not capped at two segments. An interior segment (neither the original
  // occupant nor the current tail) still has its own commits scope-checked against its own grant
  // (`scopeBreachBlockers`), and must not be able to waive findings on that work just because
  // `assertWaiverAuthorized` used to check only `identity.legacy` (segment 0) and `identity.canonical`
  // (the tail).
  it("refuses a self-waiver from an interior segment of a 3-segment delivery, not just the first/tail", async () => {
    const { repo, wt, baseSha } = fixture();
    write(path.join(wt, "src", "feature.txt"), "new\n");
    git(wt, ["add", "src/feature.txt"]);
    git(wt, ["commit", "-qm", "t-delivery implement behavior"]);
    await delivery(repo, "d-interior", baseSha, ["worker", "fixer-1", "fixer-2"]);
    const waivers = [{ finding: "README.md", reason: "self-authored, trust me" }];

    const interior = await runVerify({
      workspaceRoot: repo, deliveryId: "d-interior", waivers,
      verifierCaller: { kind: "agent", name: "fixer-1" },
    }).catch((e) => e);
    expect(interior).toMatchObject({ code: "SELF_WAIVER_FORBIDDEN" });

    // the first and tail occupants are still refused too — unaffected by this fix.
    const first = await runVerify({
      workspaceRoot: repo, deliveryId: "d-interior", waivers,
      verifierCaller: { kind: "agent", name: "worker" },
    }).catch((e) => e);
    expect(first).toMatchObject({ code: "SELF_WAIVER_FORBIDDEN" });
    const tail = await runVerify({
      workspaceRoot: repo, deliveryId: "d-interior", waivers,
      verifierCaller: { kind: "agent", name: "fixer-2" },
    }).catch((e) => e);
    expect(tail).toMatchObject({ code: "SELF_WAIVER_FORBIDDEN" });

    // a genuine coordinator still passes, and the record carries every occupant.
    const coordinator = await runVerify({
      workspaceRoot: repo, deliveryId: "d-interior", waivers,
      verifierCaller: { kind: "agent", name: "coordinator" },
    });
    expect(coordinator.verdict).toBe("accept");
    expect(coordinator.record.identity).toMatchObject({ occupants: ["worker", "fixer-1", "fixer-2"] });
  });

  it("runs behavior checks in the agent worktree so ignored node_modules tools are available", async () => {
    const { repo, wt, baseSha } = fixture();
    write(
      path.join(wt, "node_modules", ".bin", "behavior-runner"),
      "#!/usr/bin/env node\nconst fs = require('fs'); process.exit(fs.readFileSync('src/feature.txt', 'utf8').trim() === 'new' ? 0 : 1);\n",
    );
    fs.chmodSync(path.join(wt, "node_modules", ".bin", "behavior-runner"), 0o755);
    write(path.join(wt, "src", "feature.txt"), "new\n");
    git(wt, ["add", "src/feature.txt"]);
    git(wt, ["commit", "-qm", "t-123abc implement behavior"]);
    record(repo, baseSha, ["src"], "cmd:node_modules/.bin/behavior-runner");

    const result = await runVerify({ workspaceRoot: repo, agent: "worker" });

    expect(result.verdict).toBe("accept");
    expect(result.record.commands.map((c) => c.cwd)).toEqual([wt, wt, wt]);
    expect(result.record.commands[1]).toMatchObject({ argv: ["node_modules/.bin/behavior-runner"] });
    expect(git(wt, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("tachyon/worker");
  });

  it("passes plain behavior tests to npm as an argv array without shell interpolation", async () => {
    const { repo, wt, baseSha } = fixture();
    write(path.join(wt, "src", "feature.txt"), "new\n");
    git(wt, ["add", "src/feature.txt"]);
    git(wt, ["commit", "-qm", "t-123abc implement behavior"]);
    record(repo, baseSha, ["src"], 'quote "x" (case)');

    const result = await runVerify({ workspaceRoot: repo, agent: "worker" });

    expect(result.verdict).toBe("accept");
    expect(result.record.commands[1]).toMatchObject({ argv: ["npm", "test", "--", "--run", "-t", 'quote "x" (case)', "--reporter=json"] });
    expect(result.record.commands[1].command).not.toContain("sh -lc");
  });

  it("blocks plain behavior tests when the Vitest name filter matches no executable tests", async () => {
    const { repo, wt, baseSha } = fixture();
    write(path.join(wt, "src", "feature.txt"), "new\n");
    git(wt, ["add", "src/feature.txt"]);
    git(wt, ["commit", "-qm", "t-123abc implement behavior"]);
    record(repo, baseSha, ["src"], "missing behavior name");

    const result = await runVerify({ workspaceRoot: repo, agent: "worker" });

    expect(result.verdict).toBe("blocked");
    expect(result.blockers).toContainEqual({
      code: "behavior_failed",
      detail: expect.stringContaining("matched no executable Vitest tests"),
    });
    expect(result.record.commands.map((c) => c.name)).toEqual(["affected_tests", "behavior_head_expect_pass", "behavior_base_expect_fail"]);
    expect(result.record.commands[1]).toMatchObject({
      argv: ["npm", "test", "--", "--run", "-t", "missing behavior name", "--reporter=json"],
      exitCode: 86,
      stderr: "plain behaviorTest 'missing behavior name' matched no executable Vitest tests",
    });
  });

  it("blocks when the generated canonical behavior stub is renamed", async () => {
    const { repo, wt } = fixture();
    const stubPath = "test/unit/workerBehavior.gen.test.ts";
    write(path.join(wt, stubPath), "it('generated behavior stays canonical', () => {});\n");
    git(wt, ["add", stubPath]);
    git(wt, ["commit", "-qm", "tachyon setup: canonical behavior stub"]);
    const baseSha = git(wt, ["rev-parse", "HEAD"]);

    write(path.join(wt, "src", "feature.txt"), "new\n");
    fs.renameSync(path.join(wt, stubPath), path.join(wt, "test", "unit", "renamedBehavior.test.ts"));
    git(wt, ["add", "src/feature.txt", stubPath, "test/unit/renamedBehavior.test.ts"]);
    git(wt, ["commit", "-qm", "t-123abc implement behavior but rename stub"]);
    record(repo, baseSha, ["src", stubPath, "test/unit/renamedBehavior.test.ts"], "generated behavior stays canonical", undefined, stubPath);

    const result = await runVerify({ workspaceRoot: repo, agent: "worker" });

    expect(result.verdict).toBe("blocked");
    expect(result.blockers).toContainEqual({
      code: "behavior_test_renamed",
      detail: expect.stringContaining("canonical behavior test stub was renamed"),
      file: stubPath,
    });
  });

  it("blocks when the generated canonical behavior stub is removed", async () => {
    const { repo, wt } = fixture();
    const stubPath = "test/unit/workerBehavior.gen.test.ts";
    write(path.join(wt, stubPath), "it('generated behavior stays canonical', () => {});\n");
    git(wt, ["add", stubPath]);
    git(wt, ["commit", "-qm", "tachyon setup: canonical behavior stub"]);
    const baseSha = git(wt, ["rev-parse", "HEAD"]);

    write(path.join(wt, "src", "feature.txt"), "new\n");
    fs.rmSync(path.join(wt, stubPath));
    git(wt, ["add", "src/feature.txt", stubPath]);
    git(wt, ["commit", "-qm", "t-123abc implement behavior but remove stub"]);
    record(repo, baseSha, ["src", stubPath], "generated behavior stays canonical", undefined, stubPath);

    const result = await runVerify({ workspaceRoot: repo, agent: "worker" });

    expect(result.verdict).toBe("blocked");
    expect(result.blockers).toContainEqual({
      code: "behavior_test_renamed",
      detail: `canonical behavior test stub was removed: ${stubPath}`,
      file: stubPath,
    });
  });

  it("blocks when the executed Vitest name does not match the generated canonical behavior test", async () => {
    const { repo, wt } = fixture();
    const stubPath = "test/unit/workerBehavior.gen.test.ts";
    write(path.join(wt, stubPath), "it('renamed behavior', () => {});\n");
    git(wt, ["add", stubPath]);
    git(wt, ["commit", "-qm", "tachyon setup: canonical behavior stub"]);
    const baseSha = git(wt, ["rev-parse", "HEAD"]);

    write(path.join(wt, "src", "feature.txt"), "new\n");
    git(wt, ["add", "src/feature.txt", stubPath]);
    git(wt, ["commit", "-qm", "t-123abc implement behavior with renamed test name"]);
    record(repo, baseSha, ["src", stubPath], "generated behavior stays canonical", undefined, stubPath);

    let behaviorRuns = 0;
    const result = await verifyTask({
      workspaceRoot: repo,
      agent: "worker",
      runner: async (_cwd, argv) => {
        if (argv[0] === "npx") return { command: argv.join(" "), argv, exitCode: 0, stdout: "related ok\n", stderr: "" };
        behaviorRuns += 1;
        const exitCode = behaviorRuns === 1 ? 0 : 1;
        return {
          command: argv.join(" "),
          argv,
          exitCode,
          stdout: JSON.stringify({
            numTotalTests: 1,
            numPassedTests: exitCode === 0 ? 1 : 0,
            numFailedTests: exitCode === 0 ? 0 : 1,
            numPendingTests: 0,
            testResults: [{ assertionResults: [{ fullName: "renamed behavior", status: exitCode === 0 ? "passed" : "failed" }] }],
          }),
          stderr: "",
        };
      },
    });

    expect(result.verdict).toBe("blocked");
    expect(result.blockers).toContainEqual({
      code: "behavior_test_renamed",
      detail: `canonical behavior test 'generated behavior stays canonical' was not observed in ${stubPath}`,
      file: stubPath,
    });
  });

  it("accepts a generated canonical behavior test reported with its describe wrapper in Vitest fullName", async () => {
    const { repo, wt } = fixture();
    const stubPath = "test/unit/workerBehavior.gen.test.ts";
    write(
      path.join(wt, stubPath),
      [
        'import { describe, it } from "vitest";',
        'describe("container-generated delegation behavior", () => {',
        "  it('generated behavior stays canonical', () => {});",
        "});",
        "",
      ].join("\n"),
    );
    git(wt, ["add", stubPath]);
    git(wt, ["commit", "-qm", "tachyon setup: canonical behavior stub"]);
    const baseSha = git(wt, ["rev-parse", "HEAD"]);

    write(path.join(wt, "src", "feature.txt"), "new\n");
    git(wt, ["add", "src/feature.txt", stubPath]);
    git(wt, ["commit", "-qm", "t-123abc implement behavior with wrapped test name"]);
    record(repo, baseSha, ["src", stubPath], "generated behavior stays canonical", undefined, stubPath);

    let behaviorRuns = 0;
    const result = await verifyTask({
      workspaceRoot: repo,
      agent: "worker",
      runner: async (_cwd, argv) => {
        if (argv[0] === "npx") return { command: argv.join(" "), argv, exitCode: 0, stdout: "related ok\n", stderr: "" };
        behaviorRuns += 1;
        const exitCode = behaviorRuns === 1 ? 0 : 1;
        return {
          command: argv.join(" "),
          argv,
          exitCode,
          stdout: JSON.stringify({
            numTotalTests: 1,
            numPassedTests: exitCode === 0 ? 1 : 0,
            numFailedTests: exitCode === 0 ? 0 : 1,
            numPendingTests: 0,
            testResults: [
              {
                assertionResults: [
                  {
                    ancestorTitles: ["container-generated delegation behavior"],
                    fullName: "container-generated delegation behavior generated behavior stays canonical",
                    status: exitCode === 0 ? "passed" : "failed",
                    title: "generated behavior stays canonical",
                  },
                ],
              },
            ],
          }),
          stderr: "",
        };
      },
    });

    expect(result.verdict).toBe("accept");
    expect(result.blockers).toEqual([]);
  });

  it("runs configured typecheck and affected tests on every verification but skips full by default", async () => {
    const { repo, wt, baseSha } = fixture();
    write(path.join(repo, "tachyon.yml"), "agents:\n  worker:\n    cmd: codex\nsettings:\n  verify:\n    typecheck: node typecheck.js\n    full: node full.js\n");
    write(path.join(wt, "typecheck.js"), "process.exit(0);\n");
    write(path.join(wt, "full.js"), "process.exit(0);\n");
    write(path.join(wt, "src", "feature.txt"), "new\n");
    git(wt, ["add", "src/feature.txt", "typecheck.js", "full.js"]);
    git(wt, ["commit", "-qm", "t-123abc implement behavior"]);
    record(repo, baseSha, ["src", "typecheck.js", "full.js"]);

    const result = await runVerify({ workspaceRoot: repo, agent: "worker" });

    expect(result.verdict).toBe("accept");
    expect(result.record.commands.map((c) => c.name)).toEqual(["typecheck", "affected_tests", "behavior_head_expect_pass", "behavior_base_expect_fail"]);
    expect(result.record.commands[0].argv).toEqual(["node", "typecheck.js"]);
    expect(result.record.commands[1].argv).toEqual(["npx", "vitest", "related", "--run", "full.js", "src/feature.txt", "typecheck.js"]);
  });

  it("filters affected-test files to paths that still exist at refSha", async () => {
    const { repo, wt } = fixture();
    write(path.join(wt, "src", "removed.txt"), "delete me\n");
    git(wt, ["add", "src/removed.txt"]);
    git(wt, ["commit", "-qm", "t-123abc add removable fixture"]);
    const taskBase = git(wt, ["rev-parse", "HEAD"]);
    write(path.join(wt, "src", "feature.txt"), "new\n");
    fs.rmSync(path.join(wt, "src", "removed.txt"));
    git(wt, ["add", "src/feature.txt", "src/removed.txt"]);
    git(wt, ["commit", "-qm", "t-123abc implement behavior and delete file"]);
    record(repo, taskBase, ["src"]);

    const result = await runVerify({ workspaceRoot: repo, agent: "worker" });

    expect(result.verdict).toBe("accept");
    expect(result.record.commands[0].argv).toEqual(["npx", "vitest", "related", "--run", "src/feature.txt"]);
  });

  it("runs the configured full command only when full:true is requested", async () => {
    const { repo, wt, baseSha } = fixture();
    write(path.join(repo, "tachyon.yml"), "agents:\n  worker:\n    cmd: codex\nsettings:\n  verify:\n    full: node full.js\n");
    write(path.join(wt, "full.js"), "process.exit(0);\n");
    write(path.join(wt, "src", "feature.txt"), "new\n");
    git(wt, ["add", "src/feature.txt", "full.js"]);
    git(wt, ["commit", "-qm", "t-123abc implement behavior"]);
    record(repo, baseSha, ["src", "full.js"]);

    const result = await runVerify({ workspaceRoot: repo, agent: "worker", full: true });

    expect(result.verdict).toBe("accept");
    expect(result.record.commands.map((c) => c.name)).toEqual(["affected_tests", "full_tests", "behavior_head_expect_pass", "behavior_base_expect_fail"]);
    expect(result.record.commands[1].argv).toEqual(["node", "full.js"]);
  });

  it("blocks when a tiered verification command fails", async () => {
    const { repo, wt, baseSha } = fixture();
    write(path.join(wt, "src", "feature.txt"), "new\n");
    git(wt, ["add", "src/feature.txt"]);
    git(wt, ["commit", "-qm", "t-123abc implement behavior"]);
    record(repo, baseSha);

    const result = await verifyTask({
      workspaceRoot: repo,
      agent: "worker",
      runner: async (cwd, argv, opts) => {
        if (argv[0] === "npx") return { command: argv.join(" "), argv, exitCode: 1, stdout: "", stderr: "related failed\n" };
        return testRunner(cwd, argv, opts);
      },
    });

    expect(result.verdict).toBe("blocked");
    expect(result.blockers.map((b) => b.code)).toContain("affected_tests_failed");
    expect(result.blockers.map((b) => b.code)).toContain("behavior_not_run");
    expect(result.record.commands.map((c) => c.name)).toEqual(["affected_tests"]);
  });

  it("blocks when the task ref has no new commit", async () => {
    const { repo, baseSha } = fixture();
    record(repo, baseSha);

    const result = await runVerify({ workspaceRoot: repo, agent: "worker" });

    expect(result.verdict).toBe("blocked");
    expect(result.blockers.map((b) => b.code)).toContain("no_commit");
  });

  it("blocks dirty agent worktrees", async () => {
    const { repo, wt, baseSha } = fixture();
    write(path.join(wt, "src", "feature.txt"), "new\n");
    git(wt, ["add", "src/feature.txt"]);
    git(wt, ["commit", "-qm", "t-123abc implement behavior"]);
    write(path.join(wt, "scratch.txt"), "uncommitted\n");
    record(repo, baseSha);

    const result = await runVerify({ workspaceRoot: repo, agent: "worker" });

    expect(result.verdict).toBe("blocked");
    expect(result.blockers.map((b) => b.code)).toContain("dirty_worktree");
  });

  it("blocks behavior verification while the agent is still running", async () => {
    const { repo, wt, baseSha } = fixture();
    write(path.join(wt, "src", "feature.txt"), "new\n");
    git(wt, ["add", "src/feature.txt"]);
    git(wt, ["commit", "-qm", "t-123abc implement behavior"]);
    record(repo, baseSha);

    const result = await runVerify({ workspaceRoot: repo, agent: "worker", isAgentRunning: async () => true });

    expect(result.verdict).toBe("blocked");
    expect(result.blockers.map((b) => b.code)).toContain("agent_still_running");
    expect(result.record.commands).toEqual([]);
    expect(git(wt, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("tachyon/worker");
  });

  it("runs behavior verification inside the supplied worktree lock", async () => {
    const { repo, wt, baseSha } = fixture();
    write(path.join(wt, "src", "feature.txt"), "new\n");
    git(wt, ["add", "src/feature.txt"]);
    git(wt, ["commit", "-qm", "t-123abc implement behavior"]);
    record(repo, baseSha);
    const calls: string[] = [];

    const result = await runVerify({
      workspaceRoot: repo,
      agent: "worker",
      isAgentRunning: async () => false,
      withWorktreeLock: async (agent, fn) => {
        calls.push(`lock:${agent}`);
        const out = await fn();
        calls.push(`unlock:${agent}`);
        return out;
      },
    });

    expect(result.verdict).toBe("accept");
    expect(calls).toEqual(["lock:worker", "unlock:worker"]);
    expect(git(wt, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("tachyon/worker");
  });

  it("blocks files outside declared owns paths", async () => {
    const { repo, wt, baseSha } = fixture();
    write(path.join(wt, "src", "feature.txt"), "new\n");
    write(path.join(wt, "README.md"), "outside\n");
    git(wt, ["add", "src/feature.txt", "README.md"]);
    git(wt, ["commit", "-qm", "t-123abc implement behavior"]);
    record(repo, baseSha, ["src"]);

    const result = await runVerify({ workspaceRoot: repo, agent: "worker" });

    expect(result.verdict).toBe("blocked");
    expect(result.blockers).toContainEqual({ code: "scope_breach", detail: "changed file is outside declared owns paths", file: "README.md" });
  });

  it("t-815796 HIGH fix: a fixer round's commits are scope-checked against ITS granted owns_subset, not the original delegation's wider owns", async () => {
    const { repo, wt, baseSha } = fixture();

    // The original agent's own commit — within the original, wide `owns: ["src"]`.
    write(path.join(wt, "src", "feature.txt"), "new\n");
    git(wt, ["add", "src/feature.txt"]);
    git(wt, ["commit", "-qm", "t-123abc original agent work"]);
    const branchHeadAtGrant = git(wt, ["rev-parse", "HEAD"]);

    // A fixer round is granted ONLY `src/fix.txt` — narrower than `owns`. It commits one file inside
    // that subset (fine) and one file outside the subset but still inside the original `owns` (must be
    // flagged: the grant, not the original delegation's owns, is this round's actual authority).
    write(path.join(wt, "src", "fix.txt"), "fixed\n");
    write(path.join(wt, "src", "other.txt"), "outside the granted subset\n");
    git(wt, ["add", "src/fix.txt", "src/other.txt"]);
    git(wt, ["commit", "-qm", "t-123abc fixer round"]);

    const createdAt = new Date().toISOString();
    writeDelegationRecord(repo, {
      ...delegationRecordFromSpawn({
        agent: "worker",
        baseSha,
        taskRef: "tachyon/worker",
        gate: { behaviorTest: "cmd:node behavior.js", owns: ["src"] },
        contract: { task: "ship behavior", context: "fixture", constraints: "none", doneWhen: "behavior passes" },
        createdAt,
      }),
      fixerAttempts: [{ occupantAgent: "fixer-1", requestedOwnsSubset: ["src/fix.txt"], grantedAt: createdAt, branchHeadAtGrant }],
    });

    const result = await runVerify({ workspaceRoot: repo, agent: "worker" });

    // The original agent's own commit (segment before any grant) is checked against `owns` and passes.
    expect(result.blockers.map((b) => b.file)).not.toContain("src/feature.txt");
    // The fixer's commit inside its granted subset passes.
    expect(result.blockers.map((b) => b.file)).not.toContain("src/fix.txt");
    // The fixer's commit outside its granted subset (but inside the original owns) is named to the attempt.
    expect(result.blockers).toContainEqual(
      expect.objectContaining({
        code: "scope_breach",
        file: "src/other.txt",
        detail: expect.stringContaining("fixer attempt 1 (fixer-1)"),
      }),
    );
    expect(result.blockers.filter((b) => b.code === "scope_breach")).toHaveLength(1);
  });

  it("waives a segmented scope breach by file path regardless of fixer attempt detail", async () => {
    const { repo, wt, baseSha } = fixture();

    write(path.join(wt, "src", "feature.txt"), "new\n");
    git(wt, ["add", "src/feature.txt"]);
    git(wt, ["commit", "-qm", "t-123abc original agent work"]);
    const branchHeadAtGrant = git(wt, ["rev-parse", "HEAD"]);

    write(path.join(wt, "src", "fix.txt"), "fixed\n");
    write(path.join(wt, "src", "other.txt"), "outside the granted subset\n");
    git(wt, ["add", "src/fix.txt", "src/other.txt"]);
    git(wt, ["commit", "-qm", "t-123abc fixer round"]);

    const createdAt = new Date().toISOString();
    writeDelegationRecord(repo, {
      ...delegationRecordFromSpawn({
        agent: "worker",
        baseSha,
        taskRef: "tachyon/worker",
        gate: { behaviorTest: "cmd:node behavior.js", owns: ["src"] },
        contract: { task: "ship behavior", context: "fixture", constraints: "none", doneWhen: "behavior passes" },
        createdAt,
      }),
      fixerAttempts: [{ occupantAgent: "fixer-1", requestedOwnsSubset: ["src/fix.txt"], grantedAt: createdAt, branchHeadAtGrant }],
    });

    const waiver = { finding: "src/other.txt", reason: "coordinator confirms fixer needed this adjacent file" };
    const result = await runVerify({ workspaceRoot: repo, agent: "worker", waivers: [waiver] });

    expect(result.verdict).toBe("accept");
    expect(result.blockers.map((b) => b.code)).not.toContain("scope_breach");
    expect(result.record.waivers).toEqual([waiver]);
    expect(result.record.findings).toContainEqual(
      expect.objectContaining({
        code: "scope_breach",
        file: "src/other.txt",
        detail: expect.stringContaining("fixer attempt 1 (fixer-1)"),
        blocking: false,
        waiver,
      }),
    );
  });

  it("rejects a waiver keyed on the bare code 'scope_breach' before any git work runs", async () => {
    const { repo, wt, baseSha } = fixture();
    write(path.join(wt, "src", "feature.txt"), "new\n");
    write(path.join(wt, "README.md"), "outside declared scope\n");
    git(wt, ["add", "src/feature.txt", "README.md"]);
    git(wt, ["commit", "-qm", "t-123abc implement behavior"]);
    record(repo, baseSha, ["src"]);

    await expect(
      runVerify({
        workspaceRoot: repo,
        agent: "worker",
        waivers: [{ finding: "scope_breach", reason: "blanket-waive everything" }],
      }),
    ).rejects.toThrow(/bare code 'scope_breach'/);

    // no verification record written — the rejection happened before any git/behavior work.
    expect(fs.existsSync(path.join(repo, ".tachyon", "verifications"))).toBe(false);
  });

  it("skips scope checking when owns is absent", async () => {
    const { repo, wt, baseSha } = fixture();
    write(path.join(wt, "src", "feature.txt"), "new\n");
    write(path.join(wt, "README.md"), "outside but owns is optional\n");
    git(wt, ["add", "src/feature.txt", "README.md"]);
    git(wt, ["commit", "-qm", "t-123abc implement behavior"]);
    record(repo, baseSha, []);

    const result = await runVerify({ workspaceRoot: repo, agent: "worker" });

    expect(result.verdict).toBe("accept");
    expect(result.blockers.map((b) => b.code)).not.toContain("scope_breach");
  });

  it("blocks behavior tests that already passed at BASE_SHA", async () => {
    const { repo, wt, baseSha } = fixture("new");
    write(path.join(wt, "README.md"), "shape only\n");
    git(wt, ["add", "README.md"]);
    git(wt, ["commit", "-qm", "t-123abc shape only"]);
    record(repo, baseSha, ["README.md"]);

    const result = await runVerify({ workspaceRoot: repo, agent: "worker" });

    expect(result.verdict).toBe("blocked");
    expect(result.blockers.map((b) => b.code)).toContain("behavior_already_passed");
  });

  it("blocks behavior tests that do not pass at HEAD", async () => {
    const { repo, wt, baseSha } = fixture();
    write(path.join(wt, "src", "feature.txt"), "still-old\n");
    git(wt, ["add", "src/feature.txt"]);
    git(wt, ["commit", "-qm", "t-123abc wrong behavior"]);
    record(repo, baseSha);

    const result = await runVerify({ workspaceRoot: repo, agent: "worker" });

    expect(result.verdict).toBe("blocked");
    expect(result.blockers.map((b) => b.code)).toContain("behavior_failed");
  });

  it("blocks suppression tripwires unless coordinator waivers match the finding", async () => {
    const { repo, wt, baseSha } = fixture();
    write(path.join(wt, "src", "feature.txt"), "new\n");
    write(path.join(wt, "test", "feature.test.ts"), "it.skip('old behavior', () => {});\n");
    git(wt, ["add", "src/feature.txt", "test/feature.test.ts"]);
    git(wt, ["commit", "-qm", "t-123abc behavior with suppression"]);
    record(repo, baseSha, ["src", "test"]);

    const blocked = await runVerify({ workspaceRoot: repo, agent: "worker" });
    expect(blocked.verdict).toBe("blocked");
    expect(blocked.blockers.map((b) => b.code)).toContain("test_suppression");

    const waived = await runVerify({
      workspaceRoot: repo,
      agent: "worker",
      waivers: [{ finding: "test_suppression", reason: "coordinator inspected changed behavior test", cites: "src/feature.txt" }],
    });
    expect(waived.verdict).toBe("accept");
    expect(waived.record.waivers).toHaveLength(1);
  });

  it("surfaces waived findings at the top level of the result, not just buried in record.findings", async () => {
    const { repo, wt, baseSha } = fixture();
    write(path.join(wt, "src", "feature.txt"), "new\n");
    write(path.join(wt, "README.md"), "outside declared scope\n");
    git(wt, ["add", "src/feature.txt", "README.md"]);
    git(wt, ["commit", "-qm", "t-123abc implement behavior"]);
    record(repo, baseSha, ["src"]);

    const clean = await runVerify({ workspaceRoot: repo, agent: "worker" });
    expect(clean.verdict).toBe("blocked");
    expect(clean.waivedFindings).toEqual([]);

    const waiver = { finding: "README.md", reason: "coordinator confirms README change is required by task scope" };
    const waived = await runVerify({ workspaceRoot: repo, agent: "worker", waivers: [waiver] });
    expect(waived.verdict).toBe("accept");
    expect(waived.waivedFindings).toEqual([
      { code: "scope_breach", detail: "changed file is outside declared owns paths", file: "README.md", blocking: false, waiver },
    ]);
  });

  it("records the resolved verifier caller on the record, defaulting to legacy, and hashes it into integrity", async () => {
    const { repo, wt, baseSha } = fixture();
    write(path.join(wt, "src", "feature.txt"), "new\n");
    git(wt, ["add", "src/feature.txt"]);
    git(wt, ["commit", "-qm", "t-123abc implement behavior"]);
    record(repo, baseSha);

    const legacy = await runVerify({ workspaceRoot: repo, agent: "worker" });
    expect(legacy.record.verifierCaller).toEqual({ kind: "legacy" });

    const withCaller = await runVerify({
      workspaceRoot: repo,
      agent: "worker",
      verifierCaller: { kind: "agent", name: "coordinator" },
    });
    expect(withCaller.record.verifierCaller).toEqual({ kind: "agent", name: "coordinator" });

    // integrity hash covers verifierCaller: a differently-attributed but otherwise-identical record hashes differently.
    expect(withCaller.record.integrityHash).not.toBe(legacy.record.integrityHash);
  });

  it("binds verification records to the exact ref SHA so later commits have no matching record", async () => {
    const { repo, wt, baseSha } = fixture();
    write(path.join(wt, "src", "feature.txt"), "new\n");
    git(wt, ["add", "src/feature.txt"]);
    git(wt, ["commit", "-qm", "t-123abc implement behavior"]);
    record(repo, baseSha);
    const first = await runVerify({ workspaceRoot: repo, agent: "worker" });

    write(path.join(wt, "src", "feature.txt"), "newer\n");
    git(wt, ["add", "src/feature.txt"]);
    git(wt, ["commit", "-qm", "t-123abc later commit"]);
    const current = git(repo, ["rev-parse", "tachyon/worker"]);

    expect(current).not.toBe(first.record.refSha);
    expect(fs.existsSync(path.join(repo, ".tachyon", "verifications", `${current}.json`))).toBe(false);
  });

  it("verify_task reports a missed doorbell as a non-blocking finding", async () => {
    const { repo, wt, baseSha } = fixture();
    write(path.join(wt, "src", "feature.txt"), "new\n");
    git(wt, ["add", "src/feature.txt"]);
    git(wt, ["commit", "-qm", "t-123abc implement behavior"]);
    record(repo, baseSha, ["src"], "cmd:node behavior.js", "boss");

    const result = await runVerify({ workspaceRoot: repo, agent: "worker" });

    expect(result.verdict).toBe("accept");
    expect(result.blockers).toEqual([]);
    expect(result.record.findings).toContainEqual({
      code: "protocol_doorbell_missed",
      detail: expect.stringContaining("boss"),
      blocking: false,
    });
  });

  it("clears protocol_doorbell_missed once the agent notifies its recorded delegator", async () => {
    const { repo, wt, baseSha } = fixture();
    write(path.join(wt, "src", "feature.txt"), "new\n");
    git(wt, ["add", "src/feature.txt"]);
    git(wt, ["commit", "-qm", "t-123abc implement behavior"]);
    const createdAt = record(repo, baseSha, ["src"], "cmd:node behavior.js", "boss");
    appendDoorbellEvent(repo, { from: "worker", to: "boss", at: createdAt });

    const result = await runVerify({ workspaceRoot: repo, agent: "worker" });

    expect(result.verdict).toBe("accept");
    expect(result.record.findings.map((f) => f.code)).not.toContain("protocol_doorbell_missed");
  });

  it("falls back to any outgoing doorbell event when the delegation record has no delegator", async () => {
    const { repo, wt, baseSha } = fixture();
    write(path.join(wt, "src", "feature.txt"), "new\n");
    git(wt, ["add", "src/feature.txt"]);
    git(wt, ["commit", "-qm", "t-123abc implement behavior"]);
    const createdAt = record(repo, baseSha);
    appendDoorbellEvent(repo, { from: "worker", to: "some-sibling", at: createdAt });

    const result = await runVerify({ workspaceRoot: repo, agent: "worker" });

    expect(result.record.findings.map((f) => f.code)).not.toContain("protocol_doorbell_missed");
  });

  it("keeps protocol_doorbell_missed out of blockers even when another finding blocks the verdict", async () => {
    const { repo, wt, baseSha } = fixture();
    write(path.join(wt, "src", "feature.txt"), "still-old\n");
    git(wt, ["add", "src/feature.txt"]);
    git(wt, ["commit", "-qm", "t-123abc wrong behavior"]);
    record(repo, baseSha, ["src"], "cmd:node behavior.js", "boss");

    const result = await runVerify({ workspaceRoot: repo, agent: "worker" });

    expect(result.verdict).toBe("blocked");
    expect(result.blockers.map((b) => b.code)).toContain("behavior_failed");
    expect(result.blockers.map((b) => b.code)).not.toContain("protocol_doorbell_missed");
    expect(result.record.findings.map((f) => f.code)).toContain("protocol_doorbell_missed");
  });
});

function fakeRecord(overrides: Partial<VerifyTaskRecord> = {}): VerifyTaskRecord {
  return {
    refSha: "a".repeat(40),
    treeSha: "b".repeat(40),
    baseSha: "c".repeat(40),
    taskRef: "tachyon/worker",
    agent: "worker",
    identity: { legacy: "worker", canonical: "worker", occupants: ["worker"] },
    verifierVersion: "test",
    commands: [],
    findings: [],
    waivers: [],
    verdict: "accept",
    at: new Date(0).toISOString(),
    verifierCaller: { kind: "legacy" },
    integrityHash: "d".repeat(64),
    ...overrides,
  };
}

describe("verify_task Bridge tool caller-identity guard (t-7acc58)", () => {
  beforeEach(() => {
    (verifyTask as unknown as Mock).mockClear();
  });

  // t-0b5723 (F1) — the guard now lives inside verifyTask, because it can only be decided AFTER the
  // delegation resolves: it compares the caller against the RESOLVED occupant, not against the `agent`
  // argument the caller supplied. So this drives the real implementation over a real record on disk.
  it("rejects a self-caller from waiving its own verification, after resolving the delegation", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-vtask-guard-"));
    writeDelegationRecord(root, delegationRecordFromSpawn({
      id: "d-guard",
      agent: "worker",
      baseSha: "a".repeat(40),
      taskRef: "tachyon/worker",
      gate: { behaviorTest: "behavior", owns: ["src"] },
      contract: { task: "task", context: "test", constraints: "none", doneWhen: "done" },
      createdAt: "2026-01-01T00:00:00.000Z",
    }));
    const mcp = wireVerifyTaskTool(root, { kind: "agent", name: "worker" });

    const res = await callVerifyTaskTool(mcp, {
      agent: "worker",
      waivers: [{ finding: "README.md", reason: "self-authored, trust me" }],
    });

    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain("an agent cannot waive findings on its own verification — waivers are coordinator-authored");
    expect(res.structuredContent).toMatchObject({ error: { code: "SELF_WAIVER_FORBIDDEN" } });
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("allows a self-caller to verify its own gate when no waivers are present", async () => {
    (verifyTask as unknown as Mock).mockResolvedValueOnce({
      verdict: "blocked",
      blockers: [{ code: "behavior_failed", detail: "nope" }],
      waivedFindings: [],
      record: fakeRecord({ verdict: "blocked", verifierCaller: { kind: "agent", name: "worker" } }),
      recordPath: "/tmp/fake-record.json",
    });

    const mcp = wireVerifyTaskTool("/does/not/matter", { kind: "agent", name: "worker" });
    const res = await callVerifyTaskTool(mcp, { agent: "worker" });

    expect(res.isError).toBeUndefined();
    expect(res.content[0]!.text).not.toContain("cannot waive findings on its own verification");
    expect(verifyTask).toHaveBeenCalledTimes(1);
    const call = (verifyTask as unknown as Mock).mock.lastCall![0];
    expect(call.verifierCaller).toEqual({ kind: "agent", name: "worker" });
  });

  it("allows a coordinator/legacy caller's file-keyed waiver, and marks accept+WAIVED at the top of the output", async () => {
    const waiver = { finding: "README.md", reason: "coordinator confirms README change is required by task scope" };
    const waivedFinding = { code: "scope_breach", detail: "changed file is outside declared owns paths", file: "README.md", blocking: false, waiver };
    (verifyTask as unknown as Mock).mockResolvedValueOnce({
      verdict: "accept",
      blockers: [],
      waivedFindings: [waivedFinding],
      record: fakeRecord({ findings: [waivedFinding], waivers: [waiver], verifierCaller: { kind: "legacy" } }),
      recordPath: "/tmp/fake-record.json",
    });

    const mcp = wireVerifyTaskTool("/does/not/matter", { kind: "legacy" });
    const res = await callVerifyTaskTool(mcp, { agent: "worker", waivers: [waiver] });

    expect(res.isError).toBeUndefined();
    const [verdictLine, ...jsonLines] = res.content[0]!.text.split("\n");
    expect(verdictLine).toBe("verdict: accept (1 finding(s) WAIVED — coordinator waivers applied)");
    const parsed = JSON.parse(jsonLines.join("\n"));
    expect(parsed.waivedFindings).toEqual([waivedFinding]);
    expect(parsed.record.verifierCaller).toEqual({ kind: "legacy" });
    const call = (verifyTask as unknown as Mock).mock.lastCall![0];
    expect(call.verifierCaller).toEqual({ kind: "legacy" });
  });

  it("does not prepend a WAIVED marker when the accept has no waived findings", async () => {
    (verifyTask as unknown as Mock).mockResolvedValueOnce({
      verdict: "accept",
      blockers: [],
      waivedFindings: [],
      record: fakeRecord(),
      recordPath: "/tmp/fake-record.json",
    });

    const mcp = wireVerifyTaskTool("/does/not/matter", { kind: "legacy" });
    const res = await callVerifyTaskTool(mcp, { agent: "worker" });

    expect(res.content[0]!.text.split("\n")[0]).toBe("verdict: accept");
  });
});

// t-0b5723 (F2) — the adapter's fail-closed identity resolution, driven directly so the ambiguous shapes
// the DeliveryStore's invariants would reject at write time can still be proven to be refused at read time.
describe("Delivery operational identity (t-0b5723 F2)", () => {
  function segment(over: Partial<DelegationSegment> & { id: string; index: number; executionAgent: string }): DelegationSegment {
    return {
      role: "implementer",
      grantedBy: { kind: "agent", name: "coordinator" },
      ownsSubset: ["src"],
      grantedHeadSha: "a".repeat(40),
      grantedAt: "2026-01-01T00:00:00.000Z",
      ...over,
    };
  }
  const closed = { releasedAt: "2026-01-02T00:00:00.000Z", releasedHeadSha: "b".repeat(40), outcome: "completed" as const };

  function delivery(over: Partial<Delivery> = {}): Delivery {
    return {
      schemaVersion: 1,
      id: "d-identity",
      version: 1,
      workspaceId: "ws",
      createdBy: { kind: "agent", name: "coordinator" },
      contract: { taskId: "t-x", baseSha: "a".repeat(40), behaviorTest: "cmd:node behavior.js", owns: ["src"], taskRef: "tachyon/worker" },
      lease: { state: "free", changedAt: "2026-01-01T00:00:00.000Z" },
      segments: [segment({ id: "seg-0", index: 0, executionAgent: "worker" })],
      events: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      ...over,
    };
  }

  it("names the tail segment — not segment zero — as the current occupant", () => {
    const view = deliveryToVerificationRecord(delivery({
      segments: [
        segment({ id: "seg-0", index: 0, executionAgent: "worker", ...closed }),
        segment({ id: "seg-1", index: 1, executionAgent: "fixer", role: "fixer" }),
      ],
    }));

    expect(view.identity).toMatchObject({ legacy: "worker", canonical: "fixer", deliveryId: "d-identity", segmentId: "seg-1", segmentIndex: 1 });
    // The contract itself is carried through untouched — the adapter reshapes identity, never authority.
    expect(view.record.owns).toEqual(["src"]);
    expect(view.record.baseSha).toBe("a".repeat(40));
    expect(view.record.agent).toBe("worker"); // scope anchor for record.owns; the fixer brings its own subset
  });

  it("refuses a Delivery with no segments instead of inventing an occupant", () => {
    expect(() => deliveryToVerificationRecord(delivery({ segments: [] })))
      .toThrow(expect.objectContaining({ code: "DELIVERY_SEGMENTS_MISSING" }) as Error);
  });

  it("refuses when two segments are still open (no single provable occupant)", () => {
    expect(() => resolveOperationalSegment(delivery({
      segments: [
        segment({ id: "seg-0", index: 0, executionAgent: "worker" }),
        segment({ id: "seg-1", index: 1, executionAgent: "fixer" }),
      ],
    }))).toThrow(expect.objectContaining({ code: "DELIVERY_IDENTITY_AMBIGUOUS" }) as Error);
  });

  it("refuses when the lease holder contradicts the tail segment", () => {
    expect(() => resolveOperationalSegment(delivery({
      segments: [
        segment({ id: "seg-0", index: 0, executionAgent: "worker", ...closed }),
        segment({ id: "seg-1", index: 1, executionAgent: "fixer" }),
      ],
      lease: { state: "held", changedAt: "x", holder: { segmentId: "seg-0", executionAgent: "worker" } },
    }))).toThrow(expect.objectContaining({ code: "DELIVERY_IDENTITY_AMBIGUOUS" }) as Error);
  });
});
