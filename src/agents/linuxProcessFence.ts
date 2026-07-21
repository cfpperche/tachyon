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
import { normalize, resolve } from "node:path";
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
  /** Atomic create; false means a receipt already exists. */
  create(identity: FenceIdentityV1): Promise<boolean>;
  /** Atomic exact-value transition; false means the receipt changed. */
  compareAndSet(expected: FenceIdentityV1, next: FenceIdentityV1): Promise<boolean>;
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
  /** Explicit production pin; no self-reported helper identity is trusted. */
  expectedHelperPath: string;
  expectedHelperSha256: string;
  /** Real UID the helper must report about itself. */
  expectedRuntimeUid: number;
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
export function parseAuditHelperStdout(stdout: string, target: string, expectedUid: number): ParsedHelperOutput | null {
  const lines = stdout.split(/\r?\n/).filter((l) => l.length > 0);
  let state: ParsedHelperOutput["state"] | undefined;
  let capSysPtrace: "yes" | "no" | undefined;
  let matchCount: number | undefined;
  let unknownCount: number | undefined;
  let selfUid: number | undefined;
  let outputTarget: string | undefined;
  let matchTruncated: number | undefined;
  let unknownTruncated: number | undefined;
  const matchPids: number[] = [];
  let unknownLines = 0;
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
      matchCount = Number(v); if (!Number.isSafeInteger(matchCount)) return null;
      continue;
    }
    if (line.startsWith("unknown_count=")) {
      if (seen.has("unknown_count")) return null;
      seen.add("unknown_count");
      const v = line.slice("unknown_count=".length);
      if (!/^\d+$/.test(v)) return null;
      unknownCount = Number(v); if (!Number.isSafeInteger(unknownCount)) return null;
      continue;
    }
    // This is the exact C helper grammar, including a bounded fd field.
    const matchM = /^match pid=(\d+) starttime=(\d+) kind=(?:cwd|root|fd fd=(\d+))$/.exec(line);
    if (matchM) {
      const pid = Number(matchM[1]);
      const starttime = Number(matchM[2]);
      const fd = matchM[3] === undefined ? undefined : Number(matchM[3]);
      if (!isSafePositive(pid) || !isSafePositive(starttime) || (fd !== undefined && !isSafeNonnegative(fd))) return null;
      matchPids.push(pid);
      continue;
    }
    // C helper prints reason followed by optional pid/kind/fd fields in this order.
    const unknownM = /^unknown reason=[A-Za-z0-9_-]+(?: pid=(\d+))?(?: kind=(cwd|root|fd))?(?: fd=(\d+))?$/.exec(line);
    if (unknownM) {
      const pid = unknownM[1] === undefined ? undefined : Number(unknownM[1]);
      const kind = unknownM[2];
      const fd = unknownM[3] === undefined ? undefined : Number(unknownM[3]);
      if ((pid !== undefined && !isSafePositive(pid)) || (fd !== undefined && !isSafeNonnegative(fd))) return null;
      // The helper only reports descriptors for fd matches.  cwd/root matches
      // carry their PID and never an fd; a bare reason may omit all location data.
      if ((fd !== undefined && kind !== "fd")
        || (kind === "fd" && pid === undefined)
        || ((kind === "cwd" || kind === "root") && (pid === undefined || fd !== undefined))) return null;
      unknownLines++;
      continue;
    }
    if (line.startsWith("self_ruid=")) { if (seen.has("self_ruid")) return null; seen.add("self_ruid"); const v=line.slice(10); if (!/^\d+$/.test(v)) return null; selfUid=Number(v); if (!Number.isSafeInteger(selfUid)) return null; continue; }
    if (line.startsWith("target=")) { if (seen.has("target")) return null; seen.add("target"); outputTarget=line.slice(7); continue; }
    const matchTruncatedM = /^match_truncated=yes omitted=(\d+)$/.exec(line);
    if (matchTruncatedM) { if (seen.has("match_truncated")) return null; seen.add("match_truncated"); matchTruncated=Number(matchTruncatedM[1]); if (!Number.isSafeInteger(matchTruncated)) return null; continue; }
    const unknownTruncatedM = /^unknown_truncated=yes omitted=(\d+)$/.exec(line);
    if (unknownTruncatedM) { if (seen.has("unknown_truncated")) return null; seen.add("unknown_truncated"); unknownTruncated=Number(unknownTruncatedM[1]); if (!Number.isSafeInteger(unknownTruncated)) return null; continue; }
    // Unrecognized line → refuse (strict)
    return null;
  }

  if (state === undefined || capSysPtrace === undefined
    || matchCount === undefined || unknownCount === undefined || selfUid !== expectedUid || outputTarget !== target) {
    return null;
  }
  const matchOmitted = matchTruncated ?? 0;
  const unknownOmitted = unknownTruncated ?? 0;
  // Markers exist iff something was omitted; each count is exact, not a lower bound.
  if ((matchOmitted === 0 && matchTruncated !== undefined) || (unknownOmitted === 0 && unknownTruncated !== undefined)
    || matchPids.length + matchOmitted !== matchCount || unknownLines + unknownOmitted !== unknownCount) return null;

  return { state, capSysPtrace, matchCount, unknownCount, matchPids };
}

function isRegularExecutable(mode: number): boolean {
  // S_IFREG = 0o100000; owner or group/other execute bit present
  return (mode & 0o170000) === 0o100000 && (mode & 0o111) !== 0;
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
  private readonly expectedHelperPath: string;
  private readonly expectedHelperSha256: string;
  private readonly expectedRuntimeUid: number;
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
    this.expectedHelperPath = deps.expectedHelperPath;
    this.expectedHelperSha256 = deps.expectedHelperSha256;
    this.expectedRuntimeUid = deps.expectedRuntimeUid;
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
    if (!(await this.store.create(pending))) {
      throw new ProcessFenceError("PROCESS_FENCE_IDENTITY", "fence identity already exists; refusing duplicate launch");
    }

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

    if (identity.bootId !== bootId) throw new ProcessFenceError("PROCESS_FENCE_BOOT", "boot id drift since prepare");
    this.validateIdentity(identity, digest, bootId);

    if (identity.phase === "confirmed") {
      await this.assertExactLiveIdentity(identity);
      return;
    }

    const snap = await this.pollUntil(async () => {
      const s = await this.systemd.show(unitName);
      if (s.loadState === "not-found") return null;
      if (s.id !== unitName) {
        throw new ProcessFenceError("PROCESS_FENCE_IDENTITY", "unit identity has an unexpected unit id");
      }
      if (s.activeState === "activating") return null;
      if (s.activeState === "inactive" || s.activeState === "failed") {
        throw new ProcessFenceError("PROCESS_FENCE_IDENTITY", "unit identity is not exact active receipt");
      }
      if (s.activeState !== "active" || !s.invocationId.trim() || !s.controlGroup.trim()) return null;
      return s;
    }, "unit did not become active with InvocationID/ControlGroup");

    const procs = await this.cgroup.readProcs(snap.controlGroup);
    if (procs === "missing" || procs.length === 0) {
      throw new ProcessFenceError("PROCESS_FENCE_CGROUP", "control group missing or empty at confirm");
    }
    const second = await this.systemd.show(unitName);
    if (!this.sameSnapshot(snap, second) || !this.isActiveDeterministicSnapshot(unitName, second)) {
      throw new ProcessFenceError("PROCESS_FENCE_IDENTITY", "unit changed between membership observation and confirm");
    }

    const confirmed: FenceIdentityV1 = {
      ...identity,
      phase: "confirmed",
      invocationId: snap.invocationId,
      controlGroup: snap.controlGroup,
    };
    if (!(await this.store.compareAndSet(identity, confirmed))) {
      throw new ProcessFenceError("PROCESS_FENCE_IDENTITY", "fence identity changed during confirm");
    }
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

    await this.cgroup.writeKill(cg);

    await this.pollUntil(async () => {
      const live = await this.systemd.show(unitName);
      if (live.loadState === "not-found") return this.stableTerminalEmpty(identity, live, "not-found");
      if (!this.isExactSnapshotFor(identity, live, ["active", "inactive", "failed"])) {
        throw new ProcessFenceError("PROCESS_FENCE_IDENTITY", "unit drift during terminate");
      }
      const events = await this.cgroup.readEvents(cg);
      if (events === "missing" || events.populated === 0) {
        if (live.activeState === "inactive" || live.activeState === "failed") return this.stableTerminalEmpty(identity, live, "terminal");
        if (events === "missing") return null;
        const second = await this.systemd.show(unitName);
        if (!this.sameSnapshot(live, second) || !this.isExactSnapshotFor(identity, second, ["active"])) {
          throw new ProcessFenceError("PROCESS_FENCE_IDENTITY", "unit changed before stop");
        }
        await this.systemd.stop(unitName);
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
      if (!isCanonicalAbsolutePath(worktree)) {
        return { state: "unknown", reason: "canonical worktree must be a canonical absolute path" };
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

      const parsed = run.stderr === "" ? parseAuditHelperStdout(run.stdout, worktree, this.expectedRuntimeUid) : null;
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
        if (parsed.state !== "survivors" || parsed.capSysPtrace !== "yes" || parsed.unknownCount !== 0 || parsed.matchCount <= 0) {
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

      if (run.exitCode === 2 && parsed.state === "unknown" && parsed.unknownCount > 0) {
        return { state: "unknown", reason: "audit helper reported unknown process evidence" };
      }
      // exit 2 malformed, exit 3 error, or anything else
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
    if (!this.depsHelperPinValid() || inspection.path !== this.depsExpectedHelperPath() || this.auditHelper.path() !== this.depsExpectedHelperPath()) {
      throw new ProcessFenceError("PROCESS_FENCE_HELPER", "helper path mismatch");
    }
    if (inspection.sha256 !== this.depsExpectedHelperSha256()) {
      throw new ProcessFenceError("PROCESS_FENCE_HELPER", "helper sha256 mismatch");
    }
    if (!isRegularExecutable(inspection.mode)) {
      throw new ProcessFenceError("PROCESS_FENCE_HELPER", "helper is not a regular executable");
    }
    if ((inspection.mode & 0o022) !== 0) {
      throw new ProcessFenceError("PROCESS_FENCE_HELPER", "helper is group or world-writable");
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
    this.validateIdentity(identity, digest, await this.boot.getBootId());
    if (identity.phase !== "confirmed") {
      throw new ProcessFenceError("PROCESS_FENCE_IDENTITY", "fence identity is not confirmed");
    }
    if (!identity.invocationId || !identity.controlGroup) {
      throw new ProcessFenceError("PROCESS_FENCE_IDENTITY", "confirmed identity missing InvocationID/ControlGroup");
    }
    return identity;
  }

  private validateIdentity(identity: FenceIdentityV1, digest: string, bootId: string): void {
    if (identity.schemaVersion !== 1 || !/^[0-9a-f]{64}$/.test(identity.nonceDigest)
      || identity.nonceDigest !== digest || identity.unitName !== unitNameForDigest(digest)
      || identity.bootId !== bootId || identity.helperPath !== this.depsExpectedHelperPath()
      || identity.helperSha256 !== this.depsExpectedHelperSha256()
      || (identity.phase !== "pending" && identity.phase !== "confirmed")) {
      throw new ProcessFenceError("PROCESS_FENCE_IDENTITY", "invalid or drifted fence identity");
    }
    if (identity.phase === "pending" && (identity.invocationId !== undefined || identity.controlGroup !== undefined)) {
      throw new ProcessFenceError("PROCESS_FENCE_IDENTITY", "pending identity contains confirmed fields");
    }
    if (identity.phase === "confirmed" && (!identity.invocationId?.trim() || !identity.controlGroup?.trim())) {
      throw new ProcessFenceError("PROCESS_FENCE_IDENTITY", "confirmed identity missing InvocationID/ControlGroup");
    }
  }

  private depsExpectedHelperPath(): string { return this.expectedHelperPath; }
  private depsExpectedHelperSha256(): string { return this.expectedHelperSha256; }
  private depsHelperPinValid(): boolean {
    return isCanonicalAbsolutePath(this.expectedHelperPath) && /^[0-9a-f]{64}$/.test(this.expectedHelperSha256)
      && isSafeLinuxUid(this.expectedRuntimeUid) && isSafeLinuxUid(this.expectedHelperUid);
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
    if (snap.id !== identity.unitName) throw new ProcessFenceError("PROCESS_FENCE_IDENTITY", "unit id drift");
    if (!snap.invocationId.trim() || snap.invocationId !== identity.invocationId) throw new ProcessFenceError("PROCESS_FENCE_IDENTITY", "InvocationID drift");
    if (!snap.controlGroup.trim() || snap.controlGroup !== identity.controlGroup) throw new ProcessFenceError("PROCESS_FENCE_IDENTITY", "ControlGroup drift");
    if (snap.loadState === "not-found" || snap.activeState !== "active") throw new ProcessFenceError("PROCESS_FENCE_IDENTITY", "pinned unit is not exact active receipt");
  }

  private async tryRepairPending(
    digest: string,
    unitName: string,
    bootId: string,
  ): Promise<FenceIdentityV1 | undefined> {
    const snap = await this.systemd.show(unitName);
    if (snap.loadState === "not-found" || snap.id !== unitName) return undefined;
    if (!snap.invocationId.trim() || !snap.controlGroup.trim()) return undefined;
    if (snap.activeState !== "active") return undefined;

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
    const procs = await this.cgroup.readProcs(snap.controlGroup);
    if (procs === "missing" || procs.length === 0) return undefined;
    if (!(await this.store.create(pending))) return undefined;
    return pending;
  }

  private async containmentEmptyProof(
    identity: FenceIdentityV1,
  ): Promise<{ state: "empty" } | { state: "survivors"; pids: number[]; reason: string } | { state: "unknown"; reason: string }> {
    const bootId = await this.boot.getBootId();
    if (bootId !== identity.bootId) {
      return { state: "unknown", reason: "boot id drift during proveEmpty" };
    }

    const first = await this.systemd.show(identity.unitName);
    const absent = first.loadState === "not-found";
    if (!absent && !this.isExactSnapshotFor(identity, first, ["active", "inactive", "failed"])) return { state: "unknown", reason: "unit identity drift during proveEmpty" };
    const events = await this.cgroup.readEvents(identity.controlGroup!);
    const procs = events !== "missing" && events.populated === 1 ? await this.cgroup.readProcs(identity.controlGroup!) : [];
    const second = await this.systemd.show(identity.unitName);
    if (absent) {
      if (second.loadState !== "not-found") return { state: "unknown", reason: "unit appeared during proveEmpty" };
    } else if (!this.sameSnapshot(first, second) || !this.isExactSnapshotFor(identity, second, ["active", "inactive", "failed"])) {
      return { state: "unknown", reason: "unit changed during proveEmpty" };
    }
    if (events !== "missing" && events.populated === 1) {
      if (procs !== "missing" && procs.length > 0) return { state: "survivors", pids: uniqueSorted(procs), reason: "cgroup populated" };
      return { state: "unknown", reason: "cgroup populated=1 without readable survivors" };
    }
    if (!absent && first.activeState === "active") return { state: "unknown", reason: "unit remains active" };
    return { state: "empty" };
  }

  private isExactSnapshotFor(identity: FenceIdentityV1, snap: SystemdUnitSnapshot, allowed: readonly string[]): boolean {
    return snap.loadState !== "not-found" && snap.id === identity.unitName && !!snap.invocationId.trim() && !!snap.controlGroup.trim()
      && snap.invocationId === identity.invocationId && snap.controlGroup === identity.controlGroup && allowed.includes(snap.activeState);
  }

  private isActiveDeterministicSnapshot(unitName: string, snap: SystemdUnitSnapshot): boolean {
    return snap.loadState !== "not-found" && snap.id === unitName && snap.activeState === "active"
      && !!snap.invocationId.trim() && !!snap.controlGroup.trim();
  }

  private sameSnapshot(a: SystemdUnitSnapshot, b: SystemdUnitSnapshot): boolean {
    return a.loadState === b.loadState && a.activeState === b.activeState && a.id === b.id
      && a.invocationId === b.invocationId && a.controlGroup === b.controlGroup;
  }

  private async stableTerminalEmpty(identity: FenceIdentityV1, first: SystemdUnitSnapshot, kind: "not-found" | "terminal"): Promise<boolean | null> {
    const events = await this.cgroup.readEvents(identity.controlGroup!);
    if (events !== "missing" && events.populated !== 0) return null;
    const second = await this.systemd.show(identity.unitName);
    if (kind === "not-found") return second.loadState === "not-found" ? true : null;
    return this.sameSnapshot(first, second) && this.isExactSnapshotFor(identity, second, ["inactive", "failed"]) ? true : null;
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
    if (!isCanonicalAbsolutePath(deps.expectedHelperPath) || !/^[0-9a-f]{64}$/.test(deps.expectedHelperSha256)
      || !isSafeLinuxUid(deps.expectedRuntimeUid)
      || deps.auditHelper.path() !== deps.expectedHelperPath || inspection.path !== deps.expectedHelperPath
      || inspection.sha256 !== deps.expectedHelperSha256) {
      return { supported: false, reason: "audit helper sha256 unavailable" };
    }
    if (!isRegularExecutable(inspection.mode) || (inspection.mode & 0o022) !== 0) {
      return { supported: false, reason: "audit helper mode unacceptable" };
    }
    const expectedUid = deps.expectedHelperUid
      ?? (typeof process.getuid === "function" ? process.getuid() : 0);
    if (!isSafeLinuxUid(expectedUid) || inspection.uid !== expectedUid) {
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

function isCanonicalAbsolutePath(value: string): boolean {
  return typeof value === "string" && value.startsWith("/") && value === normalize(value) && value === resolve(value)
    && !value.includes("//") && !value.includes("/./") && !value.includes("/../");
}

function isSafeLinuxUid(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value <= 0xffff_ffff;
}

function isSafePositive(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function isSafeNonnegative(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
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
