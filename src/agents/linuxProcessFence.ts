/**
 * SDD 368 T14.6A — opt-in Linux systemd-user / cgroup ProcessFence adapter.
 *
 * Separately typed from ProcessFencePort so existing UnavailableProcessFence callers
 * and DeliveryLeaseService mocks stay byte-compatible. All OS effects go through
 * injected ports; this module never invokes sudo, installs, or builds helpers.
 *
 * Identity never stores or logs the raw execution nonce — only its SHA-256 digest.
 */

import { createHash } from "node:crypto";
import type {
  ProcessFenceCapability,
  ProcessFenceEmptyProof,
  ProcessFencePort,
} from "./processFence.js";

export const FENCE_IDENTITY_SCHEMA_VERSION = 1 as const;
export const LINUX_PROCESS_FENCE_DOMAIN = "linux-systemd-user-cgroup+audit-helper";

/** Default bounded wait budget for freeze / kill / confirm polls. */
export const DEFAULT_FENCE_WAIT_MS = 5_000;
export const DEFAULT_FENCE_POLL_MS = 25;
export const DEFAULT_HELPER_TIMEOUT_MS = 10_000;

// ── Identity ───────────────────────────────────────────────────────────────

export type FenceIdentityPhase = "pending" | "confirmed";

/**
 * Durable nonce-bound fence identity (schema v1).
 * `nonceDigest` is SHA-256 hex of the execution nonce; the raw nonce is never persisted.
 */
export type FenceIdentityV1 = {
  schemaVersion: typeof FENCE_IDENTITY_SCHEMA_VERSION;
  nonceDigest: string;
  bootId: string;
  unitName: string;
  phase: FenceIdentityPhase;
  /** Present only after confirmLaunch succeeds. */
  invocationId?: string;
  /** Exact ControlGroup path from systemd after confirm. */
  controlGroup?: string;
  helperPath: string;
  helperSha256: string;
};

// ── Ports (all OS effects) ─────────────────────────────────────────────────

export type SystemdUnitSnapshot = {
  loadState: string;
  activeState: string;
  subState: string;
  id: string;
  invocationId: string;
  controlGroup: string;
};

export interface SystemdUserPort {
  /** Probe whether user systemd is usable for transient scopes. */
  isAvailable(): Promise<boolean>;
  /** Exact unit property snapshot; missing units report loadState=not-found. */
  show(unitName: string): Promise<SystemdUnitSnapshot>;
  /**
   * Stop exactly the named unit. Adapter may call this only for the pinned unit
   * as a bounded cleanup path after cgroup.kill — never for foreign units.
   */
  stop(unitName: string): Promise<void>;
}

export type CgroupEvents = {
  populated: 0 | 1;
  frozen: 0 | 1;
};

export interface CgroupFsPort {
  /** Unified cgroup v2 present and writable for freeze/kill on transient scopes. */
  isAvailable(): Promise<boolean>;
  readEvents(controlGroup: string): Promise<CgroupEvents | "missing">;
  readProcs(controlGroup: string): Promise<number[] | "missing">;
  writeFreeze(controlGroup: string, freeze: boolean): Promise<void>;
  writeKill(controlGroup: string): Promise<void>;
}

export type HelperBinaryInspection = {
  path: string;
  sha256: string;
  /** st_mode permission bits (e.g. 0o100755). */
  mode: number;
  uid: number;
  gid: number;
  hasCapSysPtrace: boolean;
  /** True when the helper's mount has nosuid (capability raise impossible). */
  mountNosuid: boolean;
};

export type AuditHelperRunResult =
  | { timedOut: true }
  | { timedOut: false; exitCode: number; stdout: string; stderr: string };

export interface AuditHelperPort {
  /** Absolute path of the checksum-pinned helper binary. */
  path(): string;
  inspect(): Promise<HelperBinaryInspection>;
  run(canonicalWorktree: string, timeoutMs: number): Promise<AuditHelperRunResult>;
}

export interface BootIdentityPort {
  getBootId(): Promise<string>;
}

export interface FenceIdentityStore {
  load(nonceDigest: string): Promise<FenceIdentityV1 | undefined>;
  /** Atomic replace of the identity record for this digest. */
  store(identity: FenceIdentityV1): Promise<void>;
}

export interface FenceClock {
  nowMs(): number;
  sleep(ms: number): Promise<void>;
}

export type LinuxProcessFenceDeps = {
  systemd: SystemdUserPort;
  cgroup: CgroupFsPort;
  auditHelper: AuditHelperPort;
  boot: BootIdentityPort;
  store: FenceIdentityStore;
  clock: FenceClock;
  /** Expected helper owner uid (defaults to process euid). */
  expectedHelperUid?: number;
  waitBudgetMs?: number;
  pollIntervalMs?: number;
  helperTimeoutMs?: number;
};

// ── Launch surface (separate from ProcessFencePort) ────────────────────────

export type PreparedFenceLaunch = {
  /** Shell-safe systemd-run wrapper. Never contains the raw nonce. */
  command: string;
  unitName: string;
  nonceDigest: string;
};

/**
 * Launch-capable Linux fence: prepare/confirm are outside ProcessFencePort so
 * mocks and existing callers stay untouched.
 */
export interface LinuxProcessFenceLaunchPort {
  prepareLaunch(executionNonce: string, command: string): Promise<PreparedFenceLaunch>;
  confirmLaunch(executionNonce: string): Promise<void>;
}

export type LinuxProcessFencePort = ProcessFencePort & LinuxProcessFenceLaunchPort;

// ── Errors ─────────────────────────────────────────────────────────────────

export class ProcessFenceError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "ProcessFenceError";
    this.code = code;
  }
}

// ── Pure helpers (exported for focused tests) ──────────────────────────────

/** Cryptographic nonce digest — SHA-256 hex; never log/store the raw nonce. */
export function nonceDigestOf(executionNonce: string): string {
  return createHash("sha256").update(executionNonce, "utf8").digest("hex");
}

/**
 * Deterministic transient unit name from digest only.
 * Shape: tachyon-pf-<32 hex>.scope (collision-resistant prefix of SHA-256).
 */
export function unitNameForDigest(nonceDigest: string): string {
  if (!/^[0-9a-f]{64}$/.test(nonceDigest)) {
    throw new ProcessFenceError("PROCESS_FENCE_IDENTITY", "nonce digest is not SHA-256 hex");
  }
  return `tachyon-pf-${nonceDigest.slice(0, 32)}.scope`;
}

/** POSIX single-quote escaping for arguments embedded in a shell command line. */
export function posixShellQuote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

/**
 * One shell-quoted systemd-run --user --scope --collect wrapper around `command`.
 * Unit name is already digest-derived; command is quoted as a single sh -c payload.
 */
export function wrapSystemdScopeCommand(unitName: string, command: string): string {
  return [
    "systemd-run",
    "--user",
    "--scope",
    "--collect",
    `--unit=${posixShellQuote(unitName)}`,
    "--",
    "/bin/sh",
    "-c",
    posixShellQuote(command),
  ].join(" ");
}

export type ParsedHelperOutput = {
  state: "empty" | "survivors" | "unknown";
  capSysPtrace: "yes" | "no";
  matchCount: number;
  unknownCount: number;
  matchPids: number[];
};

/**
 * Strict machine-readable helper parser. Any missing/duplicate/malformed key → null.
 * Never optimistically treats partial output as empty.
 */
export function parseAuditHelperStdout(stdout: string): ParsedHelperOutput | null {
  const lines = stdout.split(/\r?\n/).filter((l) => l.length > 0);
  let state: ParsedHelperOutput["state"] | undefined;
  let capSysPtrace: "yes" | "no" | undefined;
  let matchCount: number | undefined;
  let unknownCount: number | undefined;
  const matchPids: number[] = [];
  const seen = new Set<string>();

  for (const line of lines) {
    if (line.startsWith("state=")) {
      if (seen.has("state")) return null;
      seen.add("state");
      const v = line.slice("state=".length);
      if (v !== "empty" && v !== "survivors" && v !== "unknown") return null;
      state = v;
      continue;
    }
    if (line.startsWith("cap_sys_ptrace=")) {
      if (seen.has("cap_sys_ptrace")) return null;
      seen.add("cap_sys_ptrace");
      const v = line.slice("cap_sys_ptrace=".length);
      if (v !== "yes" && v !== "no") return null;
      capSysPtrace = v;
      continue;
    }
    if (line.startsWith("match_count=")) {
      if (seen.has("match_count")) return null;
      seen.add("match_count");
      const v = line.slice("match_count=".length);
      if (!/^\d+$/.test(v)) return null;
      matchCount = Number(v);
      continue;
    }
    if (line.startsWith("unknown_count=")) {
      if (seen.has("unknown_count")) return null;
      seen.add("unknown_count");
      const v = line.slice("unknown_count=".length);
      if (!/^\d+$/.test(v)) return null;
      unknownCount = Number(v);
      continue;
    }
    // match pid=N starttime=... kind=...
    const matchM = /^match pid=(\d+) starttime=\d+ kind=(?:cwd|root|fd(?: fd=\d+)?)$/.exec(line);
    if (matchM) {
      matchPids.push(Number(matchM[1]));
      continue;
    }
    // unknown reason=... optional fields — accepted but not required for identity keys
    if (line.startsWith("unknown reason=")) continue;
    if (line.startsWith("self_ruid=")) continue;
    if (line.startsWith("target=")) continue;
    if (line.startsWith("match_truncated=")) continue;
    if (line.startsWith("unknown_truncated=")) continue;
    // Unrecognized line → refuse (strict)
    return null;
  }

  if (state === undefined || capSysPtrace === undefined
    || matchCount === undefined || unknownCount === undefined) {
    return null;
  }
  // Count consistency: reported match lines must not exceed match_count
  if (matchPids.length > matchCount) return null;

  return { state, capSysPtrace, matchCount, unknownCount, matchPids };
}

function isRegularExecutable(mode: number): boolean {
  // S_IFREG = 0o100000; owner or group/other execute bit present
  return (mode & 0o170000) === 0o100000 && (mode & 0o111) !== 0;
}

function isWorldWritable(mode: number): boolean {
  return (mode & 0o002) !== 0;
}

// ── Implementation ─────────────────────────────────────────────────────────

export class LinuxSystemdProcessFence implements LinuxProcessFencePort {
  private readonly systemd: SystemdUserPort;
  private readonly cgroup: CgroupFsPort;
  private readonly auditHelper: AuditHelperPort;
  private readonly boot: BootIdentityPort;
  private readonly store: FenceIdentityStore;
  private readonly clock: FenceClock;
  private readonly expectedHelperUid: number;
  private readonly waitBudgetMs: number;
  private readonly pollIntervalMs: number;
  private readonly helperTimeoutMs: number;
  private readonly cachedCapability: ProcessFenceCapability;

  private constructor(deps: LinuxProcessFenceDeps, capability: ProcessFenceCapability) {
    this.systemd = deps.systemd;
    this.cgroup = deps.cgroup;
    this.auditHelper = deps.auditHelper;
    this.boot = deps.boot;
    this.store = deps.store;
    this.clock = deps.clock;
    this.expectedHelperUid = deps.expectedHelperUid ?? (typeof process.getuid === "function" ? process.getuid() : 0);
    this.waitBudgetMs = deps.waitBudgetMs ?? DEFAULT_FENCE_WAIT_MS;
    this.pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_FENCE_POLL_MS;
    this.helperTimeoutMs = deps.helperTimeoutMs ?? DEFAULT_HELPER_TIMEOUT_MS;
    this.cachedCapability = capability;
  }

  /**
   * Probe host primitives once, cache capability, return a launch-capable fence.
   * Unsupported hosts still get an instance whose capability() is false and
   * mutating methods fail closed — callers may also keep using UnavailableProcessFence.
   */
  static async create(deps: LinuxProcessFenceDeps): Promise<LinuxSystemdProcessFence> {
    const capability = await probeCapability(deps);
    return new LinuxSystemdProcessFence(deps, capability);
  }

  /** Test/constructor escape hatch with an explicit cached capability. */
  static createWithCapability(
    deps: LinuxProcessFenceDeps,
    capability: ProcessFenceCapability,
  ): LinuxSystemdProcessFence {
    return new LinuxSystemdProcessFence(deps, capability);
  }

  capability(): ProcessFenceCapability {
    return this.cachedCapability;
  }

  async prepareLaunch(executionNonce: string, command: string): Promise<PreparedFenceLaunch> {
    this.requireSupported();
    const nonce = requireNonBlank(executionNonce, "executionNonce");
    const cmd = requireNonBlank(command, "command");
    const digest = nonceDigestOf(nonce);
    const unitName = unitNameForDigest(digest);
    const bootId = await this.boot.getBootId();
    if (!bootId.trim()) {
      throw new ProcessFenceError("PROCESS_FENCE_BOOT", "boot id unavailable");
    }

    const inspection = await this.requireHelperIdentity();
    const existing = await this.store.load(digest);
    if (existing) {
      if (existing.unitName !== unitName || existing.bootId !== bootId) {
        throw new ProcessFenceError(
          "PROCESS_FENCE_IDENTITY",
          "existing fence identity conflicts with deterministic unit/boot",
        );
      }
      // Idempotent prepare: reuse pending/confirmed on same boot+unit; still return wrapper.
      if (existing.phase === "confirmed") {
        return {
          command: wrapSystemdScopeCommand(unitName, cmd),
          unitName,
          nonceDigest: digest,
        };
      }
    }

    const pending: FenceIdentityV1 = {
      schemaVersion: FENCE_IDENTITY_SCHEMA_VERSION,
      nonceDigest: digest,
      bootId,
      unitName,
      phase: "pending",
      helperPath: inspection.path,
      helperSha256: inspection.sha256,
    };
    // Pending receipt MUST precede returned command.
    await this.store.store(pending);

    return {
      command: wrapSystemdScopeCommand(unitName, cmd),
      unitName,
      nonceDigest: digest,
    };
  }

  async confirmLaunch(executionNonce: string): Promise<void> {
    this.requireSupported();
    const digest = nonceDigestOf(requireNonBlank(executionNonce, "executionNonce"));
    let identity = await this.store.load(digest);
    const bootId = await this.boot.getBootId();
    const unitName = unitNameForDigest(digest);

    if (!identity) {
      // Repair pending only from exact deterministic live unit on same boot.
      identity = await this.tryRepairPending(digest, unitName, bootId);
      if (!identity) {
        throw new ProcessFenceError(
          "PROCESS_FENCE_IDENTITY",
          "no fence identity receipt and live unit repair failed",
        );
      }
    }

    if (identity.nonceDigest !== digest || identity.unitName !== unitName) {
      throw new ProcessFenceError("PROCESS_FENCE_IDENTITY", "identity digest/unit mismatch");
    }
    if (identity.bootId !== bootId) {
      throw new ProcessFenceError("PROCESS_FENCE_BOOT", "boot id drift since prepare");
    }

    if (identity.phase === "confirmed") {
      await this.assertExactLiveIdentity(identity);
      return;
    }

    const snap = await this.pollUntil(async () => {
      const s = await this.systemd.show(unitName);
      if (s.loadState === "not-found") return null;
      if (!s.invocationId.trim() || !s.controlGroup.trim()) return null;
      if (s.id && s.id !== unitName && s.id !== unitName.replace(/\.scope$/, "")) {
        // Accept unit id with or without .scope suffix conventions; require exact name match when present.
      }
      if (s.activeState !== "active" && s.activeState !== "running") return null;
      return s;
    }, "unit did not become active with InvocationID/ControlGroup");

    if (snap.id && snap.id !== unitName) {
      throw new ProcessFenceError("PROCESS_FENCE_IDENTITY", "unit id does not match deterministic name");
    }

    const procs = await this.cgroup.readProcs(snap.controlGroup);
    if (procs === "missing") {
      throw new ProcessFenceError("PROCESS_FENCE_CGROUP", "control group missing at confirm");
    }

    const confirmed: FenceIdentityV1 = {
      ...identity,
      phase: "confirmed",
      invocationId: snap.invocationId,
      controlGroup: snap.controlGroup,
    };
    await this.store.store(confirmed);
  }

  async freeze(executionNonce: string): Promise<void> {
    this.requireSupported();
    const identity = await this.requireConfirmedIdentity(executionNonce);
    await this.assertExactLiveIdentity(identity);
    const cg = identity.controlGroup!;
    await this.cgroup.writeFreeze(cg, true);
    await this.pollUntil(async () => {
      const events = await this.cgroup.readEvents(cg);
      if (events === "missing") return null;
      return events.frozen === 1 ? events : null;
    }, "cgroup freeze did not reach frozen=1 within budget");
    await this.assertExactLiveIdentity(identity);
  }

  async terminate(executionNonce: string): Promise<void> {
    this.requireSupported();
    const identity = await this.requireConfirmedIdentity(executionNonce);
    // Verify pinned identity before any kill; never act on another unit.
    await this.assertExactLiveIdentity(identity);
    const unitName = identity.unitName;
    const cg = identity.controlGroup!;

    try {
      await this.cgroup.writeKill(cg);
    } catch {
      // cgroup may already be gone mid-teardown; fall through to exact unit wait
    }

    await this.pollUntil(async () => {
      // Re-check we never drifted to another unit before optional stop cleanup.
      const live = await this.systemd.show(unitName);
      if (live.loadState === "not-found" || live.activeState === "inactive" || live.activeState === "failed") {
        const events = identity.controlGroup
          ? await this.cgroup.readEvents(identity.controlGroup)
          : "missing";
        if (events === "missing" || events.populated === 0) return true;
      }
      if (live.invocationId && identity.invocationId && live.invocationId !== identity.invocationId) {
        throw new ProcessFenceError("PROCESS_FENCE_IDENTITY", "invocation drift during terminate");
      }
      const events = await this.cgroup.readEvents(cg);
      if (events !== "missing" && events.populated === 0) {
        // Exact collected absence: unit gone or inactive after kill.
        if (live.loadState === "not-found" || live.activeState === "inactive" || live.activeState === "failed") {
          return true;
        }
        // Bounded cleanup only for the same exact unit.
        try {
          await this.systemd.stop(unitName);
        } catch {
          // ignore; keep polling
        }
      }
      return null;
    }, "cgroup kill did not reach populated=0 with exact unit absence");
  }

  async proveEmpty(executionNonce: string, canonicalWorktree: string): Promise<ProcessFenceEmptyProof> {
    if (!this.cachedCapability.supported) {
      return {
        state: "unknown",
        reason: this.cachedCapability.reason,
      };
    }

    try {
      const worktree = requireNonBlank(canonicalWorktree, "canonicalWorktree");
      if (!worktree.startsWith("/")) {
        return { state: "unknown", reason: "canonical worktree must be an absolute path" };
      }

      let identity: FenceIdentityV1;
      try {
        identity = await this.requireConfirmedIdentity(executionNonce);
      } catch (err) {
        return { state: "unknown", reason: errMessage(err) };
      }

      // Containment empty check against pinned identity (never invent empty from unrelated missing path).
      const containment = await this.containmentEmptyProof(identity);
      if (containment.state !== "empty") {
        if (containment.state === "survivors") {
          // Still run helper? Contract: both independent proofs. Survivors in cgroup → not proven_empty.
          // Return survivors from containment when we have pids; else unknown.
          return containment.pids.length > 0
            ? { state: "survivors", pids: containment.pids }
            : { state: "unknown", reason: containment.reason };
        }
        return { state: "unknown", reason: containment.reason };
      }

      // Helper identity: hash/mode/owner/cap/nosuid
      let inspection: HelperBinaryInspection;
      try {
        inspection = await this.requireHelperIdentity();
      } catch (err) {
        return { state: "unknown", reason: errMessage(err) };
      }
      if (inspection.path !== identity.helperPath || inspection.sha256 !== identity.helperSha256) {
        return { state: "unknown", reason: "helper path or sha256 drift from fence identity" };
      }

      const run = await this.auditHelper.run(worktree, this.helperTimeoutMs);
      if (run.timedOut) {
        return { state: "unknown", reason: "audit helper timed out" };
      }

      const parsed = parseAuditHelperStdout(run.stdout);
      if (!parsed) {
        return { state: "unknown", reason: "audit helper output malformed or incomplete" };
      }

      // Exit/state/count consistency table
      if (run.exitCode === 0) {
        if (parsed.state !== "empty" || parsed.capSysPtrace !== "yes"
          || parsed.matchCount !== 0 || parsed.unknownCount !== 0) {
          return {
            state: "unknown",
            reason: "audit helper exit 0 inconsistent with state/cap/counts",
          };
        }
        return { state: "proven_empty" };
      }

      if (run.exitCode === 1) {
        if (parsed.state !== "survivors" || parsed.unknownCount !== 0) {
          return {
            state: "unknown",
            reason: "audit helper exit 1 inconsistent with survivors/unknown counts",
          };
        }
        // Bounded PIDs from match lines; if counts claim survivors but no lines, still surface empty list? prefer unknown when count>0 but no pids.
        if (parsed.matchCount > 0 && parsed.matchPids.length === 0) {
          return { state: "unknown", reason: "audit helper survivors missing match pid lines" };
        }
        const pids = uniqueSorted(parsed.matchPids.slice(0, 256));
        return { state: "survivors", pids };
      }

      // exit 2 unknown, exit 3 error, or anything else
      return {
        state: "unknown",
        reason: `audit helper exit ${run.exitCode} state=${parsed.state}`,
      };
    } catch (err) {
      return { state: "unknown", reason: errMessage(err) };
    }
  }

  // ── private ──────────────────────────────────────────────────────────────

  private requireSupported(): void {
    if (!this.cachedCapability.supported) {
      throw new ProcessFenceError(
        "PROCESS_FENCE_UNAVAILABLE",
        this.cachedCapability.reason,
      );
    }
  }

  private async requireHelperIdentity(): Promise<HelperBinaryInspection> {
    const inspection = await this.auditHelper.inspect();
    if (inspection.path !== this.auditHelper.path()) {
      throw new ProcessFenceError("PROCESS_FENCE_HELPER", "helper path mismatch");
    }
    if (!/^[0-9a-f]{64}$/.test(inspection.sha256)) {
      throw new ProcessFenceError("PROCESS_FENCE_HELPER", "helper sha256 malformed");
    }
    if (!isRegularExecutable(inspection.mode)) {
      throw new ProcessFenceError("PROCESS_FENCE_HELPER", "helper is not a regular executable");
    }
    if (isWorldWritable(inspection.mode)) {
      throw new ProcessFenceError("PROCESS_FENCE_HELPER", "helper is world-writable");
    }
    if (inspection.uid !== this.expectedHelperUid) {
      throw new ProcessFenceError("PROCESS_FENCE_HELPER", "helper owner uid mismatch");
    }
    if (inspection.mountNosuid) {
      throw new ProcessFenceError("PROCESS_FENCE_HELPER", "helper mount is nosuid");
    }
    if (!inspection.hasCapSysPtrace) {
      throw new ProcessFenceError("PROCESS_FENCE_HELPER", "helper lacks CAP_SYS_PTRACE");
    }
    return inspection;
  }

  private async requireConfirmedIdentity(executionNonce: string): Promise<FenceIdentityV1> {
    const digest = nonceDigestOf(requireNonBlank(executionNonce, "executionNonce"));
    const identity = await this.store.load(digest);
    if (!identity) {
      throw new ProcessFenceError("PROCESS_FENCE_IDENTITY", "no fence identity for nonce digest");
    }
    if (identity.phase !== "confirmed") {
      throw new ProcessFenceError("PROCESS_FENCE_IDENTITY", "fence identity is not confirmed");
    }
    if (!identity.invocationId || !identity.controlGroup) {
      throw new ProcessFenceError("PROCESS_FENCE_IDENTITY", "confirmed identity missing InvocationID/ControlGroup");
    }
    if (identity.unitName !== unitNameForDigest(digest)) {
      throw new ProcessFenceError("PROCESS_FENCE_IDENTITY", "unit name drift from digest");
    }
    return identity;
  }

  /**
   * Exact identity checks before every cgroup/systemd action.
   * Boot, unit, InvocationID, and ControlGroup must all match the receipt.
   */
  private async assertExactLiveIdentity(identity: FenceIdentityV1): Promise<void> {
    const bootId = await this.boot.getBootId();
    if (bootId !== identity.bootId) {
      throw new ProcessFenceError("PROCESS_FENCE_BOOT", "boot id drift");
    }
    const snap = await this.systemd.show(identity.unitName);
    if (snap.loadState === "not-found") {
      // Allowed only when caller is terminate/proveEmpty emptiness path — freeze requires live.
      throw new ProcessFenceError("PROCESS_FENCE_IDENTITY", "pinned unit not found");
    }
    if (identity.invocationId && snap.invocationId !== identity.invocationId) {
      throw new ProcessFenceError("PROCESS_FENCE_IDENTITY", "InvocationID drift");
    }
    if (identity.controlGroup && snap.controlGroup !== identity.controlGroup) {
      throw new ProcessFenceError("PROCESS_FENCE_IDENTITY", "ControlGroup drift");
    }
  }

  private async tryRepairPending(
    digest: string,
    unitName: string,
    bootId: string,
  ): Promise<FenceIdentityV1 | undefined> {
    const snap = await this.systemd.show(unitName);
    if (snap.loadState === "not-found") return undefined;
    if (!snap.invocationId.trim() || !snap.controlGroup.trim()) return undefined;
    if (snap.activeState !== "active" && snap.activeState !== "running") return undefined;

    let inspection: HelperBinaryInspection;
    try {
      inspection = await this.requireHelperIdentity();
    } catch {
      return undefined;
    }

    const pending: FenceIdentityV1 = {
      schemaVersion: FENCE_IDENTITY_SCHEMA_VERSION,
      nonceDigest: digest,
      bootId,
      unitName,
      phase: "pending",
      helperPath: inspection.path,
      helperSha256: inspection.sha256,
    };
    await this.store.store(pending);
    return pending;
  }

  private async containmentEmptyProof(
    identity: FenceIdentityV1,
  ): Promise<{ state: "empty" } | { state: "survivors"; pids: number[]; reason: string } | { state: "unknown"; reason: string }> {
    const bootId = await this.boot.getBootId();
    if (bootId !== identity.bootId) {
      return { state: "unknown", reason: "boot id drift during proveEmpty" };
    }

    const snap = await this.systemd.show(identity.unitName);
    if (snap.loadState !== "not-found") {
      if (identity.invocationId && snap.invocationId && snap.invocationId !== identity.invocationId) {
        return { state: "unknown", reason: "InvocationID drift during proveEmpty" };
      }
      if (identity.controlGroup && snap.controlGroup && snap.controlGroup !== identity.controlGroup) {
        return { state: "unknown", reason: "ControlGroup drift during proveEmpty" };
      }
      if (snap.activeState === "active" || snap.activeState === "running") {
        const procs = identity.controlGroup
          ? await this.cgroup.readProcs(identity.controlGroup)
          : "missing";
        if (procs !== "missing" && procs.length > 0) {
          return {
            state: "survivors",
            pids: uniqueSorted(procs),
            reason: "cgroup still populated",
          };
        }
        const events = identity.controlGroup
          ? await this.cgroup.readEvents(identity.controlGroup)
          : "missing";
        if (events !== "missing" && events.populated === 1) {
          return { state: "unknown", reason: "unit active with populated=1 but procs unreadable" };
        }
        return { state: "unknown", reason: "unit still loaded without proven empty cgroup" };
      }
    }

    // Unit not-found / inactive: require cgroup missing or populated=0 for the *pinned* path only.
    if (!identity.controlGroup) {
      return { state: "unknown", reason: "confirmed identity missing control group" };
    }
    const events = await this.cgroup.readEvents(identity.controlGroup);
    if (events === "missing") {
      // Pinned path gone after kill/collect — acceptable empty for that exact identity.
      return { state: "empty" };
    }
    if (events.populated === 1) {
      const procs = await this.cgroup.readProcs(identity.controlGroup);
      if (procs !== "missing" && procs.length > 0) {
        return { state: "survivors", pids: uniqueSorted(procs), reason: "cgroup populated after unit teardown" };
      }
      return { state: "unknown", reason: "cgroup populated=1 without readable survivors" };
    }
    return { state: "empty" };
  }

  private async pollUntil<T>(
    probe: () => Promise<T | null>,
    timeoutReason: string,
  ): Promise<T> {
    const deadline = this.clock.nowMs() + this.waitBudgetMs;
    for (;;) {
      const value = await probe();
      if (value !== null) return value;
      if (this.clock.nowMs() >= deadline) {
        throw new ProcessFenceError("PROCESS_FENCE_TIMEOUT", timeoutReason);
      }
      await this.clock.sleep(this.pollIntervalMs);
    }
  }
}

async function probeCapability(deps: LinuxProcessFenceDeps): Promise<ProcessFenceCapability> {
  try {
    if (!(await deps.systemd.isAvailable())) {
      return { supported: false, reason: "systemd --user is not available" };
    }
    if (!(await deps.cgroup.isAvailable())) {
      return { supported: false, reason: "cgroup v2 freeze/kill is not available" };
    }
    const bootId = await deps.boot.getBootId();
    if (!bootId.trim()) {
      return { supported: false, reason: "boot id unavailable" };
    }
    const inspection = await deps.auditHelper.inspect();
    if (!/^[0-9a-f]{64}$/.test(inspection.sha256)) {
      return { supported: false, reason: "audit helper sha256 unavailable" };
    }
    if (!isRegularExecutable(inspection.mode) || isWorldWritable(inspection.mode)) {
      return { supported: false, reason: "audit helper mode unacceptable" };
    }
    const expectedUid = deps.expectedHelperUid
      ?? (typeof process.getuid === "function" ? process.getuid() : 0);
    if (inspection.uid !== expectedUid) {
      return { supported: false, reason: "audit helper owner mismatch" };
    }
    if (inspection.mountNosuid) {
      return { supported: false, reason: "audit helper mount is nosuid" };
    }
    if (!inspection.hasCapSysPtrace) {
      return { supported: false, reason: "audit helper lacks CAP_SYS_PTRACE" };
    }
    return { supported: true, domain: LINUX_PROCESS_FENCE_DOMAIN };
  } catch (err) {
    return { supported: false, reason: `capability probe failed: ${errMessage(err)}` };
  }
}

function requireNonBlank(value: string, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ProcessFenceError("PROCESS_FENCE_INPUT", `${name} must be a non-blank string`);
  }
  return value;
}

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function uniqueSorted(pids: number[]): number[] {
  return [...new Set(pids)].filter((p) => Number.isInteger(p) && p > 0).sort((a, b) => a - b);
}
