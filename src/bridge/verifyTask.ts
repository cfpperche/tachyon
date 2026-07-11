import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { findNonArchivedDelegationRecordsByAgent, type DelegationRecord } from "./delegationRecord.js";
import { DeliveryStore } from "../delivery/store.js";
import { DeliveryIdentityError, deliveryToVerificationRecord } from "../delivery/verifyAdapter.js";
import { hasDoorbellRung } from "./doorbell.js";
import { CONFIG_FILENAMES, loadConfigFile, type TachyonConfig } from "../config/loadConfig.js";
import type { CallerSnapshot } from "./callerIdentity.js";
import type { Delivery } from "../delivery/types.js";
import type { DeliveryVerificationContext, DeliveryVerificationLeaseService, PreparedDeliveryVerification } from "../delivery/verificationLease.js";

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
  stdout?: string;
  stderr?: string;
}

/** F3 — who this verification is about, bound into the record (and therefore into its integrity hash).
 *  A bare refSha says only "some commit was verified"; two Deliveries can land the same tree at the same
 *  SHA, and a record that names neither the Delivery nor the segment cannot tell them apart afterwards. */
export interface VerifyTaskIdentity {
  /** The original occupant (Delivery segment 0, or the legacy DelegationRecord's agent). */
  legacy: string;
  /** The current occupant this verification actually acted on — the Delivery's tail segment, or (for a
   *  legacy DelegationRecord) the last `fixerAttempts[].occupantAgent`, falling back to `legacy` when
   *  there have been no fixer rounds. */
  canonical: string;
  /** G2 — every occupant this verification target has ever had, in chronological order: every Delivery
   *  segment's `executionAgent`, or (legacy) `record.agent` followed by every `fixerAttempts[].occupantAgent`.
   *  `legacy` is always `occupants[0]`, `canonical` is always the last entry. The waiver guard checks
   *  against the full list so an interior occupant — neither original nor current — cannot self-waive
   *  findings on the work it alone authored. */
  occupants: string[];
  /** Present when the verification resolved a canonical Delivery. */
  deliveryId?: string;
  segmentId?: string;
  segmentIndex?: number;
  /** Present when the verification resolved a legacy DelegationRecord that carries an id. */
  delegationId?: string;
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
  /** Canonical identity. When present, legacy agent-name resolution is not consulted. */
  deliveryId?: string;
  /** Compatibility sugar, accepted only when exactly one non-archived record matches. */
  agent?: string;
  full?: boolean;
  waivers?: VerifyTaskWaiver[];
  isAgentRunning?: (agent: string) => Promise<boolean>;
  withWorktreeLock?: <T>(agent: string, fn: () => Promise<T>) => Promise<T>;
  verifySettings?: TachyonConfig["settings"]["verify"];
  runner?: VerifyTaskRunner;
  /** t-7acc58 — the Bridge-resolved caller for this verification (spec 351 pattern); recorded on the
   *  record for attribution. Omitted -> {kind:"legacy"}, matching every other deps.caller consumer in tools.ts. */
  verifierCaller?: { kind: CallerSnapshot["kind"]; name?: string };
  /** Canonical Delivery path only; Workspace owns this lifecycle service once per host epoch. */
  deliveryVerification?: DeliveryVerificationLeaseService;
};

export type VerifyTaskErrorCode =
  | "VERIFY_TASK_IDENTITY_REQUIRED"
  | "DELIVERY_VERIFICATION_REQUIRED"
  | "DELIVERY_NOT_FOUND"
  | "LEGACY_DELEGATION_NOT_FOUND"
  | "AMBIGUOUS_LEGACY_DELEGATION"
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

/** The resolved subject of a verification: the compatibility record the checks run against, plus the
 *  identity those checks (and the waiver guard) must act on. */
interface VerificationTarget {
  record: DelegationRecord;
  identity: VerifyTaskIdentity;
}

async function resolveVerificationTarget(input: VerifyTaskInput): Promise<VerificationTarget> {
  if (input.deliveryId) {
    const delivery = await new DeliveryStore(input.workspaceRoot).get(input.deliveryId);
    if (!delivery) throw new VerifyTaskResolutionError("DELIVERY_NOT_FOUND", `Delivery '${input.deliveryId}' was not found`);
    try {
      const view = deliveryToVerificationRecord(delivery);
      return { record: view.record, identity: { ...view.identity, ...(view.record.id ? { delegationId: view.record.id } : {}) } };
    } catch (err) {
      // Fail closed: an unprovable occupant is a refusal, never a guess (see resolveOperationalSegment).
      if (err instanceof DeliveryIdentityError) throw new VerifyTaskResolutionError(err.code, err.message);
      throw err;
    }
  }
  if (!input.agent) {
    throw new VerifyTaskResolutionError("VERIFY_TASK_IDENTITY_REQUIRED", "verify_task requires delivery_id or legacy agent");
  }
  const matches = findNonArchivedDelegationRecordsByAgent(input.workspaceRoot, input.agent);
  const candidates = matches.map(({ path: recordPath, record }) => ({ id: record.id, path: recordPath }));
  if (matches.length === 0) {
    throw new VerifyTaskResolutionError("LEGACY_DELEGATION_NOT_FOUND", `no non-archived delegation record found for agent '${input.agent}'`, candidates);
  }
  if (matches.length !== 1) {
    throw new VerifyTaskResolutionError(
      "AMBIGUOUS_LEGACY_DELEGATION",
      `agent '${input.agent}' matches ${matches.length} non-archived delegation records; use delivery_id`,
      candidates,
    );
  }
  // G1 — a legacy DelegationRecord's operational occupant is `agent` ONLY when it has never been handed
  // off. `reuse_worktree` (t-815796) is a live mechanism: it grants a NEW agent name the worktree and
  // records it in `fixerAttempts[].occupantAgent` (`appendFixerAttempt`), but never rewrites `record.agent`
  // itself — that stays the original delegate's name for the life of the record (it is the lookup key
  // `findNonArchivedDelegationRecordsByAgent` above resolves by, and the anchor the scope checker pairs
  // with `record.owns`). So the CURRENT occupant is the last fixer round's agent when one exists, falling
  // back to `record.agent` only when `fixerAttempts` is empty — mirroring what `deliveryToVerificationRecord`
  // already does for Delivery segments.
  const record = matches[0]!.record;
  const fixerOccupants = (record.fixerAttempts ?? []).map((attempt) => attempt.occupantAgent);
  const canonical = fixerOccupants.length > 0 ? fixerOccupants[fixerOccupants.length - 1]! : record.agent;
  return {
    record,
    identity: {
      legacy: record.agent,
      canonical,
      occupants: [record.agent, ...fixerOccupants],
      ...(record.id ? { delegationId: record.id } : {}),
    },
  };
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
 * (`canonical`) and the original one (`legacy`): a Delivery can carry any number of interior fixer/recovery
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
    const files = (await git(cwd, ["diff", "--name-only", `${segment.grantedHeadSha}..${end}`])).stdout.split(/\r?\n/).filter(Boolean);
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
 *  at one SHA must overwrite its own record (it is idempotent evidence); a different delivery landing the
 *  same SHA must never silently replace it. Falls back to `agent` so a pre-identity record on disk still
 *  compares equal to a re-verification of the same legacy delegation instead of reading as a conflict. */
function verificationScopeKey(record: Pick<VerifyTaskRecord, "taskRef" | "baseSha"> & Partial<Pick<VerifyTaskRecord, "identity" | "agent">>): string {
  const identity = record.identity;
  return JSON.stringify([
    identity?.deliveryId ?? null,
    identity?.segmentId ?? null,
    identity?.legacy ?? record.agent ?? null,
    identity?.canonical ?? record.agent ?? null,
    record.taskRef ?? null,
    record.baseSha ?? null,
  ]);
}

/** Delivery-backed records get a path scoped to (delivery, segment) so two Deliveries at the same refSha
 *  land in different files. Legacy delegations keep the historic `<refSha>.json` path — the compat
 *  contract — and lean on the conflict check below instead. */
function verificationRecordPath(dir: string, record: VerifyTaskRecord): string {
  const { deliveryId, segmentId } = record.identity;
  if (!deliveryId) return path.join(dir, `${record.refSha}.json`);
  // Hashed rather than interpolated: delivery and segment ids must never reach the filesystem as path text.
  const scope = crypto.createHash("sha256").update(`${deliveryId} ${segmentId ?? ""}`).digest("hex").slice(0, 16);
  return path.join(dir, `${record.refSha}.${scope}.json`);
}

function writeVerificationRecord(workspaceRoot: string, record: VerifyTaskRecord): string {
  const dir = path.join(workspaceRoot, ".tachyon", "verifications");
  fs.mkdirSync(dir, { recursive: true });
  const file = verificationRecordPath(dir, record);

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
        [{ id: record.identity.deliveryId ?? record.identity.delegationId, path: file }],
      );
    }
  }

  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, file);
    // Windows does not support opening directories for fsync. Other platforms must surface a
    // directory durability failure because this record is crash-sensitive evidence.
    if (process.platform !== "win32") {
      const directory = fs.openSync(dir, "r");
      try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
    }
  } catch (error) {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch { /* preserve the publication failure */ }
    }
    fs.rmSync(temporary, { force: true });
    throw error;
  }
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
  if (input.deliveryId && !input.deliveryVerification) {
    throw new VerifyTaskResolutionError("DELIVERY_VERIFICATION_REQUIRED", "verify_task: deliveryId requires the Workspace-owned verification lease service");
  }
  if (input.deliveryId && input.deliveryVerification) {
    return input.deliveryVerification.run(input.deliveryId, verifierCaller, async (context): Promise<PreparedDeliveryVerification<VerifyTaskResult>> => {
      let view;
      try {
        view = deliveryToVerificationRecord(context.delivery);
      } catch (err) {
        if (err instanceof DeliveryIdentityError) throw new VerifyTaskResolutionError(err.code, err.message);
        throw err;
      }
      const target = { record: view.record, identity: { ...view.identity, ...(view.record.id ? { delegationId: view.record.id } : {}) } };
      return verifyTaskResolved(input, target, context);
    });
  }

  const target = await resolveVerificationTarget(input);
  const prepared = await verifyTaskResolved(input, target);
  return (await prepared.publish()).result;
}

async function verifyTaskResolved(input: VerifyTaskInput, target: VerificationTarget, canonical?: DeliveryVerificationContext): Promise<PreparedVerifyTask> {
  const waivers = input.waivers ?? [];

  // F1 — resolve the delivery FIRST, then authorize the waivers against the identity that resolution
  // proved. Authorizing before resolving is what let a caller name someone else's agent (or hand over a
  // delivery_id) and waive its own findings.
  const { record, identity } = target;
  const verifierCaller = input.verifierCaller ?? { kind: "legacy" as const };
  assertWaiverAuthorized(verifierCaller, identity, waivers);

  /** Every act against the live worktree names the CURRENT occupant, not the original one (F2). */
  const occupant = identity.canonical;
  const blockers: VerifyTaskBlocker[] = [];
  const commands: VerifyTaskCommand[] = [];
  const runner = input.runner ?? runArgv;
  const verifySettings = input.verifySettings ?? loadVerifySettings(input.workspaceRoot);

  const refSha = canonical?.deliveredHeadSha ?? (await git(input.workspaceRoot, ["rev-parse", record.taskRef])).stdout.trim();
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
  const waivedFindings: VerifyTaskBlocker[] = [];
  const scopeFindings = canonical
    ? await canonicalSegmentBlockers(canonical.delivery, refSha, canonical.worktreePath)
    : await scopeBreachBlockers(record, refSha, gitDiffNameOnly);
  const nonWaivableScopeFindings = scopeFindings.filter((finding) => finding.code !== "scope_breach");
  blockers.push(...nonWaivableScopeFindings);
  const scopedWaivers = waiveFindings(scopeFindings.filter((finding) => finding.code === "scope_breach"), waivers);
  blockers.push(...scopedWaivers.unwaived);
  waivedFindings.push(...scopedWaivers.waived);

  const wtPath = canonical?.worktreePath ?? await worktreePathForRef(input.workspaceRoot, record.taskRef);
  let canRunBehavior = !noCommit && !blockers.some((finding) => ["non_linear_segment_history", "invalid_segment_scope", "invalid_segment_role"].includes(finding.code));
  if (!wtPath) {
    blockers.push({ code: "worktree_missing", detail: `task ref ${record.taskRef} is not checked out in an isolated worktree` });
    canRunBehavior = false;
  }

  if (wtPath) {
    const withWorktreeLock = canonical
      ? (async <T>(_agent: string, fn: () => Promise<T>): Promise<T> => fn())
      : input.withWorktreeLock ?? (async <T>(_agent: string, fn: () => Promise<T>): Promise<T> => fn());
    await withWorktreeLock(occupant, async () => {
      if (!canonical && await input.isAgentRunning?.(occupant)) {
        blockers.push({ code: "agent_still_running", detail: `agent '${occupant}' is still running; stop it before verify_task mutates its worktree for the behavior check` });
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
      const runAtVerificationSha = canonical
        ? canonical.runAtSha
        : <T>(sha: string, fn: () => Promise<T>) => runAtSha(wtPath, record.taskRef, sha, fn);
      await runAtVerificationSha(refSha, async () => {
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

      const baseRun = canonical
        ? await canonical.runAtSha(record.baseSha, () => runBehaviorInCurrentCheckout(wtPath, record.behaviorTest, runner))
        : await runBehaviorAtSha(wtPath, record.taskRef, record.baseSha, record.behaviorTest, runner);
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
  const suppressionWaivers = waiveFindings(suppressionFindings(nameStatus, patch), waivers);
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
