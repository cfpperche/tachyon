import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readLatestDelegationRecord, type DelegationRecord } from "./delegationRecord.js";

const execFileP = promisify(execFile);
const VERIFIER_VERSION = "362-phase1-t2";

export interface VerifyTaskWaiver {
  finding: string;
  reason: string;
  cites?: string;
}

export interface VerifyTaskBlocker {
  code: string;
  detail: string;
  file?: string;
}

export interface VerifyTaskCommand {
  name: string;
  cwd: string;
  command: string;
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

interface CommandResult {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function git(cwd: string, args: string[], opts: { okExitCodes?: number[] } = {}): Promise<CommandResult> {
  const okExitCodes = opts.okExitCodes ?? [0];
  try {
    const { stdout, stderr } = await execFileP("git", args, { cwd, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
    return { command: `git ${args.join(" ")}`, exitCode: 0, stdout, stderr };
  } catch (err) {
    const e = err as Error & { code?: number; stdout?: string; stderr?: string };
    const exitCode = typeof e.code === "number" ? e.code : 1;
    if (okExitCodes.includes(exitCode)) {
      return { command: `git ${args.join(" ")}`, exitCode, stdout: e.stdout ?? "", stderr: e.stderr ?? e.message };
    }
    throw new Error(`git ${args.join(" ")} failed: ${(e.stderr ?? e.message).trim()}`);
  }
}

async function runBehavior(cwd: string, behaviorTest: string): Promise<CommandResult> {
  const explicit = behaviorTest.match(/^cmd:\s*(.+)$/s)?.[1];
  const cmd = explicit ? explicit.trim() : `npm test -- --run -t ${JSON.stringify(behaviorTest)}`;
  try {
    const { stdout, stderr } = await execFileP("sh", ["-lc", cmd], { cwd, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: 120_000 });
    return { command: cmd, exitCode: 0, stdout, stderr };
  } catch (err) {
    const e = err as Error & { code?: number; stdout?: string; stderr?: string };
    return { command: cmd, exitCode: typeof e.code === "number" ? e.code : 1, stdout: e.stdout ?? "", stderr: e.stderr ?? e.message };
  }
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

async function withTempWorktree<T>(workspaceRoot: string, sha: string, fn: (cwd: string) => Promise<T>): Promise<T> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-verify-task-"));
  try {
    await git(workspaceRoot, ["worktree", "add", "--detach", "--quiet", tmp, sha]);
    return await fn(tmp);
  } finally {
    try {
      await git(workspaceRoot, ["worktree", "remove", "--force", tmp], { okExitCodes: [0, 128] });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
}

async function runBehaviorInTemp(workspaceRoot: string, sha: string, behaviorTest: string): Promise<{ cwd: string; result: CommandResult }> {
  return withTempWorktree(workspaceRoot, sha, async (cwd) => ({ cwd, result: await runBehavior(cwd, behaviorTest) }));
}

function commandRecord(name: string, cwd: string, result: CommandResult): VerifyTaskCommand {
  return {
    name,
    cwd,
    command: result.command,
    exitCode: result.exitCode,
    ...(firstLine(result.stdout) ? { stdout: firstLine(result.stdout) } : {}),
    ...(firstLine(result.stderr) ? { stderr: firstLine(result.stderr) } : {}),
  };
}

export async function verifyTask(input: { workspaceRoot: string; agent: string; waivers?: VerifyTaskWaiver[] }): Promise<VerifyTaskResult> {
  const loaded = readLatestDelegationRecord(input.workspaceRoot, input.agent);
  if (!loaded) throw new Error(`no delegation record found for agent '${input.agent}'`);
  const record: DelegationRecord = loaded.record;
  const waivers = input.waivers ?? [];
  const blockers: VerifyTaskBlocker[] = [];
  const commands: VerifyTaskCommand[] = [];

  const refSha = (await git(input.workspaceRoot, ["rev-parse", record.taskRef])).stdout.trim();
  const treeSha = (await git(input.workspaceRoot, ["rev-parse", `${refSha}^{tree}`])).stdout.trim();
  if (refSha === record.baseSha) blockers.push({ code: "no_commit", detail: `task ref ${record.taskRef} is still at baseSha ${record.baseSha}` });

  const wtPath = await worktreePathForRef(input.workspaceRoot, record.taskRef);
  if (!wtPath) {
    blockers.push({ code: "worktree_missing", detail: `task ref ${record.taskRef} is not checked out in an isolated worktree` });
  } else {
    const status = (await git(wtPath, ["status", "--porcelain"])).stdout.trim();
    if (status) blockers.push({ code: "dirty_worktree", detail: `agent worktree has uncommitted changes`, file: wtPath });
  }

  const changed = (await git(input.workspaceRoot, ["diff", "--name-only", `${record.baseSha}..${refSha}`])).stdout.split(/\r?\n/).filter(Boolean);
  if (changed.length === 0) blockers.push({ code: "no_changed_files", detail: `no files changed between baseSha and ${refSha}` });
  if (record.taskId) {
    const messages = (await git(input.workspaceRoot, ["log", "--format=%B", `${record.baseSha}..${refSha}`])).stdout;
    if (!messages.includes(record.taskId)) blockers.push({ code: "task_id_missing", detail: `no commit message between baseSha and refSha mentions task id ${record.taskId}` });
  }
  if (record.owns.length === 0) {
    blockers.push({ code: "owns_missing", detail: "delegation record has no declared owns paths" });
  } else {
    for (const file of changed) {
      if (!withinOwns(file, record.owns)) blockers.push({ code: "scope_breach", detail: `changed file is outside declared owns paths`, file });
    }
  }

  const baseRun = await runBehaviorInTemp(input.workspaceRoot, record.baseSha, record.behaviorTest);
  commands.push(commandRecord("behavior_base_expect_fail", baseRun.cwd, baseRun.result));
  if (baseRun.result.exitCode === 0) blockers.push({ code: "behavior_already_passed", detail: `behaviorTest passed at baseSha and proves no delivered change: ${record.behaviorTest}` });

  const headRun = await runBehaviorInTemp(input.workspaceRoot, refSha, record.behaviorTest);
  commands.push(commandRecord("behavior_head_expect_pass", headRun.cwd, headRun.result));
  if (headRun.result.exitCode !== 0) {
    blockers.push({
      code: "behavior_failed",
      detail: `behaviorTest failed at refSha ${refSha}: ${firstLine(headRun.result.stderr) ?? firstLine(headRun.result.stdout) ?? record.behaviorTest}`,
    });
  }

  const nameStatus = (await git(input.workspaceRoot, ["diff", "--name-status", `${record.baseSha}..${refSha}`])).stdout;
  const patch = (await git(input.workspaceRoot, ["diff", `${record.baseSha}..${refSha}`])).stdout;
  const unwaivedSuppression = waiveFindings(suppressionFindings(nameStatus, patch), waivers);
  blockers.push(...unwaivedSuppression);

  const verdict = blockers.length === 0 ? "accept" : "blocked";
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
  return { verdict, blockers, record: verification, recordPath };
}
