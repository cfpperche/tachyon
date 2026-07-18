import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import {
  DeliveryIdentityError,
  deliveryVerificationSubject,
  type DeliveryVerificationSubject,
} from "../delivery/verificationSubject.js";
import { hasDoorbellRung } from "./doorbell.js";
import { CONFIG_FILENAMES, loadConfigFile, type TachyonConfig } from "../config/loadConfig.js";
import type { CallerSnapshot } from "./callerIdentity.js";
import { decideHeavyGate } from "../host/hostResources.js";
import type { Delivery, DeliveryContract } from "../delivery/types.js";
import type { DeliveryVerificationContext, DeliveryVerificationLeaseService, PreparedDeliveryVerification } from "../delivery/verificationLease.js";
import { parseArgvCommand } from "../config/argvCommand.js";
import { parseNameStatus, type ChangedFile } from "../worktree/review.js";
import { behaviorStubPathError, configuredBehaviorStubPath } from "../config/behaviorVerification.js";

const execFileP = promisify(execFile);
const VERIFIER_VERSION = "385-project-owned-verifiers";
/** spec 385 — retained as an exported compatibility symbol to make the absence of a product-global
 * package-manager default explicit. Full verification now requires settings.verify.full. */
export const DEFAULT_FULL_VERIFY: undefined = undefined;
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
  waiver?: VerifyTaskWaiver;
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
  timedOut?: boolean;
  signal?: string;
  stdout?: string;
  stderr?: string;
}

export interface VerifyTaskBehaviorEvidence {
  identifier: string;
  mode: "cmd" | "vitest-name" | "unconfigured";
  prepare?: string;
  /** Exact project adapter snapshot used for this proof; omitted for runner-neutral cmd: gates. */
  adapter?: NonNullable<NonNullable<TachyonConfig["settings"]["verify"]>["behavior"]>;
  stubPath?: string;
  oracleHash?: string;
  executorHashes?: Record<string, string>;
  baseAssertions: VitestAssertionObservation[];
  headAssertions: VitestAssertionObservation[];
}

/** F3 — who this verification is about, bound into the record (and therefore into its integrity hash).
 *  A bare refSha says only "some commit was verified"; two Deliveries can land the same tree at the same
 *  SHA, and a record that names neither the Delivery nor the segment cannot tell them apart afterwards. */
export interface VerifyTaskIdentity {
  /** The first Delivery segment's occupant. */
  firstOccupant: string;
  /** The current tail segment occupant this verification acted on. */
  currentOccupant: string;
  /** Every Delivery segment occupant in chronological order. */
  occupants: string[];
  deliveryId: string;
  segmentId: string;
  segmentIndex: number;
}

export interface VerifyTaskRecord {
  refSha: string;
  treeSha: string;
  baseSha: string;
  taskRef: string;
  /** The operational identity the verifier acted on (`identity.canonical`); kept for compatibility. */
  agent: string;
  identity: VerifyTaskIdentity;
  taskId?: string;
  verifierVersion: string;
  commands: VerifyTaskCommand[];
  /** Oracle/adapter/assertion facts covered by integrityHash. */
  behaviorEvidence?: VerifyTaskBehaviorEvidence;
  findings: VerifyTaskBlocker[];
  waivers: VerifyTaskWaiver[];
  verdict: "accept" | "blocked";
  at: string;
  /** t-7acc58 — the Bridge-resolved caller that made THIS verify_task call (spec 351 pattern), recorded
   *  for after-the-fact attribution and hashed with the rest of the record so it can't be edited post hoc.
   *  Defaults to {kind:"legacy"} when the Bridge doesn't thread a resolved caller (direct verifyTask() calls). */
  verifierCaller: { kind: CallerSnapshot["kind"]; name?: string };
  integrityHash: string;
}

export interface VerifyTaskResult {
  verdict: "accept" | "blocked";
  blockers: VerifyTaskBlocker[];
  /** t-7acc58 — every finding a coordinator waiver suppressed, surfaced at the top level so a caller
   *  checking verdict/blockers at a glance can't miss that a waiver was applied without reading record.findings. */
  waivedFindings: VerifyTaskBlocker[];
  record: VerifyTaskRecord;
  recordPath: string;
}

export type VerifyTaskInput = {
  workspaceRoot: string;
  /** Required canonical identity. No agent-name or worktree inference is performed. */
  deliveryId: string;
  full?: boolean;
  waivers?: VerifyTaskWaiver[];
  verifySettings?: TachyonConfig["settings"]["verify"];
  runner?: VerifyTaskRunner;
  /** t-7acc58 — the Bridge-resolved caller for this verification (spec 351 pattern); recorded on the
   *  record for attribution. Omitted -> {kind:"legacy"}, matching every other deps.caller consumer in tools.ts. */
  verifierCaller?: { kind: CallerSnapshot["kind"]; name?: string };
  /** Workspace-owned canonical verification lifecycle service. */
  deliveryVerification: DeliveryVerificationLeaseService;
};

export type VerifyTaskErrorCode =
  | "DELIVERY_VERIFICATION_REQUIRED"
  | "DELIVERY_NOT_FOUND"
  | "DELIVERY_SEGMENTS_MISSING"
  | "DELIVERY_IDENTITY_AMBIGUOUS"
  | "SELF_WAIVER_FORBIDDEN"
  | "VERIFICATION_RECORD_CONFLICT";

/** Base for every verify_task refusal the Bridge surfaces as structuredContent. */
export class VerifyTaskStructuredError extends Error {
  constructor(
    readonly code: VerifyTaskErrorCode,
    message: string,
    readonly candidates: Array<{ id?: string; path: string }> = [],
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class VerifyTaskResolutionError extends VerifyTaskStructuredError {}
/** F1 — an occupant tried to waive findings on its own verification. */
export class VerifyTaskWaiverError extends VerifyTaskStructuredError {}
/** F3 — a different verification already owns this record path; refuse rather than overwrite it. */
export class VerifyTaskRecordConflictError extends VerifyTaskStructuredError {}

/** The resolved subject of a verification: the canonical contract projection the checks run against, plus the
 *  identity those checks (and the waiver guard) must act on. */
interface VerificationRecord extends DeliveryContract {
  agent: string;
  delegator?: string;
  createdAt: string;
}

interface VerificationTarget {
  delivery: Delivery;
  subject: DeliveryVerificationSubject;
  record: VerificationRecord;
  identity: VerifyTaskIdentity;
}

/**
 * F1 — the anti-laundering guard (spec 351 pattern, mirrors request_human_approval): a requester never
 * resolves its own escalation. Verifying your OWN gate is legitimate — that's the normal self-check, and
 * it stays allowed. Waiving findings on it is not: a self-caller could author and apply its own waiver
 * with nobody else ever seeing it.
 *
 * It compares the Bridge-resolved caller against the RESOLVED occupants of the delivery — never against
 * the `agent` argument, which the caller supplies and can therefore set to anyone else's name to slip
 * past a naive `caller.name === agent` check. G2 — EVERY occupant counts, not just the current one
 * (current and original): a Delivery can carry any number of interior fixer/recovery
 * segments between them, and each one's own commits were scope-checked against its own grant, so each one
 * must be checked here too (`identity.occupants`). A coordinator matches none of them and passes, as does
 * any non-agent (legacy-token) caller.
 */
function assertWaiverAuthorized(
  caller: { kind: CallerSnapshot["kind"]; name?: string },
  identity: VerifyTaskIdentity,
  waivers: VerifyTaskWaiver[],
): void {
  if (waivers.length === 0 || caller.kind !== "agent" || !caller.name) return;
  if (!identity.occupants.includes(caller.name)) return;
  throw new VerifyTaskWaiverError(
    "SELF_WAIVER_FORBIDDEN",
    `an agent cannot waive findings on its own verification — waivers are coordinator-authored ` +
      `(caller '${caller.name}' is an occupant of this delivery: ${identity.occupants.join(", ")})`,
  );
}

export interface CommandResult {
  command: string;
  argv: string[];
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
  signal?: string;
  observedTestNames?: string[];
  observedVitestAssertions?: VitestAssertionObservation[];
}

export interface VitestAssertionObservation {
  file?: string;
  title?: string;
  fullName?: string;
  status: string;
}

export type VerifyTaskRunner = (
  cwd: string,
  argv: string[],
  opts?: { timeout?: number; env?: NodeJS.ProcessEnv },
) => Promise<CommandResult>;

async function runArgv(
  cwd: string,
  argv: string[],
  opts: { timeout?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<CommandResult> {
  const [file, ...args] = argv;
  const command = argv.join(" ");
  if (!file) return { command, argv, exitCode: 1, stdout: "", stderr: "empty command" };
  try {
    const { stdout, stderr } = await execFileP(file, args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      timeout: opts.timeout ?? 120_000,
      env: opts.env,
    });
    return { command, argv, exitCode: 0, stdout, stderr };
  } catch (err) {
    const e = err as Error & { code?: number | string | null; stdout?: string; stderr?: string; killed?: boolean; signal?: string };
    return {
      command, argv, exitCode: typeof e.code === "number" ? e.code : 1,
      stdout: e.stdout ?? "", stderr: e.stderr ?? e.message,
      ...(e.code === "ETIMEDOUT" || (e.killed === true && (e.code === null || e.code === undefined))
        ? { timedOut: true }
        : {}),
      ...(e.signal ? { signal: e.signal } : {}),
    };
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

type BehaviorCommand = { argv: string[]; mode: "cmd" | "vitest-name" | "unconfigured"; error?: string };
type VitestSummary = {
  total: number;
  passed: number;
  failed: number;
  pending: number;
  todo: number;
  assertions: VitestAssertionObservation[];
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseCmdBehavior(
  behaviorTest: string,
  settings: TachyonConfig["settings"]["verify"] | undefined,
): BehaviorCommand {
  const explicitMatch = behaviorTest.match(/^cmd:\s*(.*)$/s);
  if (explicitMatch) {
    try {
      return { argv: parseArgvCommand(explicitMatch[1] ?? ""), mode: "cmd" };
    } catch (error) {
      return { argv: [], mode: "unconfigured", error: `invalid cmd: behavior verifier (${error instanceof Error ? error.message : String(error)})` };
    }
  }
  const configured = settings?.behavior;
  if (!configured) return { argv: [], mode: "unconfigured" };
  let prefix: string[];
  try {
    prefix = parseArgvCommand(configured.command);
  } catch (error) {
    return { argv: [], mode: "unconfigured", error: `invalid settings.verify.behavior.command (${error instanceof Error ? error.message : String(error)})` };
  }
  return {
    argv: [...prefix, "--run", "-t", `${escapeRegExp(behaviorTest)}$`, "--reporter=json"],
    mode: "vitest-name",
  };
}

async function runBehavior(
  cwd: string,
  behaviorTest: string,
  settings: TachyonConfig["settings"]["verify"] | undefined,
  runner: VerifyTaskRunner,
): Promise<CommandResult> {
  const behavior = parseCmdBehavior(behaviorTest, settings);
  if (behavior.mode === "unconfigured") {
    return {
      command: "",
      argv: [],
      exitCode: NO_MATCH_EXIT_CODE,
      stdout: "",
      stderr: behavior.error ?? `plain behaviorTest '${behaviorTest}' requires settings.verify.behavior; use cmd:<command> for a runner-neutral verifier`,
    };
  }
  const result = await runner(cwd, behavior.argv, { timeout: 120_000 });
  if (behavior.mode !== "vitest-name") return result;
  return normalizeVitestNameFilterResult(result, behaviorTest);
}

async function runVerificationPrepare(
  cwd: string,
  prepare: string,
  runner: VerifyTaskRunner,
): Promise<CommandResult> {
  let argv: string[];
  try {
    argv = parseArgvCommand(prepare);
  } catch (error) {
    return {
      command: "",
      argv: [],
      exitCode: NO_MATCH_EXIT_CODE,
      stdout: "",
      stderr: `invalid settings.verify.prepare (${error instanceof Error ? error.message : String(error)})`,
    };
  }
  return runner(cwd, argv, { timeout: 600_000 });
}

type VitestReporterParseResult = { summary?: VitestSummary; error?: string };

/** Extract top-level JSON objects without mistaking nested assertion objects for extra reporters. */
function jsonObjectPayloads(stdout: string): unknown[] {
  const payloads: unknown[] = [];
  for (let start = 0; start < stdout.length; start += 1) {
    if (stdout[start] !== "{") continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    let end = start;
    for (; end < stdout.length; end += 1) {
      const character = stdout[end]!;
      if (inString) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') inString = false;
        continue;
      }
      if (character === '"') inString = true;
      else if (character === "{") depth += 1;
      else if (character === "}") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    if (depth !== 0) continue;
    try {
      payloads.push(JSON.parse(stdout.slice(start, end + 1)));
      start = end;
    } catch {
      // A log line may contain a non-JSON brace. Advance one character so nested/later payloads
      // remain discoverable instead of letting malformed prefix text hide the real reporter.
    }
  }
  return payloads;
}

function vitestReportShaped(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const report = value as Record<string, unknown>;
  return ["numTotalTests", "numPassedTests", "numFailedTests", "numPendingTests"]
    .every((key) => Object.hasOwn(report, key));
}

function parseVitestJsonReporter(stdout: string): VitestReporterParseResult {
  const reports = jsonObjectPayloads(stdout).filter(vitestReportShaped);
  if (reports.length === 0) return {};
  if (reports.length !== 1) {
    return { error: `emitted ${reports.length} Vitest JSON reporter-shaped payloads; exactly one is required` };
  }

  const report = reports[0]!;
  const count = (key: string, optional = false): number | undefined => {
    if (optional && !Object.hasOwn(report, key)) return 0;
    const value = report[key];
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  };
  const total = count("numTotalTests");
  const passed = count("numPassedTests");
  const failed = count("numFailedTests");
  const pending = count("numPendingTests");
  const todo = count("numTodoTests", true);
  if ([total, passed, failed, pending, todo].some((value) => value === undefined)) {
    return { error: "emitted a Vitest JSON reporter payload with invalid test counts" };
  }
  if (total !== passed! + failed! + pending! + todo!) {
    return { error: "emitted an inconsistent Vitest JSON reporter payload: total does not equal passed + failed + pending + todo" };
  }
  if (!Array.isArray(report.testResults)) {
    return { error: "emitted an inconsistent Vitest JSON reporter payload: testResults is missing" };
  }

  const assertions: VitestAssertionObservation[] = [];
  const observedCounts = { passed: 0, failed: 0, pending: 0, todo: 0 };
  for (const testResult of report.testResults) {
    if (!testResult || typeof testResult !== "object" || Array.isArray(testResult)) {
      return { error: "emitted an inconsistent Vitest JSON reporter payload: testResults contains a non-object" };
    }
    const result = testResult as Record<string, unknown>;
    if (!Array.isArray(result.assertionResults)) {
      return { error: "emitted an inconsistent Vitest JSON reporter payload: assertionResults is missing" };
    }
    const file = typeof result.name === "string" ? result.name : undefined;
    for (const assertion of result.assertionResults) {
      if (!assertion || typeof assertion !== "object" || Array.isArray(assertion)) {
        return { error: "emitted an inconsistent Vitest JSON reporter payload: assertionResults contains a non-object" };
      }
      const item = assertion as Record<string, unknown>;
      if (typeof item.status !== "string"
        || (item.title !== undefined && typeof item.title !== "string")
        || (item.fullName !== undefined && typeof item.fullName !== "string")) {
        return { error: "emitted an inconsistent Vitest JSON reporter payload: assertion identity/status is invalid" };
      }
      const bucket = item.status === "passed" || item.status === "failed" || item.status === "todo"
        ? item.status
        : item.status === "pending" || item.status === "skipped" || item.status === "disabled"
          ? "pending"
          : undefined;
      if (!bucket) {
        return { error: `emitted an inconsistent Vitest JSON reporter payload: unknown assertion status '${item.status}'` };
      }
      observedCounts[bucket] += 1;
      assertions.push({
        ...(file ? { file } : {}),
        ...(typeof item.title === "string" ? { title: item.title } : {}),
        ...(typeof item.fullName === "string" ? { fullName: item.fullName } : {}),
        status: item.status,
      });
    }
  }
  if (assertions.length !== total
    || observedCounts.passed !== passed
    || observedCounts.failed !== failed
    || observedCounts.pending !== pending
    || observedCounts.todo !== todo) {
    return { error: "emitted an inconsistent Vitest JSON reporter payload: summary counts do not match assertion results" };
  }
  return { summary: { total, passed, failed, pending, todo, assertions } as VitestSummary };
}

function assertionTitleMatches(assertion: VitestAssertionObservation, behaviorTest: string): boolean {
  return assertion.title === behaviorTest || (!assertion.title && assertion.fullName === behaviorTest);
}

function assertionFileMatches(assertion: VitestAssertionObservation, cwd: string, stubPath?: string): boolean {
  if (!stubPath) return true;
  if (!assertion.file) return false;
  const observed = path.isAbsolute(assertion.file)
    ? path.resolve(assertion.file)
    : path.resolve(cwd, assertion.file);
  const expected = path.resolve(cwd, ...stubPath.split("/"));
  // Compare the reporter identity lexically. Realpathing here would let a symlinked canonical
  // stub inherit another file identity; regular-file/containment checks run inside each checkout.
  const canonical = (candidate: string): string =>
    process.platform === "win32" ? path.normalize(candidate).toLowerCase() : path.normalize(candidate);
  return canonical(observed) === canonical(expected);
}

function canonicalBehaviorStubFileFinding(
  cwd: string,
  stubPath: string,
  phase: "baseSha" | "refSha",
): VerifyTaskBlocker | undefined {
  const pathError = behaviorStubPathError(stubPath);
  if (pathError) {
    return {
      code: "behavior_test_renamed",
      detail: `canonical behavior stub has an unsafe recorded path at ${phase}: ${pathError}`,
      file: stubPath,
    };
  }
  let root: string;
  try {
    root = fs.realpathSync.native(cwd);
  } catch (error) {
    return {
      code: "behavior_test_renamed",
      detail: `canonical behavior stub worktree cannot be resolved at ${phase}: ${error instanceof Error ? error.message : String(error)}`,
      file: stubPath,
    };
  }
  let current = root;
  const segments = stubPath.split("/");
  for (let index = 0; index < segments.length; index++) {
    current = path.join(current, segments[index]!);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(current);
    } catch {
      return {
        code: "behavior_test_renamed",
        detail: `canonical behavior stub is missing at ${phase}: ${stubPath}`,
        file: stubPath,
      };
    }
    const leaf = index === segments.length - 1;
    if (stat.isSymbolicLink() || (leaf ? !stat.isFile() : !stat.isDirectory())) {
      return {
        code: "behavior_test_renamed",
        detail: `canonical behavior stub is not a regular non-symlink file at ${phase}: ${stubPath}`,
        file: stubPath,
      };
    }
    let canonical: string;
    try {
      canonical = fs.realpathSync.native(current);
    } catch {
      return {
        code: "behavior_test_renamed",
        detail: `canonical behavior stub cannot be resolved at ${phase}: ${stubPath}`,
        file: stubPath,
      };
    }
    const relative = path.relative(root, canonical);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      return {
        code: "behavior_test_renamed",
        detail: `canonical behavior stub resolves outside the worktree at ${phase}: ${stubPath}`,
        file: stubPath,
      };
    }
  }
  return undefined;
}

function canonicalBehaviorOracleHashFinding(
  cwd: string,
  stubPath: string,
  expectedHash: string,
  phase: "baseSha" | "refSha",
): VerifyTaskBlocker | undefined {
  if (!/^[0-9a-f]{64}$/i.test(expectedHash)) {
    return {
      code: "behavior_oracle_changed",
      detail: `canonical behavior oracle has no valid recorded SHA-256 at ${phase}: ${stubPath}`,
      file: stubPath,
    };
  }
  let actual: string;
  try {
    actual = crypto.createHash("sha256").update(fs.readFileSync(path.resolve(cwd, ...stubPath.split("/")))).digest("hex");
  } catch (error) {
    return {
      code: "behavior_oracle_changed",
      detail: `canonical behavior oracle could not be hashed at ${phase}: ${error instanceof Error ? error.message : String(error)}`,
      file: stubPath,
    };
  }
  if (actual !== expectedHash) {
    return {
      code: "behavior_oracle_changed",
      detail: `canonical behavior oracle bytes changed at ${phase}: ${stubPath}`,
      file: stubPath,
    };
  }
  return undefined;
}

function behaviorExecutorHashFinding(
  cwd: string,
  executorPath: string,
  expectedHash: string,
  phase: "baseSha" | "refSha",
): VerifyTaskBlocker | undefined {
  const fileFinding = canonicalBehaviorStubFileFinding(cwd, executorPath, phase);
  if (fileFinding) {
    return {
      code: "behavior_executor_changed",
      detail: `fixed behavior executor file is missing, unsafe, or replaced at ${phase}: ${executorPath}`,
      file: executorPath,
    };
  }
  if (!/^[0-9a-f]{64}$/i.test(expectedHash)) {
    return {
      code: "behavior_executor_changed",
      detail: `fixed behavior executor has no valid recorded SHA-256 at ${phase}: ${executorPath}`,
      file: executorPath,
    };
  }
  try {
    const actual = crypto.createHash("sha256")
      .update(fs.readFileSync(path.resolve(cwd, ...executorPath.split("/"))))
      .digest("hex");
    if (actual === expectedHash) return undefined;
  } catch (error) {
    return {
      code: "behavior_executor_changed",
      detail: `fixed behavior executor could not be hashed at ${phase}: ${error instanceof Error ? error.message : String(error)}`,
      file: executorPath,
    };
  }
  return {
    code: "behavior_executor_changed",
    detail: `fixed behavior executor bytes changed at ${phase}: ${executorPath}`,
    file: executorPath,
  };
}

function behaviorExecutorBindingsFinding(
  settings: NonNullable<NonNullable<TachyonConfig["settings"]["verify"]>["behavior"]>,
  hashes: Record<string, string> | undefined,
): VerifyTaskBlocker | undefined {
  const configured = [...settings.executorPaths].sort();
  const recorded = hashes ? Object.keys(hashes).sort() : [];
  if (configured.length === recorded.length && configured.every((entry, index) => entry === recorded[index])) return undefined;
  return {
    code: "behavior_executor_changed",
    detail: "named behavior verifier has no exact spawn-bound hash for every configured executor path",
  };
}

function firstBehaviorExecutorFinding(
  cwd: string,
  hashes: Record<string, string>,
  phase: "baseSha" | "refSha",
): VerifyTaskBlocker | undefined {
  for (const executorPath of Object.keys(hashes).sort()) {
    const finding = behaviorExecutorHashFinding(cwd, executorPath, hashes[executorPath]!, phase);
    if (finding) return finding;
  }
  return undefined;
}

function canonicalVitestAssertions(
  result: CommandResult,
  behaviorTest: string,
  cwd: string,
  stubPath?: string,
): VitestAssertionObservation[] {
  return (result.observedVitestAssertions ?? [])
    .filter((assertion) => assertionTitleMatches(assertion, behaviorTest))
    .filter((assertion) => assertionFileMatches(assertion, cwd, stubPath));
}

function exactVitestAssertions(result: CommandResult, behaviorTest: string): VitestAssertionObservation[] {
  return (result.observedVitestAssertions ?? [])
    .filter((assertion) => assertionTitleMatches(assertion, behaviorTest));
}

function sameVitestAssertionIdentity(
  base: VitestAssertionObservation,
  head: VitestAssertionObservation,
): boolean {
  // The phase-specific absolute checkout prefix is intentionally excluded. Both observations have
  // already been proven to resolve lexically to the same spawn-bound canonical stubPath.
  return base.title === head.title && base.fullName === head.fullName;
}

function normalizeVitestNameFilterResult(result: CommandResult, behaviorTest: string): CommandResult {
  const parsed = parseVitestJsonReporter(result.stdout);
  if (!parsed.summary) {
    return {
      ...result,
      exitCode: NO_MATCH_EXIT_CODE,
      stderr: parsed.error
        ? `plain behaviorTest '${behaviorTest}' ${parsed.error}`
        : `plain behaviorTest '${behaviorTest}' did not emit Vitest JSON; use cmd:<command> for non-Vitest behavior verifiers`,
    };
  }
  const summary = parsed.summary;
  const executed = summary.passed + summary.failed;
  const observedTestNames = [...new Set(summary.assertions.flatMap((assertion) => [assertion.title, assertion.fullName].filter((name): name is string => !!name)))];
  const observedVitestAssertions = summary.assertions;
  const matching = summary.assertions.filter((assertion) => assertionTitleMatches(assertion, behaviorTest));
  const executableMatching = matching.filter((assertion) => assertion.status === "passed" || assertion.status === "failed");
  const stdout = `vitest behavior tests: total=${summary.total} executed=${executed} passed=${summary.passed} failed=${summary.failed} pending=${summary.pending} todo=${summary.todo}`;
  if (executableMatching.length === 0) {
    return {
      ...result,
      exitCode: NO_MATCH_EXIT_CODE,
      stdout,
      stderr: matching.length > 0
        ? `plain behaviorTest '${behaviorTest}' was skipped, todo, or pending instead of executed`
        : `plain behaviorTest '${behaviorTest}' matched no executable exact Vitest test`,
      observedTestNames,
      observedVitestAssertions,
    };
  }
  return { ...result, stdout, observedTestNames, observedVitestAssertions };
}

const DIAGNOSTIC_LIMIT = 4_096;

/** Keep the failure end of command output: test runners put summaries and assertion failures there. */
function boundedOutput(s: string | undefined, limit = DIAGNOSTIC_LIMIT): string | undefined {
  const normalized = s?.replace(/\u0000/g, "").trim();
  if (!normalized) return undefined;
  return normalized.length <= limit ? normalized : `…[${normalized.length - limit} chars omitted]\n${normalized.slice(-limit)}`;
}

function commandFailure(result: CommandResult, fallback: string): string {
  const termination = [result.timedOut ? "timed out" : undefined, result.signal ? `signal ${result.signal}` : undefined]
    .filter(Boolean).join(", ");
  const stderr = boundedOutput(result.stderr, 1_500);
  const stdout = boundedOutput(result.stdout, termination || stderr ? 2_000 : 3_500);
  return [termination, stderr && `stderr:\n${stderr}`, stdout && `stdout:\n${stdout}`].filter(Boolean).join("\n") || fallback;
}

function withinOwns(file: string, owns: string[]): boolean {
  const norm = file.replace(/\\/g, "/");
  return owns.some((own) => {
    const o = own.replace(/\\/g, "/").replace(/\/+$/, "");
    return norm === o || norm.startsWith(`${o}/`);
  });
}

function normalizeSegmentOwns(owns: string[]): string[] | undefined {
  const normalized: string[] = [];
  for (const entry of owns) {
    const slashPath = entry.replace(/\\/g, "/");
    if (!slashPath || path.posix.isAbsolute(slashPath)) return undefined;
    const canonical = path.posix.normalize(slashPath);
    if (!canonical || canonical === "." || canonical === ".." || canonical.startsWith("../")) return undefined;
    normalized.push(canonical);
  }
  return [...new Set(normalized)].sort();
}

async function canonicalSegmentBlockers(delivery: Delivery, refSha: string, cwd: string): Promise<VerifyTaskBlocker[]> {
  const blockers: VerifyTaskBlocker[] = [];
  const boundaries: Array<{ from: string; to: string; label: string }> = [];
  const ranges: Array<{ segment: Delivery["segments"][number]; end: string }> = [];
  const first = delivery.segments[0];
  if (!first) return [{ code: "non_linear_segment_history", detail: "canonical Delivery has no segments" }];
  boundaries.push({ from: delivery.contract.baseSha, to: first.grantedHeadSha, label: "contract base to first grant" });
  for (let index = 0; index < delivery.segments.length; index++) {
    const segment = delivery.segments[index]!;
    const end = segment.releasedHeadSha ?? (index === delivery.segments.length - 1 ? refSha : undefined);
    if (!end) {
      blockers.push({ code: "non_linear_segment_history", detail: `segment '${segment.id}' has no provable end boundary` });
      continue;
    }
    boundaries.push({ from: segment.grantedHeadSha, to: end, label: `segment '${segment.id}' grant to end` });
    ranges.push({ segment, end });
    const next = delivery.segments[index + 1];
    if (next) boundaries.push({ from: end, to: next.grantedHeadSha, label: `segment '${segment.id}' release to '${next.id}' grant` });
    else boundaries.push({ from: end, to: refSha, label: `final segment '${segment.id}' end to delivered HEAD` });

  }
  for (const boundary of boundaries) {
    try {
      const ancestor = await git(cwd, ["merge-base", "--is-ancestor", boundary.from, boundary.to], { okExitCodes: [0, 1] });
      if (ancestor.exitCode !== 0) blockers.push({ code: "non_linear_segment_history", detail: `${boundary.label} is not ancestor-linear (${boundary.from} !<= ${boundary.to})` });
    } catch (error) {
      blockers.push({ code: "non_linear_segment_history", detail: `${boundary.label} cannot be proved: ${error instanceof Error ? error.message : String(error)}` });
    }
  }
  if (blockers.some((finding) => finding.code === "non_linear_segment_history")) return blockers;

  for (const { segment, end } of ranges) {
    if (["reviewer", "verifier"].includes(segment.role)) continue;
    if (!["implementer", "fixer", "recovery"].includes(segment.role)) {
      blockers.push({ code: "invalid_segment_role", detail: `segment '${segment.id}' has unsupported role '${String(segment.role)}'` });
      continue;
    }
    const owns = normalizeSegmentOwns(segment.ownsSubset);
    if (!owns || owns.some((entry) => !withinOwns(entry, delivery.contract.owns))) {
      blockers.push({ code: "invalid_segment_scope", detail: `segment '${segment.id}' has invalid, escaping, or widened ownsSubset authority` });
      continue;
    }
    if (segment.grantedHeadSha === end) continue;
    const files = (await git(cwd, ["diff", "-z", "--name-only", `${segment.grantedHeadSha}..${end}`])).stdout
      .split("\0")
      .filter(Boolean);
    for (const file of files) {
      if (!withinOwns(file, owns)) blockers.push({ code: "scope_breach", detail: `changed file is outside ownsSubset for segment '${segment.id}' (${segment.grantedHeadSha}..${end})`, file });
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

function suppressionFindings(changes: ChangedFile[], patch: string, vitestAdapterEnabled: boolean): VerifyTaskBlocker[] {
  if (!vitestAdapterEnabled) return [];
  const findings: VerifyTaskBlocker[] = [];
  for (const change of changes) {
    const file = change.path;
    if (!isSuppressionPath(file)) continue;
    if (change.status === "D") findings.push({ code: "test_deleted", detail: `test file deleted: ${file}`, file });
    if (change.status === "R") findings.push({ code: "test_renamed", detail: `test file renamed: ${change.from ?? file} -> ${file}`, file });
    if (change.status === "T") findings.push({ code: "test_suppression", detail: `test file type changed: ${file}`, file });
    if (/^vitest\.config\.[cm]?[jt]s$/.test(file)) findings.push({ code: "test_config_changed", detail: `test config changed: ${file}`, file });
  }
  let currentFile: string | undefined;
  for (const line of patch.split(/\r?\n/)) {
    const fileMatch = line.match(/^\+\+\+ b\/(.+)$/);
    if (fileMatch) currentFile = fileMatch[1];
    if (!line.startsWith("+") || line.startsWith("+++")) continue;
    if (/\b(?:describe|it|test)\.(?:skip|only|todo)\b|\b(?:xit|xdescribe|xfail)\b/.test(line)) {
      findings.push({
        code: "test_suppression",
        detail: `suppression marker added: ${line.slice(1).trim()}`,
        ...(currentFile ? { file: currentFile } : {}),
      });
    }
  }
  return findings;
}

function canonicalBehaviorStubFindings(record: VerificationRecord, changes: ChangedFile[]): VerifyTaskBlocker[] {
  if (!record.stubPath) return [];
  const findings: VerifyTaskBlocker[] = [];
  for (const change of changes) {
    const oldPath = change.from ?? change.path;
    const newPath = change.path;
    if (oldPath !== record.stubPath && newPath !== record.stubPath) continue;
    if (change.status === "D") {
      findings.push({ code: "behavior_test_renamed", detail: `canonical behavior test stub was removed: ${record.stubPath}`, file: record.stubPath });
    } else if (change.status === "R") {
      findings.push({ code: "behavior_test_renamed", detail: `canonical behavior test stub was renamed: ${oldPath} -> ${newPath}`, file: record.stubPath });
    } else if (change.status === "T") {
      findings.push({ code: "behavior_test_renamed", detail: `canonical behavior test stub changed file type: ${record.stubPath}`, file: record.stubPath });
    }
  }
  return findings;
}

function matchingWaiver(finding: VerifyTaskBlocker, waivers: VerifyTaskWaiver[]): VerifyTaskWaiver | undefined {
  return waivers.find((w) => w.reason.trim() && (w.finding === finding.code || w.finding === finding.detail || w.finding === finding.file));
}

function waiveFindings(findings: VerifyTaskBlocker[], waivers: VerifyTaskWaiver[]): { unwaived: VerifyTaskBlocker[]; waived: VerifyTaskBlocker[] } {
  const unwaived: VerifyTaskBlocker[] = [];
  const waived: VerifyTaskBlocker[] = [];
  for (const finding of findings) {
    const waiver = matchingWaiver(finding, waivers);
    if (waiver) waived.push({ ...finding, blocking: false, waiver });
    else unwaived.push(finding);
  }
  return { unwaived, waived };
}

function recordWithHash(record: Omit<VerifyTaskRecord, "integrityHash">): VerifyTaskRecord {
  const body = JSON.stringify(record, null, 2);
  return { ...record, integrityHash: crypto.createHash("sha256").update(body).digest("hex") };
}

/** F3 — what makes two verification records the SAME verification. Re-running verify_task on one delivery
 *  at one SHA must overwrite its own record; a different Delivery at the same SHA must never replace it. */
function verificationScopeKey(record: Pick<VerifyTaskRecord, "taskRef" | "baseSha"> & Partial<Pick<VerifyTaskRecord, "identity" | "agent">>): string {
  const identity = record.identity;
  return JSON.stringify([
    identity?.deliveryId ?? null,
    identity?.segmentId ?? null,
    identity?.firstOccupant ?? record.agent ?? null,
    identity?.currentOccupant ?? record.agent ?? null,
    record.taskRef ?? null,
    record.baseSha ?? null,
  ]);
}

/** Records are scoped to (delivery, segment) so two Deliveries at the same refSha land separately. */
function verificationRecordPath(dir: string, record: VerifyTaskRecord): string {
  const { deliveryId, segmentId } = record.identity;
  // Hashed rather than interpolated: delivery and segment ids must never reach the filesystem as path text.
  const scope = crypto.createHash("sha256").update(`${deliveryId}\0${segmentId ?? ""}`).digest("hex").slice(0, 16);
  return path.join(dir, `${record.refSha}.${scope}.json`);
}

type PublicationDatabase = import("node:sqlite").DatabaseSync;

export interface VerificationPublicationTestSeams {
  databaseFactory?: (databasePath: string) => PublicationDatabase;
  afterConflictCheck?: () => void;
}

function publicationUnavailable(error: unknown): Error {
  return new Error(`verification record publication unavailable: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
}

function withVerificationPublicationTransaction<T>(workspaceRoot: string, fn: () => T, seams?: VerificationPublicationTestSeams): T {
  const tachyonDir = path.join(workspaceRoot, ".tachyon");
  fs.mkdirSync(tachyonDir, { recursive: true });
  const databasePath = path.join(tachyonDir, "verification-publication.sqlite3");
  let database: PublicationDatabase | undefined;
  let began = false;
  let committed = false;
  let result: T | undefined;
  let primary: unknown;
  let rollbackFailure: unknown;
  let closeFailure: unknown;
  try {
    if (seams?.databaseFactory) database = seams.databaseFactory(databasePath);
    else {
      const require = createRequire(path.join(workspaceRoot, "tachyon-verification-publisher-loader.cjs"));
      const sqlite = require("node:sqlite") as typeof import("node:sqlite");
      if (typeof sqlite.DatabaseSync !== "function") throw new Error("node:sqlite DatabaseSync is unavailable");
      database = new sqlite.DatabaseSync(databasePath, { timeout: 5000 });
    }
    database.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;");
    database.exec("BEGIN IMMEDIATE");
    began = true;
  } catch (error) {
    primary = publicationUnavailable(error);
  }
  if (began) {
    try {
      result = fn();
      database!.exec("COMMIT");
      committed = true;
    } catch (error) {
      primary = error;
    }
  }
  if (began && !committed) {
    try { database!.exec("ROLLBACK"); } catch (error) { rollbackFailure = error; }
  }
  if (database) {
    try { database.close(); } catch (error) { closeFailure = error; }
  }
  const failures = [primary, rollbackFailure, closeFailure].filter((failure) => failure !== undefined);
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, "verification publication transaction lifecycle failed");
  }
  return result as T;
}

/** Internal evidence publisher. Exported only for the cross-process regression helper. */
export function writeVerificationRecord(workspaceRoot: string, record: VerifyTaskRecord, seams?: VerificationPublicationTestSeams): string {
  const dir = path.join(workspaceRoot, ".tachyon", "verifications");
  fs.mkdirSync(dir, { recursive: true });
  const file = verificationRecordPath(dir, record);
  return withVerificationPublicationTransaction(workspaceRoot, () => {
    if (fs.existsSync(file)) {
      let existing: VerifyTaskRecord | undefined;
      try {
        existing = JSON.parse(fs.readFileSync(file, "utf8")) as VerifyTaskRecord;
      } catch {
        existing = undefined; // unreadable: we cannot prove it is ours, so we must not clobber it
      }
      if (!existing || verificationScopeKey(existing) !== verificationScopeKey(record)) {
        throw new VerifyTaskRecordConflictError(
          "VERIFICATION_RECORD_CONFLICT",
          `a different verification record already exists at ${file}; refusing to overwrite it`,
          [{ id: record.identity.deliveryId, path: file }],
        );
      }
    }
    seams?.afterConflictCheck?.();

    const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    let descriptor: number | undefined;
    let ownsTemporary = false;
    try {
      descriptor = fs.openSync(temporary, "wx", 0o600);
      ownsTemporary = true;
      fs.writeFileSync(descriptor, `${JSON.stringify(record, null, 2)}\n`, "utf8");
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      fs.renameSync(temporary, file);
      ownsTemporary = false;
      // Windows does not support opening directories for fsync. Other platforms must surface a
      // directory durability failure because this record is crash-sensitive evidence.
      if (process.platform !== "win32") {
        const directory = fs.openSync(dir, "r");
        try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
      }
    } catch (primary) {
      const cleanupErrors: unknown[] = [];
      if (descriptor !== undefined) {
        try { fs.closeSync(descriptor); } catch (error) { cleanupErrors.push(error); }
      }
      if (ownsTemporary) {
        try { fs.rmSync(temporary); } catch (error) { cleanupErrors.push(error); }
      }
      if (cleanupErrors.length > 0) {
        throw new AggregateError([primary, ...cleanupErrors], "verification record publication and owned temporary cleanup failed");
      }
      throw primary;
    }
    return file;
  }, seams);
}

type VerificationCloneOwner = {
  version: 1;
  workspaceHash: string;
  pid: number;
  processStart?: string;
  nonce: string;
  createdAt: string;
};

function linuxProcessStart(pid: number): string | undefined {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    if (close < 0) return undefined;
    return stat.slice(close + 2).trim().split(/\s+/)[19]; // proc(5): field 22, after pid+comm
  } catch {
    return undefined;
  }
}

function ownerStillLive(owner: VerificationCloneOwner): boolean {
  try { process.kill(owner.pid, 0); }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
  const currentStart = linuxProcessStart(owner.pid);
  return !owner.processStart || !currentStart || currentStart === owner.processStart;
}

/** Reap only directories carrying Tachyon's exact owner marker whose process is provably gone. */
function reapAbandonedVerificationClones(parent: string, workspaceHash: string): void {
  for (const entry of fs.readdirSync(parent, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith("verify-")) continue;
    const owned = path.join(parent, entry.name);
    try {
      const marker = JSON.parse(fs.readFileSync(path.join(owned, "owner.json"), "utf8")) as Partial<VerificationCloneOwner>;
      if (marker.version !== 1
        || marker.workspaceHash !== workspaceHash
        || !Number.isSafeInteger(marker.pid)
        || marker.pid! <= 0
        || typeof marker.nonce !== "string"
        || !/^[0-9a-f]{32}$/.test(marker.nonce)
        || (marker.processStart !== undefined
          && (typeof marker.processStart !== "string" || !/^[1-9][0-9]*$/.test(marker.processStart)))
        || typeof marker.createdAt !== "string") continue;
      const owner = marker as VerificationCloneOwner;
      if (!ownerStillLive(owner)) fs.rmSync(owned, { recursive: true, force: true });
    } catch {
      // Unknown or partially-created paths are not ours to delete.
    }
  }
}

function isolatedVerificationEnvironment(root: string, ownedPath: string, checkoutPath: string): NodeJS.ProcessEnv {
  // Keep temp names short: nested dogfood (tmux AF_UNIX sockets) must stay under ~108 bytes total.
  const temporary = path.join(ownedPath, "x");
  const cache = path.join(ownedPath, "c");
  const tmuxTmp = path.join(ownedPath, "t");
  for (const directory of [temporary, cache, tmuxTmp]) {
    fs.mkdirSync(directory, { mode: 0o700 });
  }

  const source = process.env.PATH ?? process.env.Path ?? "";
  const boundedPath = source
    .split(path.delimiter)
    .filter(Boolean)
    .filter((entry) => {
      const resolved = path.resolve(entry);
      const relative = path.relative(root, resolved);
      const insideRoot = relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
      return !insideRoot && !resolved.split(path.sep).includes("node_modules");
    })
    .join(path.delimiter);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TMPDIR: temporary,
    TMP: temporary,
    TEMP: temporary,
    // Prefer a shallow socket root even when TMPDIR is nested under the verification clone.
    TMUX_TMPDIR: tmuxTmp,
    XDG_CACHE_HOME: cache,
    npm_config_cache: path.join(cache, "npm"),
    NPM_CONFIG_CACHE: path.join(cache, "npm"),
    YARN_CACHE_FOLDER: path.join(cache, "yarn"),
    PIP_CACHE_DIR: path.join(cache, "pip"),
    UV_CACHE_DIR: path.join(cache, "uv"),
    PATH: boundedPath,
    PWD: checkoutPath,
  };
  // Do not let ambient language/shell startup hooks inject code or source-tree dependencies into
  // both phases. A project that deliberately needs one can set it inside its tracked prepare/runner
  // wrapper; silently inherited host hooks are not verification evidence.
  const directCodeInjectionVariables = new Set([
    "NODE_OPTIONS", "NODE_PATH",
    "BASH_ENV", "ENV",
    "PYTHONHOME", "PYTHONPATH",
    "RUBYOPT", "RUBYLIB",
    "PERL5OPT", "PERL5LIB",
  ]);
  for (const key of Object.keys(env)) {
    if (directCodeInjectionVariables.has(key.toUpperCase())) delete env[key];
  }
  if (process.platform === "win32") env.Path = boundedPath;
  return env;
}

/**
 * Execute one verification phase in a brand-new tracked-only clone outside the source repository.
 * The project adapter must prepare its own environment in this clone. This prevents ignored ancestor
 * dependencies and shared hooks/config/remotes from becoming evidence. BASE and HEAD receive different
 * clones plus phase-private temporary and common package-cache roots. This is not a filesystem sandbox:
 * HOME, project-selected toolchain configuration, ordinary explicit environment and deliberately absolute
 * external paths remain trusted project environment, and must not be used to derive the expected result.
 * Direct ambient language/shell code-injection variables are removed; tracked wrappers may set them explicitly.
 */
async function runAtIsolatedSha<T>(
  workspaceRoot: string,
  sha: string,
  fn: (checkoutPath: string, environment: NodeJS.ProcessEnv) => Promise<T>,
): Promise<T> {
  const root = fs.realpathSync(workspaceRoot);
  const workspaceHash = crypto.createHash("sha256").update(root).digest("hex").slice(0, 24);
  // t-b3ca7e: AF_UNIX path limit (~108). Old `tachyon-verification-<24hex>` + nested dogfood
  // TMUX sockets overflowed ("File name too long") and poisoned full verify under hermetic clones.
  // Keep owner.json workspaceHash at 24 hex; path segment is a short, collision-resistant prefix.
  const parent = path.join(os.tmpdir(), `tv-${workspaceHash.slice(0, 12)}`);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const parentStat = fs.lstatSync(parent);
  if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) {
    throw new Error(`verification checkout parent is not a real directory: ${parent}`);
  }
  if (typeof process.getuid === "function" && parentStat.uid !== process.getuid()) {
    throw new Error(`verification checkout parent is not owned by the verifier process user: ${parent}`);
  }
  if ((parentStat.mode & 0o077) !== 0) {
    throw new Error(`verification checkout parent must not be group/world accessible: ${parent}`);
  }
  const canonicalParent = fs.realpathSync(parent);
  const relativeToRoot = path.relative(root, canonicalParent);
  if (relativeToRoot === "" || (!relativeToRoot.startsWith("..") && !path.isAbsolute(relativeToRoot))) {
    throw new Error(`verification checkout parent must be outside the source repository: ${canonicalParent}`);
  }
  reapAbandonedVerificationClones(canonicalParent, workspaceHash);
  const ownedPath = fs.mkdtempSync(path.join(canonicalParent, "verify-"));
  let primary: unknown;
  try {
    // Everything after mkdtemp belongs to this cleanup transaction. If marker creation or any later
    // setup step fails, the unmarked partial directory is still removed by finally.
    const nonce = crypto.randomBytes(16).toString("hex");
    const processStart = linuxProcessStart(process.pid);
    const owner: VerificationCloneOwner = {
      version: 1,
      workspaceHash,
      pid: process.pid,
      ...(processStart ? { processStart } : {}),
      nonce,
      createdAt: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(ownedPath, "owner.json"), `${JSON.stringify(owner)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    const emptyHooks = path.join(ownedPath, "hooks");
    fs.mkdirSync(emptyHooks, { mode: 0o700 });
    const checkoutPath = path.join(ownedPath, "repo");
    const environment = isolatedVerificationEnvironment(root, ownedPath, checkoutPath);
    // `--local` may hardlink object files. Verification executes project code inside this clone, so
    // sharing an inode with the source object database would let that code corrupt the trusted repo.
    // Force the transport path: object bytes may be identical, but their storage is independent.
    await git(root, ["clone", "-c", `core.hooksPath=${emptyHooks}`, "--no-local", "--no-checkout", "--no-tags", "--", root, checkoutPath]);
    await git(checkoutPath, ["remote", "remove", "origin"]);
    await git(checkoutPath, ["-c", `core.hooksPath=${emptyHooks}`, "checkout", "--detach", "--force", sha]);
    const cleanBefore = await git(checkoutPath, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
    if (cleanBefore.stdout.length > 0) throw new Error("isolated verification clone was dirty before command execution");
    const result = await fn(checkoutPath, environment);
    const cleanAfter = await git(checkoutPath, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
    if (cleanAfter.stdout.length > 0) throw new Error("verification command mutated tracked or untracked project files");
    return result;
  } catch (error) {
    primary = error;
    throw error;
  } finally {
    const cleanupFailures: unknown[] = [];
    try { fs.rmSync(ownedPath, { recursive: true, force: true }); }
    catch (error) { cleanupFailures.push(error); }
    if (cleanupFailures.length > 0) {
      throw new AggregateError(
        primary === undefined ? cleanupFailures : [primary, ...cleanupFailures],
        "isolated verification checkout cleanup failed",
        primary === undefined ? undefined : { cause: primary },
      );
    }
  }
}

async function runBehaviorInCurrentCheckout(
  worktreePath: string,
  behaviorTest: string,
  settings: TachyonConfig["settings"]["verify"] | undefined,
  runner: VerifyTaskRunner,
): Promise<CommandResult> {
  return runBehavior(worktreePath, behaviorTest, settings, runner);
}

function commandRecord(name: string, cwd: string, result: CommandResult): VerifyTaskCommand {
  return {
    name,
    cwd,
    command: result.command,
    argv: result.argv,
    exitCode: result.exitCode,
    ...(result.timedOut ? { timedOut: true } : {}),
    ...(result.signal ? { signal: result.signal } : {}),
    ...(boundedOutput(result.stdout) ? { stdout: boundedOutput(result.stdout) } : {}),
    ...(boundedOutput(result.stderr) ? { stderr: boundedOutput(result.stderr) } : {}),
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
  fullCommand?: string;
  runner: VerifyTaskRunner;
  commands: VerifyTaskCommand[];
  blockers: VerifyTaskBlocker[];
}): Promise<void> {
  if (input.settings?.typecheck) {
    const typecheck = await input.runner(input.worktreePath, parseArgvCommand(input.settings.typecheck), { timeout: 300_000 });
    input.commands.push(commandRecord("typecheck", input.worktreePath, typecheck));
    if (typecheck.exitCode !== 0) {
      input.blockers.push({ code: "typecheck_failed", detail: `typecheck failed: ${commandFailure(typecheck, input.settings.typecheck)}` });
    }
  }

  if (input.settings?.affected) {
    const existingChanged = input.changed.filter((file) => fs.existsSync(path.join(input.worktreePath, file)));
    // Git permits root-level filenames beginning with `-`. Prefix those with `./` so an arbitrary
    // project runner receives a path argument rather than an injected CLI option, without assuming
    // that the configured command supports a `--` terminator.
    const affectedPaths = existingChanged.map((file) => file.startsWith("-") ? `./${file}` : file);
    const affectedArgv = [...parseArgvCommand(input.settings.affected), ...affectedPaths];
    const affected = await input.runner(input.worktreePath, affectedArgv, { timeout: 300_000 });
    input.commands.push(commandRecord("affected_tests", input.worktreePath, affected));
    if (affected.exitCode !== 0) {
      input.blockers.push({ code: "affected_tests_failed", detail: `affected tests failed: ${commandFailure(affected, affected.command)}` });
    }
  }

  if (input.full) {
    if (!input.fullCommand) {
      input.blockers.push({
        code: "verification_config_missing",
        detail: "verify_task full=true requires the project to configure settings.verify.full",
      });
      return;
    }
    const full = await input.runner(input.worktreePath, parseArgvCommand(input.fullCommand), { timeout: 600_000 });
    input.commands.push(commandRecord("full_tests", input.worktreePath, full));
    if (full.exitCode !== 0) {
      input.blockers.push({ code: "full_tests_failed", detail: `full verify failed: ${commandFailure(full, input.fullCommand)}` });
    }
  }
}

interface PreparedVerifyTask {
  publish(): Promise<{ result: VerifyTaskResult; evidence: { refSha: string; treeSha: string; verdict: "accept" | "blocked"; integrityHash: string; recordPath: string } }>;
}

export async function verifyTask(input: VerifyTaskInput): Promise<VerifyTaskResult> {
  const waivers = input.waivers ?? [];
  // t-7acc58 — reject before any git work: a waiver keyed on the bare code "scope_breach" would blanket-
  // waive every scope breach across every file and every fixer segment (matchingWaiver's finding.code arm
  // matches all of them at once), undoing the per-file segmented authority check entirely. Scope waivers
  // must name what they're actually excusing — a file, or the exact detail string. Suppression waivers keep
  // code-match (pre-existing semantics; a suppression tripwire's code is a single semantic category, unlike
  // scope_breach's "any file outside any authority boundary").
  const bareScopeBreachWaiver = waivers.find((w) => w.finding === "scope_breach");
  if (bareScopeBreachWaiver) {
    throw new Error(
      "verify_task: waiver rejected — a scope_breach waiver cannot use the bare code 'scope_breach' " +
        "(it would blanket-waive every scope breach across every file and fixer round); name the exact " +
        "file or detail the waiver excuses instead",
    );
  }

  const verifierCaller = input.verifierCaller ?? { kind: "legacy" as const };
  if (!input.deliveryVerification) {
    throw new VerifyTaskResolutionError("DELIVERY_VERIFICATION_REQUIRED", "verify_task: deliveryId requires the Workspace-owned verification lease service");
  }
  return input.deliveryVerification.run(input.deliveryId, verifierCaller, async (context): Promise<PreparedDeliveryVerification<VerifyTaskResult>> => {
    try {
      const subject = deliveryVerificationSubject(context.delivery);
      const first = subject.segments[0]!;
      const record: VerificationRecord = {
        ...subject.contract,
        agent: first.executionAgent,
        ...(subject.createdBy.name ? { delegator: subject.createdBy.name } : {}),
        createdAt: subject.createdAt,
      };
      const identity: VerifyTaskIdentity = {
        firstOccupant: first.executionAgent,
        currentOccupant: subject.currentSegment.executionAgent,
        occupants: [...subject.occupants],
        deliveryId: subject.deliveryId,
        segmentId: subject.currentSegment.id,
        segmentIndex: subject.currentSegment.index,
      };
      return verifyTaskResolved(input, { delivery: context.delivery, subject, record, identity }, context);
    } catch (err) {
      if (err instanceof DeliveryIdentityError) throw new VerifyTaskResolutionError(err.code, err.message);
      throw err;
    }
  });
}

async function verifyTaskResolved(input: VerifyTaskInput, target: VerificationTarget, canonical: DeliveryVerificationContext): Promise<PreparedVerifyTask> {
  const waivers = input.waivers ?? [];

  // F1 — resolve the delivery FIRST, then authorize the waivers against the identity that resolution
  // proved. Authorizing before resolving is what let a caller name someone else's agent (or hand over a
  // delivery_id) and waive its own findings.
  const { record, identity } = target;
  const verifierCaller = input.verifierCaller ?? { kind: "legacy" as const };
  assertWaiverAuthorized(verifierCaller, identity, waivers);

  /** Every act against the live worktree names the CURRENT occupant, not the original one (F2). */
  const occupant = identity.currentOccupant;
  const blockers: VerifyTaskBlocker[] = [];
  const commands: VerifyTaskCommand[] = [];
  let baseBehaviorAssertions: VitestAssertionObservation[] = [];
  let headBehaviorAssertions: VitestAssertionObservation[] = [];
  const runner = input.runner ?? runArgv;
  // The Delivery snapshot wins even when it is the explicit empty object; later config changes cannot
  // replace the verification contract.
  const verifySettings = record.verifySettings ?? input.verifySettings ?? loadVerifySettings(input.workspaceRoot);
  const missingRequestedFull = input.full === true && !verifySettings?.full;
  if (missingRequestedFull) {
    blockers.push({
      code: "verification_config_missing",
      detail: "verify_task full=true requires the project to configure settings.verify.full",
    });
  }

  // t-019dac: refuse heavy full tier under host memory pressure (fail-closed, before expensive work).
  if (input.full === true && !missingRequestedFull) {
    const gate = decideHeavyGate();
    if (!gate.ok) {
      blockers.push({
        code: "memory_pressure",
        detail: gate.reason,
      });
    }
  }

  const refSha = canonical.deliveredHeadSha;
  const treeSha = (await git(input.workspaceRoot, ["rev-parse", `${refSha}^{tree}`])).stdout.trim();
  const noCommit = refSha === record.baseSha;
  if (noCommit) blockers.push({ code: "no_commit", detail: `task ref ${record.taskRef} is still at baseSha ${record.baseSha}` });

  const changed = (await git(input.workspaceRoot, ["diff", "-z", "--name-only", `${record.baseSha}..${refSha}`])).stdout
    .split("\0")
    .filter(Boolean);
  if (changed.length === 0) blockers.push({ code: "no_changed_files", detail: `no files changed between baseSha and ${refSha}` });
  if (record.taskId) {
    const messages = (await git(input.workspaceRoot, ["log", "--format=%B", `${record.baseSha}..${refSha}`])).stdout;
    if (!messages.includes(record.taskId)) blockers.push({ code: "task_id_missing", detail: `no commit message between baseSha and refSha mentions task id ${record.taskId}` });
  }
  const waivedFindings: VerifyTaskBlocker[] = [];
  const scopeFindings = await canonicalSegmentBlockers(canonical.delivery, refSha, canonical.worktreePath);
  const nonWaivableScopeFindings = scopeFindings.filter((finding) => finding.code !== "scope_breach");
  blockers.push(...nonWaivableScopeFindings);
  const scopedWaivers = waiveFindings(scopeFindings.filter((finding) => finding.code === "scope_breach"), waivers);
  blockers.push(...scopedWaivers.unwaived);
  waivedFindings.push(...scopedWaivers.waived);

  const wtPath = canonical.worktreePath;
  let canRunBehavior = !noCommit && !missingRequestedFull && !blockers.some((finding) => ["non_linear_segment_history", "invalid_segment_scope", "invalid_segment_role"].includes(finding.code));
  if (!wtPath) {
    blockers.push({ code: "worktree_missing", detail: `task ref ${record.taskRef} is not checked out in an isolated worktree` });
    canRunBehavior = false;
  }

  if (wtPath) {
    await (async () => {
      const status = (await git(wtPath, ["status", "--porcelain"])).stdout.trim();
      if (status) {
        blockers.push({ code: "dirty_worktree", detail: `agent worktree has uncommitted changes`, file: wtPath });
        canRunBehavior = false;
      }
      if (!canRunBehavior) return;

      const fullCommand = verifySettings?.full;
      const prepareCommand = verifySettings?.prepare;
      const runAtVerificationSha = <T>(
        sha: string,
        fn: (checkoutPath: string, phaseRunner: VerifyTaskRunner, prepareRunner: VerifyTaskRunner) => Promise<T>,
      ) => runAtIsolatedSha(input.workspaceRoot, sha, (checkoutPath, environment) => {
        const phaseRunner: VerifyTaskRunner = (cwd, argv, opts) =>
          runner(cwd, argv, { ...opts, env: environment });
        const prepareRunner: VerifyTaskRunner = (cwd, argv, opts) =>
          runArgv(cwd, argv, { ...opts, env: environment });
        return fn(checkoutPath, phaseRunner, prepareRunner);
      });
      const namedVitestGate = !record.behaviorTest.startsWith("cmd:") && verifySettings?.behavior?.adapter === "vitest-name";
      const namedBehaviorSettings = namedVitestGate ? verifySettings!.behavior! : undefined;
      let stubTemplateFinding: VerifyTaskBlocker | undefined;
      if (namedBehaviorSettings && record.stubPath) {
        try {
          const expectedStubPath = configuredBehaviorStubPath(record.agent, namedBehaviorSettings.stubPath);
          if (record.stubPath !== expectedStubPath) {
            stubTemplateFinding = {
              code: "behavior_base_unproven",
              detail: `recorded canonical stubPath '${record.stubPath}' does not match configured path '${expectedStubPath}' for agent '${record.agent}'`,
              file: record.stubPath,
            };
          }
        } catch (error) {
          stubTemplateFinding = {
            code: "behavior_base_unproven",
            detail: `named Vitest behavior gate cannot render its configured stubPath for agent '${record.agent}': ${error instanceof Error ? error.message : String(error)}`,
            file: record.stubPath,
          };
        }
      }
      const executorBindingsFinding = namedBehaviorSettings
        ? behaviorExecutorBindingsFinding(namedBehaviorSettings, record.executorHashes)
        : undefined;
      if (namedVitestGate && (!record.stubPath || !record.oracleHash || stubTemplateFinding || executorBindingsFinding)) {
        blockers.push(stubTemplateFinding ?? {
          code: "behavior_base_unproven",
          detail: !record.stubPath || !record.oracleHash
            ? `named Vitest behavior gate '${record.behaviorTest}' has no recorded fixed oracle path/hash`
            : executorBindingsFinding!.detail,
        });
        blockers.push({
          code: "behavior_not_run",
          detail: "named Vitest behavior verifier requires the configured project-owned oracle path and every executor path bound by SHA-256",
        });
        return;
      }

      const fixedNamedFinding = (checkoutPath: string, phase: "baseSha" | "refSha"): VerifyTaskBlocker | undefined => {
        if (!namedVitestGate || !record.stubPath || !record.executorHashes) return undefined;
        return firstBehaviorExecutorFinding(checkoutPath, record.executorHashes, phase)
          ?? canonicalBehaviorStubFileFinding(checkoutPath, record.stubPath, phase)
          ?? canonicalBehaviorOracleHashFinding(checkoutPath, record.stubPath, record.oracleHash ?? "", phase);
      };
      const blockedCommand = (detail: string): CommandResult => ({
        command: "",
        argv: [],
        exitCode: NO_MATCH_EXIT_CODE,
        stdout: "",
        stderr: detail,
      });

      // Prove RED before any delivered-HEAD command runs. A named adapter first provisions an
      // independent environment from its frozen project command and rechecks every fixed input.
      let baseFixedFinding: VerifyTaskBlocker | undefined;
      let basePrepareFailed = false;
      let baseCheckoutPath = wtPath;
      let canonicalBaseIdentity: VitestAssertionObservation | undefined;
      const baseRun = await runAtVerificationSha(record.baseSha, async (checkoutPath, phaseRunner, prepareRunner) => {
        baseCheckoutPath = checkoutPath;
        baseFixedFinding = fixedNamedFinding(checkoutPath, "baseSha");
        if (baseFixedFinding) return blockedCommand(baseFixedFinding.detail);
        if (prepareCommand) {
          const prepareRun = await runVerificationPrepare(checkoutPath, prepareCommand, prepareRunner);
          commands.push(commandRecord("verification_prepare_base", checkoutPath, prepareRun));
          if (prepareRun.exitCode !== 0) {
            basePrepareFailed = true;
            blockers.push({
              code: "verification_prepare_failed",
              detail: `project verifier preparation failed at baseSha: ${commandFailure(prepareRun, prepareCommand)}`,
            });
            return blockedCommand("project verifier preparation failed at baseSha");
          }
          baseFixedFinding = fixedNamedFinding(checkoutPath, "baseSha");
          if (baseFixedFinding) return blockedCommand(baseFixedFinding.detail);
        }
        const result = await runBehaviorInCurrentCheckout(checkoutPath, record.behaviorTest, verifySettings, phaseRunner);
        baseFixedFinding = fixedNamedFinding(checkoutPath, "baseSha");
        return result;
      });
      commands.push(commandRecord("behavior_base_expect_fail", baseCheckoutPath, baseRun));
      if (baseFixedFinding) {
        blockers.push(baseFixedFinding);
      } else if (namedVitestGate && !basePrepareFailed) {
        const exactBase = exactVitestAssertions(baseRun, record.behaviorTest);
        const canonicalBase = canonicalVitestAssertions(baseRun, record.behaviorTest, baseCheckoutPath, record.stubPath);
        baseBehaviorAssertions = structuredClone(canonicalBase);
        if (canonicalBase.length === 0) {
          blockers.push({
            code: "behavior_base_unproven",
            detail: `canonical behavior test '${record.behaviorTest}' was not executed from ${record.stubPath ?? "the configured Vitest adapter"} at baseSha`,
            ...(record.stubPath ? { file: record.stubPath } : {}),
          });
        } else if (canonicalBase.length !== 1 || exactBase.length !== 1) {
          blockers.push({
            code: "behavior_base_unproven",
            detail: `canonical behavior test '${record.behaviorTest}' must report exactly one assertion at baseSha; observed ${canonicalBase.length} canonical and ${exactBase.length} exact-name assertions`,
            ...(record.stubPath ? { file: record.stubPath } : {}),
          });
        } else if (canonicalBase[0]!.status !== "failed" || baseRun.exitCode === 0) {
          blockers.push({
            code: canonicalBase[0]!.status === "passed" ? "behavior_already_passed" : "behavior_base_unproven",
            detail: canonicalBase[0]!.status === "passed"
              ? `canonical behavior test passed at baseSha and proves no delivered change: ${record.behaviorTest}`
              : `canonical behavior test did not report a failed assertion at baseSha: ${record.behaviorTest}`,
            ...(record.stubPath ? { file: record.stubPath } : {}),
          });
        } else {
          canonicalBaseIdentity = structuredClone(canonicalBase[0]!);
        }
      } else if (baseRun.exitCode === 0) {
        blockers.push({ code: "behavior_already_passed", detail: `behaviorTest passed at baseSha and proves no delivered change: ${record.behaviorTest}` });
      }

      const blockersBeforeTiered = blockers.length;
      let behaviorHeadRan = false;
      const hasTieredHeadCommands = Boolean(verifySettings?.typecheck || verifySettings?.affected || input.full === true);

      // Tier commands are project-owned and may write ignored build/cache state. Run them in their own
      // checkout so that none of those writes can manufacture the independent GREEN behavior proof.
      if (hasTieredHeadCommands) {
        await runAtVerificationSha(refSha, async (checkoutPath, phaseRunner, prepareRunner) => {
          let tierFixedFinding = fixedNamedFinding(checkoutPath, "refSha");
          if (tierFixedFinding) {
            blockers.push(tierFixedFinding);
            return;
          }
          if (prepareCommand) {
            const prepareRun = await runVerificationPrepare(checkoutPath, prepareCommand, prepareRunner);
            commands.push(commandRecord("verification_prepare_head_tiers", checkoutPath, prepareRun));
            if (prepareRun.exitCode !== 0) {
              blockers.push({
                code: "verification_prepare_failed",
                detail: `project verifier preparation failed at refSha ${refSha}: ${commandFailure(prepareRun, prepareCommand)}`,
              });
              return;
            }
            tierFixedFinding = fixedNamedFinding(checkoutPath, "refSha");
            if (tierFixedFinding) {
              blockers.push(tierFixedFinding);
              return;
            }
          }
          await runTieredTestsInCurrentCheckout({
            worktreePath: checkoutPath,
            changed,
            settings: verifySettings,
            full: input.full === true,
            fullCommand,
            runner: phaseRunner,
            commands,
            blockers,
          });

          if (blockers.length > blockersBeforeTiered) return;
          tierFixedFinding = fixedNamedFinding(checkoutPath, "refSha");
          if (tierFixedFinding) blockers.push(tierFixedFinding);
        });
      }

      if (blockers.length === blockersBeforeTiered) {
        // Mirror the BASE proof in a new checkout prepared from the same frozen command. This keeps
        // HEAD behavior evidence independent from both the live worktree and every preceding tier.
        await runAtVerificationSha(refSha, async (checkoutPath, phaseRunner, prepareRunner) => {
          let headFixedFinding = fixedNamedFinding(checkoutPath, "refSha");
          if (headFixedFinding) {
            blockers.push(headFixedFinding);
            return;
          }
          if (prepareCommand) {
            const prepareRun = await runVerificationPrepare(checkoutPath, prepareCommand, prepareRunner);
            commands.push(commandRecord("verification_prepare_head", checkoutPath, prepareRun));
            if (prepareRun.exitCode !== 0) {
              blockers.push({
                code: "verification_prepare_failed",
                detail: `project verifier preparation failed at refSha ${refSha}: ${commandFailure(prepareRun, prepareCommand)}`,
              });
              return;
            }
            headFixedFinding = fixedNamedFinding(checkoutPath, "refSha");
            if (headFixedFinding) {
              blockers.push(headFixedFinding);
              return;
            }
          }
          const headRun = await runBehaviorInCurrentCheckout(checkoutPath, record.behaviorTest, verifySettings, phaseRunner);
          behaviorHeadRan = true;
          headFixedFinding = fixedNamedFinding(checkoutPath, "refSha");
          if (headFixedFinding) blockers.push(headFixedFinding);
          commands.push(commandRecord("behavior_head_expect_pass", checkoutPath, headRun));
          let canonicalHeadPassed = !namedVitestGate;
          if (namedVitestGate && !headFixedFinding) {
            const exactHead = exactVitestAssertions(headRun, record.behaviorTest);
            const canonicalHead = canonicalVitestAssertions(headRun, record.behaviorTest, checkoutPath, record.stubPath);
            headBehaviorAssertions = structuredClone(canonicalHead);
            if (canonicalHead.length === 0) {
              blockers.push({
                code: record.stubPath ? "behavior_test_renamed" : "behavior_failed",
                detail: `canonical behavior test '${record.behaviorTest}' was not reported passed from ${record.stubPath ?? "the configured Vitest adapter"}`,
                ...(record.stubPath ? { file: record.stubPath } : {}),
              });
            } else if (canonicalHead.length !== 1 || exactHead.length !== 1) {
              blockers.push({
                code: record.stubPath ? "behavior_test_renamed" : "behavior_failed",
                detail: `canonical behavior test '${record.behaviorTest}' must report exactly one assertion at refSha; observed ${canonicalHead.length} canonical and ${exactHead.length} exact-name assertions`,
                ...(record.stubPath ? { file: record.stubPath } : {}),
              });
            } else if (canonicalBaseIdentity && !sameVitestAssertionIdentity(canonicalBaseIdentity, canonicalHead[0]!)) {
              blockers.push({
                code: record.stubPath ? "behavior_test_renamed" : "behavior_failed",
                detail: `canonical behavior assertion identity changed between baseSha and refSha: ${record.behaviorTest}`,
                ...(record.stubPath ? { file: record.stubPath } : {}),
              });
            } else if (canonicalHead[0]!.status !== "passed") {
              blockers.push({
                code: record.stubPath ? "behavior_test_renamed" : "behavior_failed",
                detail: `canonical behavior test '${record.behaviorTest}' was not reported passed from ${record.stubPath ?? "the configured Vitest adapter"}`,
                ...(record.stubPath ? { file: record.stubPath } : {}),
              });
            } else {
              canonicalHeadPassed = true;
            }
          }
          if (headRun.exitCode !== 0 && canonicalHeadPassed) {
            blockers.push({
              code: "behavior_failed",
              detail: `behaviorTest failed at refSha ${refSha}: ${commandFailure(headRun, record.behaviorTest)}`,
            });
          }
        });
      }

      if (!behaviorHeadRan) {
        blockers.push({ code: "behavior_not_run", detail: "behavior verifier skipped because a cheaper tier already blocked verification" });
        return;
      }
    })();
  }

  if (!wtPath || !canRunBehavior) {
    blockers.push({ code: "behavior_not_run", detail: "behavior verifier requires the agent worktree to exist and be clean" });
  }

  const changes = parseNameStatus(
    (await git(input.workspaceRoot, ["diff", "-z", "--name-status", `${record.baseSha}..${refSha}`])).stdout,
  );
  const patch = (await git(input.workspaceRoot, ["diff", `${record.baseSha}..${refSha}`])).stdout;
  blockers.push(...canonicalBehaviorStubFindings(record, changes));
  const suppressionWaivers = waiveFindings(
    suppressionFindings(
      changes,
      patch,
      !record.behaviorTest.startsWith("cmd:") && verifySettings?.behavior?.adapter === "vitest-name",
    ),
    waivers,
  );
  blockers.push(...suppressionWaivers.unwaived);
  waivedFindings.push(...suppressionWaivers.waived);

  // spec 363 T1 — Bridge-witnessed doorbell check: non-blocking, so it never flips an otherwise-green
  // verdict to blocked (ratified Decision 2). Runs regardless of the git-side checks above.
  if (!hasDoorbellRung(input.workspaceRoot, occupant, record.delegator, record.createdAt)) {
    blockers.push({
      code: "protocol_doorbell_missed",
      detail: `no notify_agent(to: '${record.delegator ?? "<delegator>"}') event recorded from '${occupant}' since ${record.createdAt}`,
      blocking: false,
    });
  }

  const blockingFindings = blockers.filter((b) => b.blocking !== false);
  const verdict = blockingFindings.length === 0 ? "accept" : "blocked";
  const behaviorMode = parseCmdBehavior(record.behaviorTest, verifySettings).mode;
  const verification = recordWithHash({
    refSha,
    treeSha,
    baseSha: record.baseSha,
    taskRef: record.taskRef,
    agent: occupant,
    identity,
    ...(record.taskId ? { taskId: record.taskId } : {}),
    verifierVersion: VERIFIER_VERSION,
    commands,
    behaviorEvidence: {
      identifier: record.behaviorTest,
      mode: behaviorMode,
      ...(verifySettings?.prepare ? { prepare: verifySettings.prepare } : {}),
      ...(behaviorMode === "vitest-name" && verifySettings?.behavior
        ? { adapter: structuredClone(verifySettings.behavior) }
        : {}),
      ...(record.stubPath ? { stubPath: record.stubPath } : {}),
      ...(record.oracleHash ? { oracleHash: record.oracleHash } : {}),
      ...(record.executorHashes ? { executorHashes: structuredClone(record.executorHashes) } : {}),
      baseAssertions: baseBehaviorAssertions,
      headAssertions: headBehaviorAssertions,
    },
    findings: [...blockers, ...waivedFindings],
    waivers,
    verdict,
    at: new Date().toISOString(),
    verifierCaller,
  });
  return {
    publish: async () => {
      const recordPath = writeVerificationRecord(input.workspaceRoot, verification);
      const result: VerifyTaskResult = { verdict, blockers: blockingFindings, waivedFindings, record: verification, recordPath };
      return { result, evidence: { refSha, treeSha, verdict, integrityHash: verification.integrityHash, recordPath } };
    },
  };
}
