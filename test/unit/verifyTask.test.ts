import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from "vitest";
import fs from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { verifyTask, writeVerificationRecord, type VerifyTaskInput, type VerifyTaskRecord } from "../../src/bridge/verifyTask.js";
import { appendDoorbellEvent } from "../../src/bridge/doorbell.js";
import { registerTools, type BridgeDeps } from "../../src/bridge/tools.js";
import { DeliveryInvariantError, DeliveryStore, type DeliveryAuthorityHeadPort } from "../../src/delivery/store.js";
import { deliveryVerificationSubject, resolveOperationalSegment } from "../../src/delivery/verificationSubject.js";
import type { DelegationSegment, Delivery } from "../../src/delivery/types.js";
import { GitDeliveryStore } from "../../src/git-delivery/store.js";
import { DeliveryVerificationLeaseService } from "../../src/delivery/verificationLease.js";

// t-7acc58 — wraps the real verifyTask in a vi.fn that call-throughs by default (every existing test in
// this file keeps exercising the real implementation), so the new verify_task Bridge-tool describe block
// below can swap in mockResolvedValueOnce/mockImplementationOnce for a handful of calls without ever
// hitting real git/npx/behavior-command execution through the tools.ts handler (which has no runner override).
vi.mock("../../src/bridge/verifyTask.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/bridge/verifyTask.js")>();
  return { ...actual, verifyTask: vi.fn(actual.verifyTask) };
});

const AUTHORITY_INTEGRITY_KEY = Buffer.alloc(32, 0x42);
const CANONICAL_AUTHORITY_HEADS = new Map<string, { revision: number; mac: string }>();
const CANONICAL_AUTHORITY_HEAD: DeliveryAuthorityHeadPort = {
  current: async (identity) => CANONICAL_AUTHORITY_HEADS.get(identity),
  prepare: async (identity, next, expectedMac) => {
    const current = CANONICAL_AUTHORITY_HEADS.get(identity);
    if (expectedMac === undefined) {
      if (current !== undefined || next.revision !== 1) throw new Error("unexpected canonical authority creation head");
    } else if (!current || current.mac !== expectedMac || next.revision !== current.revision + 1) {
      throw new Error("unexpected canonical authority update head");
    }
    CANONICAL_AUTHORITY_HEADS.set(identity, { ...next });
  },
};

function authorityDeliveryStore(workspaceRoot: string, fixedNow?: string): DeliveryStore {
  return new DeliveryStore(workspaceRoot, {
    ...(fixedNow ? { now: () => fixedNow } : {}),
    authorityIntegrityKey: () => AUTHORITY_INTEGRITY_KEY,
    authorityHead: CANONICAL_AUTHORITY_HEAD,
  });
}

function storedDeliveryRecord(workspaceRoot: string, deliveryId: string): string {
  const database = new DatabaseSync(path.join(workspaceRoot, ".tachyon", "deliveries-v2.sqlite3"));
  try {
    const row = database.prepare("SELECT record_json FROM deliveries WHERE id = ?").get(deliveryId) as
      | { record_json: string }
      | undefined;
    if (!row) throw new Error(`Delivery '${deliveryId}' was not persisted`);
    return row.record_json;
  } finally {
    database.close();
  }
}

function replaceStoredDeliveryRecord(workspaceRoot: string, deliveryId: string, recordJson: string): void {
  const database = new DatabaseSync(path.join(workspaceRoot, ".tachyon", "deliveries-v2.sqlite3"));
  try {
    database.prepare("UPDATE deliveries SET record_json = ? WHERE id = ?").run(recordJson, deliveryId);
  } finally {
    database.close();
  }
}

function tamperDeliveryRecord(workspaceRoot: string, deliveryId: string, mutate: (record: Record<string, unknown>) => void): void {
  const database = new DatabaseSync(path.join(workspaceRoot, ".tachyon", "deliveries-v2.sqlite3"));
  try {
    const row = database.prepare("SELECT record_json FROM deliveries WHERE id = ?").get(deliveryId) as
      | { record_json: string }
      | undefined;
    if (!row) throw new Error(`Delivery '${deliveryId}' was not persisted`);
    const record = JSON.parse(row.record_json) as Record<string, unknown>;
    mutate(record);
    database.prepare("UPDATE deliveries SET record_json = ? WHERE id = ?").run(JSON.stringify(record), deliveryId);
  } finally {
    database.close();
  }
}

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "tachyon-test",
  GIT_AUTHOR_EMAIL: "tachyon@example.test",
  GIT_COMMITTER_NAME: "tachyon-test",
  GIT_COMMITTER_EMAIL: "tachyon@example.test",
};
const actor = { kind: "agent" as const, name: "coordinator" };

interface CanonicalTestSpec {
  wt: string;
  baseSha: string;
  owns: string[];
  behaviorTest: string;
  delegator?: string;
  stubPath?: string;
  oracleHash?: string;
  executorHashes?: Record<string, string>;
  verifySettings?: VerifyTaskInput["verifySettings"];
  createdAt: string;
  agent: string;
  deliveryId: string;
}

const worktreeByRepo = new Map<string, string>();
const canonicalSpecByRepo = new Map<string, CanonicalTestSpec>();
const canonicalStoresByRepo = new Map<string, { store: DeliveryStore; gitDeliveries: GitDeliveryStore }>();

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: ENV }).trim();
}

function write(file: string, body: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, "utf8");
}

function verificationCloneParent(repo: string): string {
  const root = fs.realpathSync(repo);
  const workspaceHash = crypto.createHash("sha256").update(root).digest("hex").slice(0, 24);
  return path.join(os.tmpdir(), `tachyon-verification-${workspaceHash}`);
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
      "const name = pattern?.replace(/\\$$/, '').replace(/\\\\([.*+?^${}()|[\\]\\\\])/g, '$1');",
      "const feature = fs.readFileSync('src/feature.txt', 'utf8').trim();",
      "const report = (passed, failed, pending, name) => { const title = name ?? 'another behavior'; console.log(JSON.stringify({ numTotalTests: 1, numPassedTests: passed, numFailedTests: failed, numPendingTests: pending, testResults: [{ name: 'test/unit/workerBehavior.gen.test.ts', assertionResults: [{ title, fullName: title, status: failed ? 'failed' : passed ? 'passed' : 'skipped' }] }] })); };",
      "if (name !== 'quote \"x\" (case) costs $5' && name !== 'generated behavior stays canonical') { report(0, 0, 1); process.exit(0); }",
      "if (feature === 'new') { report(1, 0, 0, name); process.exit(0); }",
      "report(0, 1, 0, name); process.exit(1);",
      "",
    ].join("\n"),
  );
  git(repo, ["add", ".gitignore", "src/feature.txt", "behavior.js", "package.json", "npm-behavior.js"]);
  git(repo, ["commit", "-qm", "base"]);
  const baseSha = git(repo, ["rev-parse", "HEAD"]);
  git(repo, ["worktree", "add", "-q", "-b", "tachyon/worker", wt, "HEAD"]);
  worktreeByRepo.set(repo, wt);
  return { repo, wt, baseSha };
}

function record(
  repo: string,
  baseSha: string,
  owns: string[] = ["src"],
  behaviorTest = "cmd:node behavior.js",
  delegator?: string,
  stubPath?: string,
  verifySettings?: VerifyTaskInput["verifySettings"],
): string {
  const createdAt = new Date().toISOString();
  const behaviorSettings = verifySettings?.behavior ?? (stubPath ? EXPLICIT_VITEST_VERIFY_SETTINGS.behavior : undefined);
  const oracleHash = stubPath
    ? crypto.createHash("sha256").update(execFileSync("git", ["show", `${baseSha}:./${stubPath}`], { cwd: repo, env: ENV })).digest("hex")
    : undefined;
  const executorHashes = behaviorSettings
    ? Object.fromEntries(behaviorSettings.executorPaths.map((executorPath) => [
        executorPath,
        crypto.createHash("sha256")
          .update(execFileSync("git", ["show", `${baseSha}:./${executorPath}`], { cwd: repo, env: ENV }))
          .digest("hex"),
      ]))
    : undefined;
  const wt = worktreeByRepo.get(repo);
  if (!wt) throw new Error(`missing canonical worktree for ${repo}`);
  const deliveryId = `d-test-${path.basename(repo).replace(/[^A-Za-z0-9._-]/g, "-")}`;
  canonicalSpecByRepo.set(repo, {
    wt,
    baseSha,
    owns,
    behaviorTest,
    delegator,
    stubPath,
    oracleHash,
    executorHashes,
    verifySettings,
    createdAt,
    agent: "worker",
    deliveryId,
  });
  canonicalStoresByRepo.delete(repo);
  return createdAt;
}

async function testRunner(cwd: string, argv: string[], opts?: { timeout?: number; env?: NodeJS.ProcessEnv }) {
  if (argv[0] === "npx" && argv[1] === "vitest" && argv[2] === "related") {
    return { command: argv.join(" "), argv, exitCode: 0, stdout: "related ok\n", stderr: "" };
  }
  try {
    const stdout = execFileSync(argv[0], argv.slice(1), {
      cwd,
      encoding: "utf8",
      env: { ...ENV, ...opts?.env },
      ...(opts?.timeout ? { timeout: opts.timeout } : {}),
    });
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

const VITEST_AFFECTED_COMMAND = "npx vitest related --run";
const EXPLICIT_VITEST_VERIFY_SETTINGS = {
  prepare: "node -e \"\"",
  affected: VITEST_AFFECTED_COMMAND,
  behavior: {
    adapter: "vitest-name" as const,
    command: "npm test --",
    stubPath: "test/unit/{agent}Behavior.gen.test.ts",
    executorPaths: ["package.json", "npm-behavior.js"],
  },
};

type TestVerifyInput = Omit<VerifyTaskInput, "deliveryId" | "deliveryVerification"> & {
  deliveryId?: string;
  deliveryVerification?: DeliveryVerificationLeaseService;
  /** Retired sugar accepted only by this test adapter to reuse verifier scenarios. */
  agent?: string;
  isAgentRunning?: (agent: string) => Promise<boolean>;
  withWorktreeLock?: <T>(agent: string, fn: () => Promise<T>) => Promise<T>;
  explicitTestSettings?: boolean;
};

/** Existing gate regressions are projected into a canonical Delivery before exercising verifyTask. */
async function runVerify(input: TestVerifyInput) {
  const { agent, isAgentRunning, withWorktreeLock, deliveryId, deliveryVerification, explicitTestSettings = true, ...rest } = input;
  const testDefaults = explicitTestSettings ? { verifySettings: EXPLICIT_VITEST_VERIFY_SETTINGS } : {};
  if (deliveryId || deliveryVerification) {
    return verifyTask({
      runner: testRunner,
      ...testDefaults,
      ...rest,
      deliveryId: deliveryId!,
      deliveryVerification: deliveryVerification!,
    });
  }
  if (!agent) {
    return verifyTask({
      runner: testRunner,
      ...testDefaults,
      ...rest,
      deliveryId: undefined!,
      deliveryVerification: undefined!,
    });
  }
  const spec = canonicalSpecByRepo.get(input.workspaceRoot);
  if (!spec || spec.agent !== agent) throw new Error(`no canonical test Delivery for '${agent}'`);
  let stores = canonicalStoresByRepo.get(input.workspaceRoot);
  if (!stores) {
    const store = authorityDeliveryStore(input.workspaceRoot, spec.createdAt);
    const gitDeliveries = new GitDeliveryStore(input.workspaceRoot);
    const projection = await gitDeliveries.open({
      workspaceId: "ws",
      deliveryId: spec.deliveryId,
      createdBy: actor,
      agent: spec.agent,
      branchRef: "tachyon/worker",
      worktreePath: spec.wt,
      tachyonCreatedBranch: true,
      baseRef: spec.baseSha,
      currentHeadSha: git(spec.wt, ["rev-parse", "HEAD"]),
    });
    await store.create({
      id: spec.deliveryId,
      workspaceId: "ws",
      createdBy: spec.delegator ? { kind: "agent", name: spec.delegator } : { kind: "system" },
      contract: {
        baseSha: spec.baseSha,
        behaviorTest: spec.behaviorTest,
        owns: spec.owns,
        taskRef: "tachyon/worker",
        ...(spec.stubPath ? { stubPath: spec.stubPath } : {}),
        ...(spec.oracleHash ? { oracleHash: spec.oracleHash } : {}),
        ...(spec.executorHashes ? { executorHashes: spec.executorHashes } : {}),
        ...(spec.verifySettings ? { verifySettings: spec.verifySettings } : {}),
      },
      gitDeliveryId: projection.id,
      segments: [{
        id: "seg-0",
        index: 0,
        role: "implementer",
        executionAgent: spec.agent,
        grantedBy: actor,
        ownsSubset: spec.owns,
        grantedHeadSha: spec.baseSha,
        grantedAt: spec.createdAt,
      }],
    });
    stores = { store, gitDeliveries };
    canonicalStoresByRepo.set(input.workspaceRoot, stores);
  }
  const service = new DeliveryVerificationLeaseService({
    store: stores.store,
    gitDeliveries: stores.gitDeliveries,
    ownerEpoch: "verify-task-compat-tests",
    withPathLock: async (_path, fn) => withWorktreeLock ? withWorktreeLock(spec.agent, fn) : fn(),
    isAgentRunning: isAgentRunning ?? (async () => false),
  });
  return verifyTask({
    runner: testRunner,
    ...testDefaults,
    ...rest,
    deliveryId: spec.deliveryId,
    deliveryVerification: service,
  });
}

function vitestReport(file: string, title: string, status: "passed" | "failed" | "pending" | "todo", fullName = title): string {
  return JSON.stringify({
    numTotalTests: 1,
    numPassedTests: status === "passed" ? 1 : 0,
    numFailedTests: status === "failed" ? 1 : 0,
    numPendingTests: status === "pending" ? 1 : 0,
    numTodoTests: status === "todo" ? 1 : 0,
    testResults: [{
      name: file,
      assertionResults: [{ title, fullName, status }],
    }],
  });
}

function vitestReportForAssertions(
  file: string,
  assertions: Array<{ title: string; fullName?: string; status: "passed" | "failed" | "pending" | "skipped" | "todo" }>,
): string {
  const count = (statuses: string[]) => assertions.filter((assertion) => statuses.includes(assertion.status)).length;
  return JSON.stringify({
    numTotalTests: assertions.length,
    numPassedTests: count(["passed"]),
    numFailedTests: count(["failed"]),
    numPendingTests: count(["pending", "skipped"]),
    numTodoTests: count(["todo"]),
    testResults: [{
      name: file,
      assertionResults: assertions.map((assertion) => ({
        title: assertion.title,
        fullName: assertion.fullName ?? assertion.title,
        status: assertion.status,
      })),
    }],
  });
}

async function waitForFiles(files: string[]): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!files.every((file) => fs.existsSync(file))) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${files.join(", ")}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** A fake MCP server that just captures tool handlers (mirrors probeBridge.test.ts's FakeMcp). */
type FakeToolResult = { content: { text: string }[]; isError?: boolean; structuredContent?: unknown };
class FakeMcp {
  handlers = new Map<string, (args: Record<string, unknown>) => Promise<FakeToolResult>>();
  registerTool(name: string, _def: unknown, handler: (args: Record<string, unknown>) => Promise<FakeToolResult>) {
    this.handlers.set(name, handler);
  }
}

function wireVerifyTaskTool(workspaceRoot: string, caller: BridgeDeps["caller"], withDeliveryVerification = true): FakeMcp {
  const mcp = new FakeMcp();
  const deps = {
    workspaceRoot,
    manager: { agentStates: async () => new Map() },
    caller,
    ...(withDeliveryVerification ? { deliveryVerification: { run: vi.fn() } } : {}),
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
    worktreeByRepo.clear();
    canonicalSpecByRepo.clear();
    canonicalStoresByRepo.clear();
    CANONICAL_AUTHORITY_HEADS.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
    worktreeByRepo.clear();
    canonicalSpecByRepo.clear();
    canonicalStoresByRepo.clear();
  });

  function fixture(initial?: string) {
    const f = makeRepo(initial);
    roots.push(f.repo, f.wt, verificationCloneParent(f.repo));
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
    expect(result.record.commands.map((c) => c.name)).toEqual([
      "verification_prepare_base",
      "behavior_base_expect_fail",
      "verification_prepare_head_tiers",
      "affected_tests",
      "verification_prepare_head",
      "behavior_head_expect_pass",
    ]);
    expect(result.record.commands.find((command) => command.name === "behavior_base_expect_fail"))
      .toMatchObject({ argv: ["node", "behavior.js"] });
    expect(fs.existsSync(result.recordPath)).toBe(true);
  });

  it("serializes conflicting canonical identities across processes so exactly one record remains canonical", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-vtask-publisher-race-"));
    roots.push(workspace);
    const start = path.join(workspace, "start");
    const release = path.join(workspace, "release");
    const children = ["alpha", "beta"].map((agent) => {
      const recordFile = path.join(workspace, `${agent}.record.json`);
      const ready = path.join(workspace, `${agent}.ready`);
      const calling = path.join(workspace, `${agent}.calling`);
      const postCheck = path.join(workspace, `${agent}.post-check`);
      const result = path.join(workspace, `${agent}.result.json`);
      fs.writeFileSync(recordFile, JSON.stringify(fakeRecord({ agent,
        identity: {
          firstOccupant: agent,
          currentOccupant: agent,
          occupants: [agent],
          deliveryId: "d-race",
          segmentId: "seg-0",
          segmentIndex: 0,
        },
        integrityHash: agent.repeat(64).slice(0, 64),
      })));
      const child = spawn(path.join(process.cwd(), "node_modules", ".bin", "vite-node"), [
        path.join(process.cwd(), "test", "helpers", "verificationPublisherChild.ts"),
        workspace, recordFile, ready, start, calling, postCheck, release, result,
      ], { cwd: process.cwd(), stdio: "pipe" });
      let stderr = "";
      child.stderr.setEncoding("utf8"); child.stderr.on("data", (chunk) => { stderr += chunk; });
      const exited = new Promise<void>((resolve, reject) => child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(stderr || `publisher child exited ${code}`))));
      return { agent, ready, calling, postCheck, result, exited };
    });
    await waitForFiles(children.map((child) => child.ready));
    fs.writeFileSync(start, "go");
    await waitForFiles(children.map((child) => child.calling));
    const postCheckDeadline = Date.now() + 10_000;
    while (!children.some((child) => fs.existsSync(child.postCheck))) {
      if (Date.now() >= postCheckDeadline) throw new Error("timed out waiting for first post-conflict-check marker");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const first = children.find((child) => fs.existsSync(child.postCheck))!;
    const second = children.find((child) => child !== first)!;
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(fs.existsSync(second.postCheck)).toBe(false);
    fs.writeFileSync(release, "publish");
    await Promise.all(children.map((child) => child.exited));
    const results = children.map((child) => ({ agent: child.agent,
      value: JSON.parse(fs.readFileSync(child.result, "utf8")) as { ok: boolean; code?: string; path?: string; bytes?: string } }));
    const winners = results.filter(({ value }) => value.ok);
    const losers = results.filter(({ value }) => !value.ok);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(winners[0]!.agent).toBe(first.agent);
    expect(losers[0]!.value.code).toBe("VERIFICATION_RECORD_CONFLICT");
    expect(fs.existsSync(second.postCheck)).toBe(false);
    expect(fs.readFileSync(winners[0]!.value.path!, "utf8")).toBe(winners[0]!.value.bytes);
    expect(JSON.parse(winners[0]!.value.bytes!)).toMatchObject({ agent: winners[0]!.agent });
  });

  it("preserves an unowned sibling when exclusive temp creation collides", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-vtask-publisher-open-"));
    roots.push(workspace);
    const originalOpen = fs.openSync.bind(fs);
    let collided = "";
    const open = vi.spyOn(fs, "openSync").mockImplementation((file, flags, mode) => {
      if (!collided && flags === "wx" && String(file).includes(`${path.sep}verifications${path.sep}`)) {
        collided = String(file);
        fs.writeFileSync(collided, "pre-existing sibling", "utf8");
      }
      return originalOpen(file, flags, mode);
    });
    expect(() => writeVerificationRecord(workspace, fakeRecord())).toThrow(/EEXIST/);
    open.mockRestore();
    expect(fs.readFileSync(collided, "utf8")).toBe("pre-existing sibling");
  });

  it("surfaces publication then owned-temp cleanup failures in stable order", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-vtask-publisher-cleanup-"));
    roots.push(workspace);
    const renameSync = fs.renameSync.bind(fs);
    const rmSync = fs.rmSync.bind(fs);
    let ownedTemp = "";
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (path.dirname(String(to)).endsWith(path.join(".tachyon", "verifications"))) {
        ownedTemp = String(from);
        throw new Error("primary rename failure");
      }
      renameSync(from, to);
    });
    vi.spyOn(fs, "rmSync").mockImplementation((target, options) => {
      if (String(target) === ownedTemp) throw new Error("owned temp cleanup failure");
      return rmSync(target, options);
    });
    let error: unknown;
    try { writeVerificationRecord(workspace, fakeRecord()); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors.map((item) => item instanceof Error ? item.message : String(item))).toEqual([
      "primary rename failure", "owned temp cleanup failure",
    ]);
  });

  it("wraps BEGIN busy failure as publication unavailable with its cause and still closes", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-vtask-publisher-begin-"));
    roots.push(workspace);
    const busy = new Error("database is busy");
    let closed = false;
    const database = {
      exec(sql: string) { if (sql === "BEGIN IMMEDIATE") throw busy; },
      close() { closed = true; },
    } as unknown as import("node:sqlite").DatabaseSync;
    let error: unknown;
    try { writeVerificationRecord(workspace, fakeRecord(), { databaseFactory: () => database }); } catch (caught) { error = caught; }
    expect(error).toMatchObject({ message: expect.stringContaining("verification record publication unavailable"), cause: busy });
    expect(closed).toBe(true);
  });

  it("retains conflict then rollback failures in exact order", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-vtask-publisher-rollback-"));
    roots.push(workspace);
    writeVerificationRecord(workspace, fakeRecord({ agent: "other",
      identity: {
        firstOccupant: "other",
        currentOccupant: "other",
        occupants: ["other"],
        deliveryId: "d-fake",
        segmentId: "seg-0",
        segmentIndex: 0,
      },
    }));
    const rollback = new Error("rollback failed");
    const database = {
      exec(sql: string) { if (sql === "ROLLBACK") throw rollback; }, close() {},
    } as unknown as import("node:sqlite").DatabaseSync;
    let error: unknown;
    try { writeVerificationRecord(workspace, fakeRecord(), { databaseFactory: () => database }); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([
      expect.objectContaining({ code: "VERIFICATION_RECORD_CONFLICT" }), rollback,
    ]);
  });

  it("retains COMMIT then rollback failures in exact order", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-vtask-publisher-commit-"));
    roots.push(workspace);
    const commit = new Error("commit failed");
    const rollback = new Error("rollback after commit failed");
    const database = {
      exec(sql: string) { if (sql === "COMMIT") throw commit; if (sql === "ROLLBACK") throw rollback; }, close() {},
    } as unknown as import("node:sqlite").DatabaseSync;
    let error: unknown;
    try { writeVerificationRecord(workspace, fakeRecord(), { databaseFactory: () => database }); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([commit, rollback]);
  });

  it("retains primary, rollback, then close failures in exact order", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-vtask-publisher-close-"));
    roots.push(workspace);
    const recordPath = writeVerificationRecord(workspace, fakeRecord());
    fs.writeFileSync(recordPath, "unreadable");
    const rollback = new Error("rollback failed");
    const close = new Error("close failed");
    const database = {
      exec(sql: string) { if (sql === "ROLLBACK") throw rollback; }, close() { throw close; },
    } as unknown as import("node:sqlite").DatabaseSync;
    let error: unknown;
    try { writeVerificationRecord(workspace, fakeRecord(), { databaseFactory: () => database }); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([
      expect.objectContaining({ code: "VERIFICATION_RECORD_CONFLICT" }), rollback, close,
    ]);
  });

  it("rejects a direct delivery_id call without the Workspace-owned verification service", async () => {
    const { repo, wt, baseSha } = fixture();
    write(path.join(wt, "src", "feature.txt"), "new\n");
    git(wt, ["add", "src/feature.txt"]);
    git(wt, ["commit", "-qm", "t-delivery implement behavior"]);
    const store = authorityDeliveryStore(repo);
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

    await expect(runVerify({ workspaceRoot: repo, deliveryId: "d-verify-explicit", agent: "wrong-legacy-name" }))
      .rejects.toMatchObject({ code: "DELIVERY_VERIFICATION_REQUIRED" });
    expect(fs.existsSync(path.join(repo, ".tachyon", "delegations"))).toBe(false);
    expect(fs.existsSync(path.join(repo, ".tachyon", "verifications"))).toBe(false);
  });

  async function canonicalVerification(store: DeliveryStore, gitDeliveries: GitDeliveryStore) {
    return new DeliveryVerificationLeaseService({ store, gitDeliveries, ownerEpoch: "verify-task-test-epoch",
      withPathLock: async (_worktreePath, fn) => fn(), isAgentRunning: async () => false,
      nonce: () => "verify-task-nonce", operationId: () => "verify-task-operation" });
  }

  async function canonicalFixture(id: string) {
    const { repo, wt, baseSha } = fixture();
    write(path.join(wt, "src", "feature.txt"), "new\n");
    git(wt, ["add", "src/feature.txt"]); git(wt, ["commit", "-qm", "t-delivery canonical evidence"]);
    const delivered = git(wt, ["rev-parse", "HEAD"]);
    const store = authorityDeliveryStore(repo);
    const gitDeliveries = new GitDeliveryStore(repo);
    const projection = await gitDeliveries.open({ workspaceId: "ws", createdBy: actor, deliveryId: id, agent: "worker",
      branchRef: "tachyon/worker", worktreePath: wt, tachyonCreatedBranch: true, baseRef: baseSha, currentHeadSha: delivered });
    await store.create({ id, workspaceId: "ws", createdBy: actor,
      contract: { taskId: "t-delivery", baseSha, behaviorTest: "cmd:node behavior.js", owns: ["src"], taskRef: "tachyon/worker" },
      gitDeliveryId: projection.id, segments: [{ id: "seg-0", index: 0, role: "implementer", executionAgent: "worker",
        grantedBy: actor, ownsSubset: ["src"], grantedHeadSha: baseSha, grantedAt: "2026-01-01T00:00:00.000Z" }] });
    return { repo, wt, baseSha, delivered, store, gitDeliveries };
  }

  it("fails closed before execution when canonical Delivery authority is edited directly in SQLite", async () => {
    const f = await canonicalFixture("d-tampered-authority");
    tamperDeliveryRecord(f.repo, "d-tampered-authority", (record) => {
      const contract = record.contract as Record<string, unknown>;
      contract.behaviorTest = "cmd:node -e \"process.exit(0)\"";
      contract.owns = ["."];
    });
    const runner = vi.fn(testRunner);

    const error = await runVerify({
      workspaceRoot: f.repo,
      deliveryId: "d-tampered-authority",
      deliveryVerification: await canonicalVerification(f.store, f.gitDeliveries),
      runner,
    }).catch((caught) => caught);

    expect(error).toBeInstanceOf(DeliveryInvariantError);
    expect(error.message).toContain("authority integrity check failed");
    expect(runner).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(f.repo, ".tachyon", "verifications"))).toBe(false);
  });

  it("rejects rollback to an older correctly signed canonical Delivery before execution", async () => {
    const f = await canonicalFixture("d-stale-authority");
    const staleRecord = storedDeliveryRecord(f.repo, "d-stale-authority");
    await f.store.update("d-stale-authority", 1, (delivery) => ({
      ...delivery,
      events: [...delivery.events, {
        id: "ev-authority-advanced",
        at: "2026-01-01T00:01:00.000Z",
        type: "authority_advanced",
        by: actor,
      }],
    }));
    replaceStoredDeliveryRecord(f.repo, "d-stale-authority", staleRecord);
    const runner = vi.fn(testRunner);

    const error = await runVerify({
      workspaceRoot: f.repo,
      deliveryId: "d-stale-authority",
      deliveryVerification: await canonicalVerification(f.store, f.gitDeliveries),
      runner,
    }).catch((caught) => caught);

    expect(error).toBeInstanceOf(DeliveryInvariantError);
    expect(error.message).toContain("authority head mismatch");
    expect(runner).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(f.repo, ".tachyon", "verifications"))).toBe(false);
  });

  it("fails closed before canonical execution when the host authority key is unavailable", async () => {
    const f = await canonicalFixture("d-missing-authority-key");
    const runner = vi.fn(testRunner);
    const unavailableStore = new DeliveryStore(f.repo, {
      authorityIntegrityKey: () => undefined,
      authorityHead: CANONICAL_AUTHORITY_HEAD,
    });

    const error = await runVerify({
      workspaceRoot: f.repo,
      deliveryId: "d-missing-authority-key",
      deliveryVerification: await canonicalVerification(unavailableStore, f.gitDeliveries),
      runner,
    }).catch((caught) => caught);

    expect(error).toBeInstanceOf(DeliveryInvariantError);
    expect(error.message).toContain("authority integrity key is unavailable");
    expect(runner).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(f.repo, ".tachyon", "verifications"))).toBe(false);
  });

  it("fails closed before canonical execution when the host freshness head is unavailable", async () => {
    const f = await canonicalFixture("d-missing-authority-head");
    const runner = vi.fn(testRunner);
    const unavailableStore = new DeliveryStore(f.repo, {
      authorityIntegrityKey: () => AUTHORITY_INTEGRITY_KEY,
    });

    const error = await runVerify({
      workspaceRoot: f.repo,
      deliveryId: "d-missing-authority-head",
      deliveryVerification: await canonicalVerification(unavailableStore, f.gitDeliveries),
      runner,
    }).catch((caught) => caught);

    expect(error).toBeInstanceOf(DeliveryInvariantError);
    expect(error.message).toContain("authority freshness head is unavailable");
    expect(runner).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(f.repo, ".tachyon", "verifications"))).toBe(false);
  });

  it("atomically publishes canonical evidence, cleans only its failed temp, and retries past an unrelated partial temp", async () => {
    const f = await canonicalFixture("d-atomic-rename");
    let currentTemp = "";
    let unrelatedTemp = "";
    let temporaryRecord: VerifyTaskRecord | undefined;
    const renameSync = fs.renameSync.bind(fs);
    const rename = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (!currentTemp && path.dirname(String(to)).endsWith(path.join(".tachyon", "verifications"))) {
        currentTemp = String(from);
        temporaryRecord = JSON.parse(fs.readFileSync(currentTemp, "utf8")) as VerifyTaskRecord;
        unrelatedTemp = path.join(path.dirname(currentTemp), "unrelated.partial.tmp");
        fs.writeFileSync(unrelatedTemp, "partial", "utf8");
        throw new Error("simulated rename interruption");
      }
      renameSync(from, to);
    });
    await expect(runVerify({ workspaceRoot: f.repo, deliveryId: "d-atomic-rename",
      deliveryVerification: await canonicalVerification(f.store, f.gitDeliveries) })).rejects.toThrow("simulated rename interruption");
    rename.mockRestore();
    expect(temporaryRecord).toMatchObject({ identity: { deliveryId: "d-atomic-rename" } });
    expect(fs.existsSync(currentTemp)).toBe(false);
    expect(fs.readFileSync(unrelatedTemp, "utf8")).toBe("partial");
    expect(fs.readdirSync(path.dirname(unrelatedTemp)).filter((name) => name.endsWith(".json"))).toEqual([]);

    const retried = await runVerify({ workspaceRoot: f.repo, deliveryId: "d-atomic-rename",
      deliveryVerification: await canonicalVerification(f.store, f.gitDeliveries) });
    expect(retried.verdict).toBe("accept");
    expect(JSON.parse(fs.readFileSync(retried.recordPath, "utf8"))).toMatchObject({
      integrityHash: retried.record.integrityHash, identity: { deliveryId: "d-atomic-rename" },
    });
    expect((await f.store.get("d-atomic-rename"))!.events.at(-1)?.type).toBe("verification_completed");
  });

  it("recovers a valid orphan record after completion interruption and deliberately retries without wedging", async () => {
    const f = await canonicalFixture("d-orphan-record");
    const update = f.store.update.bind(f.store);
    let interruptCompletion = false;
    f.store.update = async (...args: Parameters<DeliveryStore["update"]>) => {
      if (interruptCompletion) throw new Error("simulated completion interruption");
      return update(...args);
    };
    const renameSync = fs.renameSync.bind(fs);
    const rename = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      renameSync(from, to);
      if (path.dirname(String(to)).endsWith(path.join(".tachyon", "verifications"))) interruptCompletion = true;
    });
    await expect(runVerify({ workspaceRoot: f.repo, deliveryId: "d-orphan-record",
      deliveryVerification: await canonicalVerification(f.store, f.gitDeliveries) })).rejects.toBeInstanceOf(AggregateError);
    rename.mockRestore();
    f.store.update = update;
    const orphan = fs.readdirSync(path.join(f.repo, ".tachyon", "verifications")).find((name) => name.endsWith(".json"));
    expect(orphan).toBeTruthy();
    expect(() => JSON.parse(fs.readFileSync(path.join(f.repo, ".tachyon", "verifications", orphan!), "utf8"))).not.toThrow();
    expect((await f.store.get("d-orphan-record"))!.lease.state).toBe("verifying");

    const nextEpoch = new DeliveryVerificationLeaseService({ store: f.store, gitDeliveries: f.gitDeliveries,
      ownerEpoch: "next-epoch", withPathLock: async (_worktreePath, fn) => fn(), isAgentRunning: async () => false });
    await expect(runVerify({ workspaceRoot: f.repo, deliveryId: "d-orphan-record", deliveryVerification: nextEpoch }))
      .rejects.toMatchObject({ code: "WORKTREE_OCCUPIED", retryable: true });
    const retried = await runVerify({ workspaceRoot: f.repo, deliveryId: "d-orphan-record", deliveryVerification: nextEpoch });
    expect(retried.verdict).toBe("accept");
    expect((await f.store.get("d-orphan-record"))!.events.at(-1)?.type).toBe("verification_completed");
  });

  it("verifies three canonical write segments against their own linear scopes and restores before recording completion", async () => {
    const { repo, wt, baseSha } = fixture();
    write(path.join(wt, "src", "feature.txt"), "new\n");
    git(wt, ["add", "src/feature.txt"]); git(wt, ["commit", "-qm", "t-delivery segment zero"]);
    const first = git(wt, ["rev-parse", "HEAD"]);
    write(path.join(wt, "src", "second", "value.txt"), "second\n");
    git(wt, ["add", "src/second/value.txt"]); git(wt, ["commit", "-qm", "t-delivery segment one"]);
    const second = git(wt, ["rev-parse", "HEAD"]);
    write(path.join(wt, "src", "third", "value.txt"), "third\n");
    git(wt, ["add", "src/third/value.txt"]); git(wt, ["commit", "-qm", "t-delivery segment two"]);
    const delivered = git(wt, ["rev-parse", "HEAD"]);
    const store = authorityDeliveryStore(repo);
    const gitDeliveries = new GitDeliveryStore(repo);
    const projection = await gitDeliveries.open({ workspaceId: "ws", createdBy: { kind: "agent", name: "coordinator" },
      deliveryId: "d-three-segment", agent: "fixer-2", branchRef: "tachyon/worker", worktreePath: wt,
      tachyonCreatedBranch: true, baseRef: baseSha, currentHeadSha: delivered });
    await store.create({ id: "d-three-segment", workspaceId: "ws", createdBy: { kind: "agent", name: "coordinator" },
      contract: { taskId: "t-delivery", baseSha, behaviorTest: "cmd:node behavior.js", owns: ["src"], taskRef: "tachyon/worker" },
      gitDeliveryId: projection.id, segments: [
        { id: "seg-0", index: 0, role: "implementer", executionAgent: "worker", grantedBy: actor,
          ownsSubset: ["src/feature.txt"], grantedHeadSha: baseSha, grantedAt: "2026-01-01T00:00:00.000Z",
          releasedAt: "2026-01-01T00:01:00.000Z", releasedHeadSha: first, outcome: "completed" },
        { id: "seg-1", index: 1, role: "fixer", executionAgent: "fixer-1", grantedBy: actor,
          ownsSubset: ["src/second"], grantedHeadSha: first, grantedAt: "2026-01-01T00:01:00.000Z",
          releasedAt: "2026-01-01T00:02:00.000Z", releasedHeadSha: second, outcome: "completed" },
        { id: "seg-2", index: 2, role: "recovery", executionAgent: "fixer-2", grantedBy: actor,
          ownsSubset: ["src/third"], grantedHeadSha: second, grantedAt: "2026-01-01T00:02:00.000Z" },
      ] });
    const deliveryVerification = await canonicalVerification(store, gitDeliveries);
    const result = await runVerify({ workspaceRoot: repo, deliveryId: "d-three-segment", deliveryVerification });
    expect(result.verdict).toBe("accept");
    expect(result.blockers).toEqual([]);
    expect(git(wt, ["symbolic-ref", "--short", "HEAD"])).toBe("tachyon/worker");
    const completed = (await store.get("d-three-segment"))!;
    expect(completed.lease.state).toBe("free");
    expect(completed.events.at(-1)).toMatchObject({ type: "verification_completed",
      detail: { integrityHash: result.record.integrityHash, recordPath: result.recordPath } });
  });

  it("blocks a nonlinear adjacent canonical boundary before behavior execution", async () => {
    const { repo, wt, baseSha } = fixture();
    write(path.join(wt, "src", "feature.txt"), "new\n");
    git(wt, ["add", "src/feature.txt"]); git(wt, ["commit", "-qm", "t-delivery delivered"]);
    const delivered = git(wt, ["rev-parse", "HEAD"]);
    git(repo, ["branch", "unrelated", baseSha]);
    const unrelatedWt = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-vtask-unrelated-"));
    fs.rmSync(unrelatedWt, { recursive: true, force: true }); roots.push(unrelatedWt);
    git(repo, ["worktree", "add", "-q", unrelatedWt, "unrelated"]);
    write(path.join(unrelatedWt, "src", "unrelated.txt"), "unrelated\n");
    git(unrelatedWt, ["add", "src/unrelated.txt"]); git(unrelatedWt, ["commit", "-qm", "unrelated history"]);
    const unrelated = git(unrelatedWt, ["rev-parse", "HEAD"]);
    const store = authorityDeliveryStore(repo);
    const gitDeliveries = new GitDeliveryStore(repo);
    const projection = await gitDeliveries.open({ workspaceId: "ws", createdBy: actor, deliveryId: "d-nonlinear", agent: "fixer",
      branchRef: "tachyon/worker", worktreePath: wt, tachyonCreatedBranch: true, baseRef: baseSha, currentHeadSha: delivered });
    await store.create({ id: "d-nonlinear", workspaceId: "ws", createdBy: actor,
      contract: { taskId: "t-delivery", baseSha, behaviorTest: "cmd:node behavior.js", owns: ["src"], taskRef: "tachyon/worker" },
      gitDeliveryId: projection.id, segments: [
        { id: "seg-0", index: 0, role: "implementer", executionAgent: "worker", grantedBy: actor, ownsSubset: ["src"],
          grantedHeadSha: baseSha, grantedAt: "2026-01-01T00:00:00.000Z", releasedAt: "2026-01-01T00:01:00.000Z",
          releasedHeadSha: unrelated, outcome: "completed" },
        { id: "seg-1", index: 1, role: "fixer", executionAgent: "fixer", grantedBy: actor, ownsSubset: ["src"],
          grantedHeadSha: unrelated, grantedAt: "2026-01-01T00:01:00.000Z" },
      ] });
    const runner = vi.fn(testRunner);
    const result = await runVerify({ workspaceRoot: repo, deliveryId: "d-nonlinear", deliveryVerification: await canonicalVerification(store, gitDeliveries), runner });
    expect(result.verdict).toBe("blocked");
    expect(result.blockers).toEqual(expect.arrayContaining([expect.objectContaining({ code: "non_linear_segment_history" })]));
    expect(runner).not.toHaveBeenCalled();
  });

  it("fails closed on an unknown canonical segment role instead of treating it as read-only", async () => {
    const { repo, wt, baseSha } = fixture();
    write(path.join(wt, "src", "feature.txt"), "new\n");
    git(wt, ["add", "src/feature.txt"]); git(wt, ["commit", "-qm", "t-delivery unknown role"]);
    const delivered = git(wt, ["rev-parse", "HEAD"]);
    const store = authorityDeliveryStore(repo);
    const gitDeliveries = new GitDeliveryStore(repo);
    const projection = await gitDeliveries.open({ workspaceId: "ws", createdBy: actor, deliveryId: "d-unknown-role", agent: "worker",
      branchRef: "tachyon/worker", worktreePath: wt, tachyonCreatedBranch: true, baseRef: baseSha, currentHeadSha: delivered });
    await store.create({ id: "d-unknown-role", workspaceId: "ws", createdBy: actor,
      contract: { taskId: "t-delivery", baseSha, behaviorTest: "cmd:node behavior.js", owns: ["src"], taskRef: "tachyon/worker" },
      gitDeliveryId: projection.id, segments: [{ id: "seg-0", index: 0,
        role: "unknown-role" as DelegationSegment["role"], executionAgent: "worker", grantedBy: actor, ownsSubset: ["src"],
        grantedHeadSha: baseSha, grantedAt: "2026-01-01T00:00:00.000Z" }] });
    const runner = vi.fn(testRunner);
    const result = await runVerify({ workspaceRoot: repo, deliveryId: "d-unknown-role",
      deliveryVerification: await canonicalVerification(store, gitDeliveries), runner });
    expect(result.verdict).toBe("blocked");
    expect(result.blockers).toContainEqual(expect.objectContaining({ code: "invalid_segment_role" }));
    expect(runner).not.toHaveBeenCalled();
  });

  it.each([
    { label: "escaping normalized authority", ownsSubset: ["./../src"] },
    { label: "authority wider than the contract", ownsSubset: ["src", "test"] },
  ])("blocks $label before behavior execution", async ({ ownsSubset }) => {
    const { repo, wt, baseSha } = fixture();
    write(path.join(wt, "src", "feature.txt"), "new\n");
    git(wt, ["add", "src/feature.txt"]); git(wt, ["commit", "-qm", "t-delivery invalid scope"]);
    const delivered = git(wt, ["rev-parse", "HEAD"]);
    const store = authorityDeliveryStore(repo);
    const gitDeliveries = new GitDeliveryStore(repo);
    const projection = await gitDeliveries.open({ workspaceId: "ws", createdBy: actor, deliveryId: "d-invalid-scope", agent: "worker",
      branchRef: "tachyon/worker", worktreePath: wt, tachyonCreatedBranch: true, baseRef: baseSha, currentHeadSha: delivered });
    await store.create({ id: "d-invalid-scope", workspaceId: "ws", createdBy: actor,
      contract: { taskId: "t-delivery", baseSha, behaviorTest: "cmd:node behavior.js", owns: ["src"], taskRef: "tachyon/worker" },
      gitDeliveryId: projection.id, segments: [{ id: "seg-0", index: 0,
        role: "implementer", executionAgent: "worker", grantedBy: actor, ownsSubset,
        grantedHeadSha: baseSha, grantedAt: "2026-01-01T00:00:00.000Z" }] });
    const runner = vi.fn(testRunner);
    const result = await runVerify({ workspaceRoot: repo, deliveryId: "d-invalid-scope",
      deliveryVerification: await canonicalVerification(store, gitDeliveries), runner });
    expect(result.verdict).toBe("blocked");
    expect(result.blockers).toContainEqual(expect.objectContaining({ code: "invalid_segment_scope" }));
    expect(runner).not.toHaveBeenCalled();
  });

  it.each([
    { label: "escaping", ownsSubset: ["../escape"] },
    { label: "absolute", ownsSubset: ["/absolute"] },
    { label: "widened", ownsSubset: ["test"] },
  ])("validates $label writer authority even when the segment writes nothing", async ({ ownsSubset }) => {
    const { repo, wt, baseSha } = fixture();
    const store = authorityDeliveryStore(repo);
    const gitDeliveries = new GitDeliveryStore(repo);
    const projection = await gitDeliveries.open({ workspaceId: "ws", createdBy: actor, deliveryId: "d-zero-write", agent: "worker",
      branchRef: "tachyon/worker", worktreePath: wt, tachyonCreatedBranch: true, baseRef: baseSha, currentHeadSha: baseSha });
    await store.create({ id: "d-zero-write", workspaceId: "ws", createdBy: actor,
      contract: { taskId: "t-delivery", baseSha, behaviorTest: "cmd:node behavior.js", owns: ["src"], taskRef: "tachyon/worker" },
      gitDeliveryId: projection.id, segments: [{ id: "seg-0", index: 0, role: "implementer", executionAgent: "worker",
        grantedBy: actor, ownsSubset, grantedHeadSha: baseSha, grantedAt: "2026-01-01T00:00:00.000Z" }] });
    const runner = vi.fn(testRunner);
    const result = await runVerify({ workspaceRoot: repo, deliveryId: "d-zero-write",
      deliveryVerification: await canonicalVerification(store, gitDeliveries), runner });
    expect(result.verdict).toBe("blocked");
    expect(result.blockers).toContainEqual(expect.objectContaining({ code: "invalid_segment_scope" }));
    expect(runner).not.toHaveBeenCalled();
  });

  /** Builds a Delivery on the fixture's taskRef. `segments` are given tail-last. */
  async function delivery(repo: string, wt: string, id: string, baseSha: string, agents: string[], running: (name: string) => boolean = () => false,
    taskRef = "tachyon/worker") {
    const store = authorityDeliveryStore(repo);
    const gitDeliveries = new GitDeliveryStore(repo);
    const delivered = git(wt, ["rev-parse", "HEAD"]);
    const projection = await gitDeliveries.open({ workspaceId: "ws", createdBy: actor, deliveryId: id,
      agent: agents.at(-1)!, branchRef: taskRef, worktreePath: wt, tachyonCreatedBranch: true,
      baseRef: baseSha, currentHeadSha: delivered });
    await store.create({
      id,
      workspaceId: "ws",
      createdBy: { kind: "agent", name: "coordinator" },
      contract: { taskId: "t-delivery", baseSha, behaviorTest: "cmd:node behavior.js", owns: ["src"], taskRef },
      gitDeliveryId: projection.id,
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
    return new DeliveryVerificationLeaseService({ store, gitDeliveries, ownerEpoch: `epoch-${id}`,
      withPathLock: async (_worktreePath, fn) => fn(), isAgentRunning: async (name) => running(name) });
  }

  // t-0b5723 (F2) — the operational identity is the CURRENT occupant. Before this fix the adapter handed
  // the verifier segment zero, so a live tail (the fixer actually holding the worktree) went unnoticed and
  // verify_task would have mutated the worktree out from under it.
  it("treats the tail segment as the live occupant: a running fixer blocks, and is what gets recorded", async () => {
    const { repo, wt, baseSha } = fixture();
    write(path.join(wt, "src", "feature.txt"), "new\n");
    git(wt, ["add", "src/feature.txt"]);
    git(wt, ["commit", "-qm", "t-delivery implement behavior"]);
    const deliveryVerification = await delivery(repo, wt, "d-tail", baseSha, ["worker", "fixer"], (name) => name === "fixer");

    const error = await runVerify({
      workspaceRoot: repo,
      deliveryId: "d-tail",
      deliveryVerification,
    }).catch((caught) => caught);

    expect(error).toMatchObject({ code: "WORKTREE_OCCUPIED", retryable: true });
    expect(error.message).toContain("tail execution 'fixer' is still live");
  });

  // t-0b5723 (F1) — the guard resolves the delivery and compares the caller against the occupant it
  // proved, so neither a delivery_id nor a spoofed `agent` argument gets a self-waiver through.
  it("refuses a self-waiver even when the caller spoofs `agent` or routes around it with delivery_id", async () => {
    const { repo, wt, baseSha } = fixture();
    write(path.join(wt, "src", "feature.txt"), "new\n");
    git(wt, ["add", "src/feature.txt"]);
    git(wt, ["commit", "-qm", "t-delivery implement behavior"]);
    const deliveryVerification = await delivery(repo, wt, "d-spoof", baseSha, ["worker", "fixer"]);
    const waivers = [{ finding: "README.md", reason: "self-authored, trust me" }];

    // the live tail occupant, naming someone else in `agent` to dodge a caller.name === agent check
    const spoofed = await runVerify({
      workspaceRoot: repo, deliveryId: "d-spoof", deliveryVerification, agent: "somebody-else", waivers,
      verifierCaller: { kind: "agent", name: "fixer" },
    }).catch((e) => e);
    expect(spoofed).toMatchObject({ code: "SELF_WAIVER_FORBIDDEN" });

    // the original occupant is an occupant too — it cannot waive the work it started either
    const original = await runVerify({
      workspaceRoot: repo, deliveryId: "d-spoof", deliveryVerification, waivers,
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
    const deliveryVerification = await delivery(repo, wt, "d-coord", baseSha, ["worker"]);

    const coordinator = await runVerify({
      workspaceRoot: repo, deliveryId: "d-coord", deliveryVerification,
      waivers: [{ finding: "protocol_doorbell_missed", reason: "notified out of band" }],
      verifierCaller: { kind: "agent", name: "coordinator" },
    });
    expect(coordinator.verdict).toBe("accept");
    expect(coordinator.record.verifierCaller).toEqual({ kind: "agent", name: "coordinator" });

    const self = await runVerify({
      workspaceRoot: repo, deliveryId: "d-coord", deliveryVerification,
      verifierCaller: { kind: "agent", name: "worker" },
    });
    expect(self.verdict).toBe("accept");
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
    const deliveryVerification = await delivery(repo, wt, "d-interior", baseSha, ["worker", "fixer-1", "fixer-2"]);
    const waivers = [{ finding: "README.md", reason: "self-authored, trust me" }];

    const interior = await runVerify({
      workspaceRoot: repo, deliveryId: "d-interior", deliveryVerification, waivers,
      verifierCaller: { kind: "agent", name: "fixer-1" },
    }).catch((e) => e);
    expect(interior).toMatchObject({ code: "SELF_WAIVER_FORBIDDEN" });

    // the first and tail occupants are still refused too — unaffected by this fix.
    const first = await runVerify({
      workspaceRoot: repo, deliveryId: "d-interior", deliveryVerification, waivers,
      verifierCaller: { kind: "agent", name: "worker" },
    }).catch((e) => e);
    expect(first).toMatchObject({ code: "SELF_WAIVER_FORBIDDEN" });
    const tail = await runVerify({
      workspaceRoot: repo, deliveryId: "d-interior", deliveryVerification, waivers,
      verifierCaller: { kind: "agent", name: "fixer-2" },
    }).catch((e) => e);
    expect(tail).toMatchObject({ code: "SELF_WAIVER_FORBIDDEN" });

    // a genuine coordinator still passes, and the record carries every occupant.
    const coordinator = await runVerify({
      workspaceRoot: repo, deliveryId: "d-interior", deliveryVerification, waivers,
      verifierCaller: { kind: "agent", name: "coordinator" },
    });
    expect(coordinator.verdict).toBe("accept");
    expect(coordinator.record.identity).toMatchObject({ occupants: ["worker", "fixer-1", "fixer-2"] });
  });

  it("refuses an ignored runner planted in the trusted source checkout and removes clone remotes", async () => {
    const { repo, wt, baseSha } = fixture();
    write(
      path.join(repo, "node_modules", ".bin", "behavior-runner"),
      "#!/usr/bin/env node\nconst fs = require('fs'); process.exit(fs.readFileSync('src/feature.txt', 'utf8').trim() === 'new' ? 0 : 1);\n",
    );
    fs.chmodSync(path.join(repo, "node_modules", ".bin", "behavior-runner"), 0o755);
    write(path.join(wt, "src", "feature.txt"), "new\n");
    git(wt, ["add", "src/feature.txt"]);
    git(wt, ["commit", "-qm", "t-123abc implement behavior"]);
    record(repo, baseSha, ["src"], "cmd:node_modules/.bin/behavior-runner");

    const result = await runVerify({
      workspaceRoot: repo,
      agent: "worker",
      runner: async (cwd, argv, opts) => {
        expect(git(cwd, ["remote"])).toBe("");
        return testRunner(cwd, argv, opts);
      },
    });

    expect(result.verdict).toBe("blocked");
    expect(result.blockers.map((blocker) => blocker.code)).toContain("behavior_failed");
    expect(result.record.commands.every((command) => command.cwd !== wt)).toBe(true);
    expect(result.record.commands.every((command) => command.cwd.startsWith(verificationCloneParent(repo)))).toBe(true);
    expect(result.record.commands.find((command) => command.name === "behavior_base_expect_fail"))
      .toMatchObject({ argv: ["node_modules/.bin/behavior-runner"] });
    expect(fs.existsSync(path.join(repo, "node_modules", ".bin", "behavior-runner"))).toBe(true);
    expect(git(wt, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("tachyon/worker");
  });

  it("runs cmd behavior without implicit npm, Vitest, or affected-test commands when verification is unconfigured", async () => {
    const { repo, wt, baseSha } = fixture();
    write(path.join(wt, "src", "feature.txt"), "new\n");
    git(wt, ["add", "src/feature.txt"]);
    git(wt, ["commit", "-qm", "t-123abc implement behavior"]);
    record(repo, baseSha);
    const runner = vi.fn(testRunner);

    const result = await runVerify({ workspaceRoot: repo, agent: "worker", runner, explicitTestSettings: false });

    expect(result.verdict).toBe("accept");
    expect(result.record.commands.map((command) => command.name)).toEqual([
      "behavior_base_expect_fail",
      "behavior_head_expect_pass",
    ]);
    expect(result.record.commands.map((command) => command.argv)).toEqual([
      ["node", "behavior.js"],
      ["node", "behavior.js"],
    ]);
    expect(runner.mock.calls.map(([, argv]) => argv[0])).toEqual(["node", "node"]);
  });

  it("uses the project prepare command for independent cmd-verifier BASE and HEAD environments", async () => {
    const { repo, wt } = fixture();
    write(
      path.join(wt, "behavior.js"),
      "const fs = require('fs'); const prepared = fs.existsSync('node_modules/prepared'); const feature = fs.readFileSync('src/feature.txt', 'utf8').trim(); process.exit(prepared && feature === 'new' ? 0 : 1);\n",
    );
    git(wt, ["add", "behavior.js"]);
    git(wt, ["commit", "-qm", "project cmd verifier requires preparation"]);
    const baseSha = git(wt, ["rev-parse", "HEAD"]);
    write(path.join(wt, "src", "feature.txt"), "new\n");
    git(wt, ["add", "src/feature.txt"]);
    git(wt, ["commit", "-qm", "t-123abc implement prepared behavior"]);
    const prepare = "node -e \"const fs=require('fs');fs.mkdirSync('node_modules',{recursive:true});fs.writeFileSync('node_modules/prepared','ok')\"";
    record(repo, baseSha, ["src", "behavior.js"], "cmd:node behavior.js", undefined, undefined, { prepare });

    const result = await runVerify({ workspaceRoot: repo, agent: "worker", runner: testRunner, explicitTestSettings: false });

    expect(result.verdict).toBe("accept");
    expect(result.record.commands.map((command) => command.name)).toEqual([
      "verification_prepare_base",
      "behavior_base_expect_fail",
      "verification_prepare_head",
      "behavior_head_expect_pass",
    ]);
    const prepareCwds = result.record.commands
      .filter((command) => command.name.startsWith("verification_prepare_"))
      .map((command) => command.cwd);
    expect(new Set(prepareCwds).size).toBe(2);
    expect(prepareCwds.every((cwd) => cwd.startsWith(verificationCloneParent(repo)))).toBe(true);
    expect(fs.existsSync(path.join(repo, "node_modules", "prepared"))).toBe(false);
    expect(fs.existsSync(path.join(wt, "node_modules", "prepared"))).toBe(false);
  });

  it("tracks a canonical preparation script that installs and builds missing dist artifacts", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as { scripts?: Record<string, string> };
    expect(manifest.scripts?.["verify:prepare"]).toBe("npm ci --ignore-scripts --prefer-offline --no-audit --no-fund && npm run build");
  });

  it("keeps an explicit empty verifier snapshot instead of adopting commands added after spawn", async () => {
    const { repo, wt, baseSha } = fixture();
    write(path.join(wt, "src", "feature.txt"), "new\n");
    git(wt, ["add", "src/feature.txt"]);
    git(wt, ["commit", "-qm", "t-123abc implement behavior"]);
    record(repo, baseSha, ["src"], "cmd:node behavior.js", undefined, undefined, {});
    write(
      path.join(repo, "tachyon.yml"),
      "agents:\n  worker:\n    cmd: codex\nsettings:\n  verify:\n    affected: node hostile-after-spawn.js\n",
    );
    const runner = vi.fn(testRunner);

    const result = await runVerify({ workspaceRoot: repo, agent: "worker", runner });

    expect(result.verdict).toBe("accept");
    expect(result.record.commands.map((command) => command.name)).toEqual([
      "behavior_base_expect_fail",
      "behavior_head_expect_pass",
    ]);
    expect(runner.mock.calls.flatMap(([, argv]) => argv)).not.toContain("hostile-after-spawn.js");
  });

  it("blocks a plain behavior name when no project behavior adapter is configured", async () => {
    const { repo, wt, baseSha } = fixture();
    write(path.join(wt, "src", "feature.txt"), "new\n");
    git(wt, ["add", "src/feature.txt"]);
    git(wt, ["commit", "-qm", "t-123abc implement behavior"]);
    record(repo, baseSha, ["src"], "PI-UNCONFIGURED");
    const runner = vi.fn(testRunner);

    const result = await runVerify({ workspaceRoot: repo, agent: "worker", verifySettings: {}, runner });

    expect(result.verdict).toBe("blocked");
    expect(result.blockers).toContainEqual({
      code: "behavior_failed",
      detail: expect.stringContaining("requires settings.verify.behavior"),
    });
    expect(result.record.commands.map((command) => command.name)).toEqual([
      "behavior_base_expect_fail",
      "behavior_head_expect_pass",
    ]);
    expect(result.record.commands.every((command) => command.argv.length === 0)).toBe(true);
    expect(runner).not.toHaveBeenCalled();
  });

  it("blocks a configured named gate with no recorded canonical stubPath before executing it", async () => {
    const { repo, wt, baseSha } = fixture();
    write(path.join(wt, "src", "feature.txt"), "new\n");
    git(wt, ["add", "src/feature.txt"]);
    git(wt, ["commit", "-qm", "t-123abc implement behavior"]);
    record(repo, baseSha, ["src"], "missing recorded stub");
    const runner = vi.fn(testRunner);

    const result = await runVerify({
      workspaceRoot: repo,
      agent: "worker",
      verifySettings: { behavior: EXPLICIT_VITEST_VERIFY_SETTINGS.behavior },
      runner,
    });

    expect(result.verdict).toBe("blocked");
    expect(result.blockers).toContainEqual({
      code: "behavior_base_unproven",
      detail: "named Vitest behavior gate 'missing recorded stub' has no recorded fixed oracle path/hash",
    });
    expect(result.record.commands).toEqual([]);
    expect(runner).not.toHaveBeenCalled();
  });

  it("blocks a recorded stubPath that differs from the configured template rendered for the agent", async () => {
    const { repo, wt } = fixture();
    const recordedStubPath = "test/unit/workerBehavior.gen.test.ts";
    const behaviorTest = "generated behavior stays canonical";
    write(path.join(wt, recordedStubPath), `it('${behaviorTest}', () => {});\n`);
    git(wt, ["add", recordedStubPath]);
    git(wt, ["commit", "-qm", "tachyon setup: recorded canonical behavior stub"]);
    const baseSha = git(wt, ["rev-parse", "HEAD"]);
    write(path.join(wt, "src", "feature.txt"), "new\n");
    git(wt, ["add", "src/feature.txt"]);
    git(wt, ["commit", "-qm", "t-123abc implement behavior"]);
    const verifySettings = {
      behavior: {
        ...EXPLICIT_VITEST_VERIFY_SETTINGS.behavior,
        stubPath: "test/invariants/{agent}.test.ts",
      },
    };
    record(repo, baseSha, ["src", recordedStubPath], behaviorTest, undefined, recordedStubPath, verifySettings);
    const runner = vi.fn(testRunner);

    const result = await runVerify({ workspaceRoot: repo, agent: "worker", runner });

    expect(result.verdict).toBe("blocked");
    expect(result.blockers).toContainEqual({
      code: "behavior_base_unproven",
      detail: `recorded canonical stubPath '${recordedStubPath}' does not match configured path 'test/invariants/worker.test.ts' for agent 'worker'`,
      file: recordedStubPath,
    });
    expect(result.record.commands).toEqual([]);
    expect(runner).not.toHaveBeenCalled();
  });

  it("blocks full:true without inventing a full verification command", async () => {
    const { repo, wt, baseSha } = fixture();
    write(path.join(wt, "src", "feature.txt"), "new\n");
    git(wt, ["add", "src/feature.txt"]);
    git(wt, ["commit", "-qm", "t-123abc implement behavior"]);
    record(repo, baseSha);
    const runner = vi.fn(testRunner);

    const result = await runVerify({ workspaceRoot: repo, agent: "worker", full: true, verifySettings: {}, runner });

    expect(result.verdict).toBe("blocked");
    expect(result.blockers.map((blocker) => blocker.code)).toEqual([
      "verification_config_missing",
      "behavior_not_run",
    ]);
    expect(result.record.commands).toEqual([]);
    expect(runner).not.toHaveBeenCalled();
  });

  it("omits the affected-test tier when settings.verify.affected is absent", async () => {
    const { repo, wt, baseSha } = fixture();
    write(path.join(wt, "typecheck.js"), "process.exit(0);\n");
    write(path.join(wt, "src", "feature.txt"), "new\n");
    git(wt, ["add", "src/feature.txt", "typecheck.js"]);
    git(wt, ["commit", "-qm", "t-123abc implement behavior"]);
    record(repo, baseSha, ["src", "typecheck.js"]);

    const result = await runVerify({
      workspaceRoot: repo,
      agent: "worker",
      verifySettings: { typecheck: "node typecheck.js" },
      runner: testRunner,
    });

    expect(result.verdict).toBe("accept");
    expect(result.record.commands.map((command) => command.name)).toEqual([
      "behavior_base_expect_fail",
      "typecheck",
      "behavior_head_expect_pass",
    ]);
    expect(result.record.commands.some((command) => command.name === "affected_tests")).toBe(false);
  });

  it("passes explicitly configured Vitest-name behavior tests to npm as an argv array without shell interpolation", async () => {
    const { repo, wt } = fixture();
    const stubPath = "test/unit/workerBehavior.gen.test.ts";
    write(path.join(wt, stubPath), "it('quote \\\"x\\\" (case) costs $5', () => {});\n");
    git(wt, ["add", stubPath]);
    git(wt, ["commit", "-qm", "tachyon setup: canonical behavior stub"]);
    const baseSha = git(wt, ["rev-parse", "HEAD"]);
    write(path.join(wt, "src", "feature.txt"), "new\n");
    git(wt, ["add", "src/feature.txt"]);
    git(wt, ["commit", "-qm", "t-123abc implement behavior"]);
    record(repo, baseSha, ["src", stubPath], 'quote "x" (case) costs $5', undefined, stubPath);

    const result = await runVerify({ workspaceRoot: repo, agent: "worker" });

    expect(result.verdict).toBe("accept");
    const baseBehavior = result.record.commands.find((command) => command.name === "behavior_base_expect_fail");
    expect(baseBehavior).toMatchObject({
      argv: ["npm", "test", "--", "--run", "-t", 'quote "x" \\(case\\) costs \\$5$', "--reporter=json"],
    });
    expect(baseBehavior?.command).not.toContain("sh -lc");
    expect(result.record.behaviorEvidence).toMatchObject({
      identifier: 'quote "x" (case) costs $5',
      mode: "vitest-name",
      stubPath,
      executorHashes: expect.objectContaining({
        "package.json": expect.stringMatching(/^[0-9a-f]{64}$/),
        "npm-behavior.js": expect.stringMatching(/^[0-9a-f]{64}$/),
      }),
      baseAssertions: [{ title: 'quote "x" (case) costs $5', status: "failed" }],
      headAssertions: [{ title: 'quote "x" (case) costs $5', status: "passed" }],
    });
    const { integrityHash, ...integrityBody } = result.record;
    expect(crypto.createHash("sha256").update(JSON.stringify(integrityBody, null, 2)).digest("hex"))
      .toBe(integrityHash);
  });

  it("blocks plain behavior tests when the Vitest name filter matches no executable tests", async () => {
    const { repo, wt } = fixture();
    const stubPath = "test/unit/workerBehavior.gen.test.ts";
    write(path.join(wt, stubPath), "it('missing behavior name', () => {});\n");
    git(wt, ["add", stubPath]);
    git(wt, ["commit", "-qm", "tachyon setup: canonical behavior stub"]);
    const baseSha = git(wt, ["rev-parse", "HEAD"]);
    write(path.join(wt, "src", "feature.txt"), "new\n");
    git(wt, ["add", "src/feature.txt"]);
    git(wt, ["commit", "-qm", "t-123abc implement behavior"]);
    record(repo, baseSha, ["src", stubPath], "missing behavior name", undefined, stubPath);

    const result = await runVerify({ workspaceRoot: repo, agent: "worker" });

    expect(result.verdict).toBe("blocked");
    expect(result.blockers).toContainEqual({
      code: "behavior_test_renamed",
      detail: `canonical behavior test 'missing behavior name' was not reported passed from ${stubPath}`,
      file: stubPath,
    });
    expect(result.blockers).toContainEqual({
      code: "behavior_base_unproven",
      detail: `canonical behavior test 'missing behavior name' was not executed from ${stubPath} at baseSha`,
      file: stubPath,
    });
    expect(result.record.commands.map((c) => c.name)).toEqual([
      "verification_prepare_base",
      "behavior_base_expect_fail",
      "verification_prepare_head_tiers",
      "affected_tests",
      "verification_prepare_head",
      "behavior_head_expect_pass",
    ]);
    expect(result.record.commands[5]).toMatchObject({
      argv: ["npm", "test", "--", "--run", "-t", "missing behavior name$", "--reporter=json"],
      exitCode: 86,
      stderr: "plain behaviorTest 'missing behavior name' matched no executable exact Vitest test",
    });
  });

  it("blocks an agent that makes RED turn GREEN by editing the fixed oracle body", async () => {
    const { repo, wt } = fixture();
    const stubPath = "test/unit/workerBehavior.gen.test.ts";
    const behaviorTest = "fixed oracle proves behavior";
    write(path.join(wt, stubPath), `it('${behaviorTest}', () => { throw new Error('RED'); });\n`);
    git(wt, ["add", stubPath]);
    git(wt, ["commit", "-qm", "project-owned failing oracle"]);
    const baseSha = git(wt, ["rev-parse", "HEAD"]);
    write(path.join(wt, stubPath), `it('${behaviorTest}', () => { expect(true).toBe(true); });\n`);
    write(path.join(wt, "src", "feature.txt"), "cosmetic only\n");
    git(wt, ["add", stubPath, "src/feature.txt"]);
    git(wt, ["commit", "-qm", "t-123abc edit the oracle instead of behavior"]);
    record(repo, baseSha, ["src", stubPath], behaviorTest, undefined, stubPath);

    let behaviorRuns = 0;
    const result = await runVerify({
      workspaceRoot: repo,
      agent: "worker",
      verifySettings: { behavior: EXPLICIT_VITEST_VERIFY_SETTINGS.behavior },
      runner: async (cwd, argv) => {
        behaviorRuns += 1;
        const status = behaviorRuns === 1 ? "failed" : "passed";
        return {
          command: argv.join(" "),
          argv,
          exitCode: status === "failed" ? 1 : 0,
          stdout: vitestReport(path.join(cwd, stubPath), behaviorTest, status),
          stderr: "",
        };
      },
    });

    expect(result.verdict).toBe("blocked");
    expect(result.blockers).toContainEqual({
      code: "behavior_oracle_changed",
      detail: `canonical behavior oracle bytes changed at refSha: ${stubPath}`,
      file: stubPath,
    });
    expect(behaviorRuns).toBe(1);
  });

  it("blocks a fake GREEN produced by changing the spawn-bound package executor", async () => {
    const { repo, wt } = fixture();
    const stubPath = "test/unit/workerBehavior.gen.test.ts";
    const behaviorTest = "generated behavior stays canonical";
    write(path.join(wt, stubPath), `it('${behaviorTest}', () => {});\n`);
    git(wt, ["add", stubPath]);
    git(wt, ["commit", "-qm", "project-owned failing oracle"]);
    const baseSha = git(wt, ["rev-parse", "HEAD"]);

    write(path.join(wt, "src", "feature.txt"), "new\n");
    write(path.join(wt, "package.json"), JSON.stringify({ scripts: { test: "node fake-green.js" } }, null, 2));
    write(
      path.join(wt, "fake-green.js"),
      `console.log(JSON.stringify({numTotalTests:1,numPassedTests:1,numFailedTests:0,numPendingTests:0,testResults:[{name:${JSON.stringify(stubPath)},assertionResults:[{title:${JSON.stringify(behaviorTest)},fullName:${JSON.stringify(behaviorTest)},status:"passed"}]}]}));\n`,
    );
    git(wt, ["add", "src/feature.txt", "package.json", "fake-green.js"]);
    git(wt, ["commit", "-qm", "t-123abc replace the verifier with fake green"]);
    record(
      repo,
      baseSha,
      ["src", "package.json", "fake-green.js", stubPath],
      behaviorTest,
      undefined,
      stubPath,
      EXPLICIT_VITEST_VERIFY_SETTINGS,
    );

    let fakeGreenExecuted = false;
    const result = await runVerify({
      workspaceRoot: repo,
      agent: "worker",
      runner: async (cwd, argv, opts) => {
        if (argv[0] === "npm" && fs.readFileSync(path.join(cwd, "src", "feature.txt"), "utf8").trim() === "new") {
          fakeGreenExecuted = true;
        }
        return testRunner(cwd, argv, opts);
      },
    });

    expect(result.verdict).toBe("blocked");
    expect(result.blockers).toContainEqual({
      code: "behavior_executor_changed",
      detail: `fixed behavior executor bytes changed at refSha: package.json`,
      file: "package.json",
    });
    expect(fakeGreenExecuted).toBe(false);
    expect(result.record.commands.some((command) => command.name === "behavior_head_expect_pass")).toBe(false);
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
    const result = await runVerify({
      workspaceRoot: repo,
      agent: "worker",
      verifySettings: EXPLICIT_VITEST_VERIFY_SETTINGS,
      runner: async (_cwd, argv) => {
        if (argv[0] === "npx") return { command: argv.join(" "), argv, exitCode: 0, stdout: "related ok\n", stderr: "" };
        behaviorRuns += 1;
        const isBase = behaviorRuns === 1;
        const exitCode = isBase ? 1 : 0;
        const title = isBase ? "generated behavior stays canonical" : "renamed behavior";
        return {
          command: argv.join(" "),
          argv,
          exitCode,
          stdout: JSON.stringify({
            numTotalTests: 1,
            numPassedTests: isBase ? 0 : 1,
            numFailedTests: isBase ? 1 : 0,
            numPendingTests: 0,
            testResults: [{
              name: path.join(wt, stubPath),
              assertionResults: [{ title, fullName: title, status: isBase ? "failed" : "passed" }],
            }],
          }),
          stderr: "",
        };
      },
    });

    expect(result.verdict).toBe("blocked");
    expect(result.blockers).toContainEqual({
      code: "behavior_test_renamed",
      detail: `canonical behavior test 'generated behavior stays canonical' was not reported passed from ${stubPath}`,
      file: stubPath,
    });
  });

  it("accepts a relative reporter file for the canonical stub and a describe wrapper in Vitest fullName", async () => {
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
    const result = await runVerify({
      workspaceRoot: repo,
      agent: "worker",
      verifySettings: EXPLICIT_VITEST_VERIFY_SETTINGS,
      runner: async (_cwd, argv) => {
        if (argv[0] === "npx") return { command: argv.join(" "), argv, exitCode: 0, stdout: "related ok\n", stderr: "" };
        behaviorRuns += 1;
        const exitCode = behaviorRuns === 1 ? 1 : 0;
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
                name: stubPath,
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

  it.each([
    {
      label: "mixed failed/passed assertions at BASE",
      baseStatuses: ["failed", "passed"] as const,
      headStatuses: ["passed"] as const,
      blockerCode: "behavior_base_unproven",
    },
    {
      label: "duplicate passed assertions at HEAD",
      baseStatuses: ["failed"] as const,
      headStatuses: ["passed", "passed"] as const,
      blockerCode: "behavior_test_renamed",
    },
  ])("rejects $label instead of accepting any matching status", async ({ baseStatuses, headStatuses, blockerCode }) => {
    const { repo, wt } = fixture();
    const stubPath = "test/unit/workerBehavior.gen.test.ts";
    const behaviorTest = "generated behavior stays canonical";
    write(path.join(wt, stubPath), `it('${behaviorTest}', () => {});\n`);
    git(wt, ["add", stubPath]);
    git(wt, ["commit", "-qm", "tachyon setup: canonical behavior stub"]);
    const baseSha = git(wt, ["rev-parse", "HEAD"]);
    write(path.join(wt, "src", "feature.txt"), "new\n");
    git(wt, ["add", "src/feature.txt"]);
    git(wt, ["commit", "-qm", "t-123abc implement behavior"]);
    record(repo, baseSha, ["src", stubPath], behaviorTest, undefined, stubPath);

    let behaviorRuns = 0;
    const result = await runVerify({
      workspaceRoot: repo,
      agent: "worker",
      verifySettings: { behavior: EXPLICIT_VITEST_VERIFY_SETTINGS.behavior },
      runner: async (_cwd, argv) => {
        behaviorRuns += 1;
        const isBase = behaviorRuns === 1;
        const statuses = isBase ? baseStatuses : headStatuses;
        return {
          command: argv.join(" "),
          argv,
          exitCode: isBase ? 1 : 0,
          stdout: vitestReportForAssertions(
            stubPath,
            statuses.map((status) => ({ title: behaviorTest, status })),
          ),
          stderr: "",
        };
      },
    });

    expect(result.verdict).toBe("blocked");
    expect(result.blockers).toContainEqual(expect.objectContaining({
      code: blockerCode,
      detail: expect.stringContaining("must report exactly one assertion"),
      file: stubPath,
    }));
  });

  it("requires the canonical assertion identity to stay the same from BASE to HEAD", async () => {
    const { repo, wt } = fixture();
    const stubPath = "test/unit/workerBehavior.gen.test.ts";
    const behaviorTest = "generated behavior stays canonical";
    write(path.join(wt, stubPath), `it('${behaviorTest}', () => {});\n`);
    git(wt, ["add", stubPath]);
    git(wt, ["commit", "-qm", "tachyon setup: canonical behavior stub"]);
    const baseSha = git(wt, ["rev-parse", "HEAD"]);
    write(path.join(wt, "src", "feature.txt"), "new\n");
    git(wt, ["add", "src/feature.txt"]);
    git(wt, ["commit", "-qm", "t-123abc implement behavior"]);
    record(repo, baseSha, ["src", stubPath], behaviorTest, undefined, stubPath);

    let behaviorRuns = 0;
    const result = await runVerify({
      workspaceRoot: repo,
      agent: "worker",
      verifySettings: { behavior: EXPLICIT_VITEST_VERIFY_SETTINGS.behavior },
      runner: async (_cwd, argv) => {
        behaviorRuns += 1;
        const isBase = behaviorRuns === 1;
        return {
          command: argv.join(" "),
          argv,
          exitCode: isBase ? 1 : 0,
          stdout: vitestReportForAssertions(stubPath, [{
            title: behaviorTest,
            fullName: `${isBase ? "suite A" : "suite B"} ${behaviorTest}`,
            status: isBase ? "failed" : "passed",
          }]),
          stderr: "",
        };
      },
    });

    expect(result.verdict).toBe("blocked");
    expect(result.blockers).toContainEqual({
      code: "behavior_test_renamed",
      detail: `canonical behavior assertion identity changed between baseSha and refSha: ${behaviorTest}`,
      file: stubPath,
    });
  });

  it("rejects a fake report-shaped JSON payload before the actual Vitest reporter payload", async () => {
    const { repo, wt } = fixture();
    const stubPath = "test/unit/workerBehavior.gen.test.ts";
    const behaviorTest = "generated behavior stays canonical";
    write(path.join(wt, stubPath), `it('${behaviorTest}', () => {});\n`);
    git(wt, ["add", stubPath]);
    git(wt, ["commit", "-qm", "tachyon setup: canonical behavior stub"]);
    const baseSha = git(wt, ["rev-parse", "HEAD"]);
    write(path.join(wt, "src", "feature.txt"), "new\n");
    git(wt, ["add", "src/feature.txt"]);
    git(wt, ["commit", "-qm", "t-123abc implement behavior"]);
    record(repo, baseSha, ["src", stubPath], behaviorTest, undefined, stubPath);

    let behaviorRuns = 0;
    const result = await runVerify({
      workspaceRoot: repo,
      agent: "worker",
      verifySettings: { behavior: EXPLICIT_VITEST_VERIFY_SETTINGS.behavior },
      runner: async (_cwd, argv) => {
        behaviorRuns += 1;
        const isBase = behaviorRuns === 1;
        const reporter = vitestReport(stubPath, behaviorTest, "failed");
        const fakeGreen = vitestReport(stubPath, behaviorTest, "passed");
        return {
          command: argv.join(" "),
          argv,
          exitCode: isBase ? 1 : 0,
          stdout: isBase ? reporter : `${fakeGreen}\n${reporter}`,
          stderr: "",
        };
      },
    });

    expect(result.verdict).toBe("blocked");
    expect(result.record.commands.at(-1)).toMatchObject({
      name: "behavior_head_expect_pass",
      exitCode: 86,
      stderr: expect.stringContaining("emitted 2 Vitest JSON reporter-shaped payloads"),
    });
  });

  it("rejects Vitest summary counts that disagree with the reported assertions", async () => {
    const { repo, wt } = fixture();
    const stubPath = "test/unit/workerBehavior.gen.test.ts";
    const behaviorTest = "generated behavior stays canonical";
    write(path.join(wt, stubPath), `it('${behaviorTest}', () => {});\n`);
    git(wt, ["add", stubPath]);
    git(wt, ["commit", "-qm", "tachyon setup: canonical behavior stub"]);
    const baseSha = git(wt, ["rev-parse", "HEAD"]);
    write(path.join(wt, "src", "feature.txt"), "new\n");
    git(wt, ["add", "src/feature.txt"]);
    git(wt, ["commit", "-qm", "t-123abc implement behavior"]);
    record(repo, baseSha, ["src", stubPath], behaviorTest, undefined, stubPath);

    let behaviorRuns = 0;
    const result = await runVerify({
      workspaceRoot: repo,
      agent: "worker",
      verifySettings: { behavior: EXPLICIT_VITEST_VERIFY_SETTINGS.behavior },
      runner: async (_cwd, argv) => {
        behaviorRuns += 1;
        const isBase = behaviorRuns === 1;
        return {
          command: argv.join(" "),
          argv,
          exitCode: isBase ? 1 : 0,
          stdout: isBase
            ? vitestReport(stubPath, behaviorTest, "failed")
            : JSON.stringify({
                numTotalTests: 1,
                numPassedTests: 0,
                numFailedTests: 1,
                numPendingTests: 0,
                numTodoTests: 0,
                testResults: [{
                  name: stubPath,
                  assertionResults: [{ title: behaviorTest, fullName: behaviorTest, status: "passed" }],
                }],
              }),
          stderr: "",
        };
      },
    });

    expect(result.verdict).toBe("blocked");
    expect(result.record.commands.at(-1)).toMatchObject({
      name: "behavior_head_expect_pass",
      exitCode: 86,
      stderr: expect.stringContaining("summary counts do not match assertion results"),
    });
  });

  it("blocks when a nonzero BASE Vitest run does not prove the exact canonical assertion", async () => {
    const { repo, wt } = fixture();
    const stubPath = "test/unit/workerBehavior.gen.test.ts";
    const behaviorTest = "generated behavior stays canonical";
    write(path.join(wt, stubPath), `it('${behaviorTest}', () => {});\n`);
    git(wt, ["add", stubPath]);
    git(wt, ["commit", "-qm", "tachyon setup: canonical behavior stub"]);
    const baseSha = git(wt, ["rev-parse", "HEAD"]);

    write(path.join(wt, "src", "feature.txt"), "new\n");
    git(wt, ["add", "src/feature.txt"]);
    git(wt, ["commit", "-qm", "t-123abc implement behavior"]);
    record(repo, baseSha, ["src", stubPath], behaviorTest, undefined, stubPath);

    let behaviorRuns = 0;
    const result = await runVerify({
      workspaceRoot: repo,
      agent: "worker",
      verifySettings: { behavior: EXPLICIT_VITEST_VERIFY_SETTINGS.behavior },
      runner: async (_cwd, argv) => {
        behaviorRuns += 1;
        if (behaviorRuns === 1) {
          return { command: argv.join(" "), argv, exitCode: 1, stdout: "", stderr: "expected red\n" };
        }
        return {
          command: argv.join(" "),
          argv,
          exitCode: 0,
          stdout: vitestReport(path.join(wt, stubPath), behaviorTest, "passed"),
          stderr: "",
        };
      },
    });

    expect(result.verdict).toBe("blocked");
    expect(result.blockers).toContainEqual({
      code: "behavior_base_unproven",
      detail: `canonical behavior test '${behaviorTest}' was not executed from ${stubPath} at baseSha`,
      file: stubPath,
    });
    expect(result.record.commands.map((command) => command.name)).toEqual([
      "behavior_base_expect_fail",
      "behavior_head_expect_pass",
    ]);
  });

  it("does not let an exact duplicate assertion in another file satisfy the canonical stub", async () => {
    const { repo, wt } = fixture();
    const stubPath = "test/unit/workerBehavior.gen.test.ts";
    const duplicatePath = "test/unit/duplicateBehavior.test.ts";
    const behaviorTest = "generated behavior stays canonical";
    write(path.join(wt, stubPath), `it('${behaviorTest}', () => {});\n`);
    git(wt, ["add", stubPath]);
    git(wt, ["commit", "-qm", "tachyon setup: canonical behavior stub"]);
    const baseSha = git(wt, ["rev-parse", "HEAD"]);

    write(path.join(wt, "src", "feature.txt"), "new\n");
    write(path.join(wt, duplicatePath), `it('${behaviorTest}', () => {});\n`);
    git(wt, ["add", "src/feature.txt", duplicatePath]);
    git(wt, ["commit", "-qm", "t-123abc duplicate behavior elsewhere"]);
    record(repo, baseSha, ["src", stubPath, duplicatePath], behaviorTest, undefined, stubPath);

    let behaviorRuns = 0;
    const result = await runVerify({
      workspaceRoot: repo,
      agent: "worker",
      verifySettings: { behavior: EXPLICIT_VITEST_VERIFY_SETTINGS.behavior },
      runner: async (_cwd, argv) => {
        behaviorRuns += 1;
        const isBase = behaviorRuns === 1;
        return {
          command: argv.join(" "),
          argv,
          exitCode: isBase ? 1 : 0,
          stdout: vitestReport(path.join(wt, isBase ? stubPath : duplicatePath), behaviorTest, isBase ? "failed" : "passed"),
          stderr: "",
        };
      },
    });

    expect(result.verdict).toBe("blocked");
    expect(result.blockers).toContainEqual({
      code: "behavior_test_renamed",
      detail: `canonical behavior test '${behaviorTest}' was not reported passed from ${stubPath}`,
      file: stubPath,
    });
  });

  it("blocks a canonical stub changed into a symlink before executing the HEAD verifier", async () => {
    const { repo, wt } = fixture();
    const stubPath = "test/unit/workerBehavior.gen.test.ts";
    const duplicatePath = "test/unit/duplicateBehavior.test.ts";
    const behaviorTest = "generated behavior stays canonical";
    write(path.join(wt, stubPath), `it('${behaviorTest}', () => {});\n`);
    git(wt, ["add", stubPath]);
    git(wt, ["commit", "-qm", "tachyon setup: canonical behavior stub"]);
    const baseSha = git(wt, ["rev-parse", "HEAD"]);

    write(path.join(wt, "src", "feature.txt"), "new\n");
    write(path.join(wt, duplicatePath), `it('${behaviorTest}', () => {});\n`);
    fs.rmSync(path.join(wt, stubPath));
    fs.symlinkSync(path.basename(duplicatePath), path.join(wt, stubPath));
    git(wt, ["add", "src/feature.txt", stubPath, duplicatePath]);
    git(wt, ["commit", "-qm", "t-123abc replace canonical stub with symlink"]);
    record(repo, baseSha, ["src", stubPath, duplicatePath], behaviorTest, undefined, stubPath);

    let behaviorRuns = 0;
    const result = await runVerify({
      workspaceRoot: repo,
      agent: "worker",
      verifySettings: { behavior: EXPLICIT_VITEST_VERIFY_SETTINGS.behavior },
      runner: async (_cwd, argv) => {
        behaviorRuns += 1;
        return {
          command: argv.join(" "),
          argv,
          exitCode: 1,
          stdout: vitestReport(path.join(wt, stubPath), behaviorTest, "failed"),
          stderr: "",
        };
      },
    });

    expect(result.verdict).toBe("blocked");
    expect(result.blockers).toContainEqual({
      code: "behavior_test_renamed",
      detail: `canonical behavior stub is not a regular non-symlink file at refSha: ${stubPath}`,
      file: stubPath,
    });
    expect(result.blockers).toContainEqual({
      code: "behavior_test_renamed",
      detail: `canonical behavior test stub changed file type: ${stubPath}`,
      file: stubPath,
    });
    expect(behaviorRuns).toBe(1);
  });

  it.each([
    { label: "skipped", status: "pending" as const },
    { label: "todo", status: "todo" as const },
  ])("does not accept a canonical behavior assertion reported as $label", async ({ status }) => {
    const { repo, wt } = fixture();
    const stubPath = "test/unit/workerBehavior.gen.test.ts";
    const behaviorTest = "generated behavior stays canonical";
    write(path.join(wt, stubPath), `it('${behaviorTest}', () => {});\n`);
    git(wt, ["add", stubPath]);
    git(wt, ["commit", "-qm", "tachyon setup: canonical behavior stub"]);
    const baseSha = git(wt, ["rev-parse", "HEAD"]);

    write(path.join(wt, "src", "feature.txt"), "new\n");
    git(wt, ["add", "src/feature.txt"]);
    git(wt, ["commit", "-qm", `t-123abc ${status} canonical behavior`]);
    record(repo, baseSha, ["src", stubPath], behaviorTest, undefined, stubPath);

    let behaviorRuns = 0;
    const result = await runVerify({
      workspaceRoot: repo,
      agent: "worker",
      verifySettings: { behavior: EXPLICIT_VITEST_VERIFY_SETTINGS.behavior },
      runner: async (_cwd, argv) => {
        behaviorRuns += 1;
        const isBase = behaviorRuns === 1;
        return {
          command: argv.join(" "),
          argv,
          exitCode: isBase ? 1 : 0,
          stdout: vitestReport(path.join(wt, stubPath), behaviorTest, isBase ? "failed" : status),
          stderr: "",
        };
      },
    });

    expect(result.verdict).toBe("blocked");
    expect(result.blockers).toContainEqual({
      code: "behavior_test_renamed",
      detail: `canonical behavior test '${behaviorTest}' was not reported passed from ${stubPath}`,
      file: stubPath,
    });
    expect(result.record.commands.at(-1)).toMatchObject({
      name: "behavior_head_expect_pass",
      exitCode: 86,
      stderr: `plain behaviorTest '${behaviorTest}' was skipped, todo, or pending instead of executed`,
    });
  });

  it("runs BASE before HEAD so ignored HEAD state cannot contaminate the RED proof", async () => {
    const { repo, wt, baseSha } = fixture();
    write(path.join(wt, "src", "feature.txt"), "new\n");
    git(wt, ["add", "src/feature.txt"]);
    git(wt, ["commit", "-qm", "t-123abc implement behavior"]);
    record(repo, baseSha);

    const observations: Array<{ feature: string; markerExists: boolean }> = [];
    const result = await runVerify({
      workspaceRoot: repo,
      agent: "worker",
      verifySettings: {},
      runner: async (cwd, argv) => {
        const marker = path.join(cwd, "node_modules", "head-marker");
        const feature = fs.readFileSync(path.join(cwd, "src", "feature.txt"), "utf8").trim();
        const markerExists = fs.existsSync(marker);
        observations.push({ feature, markerExists });
        if (feature === "new") write(marker, "created by HEAD\n");
        return {
          command: argv.join(" "),
          argv,
          exitCode: feature === "new" || markerExists ? 0 : 1,
          stdout: "",
          stderr: "",
        };
      },
    });

    expect(result.verdict).toBe("accept");
    expect(observations).toEqual([
      { feature: "old", markerExists: false },
      { feature: "new", markerExists: false },
    ]);
    expect(result.record.commands.map((command) => command.name)).toEqual([
      "behavior_base_expect_fail",
      "behavior_head_expect_pass",
    ]);
  });

  it("does not let a HEAD tier manufacture the GREEN proof through ignored state", async () => {
    const { repo, wt } = fixture();
    write(
      path.join(wt, "behavior.js"),
      "const fs = require('fs'); process.exit(fs.existsSync('node_modules/tier-marker') ? 0 : 1);\n",
    );
    write(
      path.join(wt, "tier.js"),
      "const fs = require('fs'); fs.mkdirSync('node_modules', { recursive: true }); fs.writeFileSync('node_modules/tier-marker', 'created by tier');\n",
    );
    git(wt, ["add", "behavior.js", "tier.js"]);
    git(wt, ["commit", "-qm", "project verifier and affected tier"]);
    const baseSha = git(wt, ["rev-parse", "HEAD"]);
    write(path.join(wt, "src", "feature.txt"), "irrelevant change\n");
    git(wt, ["add", "src/feature.txt"]);
    git(wt, ["commit", "-qm", "t-123abc unrelated implementation change"]);
    record(repo, baseSha, ["src"], "cmd:node behavior.js", undefined, undefined, { affected: "node tier.js" });

    const result = await runVerify({ workspaceRoot: repo, agent: "worker", runner: testRunner, explicitTestSettings: false });

    expect(result.verdict).toBe("blocked");
    expect(result.blockers.map((blocker) => blocker.code)).toContain("behavior_failed");
    expect(result.record.commands.map((command) => command.name)).toEqual([
      "behavior_base_expect_fail",
      "affected_tests",
      "behavior_head_expect_pass",
    ]);
    const tier = result.record.commands.find((command) => command.name === "affected_tests");
    const headBehavior = result.record.commands.find((command) => command.name === "behavior_head_expect_pass");
    expect(tier).toMatchObject({ exitCode: 0 });
    expect(headBehavior).toMatchObject({ exitCode: 1 });
    expect(tier?.cwd).not.toBe(headBehavior?.cwd);
  });

  it("does not accept RED then GREEN that depends only on a shared host temp marker", async () => {
    const { repo, wt } = fixture();
    write(
      path.join(wt, "behavior.js"),
      [
        "const fs = require('fs');",
        "const os = require('os');",
        "const path = require('path');",
        "const marker = path.join(os.tmpdir(), 'tachyon-shared-state-marker');",
        "const seen = fs.existsSync(marker);",
        "fs.writeFileSync(marker, 'state');",
        "console.log(JSON.stringify({ temporary: os.tmpdir(), nodePath: process.env.NODE_PATH }));",
        "process.exit(seen ? 0 : 1);",
        "",
      ].join("\n"),
    );
    git(wt, ["add", "behavior.js"]);
    git(wt, ["commit", "-qm", "project verifier with temp-state tripwire"]);
    const baseSha = git(wt, ["rev-parse", "HEAD"]);
    write(path.join(wt, "src", "feature.txt"), "irrelevant change\n");
    git(wt, ["add", "src/feature.txt"]);
    git(wt, ["commit", "-qm", "t-123abc unrelated implementation change"]);
    record(repo, baseSha, ["src", "behavior.js"], "cmd:node behavior.js", undefined, undefined, {});

    const priorNodePath = process.env.NODE_PATH;
    process.env.NODE_PATH = path.join(repo, "node_modules", "ambient-injection");
    let result: Awaited<ReturnType<typeof verifyTask>>;
    try {
      result = await runVerify({ workspaceRoot: repo, agent: "worker" });
    } finally {
      if (priorNodePath === undefined) delete process.env.NODE_PATH;
      else process.env.NODE_PATH = priorNodePath;
    }

    expect(result.verdict).toBe("blocked");
    expect(result.blockers.map((blocker) => blocker.code)).toContain("behavior_failed");
    const behaviorCommands = result.record.commands.filter((command) => command.name.startsWith("behavior_"));
    expect(behaviorCommands).toHaveLength(2);
    const observations = behaviorCommands.map((command) => JSON.parse(command.stdout!.trim()) as { temporary: string; nodePath?: string });
    expect(observations.map((observation) => observation.nodePath)).toEqual([undefined, undefined]);
    const phaseTemps = observations.map((observation) => observation.temporary);
    expect(phaseTemps.every((temporary) => temporary?.startsWith(verificationCloneParent(repo)))).toBe(true);
    expect(new Set(phaseTemps).size).toBe(2);
  });

  it("neutralizes shared checkout hooks and reaps only a provably abandoned owned clone", async () => {
    const { repo, wt, baseSha } = fixture();
    write(path.join(wt, "src", "feature.txt"), "new\n");
    git(wt, ["add", "src/feature.txt"]);
    git(wt, ["commit", "-qm", "t-123abc implement behavior"]);
    record(repo, baseSha, ["src"], "cmd:node behavior.js", undefined, undefined, {});

    const hookMarker = path.join(repo, ".tachyon", "post-checkout-ran");
    const hook = path.join(repo, ".git", "hooks", "post-checkout");
    write(hook, `#!/bin/sh\nprintf hook > ${JSON.stringify(hookMarker)}\n`);
    fs.chmodSync(hook, 0o755);

    const cloneParent = verificationCloneParent(repo);
    const workspaceHash = crypto.createHash("sha256").update(fs.realpathSync(repo)).digest("hex").slice(0, 24);
    const stale = path.join(cloneParent, "verify-stale-owned");
    fs.mkdirSync(cloneParent, { recursive: true, mode: 0o700 });
    fs.mkdirSync(stale);
    write(path.join(stale, "owner.json"), JSON.stringify({
      version: 1,
      workspaceHash,
      pid: 2_147_483_647,
      nonce: "a".repeat(32),
      createdAt: "2020-01-01T00:00:00.000Z",
    }));
    const invalid = path.join(cloneParent, "verify-invalid-owner");
    fs.mkdirSync(invalid);
    write(path.join(invalid, "owner.json"), JSON.stringify({
      version: 1,
      workspaceHash,
      pid: -1,
      processStart: { forged: true },
      nonce: "not-hex",
      createdAt: "2020-01-01T00:00:00.000Z",
    }));
    const zeroStart = path.join(cloneParent, "verify-zero-process-start");
    fs.mkdirSync(zeroStart);
    write(path.join(zeroStart, "owner.json"), JSON.stringify({
      version: 1,
      workspaceHash,
      pid: process.pid,
      processStart: "0",
      nonce: "b".repeat(32),
      createdAt: "2020-01-01T00:00:00.000Z",
    }));

    const result = await runVerify({ workspaceRoot: repo, agent: "worker", runner: testRunner });

    expect(result.verdict).toBe("accept");
    expect(fs.existsSync(hookMarker)).toBe(false);
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(invalid)).toBe(true);
    expect(fs.existsSync(zeroStart)).toBe(true);
    expect(fs.readdirSync(cloneParent).filter((entry) => entry.startsWith("verify-")).sort()).toEqual([
      "verify-invalid-owner",
      "verify-zero-process-start",
    ]);
  });

  it("stores verification-clone Git objects independently from the trusted source repository", async () => {
    const { repo, wt, baseSha } = fixture();
    write(path.join(wt, "src", "feature.txt"), "new\n");
    git(wt, ["add", "src/feature.txt"]);
    git(wt, ["commit", "-qm", "t-123abc implement behavior"]);
    record(repo, baseSha, ["src"], "cmd:node behavior.js", undefined, undefined, {});

    // A fully packed source makes the old `clone --local` path observably dangerous: its clone would
    // hardlink these pack files. The verifier must instead receive independently stored object bytes.
    git(repo, ["gc", "--prune=now"]);
    const sourcePackDir = path.join(repo, ".git", "objects", "pack");
    const sourcePackNames = fs.readdirSync(sourcePackDir).filter((name) => name.endsWith(".pack"));
    expect(sourcePackNames.length).toBeGreaterThan(0);
    const sourceBytes = new Map(sourcePackNames.map((name) => [
      name,
      fs.readFileSync(path.join(sourcePackDir, name)),
    ]));
    let provedIndependentStorage = false;

    const result = await runVerify({
      workspaceRoot: repo,
      agent: "worker",
      verifySettings: {},
      runner: async (cwd, argv, opts) => {
        if (!provedIndependentStorage) {
          const clonePackDir = path.join(cwd, ".git", "objects", "pack");
          const clonePackName = fs.readdirSync(clonePackDir).find((name) => name.endsWith(".pack"));
          expect(clonePackName).toBeDefined();
          const clonePack = path.join(clonePackDir, clonePackName!);
          const cloneBefore = fs.readFileSync(clonePack);
          expect(cloneBefore.length).toBeGreaterThan(0);

          const sameNamedSource = path.join(sourcePackDir, clonePackName!);
          if (fs.existsSync(sameNamedSource)) {
            const sourceStat = fs.statSync(sameNamedSource);
            const cloneStat = fs.statSync(clonePack);
            expect({ dev: cloneStat.dev, ino: cloneStat.ino }).not.toEqual({ dev: sourceStat.dev, ino: sourceStat.ino });
          }

          const mutated = Buffer.from(cloneBefore);
          mutated[mutated.length - 1] ^= 0xff;
          const cloneMode = fs.statSync(clonePack).mode;
          fs.chmodSync(clonePack, cloneMode | 0o200);
          fs.writeFileSync(clonePack, mutated);
          try {
            for (const [name, before] of sourceBytes) {
              expect(fs.readFileSync(path.join(sourcePackDir, name)).equals(before)).toBe(true);
            }
          } finally {
            fs.writeFileSync(clonePack, cloneBefore);
            fs.chmodSync(clonePack, cloneMode);
          }
          provedIndependentStorage = true;
        }
        return testRunner(cwd, argv, opts);
      },
    });

    expect(result.verdict).toBe("accept");
    expect(provedIndependentStorage).toBe(true);
  });

  it("prefixes a root affected path beginning with a dash before passing it to the project command", async () => {
    const { repo, wt, baseSha } = fixture();
    write(path.join(wt, "--passWithNoTests"), "not a CLI option\n");
    write(path.join(wt, "src", "feature.txt"), "new\n");
    git(wt, ["add", "--", "--passWithNoTests", "src/feature.txt"]);
    git(wt, ["commit", "-qm", "t-123abc add option-shaped file"]);
    record(repo, baseSha, ["src", "--passWithNoTests"]);

    const result = await runVerify({
      workspaceRoot: repo,
      agent: "worker",
      verifySettings: { affected: VITEST_AFFECTED_COMMAND },
      runner: testRunner,
    });

    expect(result.verdict).toBe("accept");
    expect(result.record.commands.find((command) => command.name === "affected_tests")?.argv).toEqual([
      "npx",
      "vitest",
      "related",
      "--run",
      "./--passWithNoTests",
      "src/feature.txt",
    ]);
  });

  it("runs configured typecheck and affected tests on every verification but skips full by default", async () => {
    const { repo, wt, baseSha } = fixture();
    write(
      path.join(repo, "tachyon.yml"),
      "agents:\n  worker:\n    cmd: codex\nsettings:\n  verify:\n    typecheck: node typecheck.js\n    affected: npx vitest related --run\n    full: node full.js\n",
    );
    write(path.join(wt, "typecheck.js"), "process.exit(0);\n");
    write(path.join(wt, "full.js"), "process.exit(0);\n");
    write(path.join(wt, "src", "feature.txt"), "new\n");
    git(wt, ["add", "src/feature.txt", "typecheck.js", "full.js"]);
    git(wt, ["commit", "-qm", "t-123abc implement behavior"]);
    record(repo, baseSha, ["src", "typecheck.js", "full.js"]);

    const result = await runVerify({ workspaceRoot: repo, agent: "worker", runner: testRunner, explicitTestSettings: false });

    expect(result.verdict).toBe("accept");
    expect(result.record.commands.map((c) => c.name)).toEqual(["behavior_base_expect_fail", "typecheck", "affected_tests", "behavior_head_expect_pass"]);
    expect(result.record.commands[1].argv).toEqual(["node", "typecheck.js"]);
    expect(result.record.commands[2].argv).toEqual(["npx", "vitest", "related", "--run", "full.js", "src/feature.txt", "typecheck.js"]);
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

    const result = await runVerify({
      workspaceRoot: repo,
      agent: "worker",
      verifySettings: { affected: VITEST_AFFECTED_COMMAND },
    });

    expect(result.verdict).toBe("accept");
    expect(result.record.commands[1].argv).toEqual(["npx", "vitest", "related", "--run", "src/feature.txt"]);
  });

  it("runs the configured full command only when full:true is requested", async () => {
    const { repo, wt, baseSha } = fixture();
    write(
      path.join(repo, "tachyon.yml"),
      "agents:\n  worker:\n    cmd: codex\nsettings:\n  verify:\n    affected: npx vitest related --run\n    full: node full.js\n",
    );
    write(path.join(wt, "full.js"), "process.exit(0);\n");
    write(path.join(wt, "src", "feature.txt"), "new\n");
    git(wt, ["add", "src/feature.txt", "full.js"]);
    git(wt, ["commit", "-qm", "t-123abc implement behavior"]);
    record(repo, baseSha, ["src", "full.js"]);

    const result = await runVerify({ workspaceRoot: repo, agent: "worker", full: true, runner: testRunner, explicitTestSettings: false });

    expect(result.verdict).toBe("accept");
    expect(result.record.commands.map((c) => c.name)).toEqual(["behavior_base_expect_fail", "affected_tests", "full_tests", "behavior_head_expect_pass"]);
    expect(result.record.commands[2].argv).toEqual(["node", "full.js"]);
  });

  it("blocks when a tiered verification command fails", async () => {
    const { repo, wt, baseSha } = fixture();
    write(path.join(wt, "src", "feature.txt"), "new\n");
    git(wt, ["add", "src/feature.txt"]);
    git(wt, ["commit", "-qm", "t-123abc implement behavior"]);
    record(repo, baseSha);

    const result = await runVerify({
      workspaceRoot: repo,
      agent: "worker",
      verifySettings: { affected: VITEST_AFFECTED_COMMAND },
      runner: async (cwd, argv, opts) => {
        if (argv[0] === "npx") return { command: argv.join(" "), argv, exitCode: 1, stdout: "", stderr: "related failed\n" };
        return testRunner(cwd, argv, opts);
      },
    });

    expect(result.verdict).toBe("blocked");
    expect(result.blockers.map((b) => b.code)).toContain("affected_tests_failed");
    expect(result.blockers.map((b) => b.code)).toContain("behavior_not_run");
    expect(result.record.commands.map((c) => c.name)).toEqual(["behavior_base_expect_fail", "affected_tests"]);
  });

  it("preserves bounded actionable diagnostics and termination metadata", async () => {
    const { repo, wt, baseSha } = fixture();
    write(path.join(wt, "src", "feature.txt"), "new\n");
    git(wt, ["add", "src/feature.txt"]);
    git(wt, ["commit", "-qm", "t-123abc implement behavior"]);
    record(repo, baseSha);
    const result = await runVerify({
      workspaceRoot: repo, agent: "worker", verifySettings: { affected: VITEST_AFFECTED_COMMAND },
      runner: async (cwd, argv, opts) => argv[0] === "npx"
        ? { command: argv.join(" "), argv, exitCode: 1, stdout: `${"noise\n".repeat(900)}REAL ASSERTION FAILED\n`, stderr: "ExperimentalWarning: sqlite\n", timedOut: true, signal: "SIGTERM" }
        : testRunner(cwd, argv, opts),
    });
    const command = result.record.commands.find((entry) => entry.name === "affected_tests");
    const blocker = result.blockers.find((entry) => entry.code === "affected_tests_failed");
    expect(command).toMatchObject({ timedOut: true, signal: "SIGTERM" });
    expect(command?.stdout).toContain("REAL ASSERTION FAILED");
    expect(command?.stdout?.length).toBeLessThanOrEqual(4_140);
    expect(blocker?.detail).toContain("timed out, signal SIGTERM");
    expect(blocker?.detail).toContain("REAL ASSERTION FAILED");
  });

  it("blocks when the task ref has no new commit", async () => {
    const { repo, baseSha } = fixture();
    record(repo, baseSha);

    const result = await runVerify({ workspaceRoot: repo, agent: "worker" });

    expect(result.verdict).toBe("blocked");
    expect(result.blockers.map((b) => b.code)).toContain("no_commit");
  });

  it("refuses dirty canonical worktrees before verification starts", async () => {
    const { repo, wt, baseSha } = fixture();
    write(path.join(wt, "src", "feature.txt"), "new\n");
    git(wt, ["add", "src/feature.txt"]);
    git(wt, ["commit", "-qm", "t-123abc implement behavior"]);
    write(path.join(wt, "scratch.txt"), "uncommitted\n");
    record(repo, baseSha);

    await expect(runVerify({ workspaceRoot: repo, agent: "worker" }))
      .rejects.toMatchObject({ code: "DELIVERY_INVALID_STATE" });
  });

  it("refuses verification while the current Delivery occupant is still running", async () => {
    const { repo, wt, baseSha } = fixture();
    write(path.join(wt, "src", "feature.txt"), "new\n");
    git(wt, ["add", "src/feature.txt"]);
    git(wt, ["commit", "-qm", "t-123abc implement behavior"]);
    record(repo, baseSha);

    await expect(runVerify({ workspaceRoot: repo, agent: "worker", isAgentRunning: async () => true }))
      .rejects.toMatchObject({ code: "WORKTREE_OCCUPIED", retryable: true });
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
    // Verification reserves its durable lease under the first lock, then runs immutable
    // checkouts under a fresh lock.  A controlled live-tail stop, when present, happens
    // between those phases and therefore outside either worktree lock.
    expect(calls).toEqual(["lock:worker", "unlock:worker", "lock:worker", "unlock:worker"]);
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
    expect(result.blockers).toContainEqual(expect.objectContaining({ code: "scope_breach", file: "README.md" }));
  });

  async function scopedFixerVerification(
    repo: string,
    wt: string,
    baseSha: string,
    branchHeadAtGrant: string,
    deliveryId: string,
  ): Promise<DeliveryVerificationLeaseService> {
    const delivered = git(wt, ["rev-parse", "HEAD"]);
    const store = authorityDeliveryStore(repo);
    const gitDeliveries = new GitDeliveryStore(repo);
    const projection = await gitDeliveries.open({
      workspaceId: "ws",
      createdBy: actor,
      deliveryId,
      agent: "fixer-1",
      branchRef: "tachyon/worker",
      worktreePath: wt,
      tachyonCreatedBranch: true,
      baseRef: baseSha,
      currentHeadSha: delivered,
    });
    await store.create({
      id: deliveryId,
      workspaceId: "ws",
      createdBy: actor,
      contract: { baseSha, behaviorTest: "cmd:node behavior.js", owns: ["src"], taskRef: "tachyon/worker" },
      gitDeliveryId: projection.id,
      segments: [
        {
          id: "seg-0", index: 0, role: "implementer", executionAgent: "worker", grantedBy: actor,
          ownsSubset: ["src"], grantedHeadSha: baseSha, grantedAt: "2026-01-01T00:00:00.000Z",
          releasedAt: "2026-01-01T00:01:00.000Z", releasedHeadSha: branchHeadAtGrant, outcome: "completed",
        },
        {
          id: "seg-1", index: 1, role: "fixer", executionAgent: "fixer-1", grantedBy: actor,
          ownsSubset: ["src/fix.txt"], grantedHeadSha: branchHeadAtGrant, grantedAt: "2026-01-01T00:01:00.000Z",
        },
      ],
    });
    return canonicalVerification(store, gitDeliveries);
  }

  it("checks a canonical fixer segment against its own grant, not the Delivery's wider scope", async () => {
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

    const deliveryId = "d-segment-scope";
    const deliveryVerification = await scopedFixerVerification(repo, wt, baseSha, branchHeadAtGrant, deliveryId);
    const result = await runVerify({ workspaceRoot: repo, deliveryId, deliveryVerification });

    // The original agent's own commit (segment before any grant) is checked against `owns` and passes.
    expect(result.blockers.map((b) => b.file)).not.toContain("src/feature.txt");
    // The fixer's commit inside its granted subset passes.
    expect(result.blockers.map((b) => b.file)).not.toContain("src/fix.txt");
    // The fixer's commit outside its granted subset (but inside the original owns) is named to the attempt.
    expect(result.blockers).toContainEqual(
      expect.objectContaining({
        code: "scope_breach",
        file: "src/other.txt",
        detail: expect.stringContaining("segment 'seg-1'"),
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

    const deliveryId = "d-segment-waiver";
    const deliveryVerification = await scopedFixerVerification(repo, wt, baseSha, branchHeadAtGrant, deliveryId);
    const waiver = { finding: "src/other.txt", reason: "coordinator confirms fixer needed this adjacent file" };
    const result = await runVerify({ workspaceRoot: repo, deliveryId, deliveryVerification, waivers: [waiver] });

    expect(result.verdict).toBe("accept");
    expect(result.blockers.map((b) => b.code)).not.toContain("scope_breach");
    expect(result.record.waivers).toEqual([waiver]);
    expect(result.record.findings).toContainEqual(
      expect.objectContaining({
        code: "scope_breach",
        file: "src/other.txt",
        detail: expect.stringContaining("segment 'seg-1'"),
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

  it("treats an empty canonical owns grant as no write authority", async () => {
    const { repo, wt, baseSha } = fixture();
    write(path.join(wt, "src", "feature.txt"), "new\n");
    write(path.join(wt, "README.md"), "outside but owns is optional\n");
    git(wt, ["add", "src/feature.txt", "README.md"]);
    git(wt, ["commit", "-qm", "t-123abc implement behavior"]);
    record(repo, baseSha, []);

    const result = await runVerify({ workspaceRoot: repo, agent: "worker" });

    expect(result.verdict).toBe("blocked");
    expect(result.blockers.map((b) => b.code)).toContain("scope_breach");
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
    const { repo, wt } = fixture();
    const stubPath = "test/unit/workerBehavior.gen.test.ts";
    write(path.join(wt, stubPath), "it('generated behavior stays canonical', () => {});\n");
    git(wt, ["add", stubPath]);
    git(wt, ["commit", "-qm", "tachyon setup: canonical behavior stub"]);
    const baseSha = git(wt, ["rev-parse", "HEAD"]);
    write(path.join(wt, "src", "feature.txt"), "new\n");
    write(path.join(wt, "test", "feature.test.ts"), "it.skip('old behavior', () => {});\n");
    git(wt, ["add", "src/feature.txt", "test/feature.test.ts"]);
    git(wt, ["commit", "-qm", "t-123abc behavior with suppression"]);
    record(repo, baseSha, ["src", "test"], "generated behavior stays canonical", undefined, stubPath);

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

  it("does not apply Vitest suppression policy to a cmd gate even when a global adapter is configured", async () => {
    const { repo, wt, baseSha } = fixture();
    write(path.join(wt, "src", "feature.txt"), "new\n");
    write(path.join(wt, "test", "feature.test.ts"), "it.skip('project-owned policy', () => {});\n");
    git(wt, ["add", "src/feature.txt", "test/feature.test.ts"]);
    git(wt, ["commit", "-qm", "t-123abc cmd behavior with project test marker"]);
    record(repo, baseSha, ["src", "test"]);

    const result = await runVerify({ workspaceRoot: repo, agent: "worker" });

    expect(result.verdict).toBe("accept");
    expect(result.blockers.map((blocker) => blocker.code)).not.toContain("test_suppression");
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
      expect.objectContaining({ code: "scope_breach", file: "README.md", blocking: false, waiver }),
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

  it("falls back to any outgoing doorbell event when the Delivery contract has no delegator", async () => {
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
    identity: {
      firstOccupant: "worker",
      currentOccupant: "worker",
      occupants: ["worker"],
      deliveryId: "d-fake",
      segmentId: "seg-0",
      segmentIndex: 0,
    },
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

  it("fails visibly when canonical verification has no Workspace-owned lease service", async () => {
    const mcp = wireVerifyTaskTool("/does/not/matter", { kind: "legacy" }, false);
    const res = await callVerifyTaskTool(mcp, { delivery_id: "d-canonical" });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain("canonical Delivery verification is unavailable");
    expect(verifyTask).not.toHaveBeenCalled();
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
    const res = await callVerifyTaskTool(mcp, { delivery_id: "d-worker" });

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
    const res = await callVerifyTaskTool(mcp, { delivery_id: "d-worker", waivers: [waiver] });

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
    const res = await callVerifyTaskTool(mcp, { delivery_id: "d-worker" });

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
    const subject = deliveryVerificationSubject(delivery({
      segments: [
        segment({ id: "seg-0", index: 0, executionAgent: "worker", ...closed }),
        segment({ id: "seg-1", index: 1, executionAgent: "fixer", role: "fixer" }),
      ],
    }));

    expect(subject).toMatchObject({
      deliveryId: "d-identity",
      occupants: ["worker", "fixer"],
      currentSegment: { id: "seg-1", index: 1, executionAgent: "fixer" },
    });
    expect(subject.contract.owns).toEqual(["src"]);
    expect(subject.contract.baseSha).toBe("a".repeat(40));
  });

  it("refuses a Delivery with no segments instead of inventing an occupant", () => {
    expect(() => deliveryVerificationSubject(delivery({ segments: [] })))
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
