import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readLatestDelegationRecord, type DelegationRecord } from "./delegationRecord.js";
import { hasDoorbellRung } from "./doorbell.js";
import { CONFIG_FILENAMES, loadConfigFile, type TachyonConfig } from "../config/loadConfig.js";

const execFileP = promisify(execFile);
const VERIFIER_VERSION = "363-phase1";
/** spec 363 T3 — exported so primer.ts falls back to the same default verify_task uses. */
export const DEFAULT_FULL_VERIFY = "npm test";
const NO_MATCH_EXIT_CODE = 86;

export interface VerifyTaskWaiver {
  finding: string;
  reason: string;
  cites?: string;
}

export interface VerifyTaskBlocker {
  code: string;
  detail: string;
  file?: string;
  /** spec 363 T1 — omitted (or true) blocks the verdict, same as every finding before this field existed;
   *  false surfaces as a FINDING only (e.g. protocol_doorbell_missed) and never flips accept to blocked. */
  blocking?: boolean;
}

export interface VerifyTaskCommand {
  name: string;
  cwd: string;
  command: string;
  argv: string[];
  exitCode: number;
  stdout?: string;
  stderr?: string;
}

export interface VerifyTaskRecord {
  refSha: string;
  treeSha: string;
  baseSha: string;
  taskRef: string;
  agent: string;
  taskId?: string;
  verifierVersion: string;
  commands: VerifyTaskCommand[];
  findings: VerifyTaskBlocker[];
  waivers: VerifyTaskWaiver[];
  verdict: "accept" | "blocked";
  at: string;
  integrityHash: string;
}

export interface VerifyTaskResult {
  verdict: "accept" | "blocked";
  blockers: VerifyTaskBlocker[];
  record: VerifyTaskRecord;
  recordPath: string;
}

export type VerifyTaskInput = {
  workspaceRoot: string;
  agent: string;
  full?: boolean;
  waivers?: VerifyTaskWaiver[];
  isAgentRunning?: (agent: string) => Promise<boolean>;
  withWorktreeLock?: <T>(agent: string, fn: () => Promise<T>) => Promise<T>;
  verifySettings?: TachyonConfig["settings"]["verify"];
  runner?: VerifyTaskRunner;
};

export interface CommandResult {
  command: string;
  argv: string[];
  exitCode: number;
  stdout: string;
  stderr: string;
  observedTestNames?: string[];
}

export type VerifyTaskRunner = (cwd: string, argv: string[], opts?: { timeout?: number }) => Promise<CommandResult>;

async function runArgv(cwd: string, argv: string[], opts: { timeout?: number } = {}): Promise<CommandResult> {
  const [file, ...args] = argv;
  const command = argv.join(" ");
  if (!file) return { command, argv, exitCode: 1, stdout: "", stderr: "empty command" };
  try {
    const { stdout, stderr } = await execFileP(file, args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      timeout: opts.timeout ?? 120_000,
    });
    return { command, argv, exitCode: 0, stdout, stderr };
  } catch (err) {
    const e = err as Error & { code?: number; stdout?: string; stderr?: string };
    return { command, argv, exitCode: typeof e.code === "number" ? e.code : 1, stdout: e.stdout ?? "", stderr: e.stderr ?? e.message };
  }
}

async function git(cwd: string, args: string[], opts: { okExitCodes?: number[] } = {}): Promise<CommandResult> {
  const okExitCodes = opts.okExitCodes ?? [0];
  try {
    const { stdout, stderr } = await execFileP("git", args, { cwd, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
    return { command: `git ${args.join(" ")}`, argv: ["git", ...args], exitCode: 0, stdout, stderr };
  } catch (err) {
    const e = err as Error & { code?: number; stdout?: string; stderr?: string };
    const exitCode = typeof e.code === "number" ? e.code : 1;
    if (okExitCodes.includes(exitCode)) {
      return { command: `git ${args.join(" ")}`, argv: ["git", ...args], exitCode, stdout: e.stdout ?? "", stderr: e.stderr ?? e.message };
    }
    throw new Error(`git ${args.join(" ")} failed: ${(e.stderr ?? e.message).trim()}`);
  }
}

type BehaviorCommand = { argv: string[]; mode: "cmd" | "vitest-name" };
type VitestSummary = { total: number; passed: number; failed: number; pending: number; names: string[] };

function parseCmdBehavior(behaviorTest: string): BehaviorCommand {
  const explicit = behaviorTest.match(/^cmd:\s*(.+)$/s)?.[1];
  if (!explicit) return { argv: ["npm", "test", "--", "--run", "-t", behaviorTest, "--reporter=json"], mode: "vitest-name" };
  const argv = explicit.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((part) => part.replace(/^(['"])(.*)\1$/, "$2")) ?? [];
  return { argv, mode: "cmd" };
}

function parseCommandLine(command: string): string[] {
  return command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((part) => part.replace(/^(['"])(.*)\1$/, "$2")) ?? [];
}

async function runBehavior(cwd: string, behaviorTest: string, runner: VerifyTaskRunner): Promise<CommandResult> {
  const behavior = parseCmdBehavior(behaviorTest);
  const result = await runner(cwd, behavior.argv, { timeout: 120_000 });
  if (behavior.mode !== "vitest-name") return result;
  return normalizeVitestNameFilterResult(result, behaviorTest);
}

function collectVitestNames(value: unknown, out: string[] = []): string[] {
  if (!value || typeof value !== "object") return out;
  if (Array.isArray(value)) {
    for (const item of value) collectVitestNames(item, out);
    return out;
  }
  const obj = value as Record<string, unknown>;
  const status = obj.status;
  const fullName = obj.fullName;
  const title = obj.title;
  if (typeof status === "string" && typeof fullName === "string" && fullName.trim()) {
    out.push(fullName);
  }
  if (typeof status === "string" && typeof title === "string" && title.trim()) {
    out.push(title);
  }
  for (const key of ["testResults", "assertionResults", "children", "tests"]) {
    collectVitestNames(obj[key], out);
  }
  return out;
}

function parseVitestJsonReporter(stdout: string): VitestSummary | undefined {
  const trimmed = stdout.trim();
  if (!trimmed) return undefined;
  const candidates = [trimmed, ...trimmed.split(/\r?\n/).filter((line) => line.trim().startsWith("{"))];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as Partial<Record<"numTotalTests" | "numPassedTests" | "numFailedTests" | "numPendingTests", unknown>>;
      const total = typeof parsed.numTotalTests === "number" ? parsed.numTotalTests : undefined;
      const passed = typeof parsed.numPassedTests === "number" ? parsed.numPassedTests : undefined;
      const failed = typeof parsed.numFailedTests === "number" ? parsed.numFailedTests : undefined;
      const pending = typeof parsed.numPendingTests === "number" ? parsed.numPendingTests : undefined;
      if (total !== undefined && passed !== undefined && failed !== undefined && pending !== undefined) {
        return { total, passed, failed, pending, names: [...new Set(collectVitestNames(parsed))] };
      }
    } catch {
      // Keep scanning; npm wrappers can print warnings before the JSON reporter payload.
    }
  }
  return undefined;
}

function exactVitestNameObserved(result: CommandResult, behaviorTest: string): boolean | undefined {
  if (result.observedTestNames) return result.observedTestNames.includes(behaviorTest);
  const summary = parseVitestJsonReporter(result.stdout);
  if (!summary) return undefined;
  return summary.names.includes(behaviorTest);
}

function normalizeVitestNameFilterResult(result: CommandResult, behaviorTest: string): CommandResult {
  const summary = parseVitestJsonReporter(result.stdout);
  if (!summary) {
    if (result.exitCode === 0) {
      return {
        ...result,
        exitCode: NO_MATCH_EXIT_CODE,
        stderr: `plain behaviorTest '${behaviorTest}' did not emit Vitest JSON; use cmd:<command> for non-Vitest behavior verifiers`,
      };
    }
    return result;
  }
  const executed = summary.passed + summary.failed;
  const observedTestNames = summary.names;
  const stdout = `vitest behavior tests: total=${summary.total} executed=${executed} passed=${summary.passed} failed=${summary.failed} pending=${summary.pending}`;
  if (executed === 0) {
    return {
      ...result,
      exitCode: NO_MATCH_EXIT_CODE,
      stdout,
      stderr: `plain behaviorTest '${behaviorTest}' matched no executable Vitest tests`,
      observedTestNames,
    };
  }
  return { ...result, stdout, observedTestNames };
}

function firstLine(s: string | undefined): string | undefined {
  return s?.split(/\r?\n/).find((line) => line.trim())?.trim();
}

function withinOwns(file: string, owns: string[]): boolean {
  const norm = file.replace(/\\/g, "/");
  return owns.some((own) => {
    const o = own.replace(/\\/g, "/").replace(/\/+$/, "");
    return norm === o || norm.startsWith(`${o}/`);
  });
}

/**
 * t-815796 — segmented scope check. A delegation with no `fixerAttempts` checks every changed file
 * (baseSha..refSha) against `record.owns`, exactly as before this change (byte-identical blockers).
 * A delegation WITH fixer rounds instead checks each commit range against the authority that actually
 * applied to it: the original agent's commits (baseSha..first grant's branchHeadAtGrant) against
 * `record.owns`, and each fixer round's own commits (its grant's branchHeadAtGrant..the next grant's, or
 * ..refSha for the last round) against THAT round's `requestedOwnsSubset` — falling back to `record.owns`
 * when a round's subset was omitted/empty (matching the grant-time rule that an omitted subset is not a
 * narrower authority, just an unrestricted one). Without this, a fixer granted a deliberately narrow
 * subset could commit anywhere within the original, wider `owns` and still pass unnoticed.
 */
async function scopeBreachBlockers(
  record: DelegationRecord,
  refSha: string,
  gitDiffNameOnly: (from: string, to: string) => Promise<string[]>,
): Promise<VerifyTaskBlocker[]> {
  const attempts = record.fixerAttempts ?? [];
  const blockers: VerifyTaskBlocker[] = [];

  if (attempts.length === 0) {
    if (record.owns.length === 0) return blockers;
    for (const file of await gitDiffNameOnly(record.baseSha, refSha)) {
      if (!withinOwns(file, record.owns)) blockers.push({ code: "scope_breach", detail: `changed file is outside declared owns paths`, file });
    }
    return blockers;
  }

  const boundaries = [record.baseSha, ...attempts.map((a) => a.branchHeadAtGrant), refSha];
  for (let i = 0; i < boundaries.length - 1; i++) {
    const from = boundaries[i];
    const to = boundaries[i + 1];
    if (from === to) continue; // no commits landed in this segment
    const isOriginalSegment = i === 0;
    const owns = isOriginalSegment ? record.owns : attempts[i - 1].requestedOwnsSubset.length > 0 ? attempts[i - 1].requestedOwnsSubset : record.owns;
    if (owns.length === 0) continue;
    const segmentLabel = isOriginalSegment ? `original delegation scope (${from}..${to})` : `fixer attempt ${i} (${attempts[i - 1].occupantAgent}) scope (${from}..${to})`;
    for (const file of await gitDiffNameOnly(from, to)) {
      if (!withinOwns(file, owns)) blockers.push({ code: "scope_breach", detail: `changed file is outside declared owns paths for ${segmentLabel}`, file });
    }
  }
  return blockers;
}

function isSuppressionPath(file: string): boolean {
  const f = file.replace(/\\/g, "/");
  return (
    f === "vitest.config.ts" ||
    f === "vitest.config.js" ||
    f.startsWith("test/") ||
    f.startsWith("tests/") ||
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(f)
  );
}

function suppressionFindings(nameStatus: string, patch: string): VerifyTaskBlocker[] {
  const findings: VerifyTaskBlocker[] = [];
  for (const line of nameStatus.split(/\r?\n/).filter(Boolean)) {
    const [status, ...rest] = line.split(/\t/);
    const file = rest[rest.length - 1];
    if (!file || !isSuppressionPath(file)) continue;
    if (status.startsWith("D")) findings.push({ code: "test_deleted", detail: `test file deleted: ${file}`, file });
    if (status.startsWith("R")) findings.push({ code: "test_renamed", detail: `test file renamed: ${rest.join(" -> ")}`, file });
    if (/^vitest\.config\.[cm]?[jt]s$/.test(file)) findings.push({ code: "test_config_changed", detail: `test config changed: ${file}`, file });
  }
  let currentFile: string | undefined;
  for (const line of patch.split(/\r?\n/)) {
    const fileMatch = line.match(/^\+\+\+ b\/(.+)$/);
    if (fileMatch) currentFile = fileMatch[1];
    if (!line.startsWith("+") || line.startsWith("+++")) continue;
    if (/\b(?:describe|it|test)\.(?:skip|only)\b|\b(?:xit|xdescribe|xfail)\b/.test(line)) {
      findings.push({
        code: "test_suppression",
        detail: `suppression marker added: ${line.slice(1).trim()}`,
        ...(currentFile ? { file: currentFile } : {}),
      });
    }
  }
  return findings;
}

function canonicalBehaviorStubFindings(record: DelegationRecord, nameStatus: string): VerifyTaskBlocker[] {
  if (!record.stubPath) return [];
  const findings: VerifyTaskBlocker[] = [];
  for (const line of nameStatus.split(/\r?\n/).filter(Boolean)) {
    const [status, ...rest] = line.split(/\t/);
    if (!status || rest.length === 0) continue;
    const oldPath = rest[0];
    const newPath = rest[rest.length - 1];
    if (oldPath !== record.stubPath && newPath !== record.stubPath) continue;
    if (status.startsWith("D")) {
      findings.push({ code: "behavior_test_renamed", detail: `canonical behavior test stub was removed: ${record.stubPath}`, file: record.stubPath });
    } else if (status.startsWith("R")) {
      findings.push({ code: "behavior_test_renamed", detail: `canonical behavior test stub was renamed: ${rest.join(" -> ")}`, file: record.stubPath });
    }
  }
  return findings;
}

function waiveFindings(findings: VerifyTaskBlocker[], waivers: VerifyTaskWaiver[]): VerifyTaskBlocker[] {
  return findings.filter((finding) => {
    const waiver = waivers.find((w) => w.reason.trim() && (w.finding === finding.code || w.finding === finding.detail || w.finding === finding.file));
    return !waiver;
  });
}

function recordWithHash(record: Omit<VerifyTaskRecord, "integrityHash">): VerifyTaskRecord {
  const body = JSON.stringify(record, null, 2);
  return { ...record, integrityHash: crypto.createHash("sha256").update(body).digest("hex") };
}

function writeVerificationRecord(workspaceRoot: string, record: VerifyTaskRecord): string {
  const dir = path.join(workspaceRoot, ".tachyon", "verifications");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${record.refSha}.json`);
  fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  return file;
}

async function worktreePathForRef(workspaceRoot: string, taskRef: string): Promise<string | undefined> {
  const list = (await git(workspaceRoot, ["worktree", "list", "--porcelain"])).stdout;
  let wt: string | undefined;
  let branch: string | undefined;
  for (const line of `${list}\n`.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) wt = line.slice("worktree ".length);
    else if (line.startsWith("branch ")) branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
    else if (!line.trim()) {
      if (wt && branch === taskRef) return wt;
      wt = undefined;
      branch = undefined;
    }
  }
  return undefined;
}

async function runAtSha<T>(worktreePath: string, taskRef: string, sha: string, fn: () => Promise<T>): Promise<T> {
  await git(worktreePath, ["checkout", "--detach", "--force", sha]);
  try {
    return await fn();
  } finally {
    await git(worktreePath, ["reset", "--hard"]);
    await git(worktreePath, ["clean", "-fd"]);
    await git(worktreePath, ["checkout", "--force", taskRef]);
  }
}

async function runBehaviorAtSha(worktreePath: string, taskRef: string, sha: string, behaviorTest: string, runner: VerifyTaskRunner): Promise<CommandResult> {
  return runAtSha(worktreePath, taskRef, sha, () => runBehavior(worktreePath, behaviorTest, runner));
}

async function runBehaviorInCurrentCheckout(worktreePath: string, behaviorTest: string, runner: VerifyTaskRunner): Promise<CommandResult> {
  return runBehavior(worktreePath, behaviorTest, runner);
}

function commandRecord(name: string, cwd: string, result: CommandResult): VerifyTaskCommand {
  return {
    name,
    cwd,
    command: result.command,
    argv: result.argv,
    exitCode: result.exitCode,
    ...(firstLine(result.stdout) ? { stdout: firstLine(result.stdout) } : {}),
    ...(firstLine(result.stderr) ? { stderr: firstLine(result.stderr) } : {}),
  };
}

/** spec 363 T3 — exported so primer.ts renders the SAME verify commands verify_task enforces
 *  (single source of truth: one config read, not a second copy of the CONFIG_FILENAMES scan). */
export function loadVerifySettings(workspaceRoot: string): TachyonConfig["settings"]["verify"] {
  for (const name of CONFIG_FILENAMES) {
    const file = path.join(workspaceRoot, name);
    if (!fs.existsSync(file)) continue;
    const parsed = loadConfigFile(file);
    if (parsed.errors.length > 0) throw new Error(`cannot load ${name} for verify_task: ${parsed.errors.join("; ")}`);
    return parsed.config?.settings.verify;
  }
  return undefined;
}

async function runTieredTestsInCurrentCheckout(input: {
  worktreePath: string;
  changed: string[];
  settings: TachyonConfig["settings"]["verify"] | undefined;
  full: boolean;
  fullCommand: string;
  runner: VerifyTaskRunner;
  commands: VerifyTaskCommand[];
  blockers: VerifyTaskBlocker[];
}): Promise<void> {
  if (input.settings?.typecheck) {
    const typecheck = await input.runner(input.worktreePath, parseCommandLine(input.settings.typecheck), { timeout: 300_000 });
    input.commands.push(commandRecord("typecheck", input.worktreePath, typecheck));
    if (typecheck.exitCode !== 0) {
      input.blockers.push({ code: "typecheck_failed", detail: `typecheck failed: ${firstLine(typecheck.stderr) ?? firstLine(typecheck.stdout) ?? input.settings.typecheck}` });
    }
  }

  const existingChanged = input.changed.filter((file) => fs.existsSync(path.join(input.worktreePath, file)));
  const relatedArgv = ["npx", "vitest", "related", "--run", ...existingChanged];
  const related = await input.runner(input.worktreePath, relatedArgv, { timeout: 300_000 });
  input.commands.push(commandRecord("affected_tests", input.worktreePath, related));
  if (related.exitCode !== 0) {
    input.blockers.push({ code: "affected_tests_failed", detail: `affected tests failed: ${firstLine(related.stderr) ?? firstLine(related.stdout) ?? related.command}` });
  }

  if (input.full) {
    const full = await input.runner(input.worktreePath, parseCommandLine(input.fullCommand), { timeout: 600_000 });
    input.commands.push(commandRecord("full_tests", input.worktreePath, full));
    if (full.exitCode !== 0) {
      input.blockers.push({ code: "full_tests_failed", detail: `full verify failed: ${firstLine(full.stderr) ?? firstLine(full.stdout) ?? input.fullCommand}` });
    }
  }
}

export async function verifyTask(input: VerifyTaskInput): Promise<VerifyTaskResult> {
  const loaded = readLatestDelegationRecord(input.workspaceRoot, input.agent);
  if (!loaded) throw new Error(`no delegation record found for agent '${input.agent}'`);
  const record: DelegationRecord = loaded.record;
  const waivers = input.waivers ?? [];
  const blockers: VerifyTaskBlocker[] = [];
  const commands: VerifyTaskCommand[] = [];
  const runner = input.runner ?? runArgv;
  const verifySettings = input.verifySettings ?? loadVerifySettings(input.workspaceRoot);

  const refSha = (await git(input.workspaceRoot, ["rev-parse", record.taskRef])).stdout.trim();
  const treeSha = (await git(input.workspaceRoot, ["rev-parse", `${refSha}^{tree}`])).stdout.trim();
  const noCommit = refSha === record.baseSha;
  if (noCommit) blockers.push({ code: "no_commit", detail: `task ref ${record.taskRef} is still at baseSha ${record.baseSha}` });

  const changed = (await git(input.workspaceRoot, ["diff", "--name-only", `${record.baseSha}..${refSha}`])).stdout.split(/\r?\n/).filter(Boolean);
  if (changed.length === 0) blockers.push({ code: "no_changed_files", detail: `no files changed between baseSha and ${refSha}` });
  if (record.taskId) {
    const messages = (await git(input.workspaceRoot, ["log", "--format=%B", `${record.baseSha}..${refSha}`])).stdout;
    if (!messages.includes(record.taskId)) blockers.push({ code: "task_id_missing", detail: `no commit message between baseSha and refSha mentions task id ${record.taskId}` });
  }
  const gitDiffNameOnly = async (from: string, to: string): Promise<string[]> =>
    (await git(input.workspaceRoot, ["diff", "--name-only", `${from}..${to}`])).stdout.split(/\r?\n/).filter(Boolean);
  blockers.push(...(await scopeBreachBlockers(record, refSha, gitDiffNameOnly)));

  const wtPath = await worktreePathForRef(input.workspaceRoot, record.taskRef);
  let canRunBehavior = !noCommit;
  if (!wtPath) {
    blockers.push({ code: "worktree_missing", detail: `task ref ${record.taskRef} is not checked out in an isolated worktree` });
    canRunBehavior = false;
  }

  if (wtPath) {
    const withWorktreeLock = input.withWorktreeLock ?? (async <T>(_agent: string, fn: () => Promise<T>): Promise<T> => fn());
    await withWorktreeLock(record.agent, async () => {
      if (await input.isAgentRunning?.(record.agent)) {
        blockers.push({ code: "agent_still_running", detail: `agent '${record.agent}' is still running; stop it before verify_task mutates its worktree for the behavior check` });
        canRunBehavior = false;
      }
      const status = (await git(wtPath, ["status", "--porcelain"])).stdout.trim();
      if (status) {
        blockers.push({ code: "dirty_worktree", detail: `agent worktree has uncommitted changes`, file: wtPath });
        canRunBehavior = false;
      }
      if (!canRunBehavior) return;

      const blockersBeforeTiered = blockers.length;
      const fullCommand = verifySettings?.full ?? DEFAULT_FULL_VERIFY;
      await runAtSha(wtPath, record.taskRef, refSha, async () => {
        await runTieredTestsInCurrentCheckout({
          worktreePath: wtPath,
          changed,
          settings: verifySettings,
          full: input.full === true,
          fullCommand,
          runner,
          commands,
          blockers,
        });

        if (blockers.length > blockersBeforeTiered) return;
        const headRun = await runBehaviorInCurrentCheckout(wtPath, record.behaviorTest, runner);
        commands.push(commandRecord("behavior_head_expect_pass", wtPath, headRun));
        if (record.stubPath && exactVitestNameObserved(headRun, record.behaviorTest) === false) {
          blockers.push({
            code: "behavior_test_renamed",
            detail: `canonical behavior test '${record.behaviorTest}' was not observed in ${record.stubPath}`,
            file: record.stubPath,
          });
        }
        if (headRun.exitCode !== 0) {
          blockers.push({
            code: "behavior_failed",
            detail: `behaviorTest failed at refSha ${refSha}: ${firstLine(headRun.stderr) ?? firstLine(headRun.stdout) ?? record.behaviorTest}`,
          });
        }
      });

      if (blockers.length > blockersBeforeTiered && !blockers.some((b) => b.code === "behavior_failed")) {
        blockers.push({ code: "behavior_not_run", detail: "behavior verifier skipped because a cheaper tier already blocked verification" });
        return;
      }

      const baseRun = await runBehaviorAtSha(wtPath, record.taskRef, record.baseSha, record.behaviorTest, runner);
      commands.push(commandRecord("behavior_base_expect_fail", wtPath, baseRun));
      if (baseRun.exitCode === 0) blockers.push({ code: "behavior_already_passed", detail: `behaviorTest passed at baseSha and proves no delivered change: ${record.behaviorTest}` });
    });
  }

  if (!wtPath || !canRunBehavior) {
    blockers.push({ code: "behavior_not_run", detail: "behavior verifier requires the agent worktree to exist and be clean" });
  }

  const nameStatus = (await git(input.workspaceRoot, ["diff", "--name-status", `${record.baseSha}..${refSha}`])).stdout;
  const patch = (await git(input.workspaceRoot, ["diff", `${record.baseSha}..${refSha}`])).stdout;
  blockers.push(...canonicalBehaviorStubFindings(record, nameStatus));
  const unwaivedSuppression = waiveFindings(suppressionFindings(nameStatus, patch), waivers);
  blockers.push(...unwaivedSuppression);

  // spec 363 T1 — Bridge-witnessed doorbell check: non-blocking, so it never flips an otherwise-green
  // verdict to blocked (ratified Decision 2). Runs regardless of the git-side checks above.
  if (!hasDoorbellRung(input.workspaceRoot, record.agent, record.delegator, record.createdAt)) {
    blockers.push({
      code: "protocol_doorbell_missed",
      detail: `no notify_agent(to: '${record.delegator ?? "<delegator>"}') event recorded from '${record.agent}' since ${record.createdAt}`,
      blocking: false,
    });
  }

  const blockingFindings = blockers.filter((b) => b.blocking !== false);
  const verdict = blockingFindings.length === 0 ? "accept" : "blocked";
  const verification = recordWithHash({
    refSha,
    treeSha,
    baseSha: record.baseSha,
    taskRef: record.taskRef,
    agent: record.agent,
    ...(record.taskId ? { taskId: record.taskId } : {}),
    verifierVersion: VERIFIER_VERSION,
    commands,
    findings: blockers,
    waivers,
    verdict,
    at: new Date().toISOString(),
  });
  const recordPath = writeVerificationRecord(input.workspaceRoot, verification);
  return { verdict, blockers: blockingFindings, record: verification, recordPath };
}
