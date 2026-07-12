import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  existsSync,
  openSync,
  closeSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";

const REPO = process.cwd();
const SRC = join(REPO, ".tachyon/studies/368-process-audit-helper.c");
const REPORT = join(REPO, ".tachyon/studies/368-process-audit-helper-spike.md");

const HARDEN_CFLAGS = [
  "-O2",
  "-pipe",
  "-Wall",
  "-Wextra",
  "-Werror",
  "-fstack-protector-strong",
  "-D_FORTIFY_SOURCE=2",
  "-fPIE",
  "-pie",
  "-Wl,-z,relro,-z,now",
];

const TARGET_UNKNOWN_RE =
  /unknown reason=target_(identity_drift|deleted|path_drift|missing|not_dir|fd_error)/;

const HIGH_FD = 200;
/** Soft limit the TEST_ONLY child applies (strictly below HIGH_FD). */
const SOFT_AFTER_LOWER = 100; // child uses high/2 with floor 8; for 200 → 100

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function compileHelper(
  buildDir: string,
  name: string,
  extra: string[] = [],
): string {
  const out = join(buildDir, name);
  const r = spawnSync("gcc", [...HARDEN_CFLAGS, ...extra, "-o", out, SRC], {
    encoding: "utf8",
  });
  expect(r.status, `gcc failed: ${r.stderr || r.stdout}`).toBe(0);
  return out;
}

function runHelper(
  helper: string,
  target: string,
  env?: NodeJS.ProcessEnv,
): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(helper, [target], {
    encoding: "utf8",
    env: env ? { ...process.env, ...env } : process.env,
  });
  return {
    status: r.status,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  };
}

function readPidLine(
  child: ChildProcessWithoutNullStreams | ReturnType<typeof spawn>,
  timeoutMs = 5000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let acc = "";
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      finish(() => reject(new Error("timed out waiting for child pid line")));
    }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer | string) => {
      acc += chunk.toString("utf8");
      if (acc.includes("\n")) {
        finish(() => resolve(acc.trim().split("\n")[0]!));
      }
    });
    child.on("error", (err) => {
      finish(() => reject(err));
    });
    child.on("exit", (code) => {
      finish(() => reject(new Error(`writer exited early code=${code}`)));
    });
  });
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForFile(path: string, timeoutMs = 10000): Promise<void> {
  const start = Date.now();
  while (!existsSync(path)) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timed out waiting for barrier file: ${path}`);
    }
    await sleepMs(5);
  }
}

function touch(path: string): void {
  closeSync(openSync(path, "w"));
}

/**
 * Run TEST_ONLY helper against target with a named seam barrier.
 * When ready appears, invoke onReady (must perform attack then return), then
 * release the barrier and await helper exit. Requires barrier reached — no
 * race-miss / ambient EACCES fallback.
 */
async function runWithSeam(opts: {
  helper: string;
  target: string;
  seamDir: string;
  phase: "post_pin" | "obs";
  onReady: () => void | Promise<void>;
}): Promise<{ status: number | null; stdout: string; stderr: string }> {
  mkdirSync(opts.seamDir, { recursive: true });
  const ready = join(opts.seamDir, `${opts.phase}.ready`);
  const release = join(opts.seamDir, `${opts.phase}.release`);
  try {
    rmSync(ready, { force: true });
  } catch {
    /* ignore */
  }
  try {
    rmSync(release, { force: true });
  } catch {
    /* ignore */
  }

  const child = spawn(opts.helper, [opts.target], {
    env: {
      ...process.env,
      PAH_TEST_SEAM_DIR: opts.seamDir,
      PAH_TEST_SEAM_PHASE: opts.phase,
    },
  }) as ChildProcessWithoutNullStreams;

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (c: Buffer) => {
    stdout += c.toString("utf8");
  });
  child.stderr.on("data", (c: Buffer) => {
    stderr += c.toString("utf8");
  });

  const exitP = new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve(code));
  });

  await waitForFile(ready, 15000);
  // Barrier reached — parent controls the observation window.
  await opts.onReady();
  touch(release);

  const status = await exitP;
  return { status, stdout, stderr };
}

describe("container-generated delegation behavior", () => {
  it("R4: pidfd_getfd fallback (stable nr_open/two-scan), high-FD soft-bound miss, seam residual BLOCKED", async () => {
    const report = readFileSync(REPORT, "utf8");
    const source = readFileSync(SRC, "utf8");

    // Report presence + honest BLOCKED (no capability / production feasibility claim).
    expect(report).toMatch(/Verdict/);
    expect(report).toContain("**BLOCKED.**");
    expect(report).toContain("CAP_SYS_PTRACE");
    expect(report).toContain("state=unknown");
    expect(report).not.toMatch(/\*\*PASS\.\*\*/);
    expect(report).not.toMatch(/\bPASS\b.*feasib/i);
    // Irreducible residual must remain explicit (no production proven_empty rollout).
    expect(report).toMatch(/swap\/restore|move\+restore|move\+ *restore/i);
    expect(report).toMatch(/residual/i);
    expect(report).toMatch(/between separate procfs|between the separate procfs|procfs syscalls/i);
    expect(report).toMatch(/TEST_ONLY|compile-time/i);
    expect(report).toMatch(/per-observation|per.observation/i);
    expect(report).not.toMatch(/sudo setcap/);
    expect(report).toMatch(/No setcap was performed/i);
    expect(report).toMatch(/proven_empty|production adapter|ProcessFence/i);
    expect(report).toMatch(/BLOCK.*production|must keep production|not.*production proven_empty|BLOCK production/i);

    // R4 contract surface in source + report.
    expect(source).toMatch(/pidfd_getfd|__NR_pidfd_getfd/);
    expect(source).toMatch(/pidfd_open|__NR_pidfd_open/);
    expect(source).toMatch(/fs\/nr_open|nr_open/);
    expect(source).toMatch(/PIDFD_NR_OPEN_SAFE_MAX/);
    expect(source).toMatch(/pidfd_scan_disagreement|pidfd_deadline|pidfd_nr_open_too_large/);
    expect(source).toMatch(/RLIMIT_NOFILE/); // only for TEST_ONLY soft-lower proof, not completeness bound
    expect(source).not.toMatch(/getrlimit\s*\(\s*RLIMIT_NOFILE[\s\S]{0,200}nr_open|probe.*rlim_cur/);
    // Completeness bound must not be soft RLIMIT — must be fs.nr_open / SAFE_MAX.
    expect(source).toMatch(/PIDFD_NR_OPEN_SAFE_MAX\s+1048576/);
    expect(report).toMatch(/pidfd_getfd|pidfd/);
    expect(report).toMatch(/nr_open|fs\.nr_open/);
    expect(report).toMatch(/two-scan|two scan|two complete scans/i);
    expect(report).toMatch(/RLIMIT_NOFILE|soft.?limit/i);
    expect(report).toMatch(/SAFE_MAX|safe maximum|1048576/);
    expect(report).toMatch(/j-aec448bf6364|R4/);
    // No grant of DAC_READ_SEARCH — only negative mentions allowed.
    expect(report).toMatch(/No setcap was performed/i);
    expect(report).toMatch(/CAP_DAC_READ_SEARCH/);
    expect(report).toMatch(/not used|No `CAP_DAC_READ_SEARCH`|do \*\*not\*\* add/i);

    // Contract surface: pin + revalidate + per-observation live path (R3 retained).
    expect(source).toMatch(/O_PATH/);
    expect(source).toMatch(/O_DIRECTORY/);
    expect(source).toMatch(/O_CLOEXEC/);
    expect(source).toMatch(/revalidate_target/);
    expect(source).toMatch(/target_identity_drift/);
    expect(source).toMatch(/realpath\s*\(/);
    expect(source).toMatch(/read_pin_live_path|\/proc\/self\/fd/);
    expect(source).toMatch(/#ifdef TEST_ONLY/);
    expect(source).toMatch(/TEST_SEAM\s*\(\s*"post_pin"\s*\)/);
    expect(source).toMatch(/TEST_SEAM\s*\(\s*"obs"\s*\)/);
    expect(source).toMatch(/PAH_TEST_SEAM_DIR/);
    expect(source).toMatch(/PAH_TEST_FORCE_PIDFD_FD_SCAN|PAH_TEST_SPAWN_HIGH_FD|PAH_TEST_NR_OPEN/);

    // Sticky capability_loss still present.
    expect(source).toMatch(/saw_cap_loss/);
    expect(source).toMatch(
      /if\s*\(\s*a->saw_cap_loss\s*\)[\s\S]{0,160}capability_loss/,
    );

    const buildDir = mkdtempSync(join(tmpdir(), "tachyon-368-audit-build-"));
    const scratch: string[] = [buildDir];
    const children: Array<ReturnType<typeof spawn>> = [];

    try {
      // Hardened production binary: seam-free, checksum-pinned for capability.
      const helper = compileHelper(buildDir, "process-audit-helper");
      // Separate TEST_ONLY binary for barrier-backed proofs only.
      const testHelper = compileHelper(buildDir, "process-audit-helper-test", [
        "-DTEST_ONLY",
      ]);

      const srcHash = sha256File(SRC);
      const binHash = sha256File(helper);
      const testBinHash = sha256File(testHelper);
      expect(binHash).not.toBe(testBinHash);

      // Report pins exact reproducible hashes for hardened (not TEST_ONLY) build.
      expect(report).toContain(srcHash);
      expect(report).toContain(binHash);
      // Seam marker string must not appear in hardened binary.
      const stringsR = spawnSync("strings", [helper], { encoding: "utf8" });
      expect(stringsR.status).toBe(0);
      expect(stringsR.stdout).not.toMatch(/PAH_TEST_SEAM_DIR/);
      expect(stringsR.stdout).not.toMatch(/PAH_TEST_FORCE_PIDFD/);
      expect(stringsR.stdout).not.toMatch(/PAH_TEST_SPAWN_HIGH_FD/);
      expect(stringsR.stdout).not.toMatch(/PAH_TEST_NR_OPEN/);
      expect(stringsR.stdout).not.toMatch(/post_pin\.ready/);
      // TEST_ONLY binary must contain the seam env keys.
      const testStrings = spawnSync("strings", [testHelper], {
        encoding: "utf8",
      });
      expect(testStrings.status).toBe(0);
      expect(testStrings.stdout).toMatch(/PAH_TEST_SEAM_DIR/);
      expect(testStrings.stdout).toMatch(/PAH_TEST_FORCE_PIDFD_FD_SCAN|PAH_TEST_SPAWN_HIGH_FD/);

      // --- no-cap unknown with reason (hardened binary) ---
      const target = mkdtempSync(join(tmpdir(), "tachyon-368-audit-target-"));
      scratch.push(target);
      const noCap = runHelper(helper, target);
      expect(noCap.status).toBe(2);
      expect(noCap.stdout).toMatch(/^state=unknown$/m);
      expect(noCap.stdout).toMatch(/^cap_sys_ptrace=no$/m);
      expect(noCap.stdout).toMatch(/^match_count=0$/m);
      // Ambient incompleteness: eaccess and/or pidfd fail-closed reasons.
      expect(noCap.stdout).toMatch(
        /unknown reason=(eaccess|pidfd_nr_open_too_large|pidfd_getfd_eperm|pidfd_open_eperm)/,
      );
      const unknownCount = Number(
        noCap.stdout.match(/^unknown_count=(\d+)$/m)?.[1] ?? "0",
      );
      expect(unknownCount).toBeGreaterThan(0);
      expect(noCap.stdout).not.toMatch(/capability_loss/);
      for (const line of noCap.stdout.split("\n")) {
        if (line.startsWith("target=")) continue;
        expect(line).not.toMatch(/^\/(?:tmp|home|proc|var|usr)\//);
      }

      // --- F1: symlink target rejection ---
      const realDir = mkdtempSync(join(tmpdir(), "tachyon-368-audit-real-"));
      scratch.push(realDir);
      const linkPath = `${realDir}-link`;
      symlinkSync(realDir, linkPath);
      scratch.push(linkPath);
      const sym = runHelper(helper, linkPath);
      expect(sym.status).toBe(3);
      expect(sym.stderr).toMatch(/error=target_not_canonical/);
      expect(sym.stdout).not.toMatch(/^state=empty$/m);

      // --- live open-FD binding match while state remains unknown ---
      const writerLog = join(target, "writer.log");
      writeFileSync(writerLog, "");
      const writer = spawn("python3", [
        "-c",
        `import os,time,sys; fd=os.open(${JSON.stringify(writerLog)},os.O_WRONLY|os.O_APPEND); os.write(fd,b"x"); os.chdir("/"); sys.stdout.write(str(os.getpid())+"\\n"); sys.stdout.flush(); time.sleep(3600)`,
      ]);
      children.push(writer);
      const wpid = await readPidLine(writer);
      const withFd = runHelper(helper, target);
      expect(withFd.status).toBe(2);
      expect(withFd.stdout).toMatch(/^state=unknown$/m);
      expect(withFd.stdout).toMatch(new RegExp(`match pid=${wpid} .*kind=fd`));
      writer.kill("SIGKILL");

      // --- R4: high-FD above lowered soft limit — fallback finds it; soft-bound would miss ---
      // Soft-bound incompleteness (mathematical): soft after lower is high/2 (=100 for 200).
      expect(HIGH_FD).toBeGreaterThanOrEqual(SOFT_AFTER_LOWER);
      // Probe range [0, soft) excludes HIGH_FD — soft-bound completeness is unsound.
      expect(HIGH_FD >= SOFT_AFTER_LOWER).toBe(true);

      const highTarget = mkdtempSync(join(tmpdir(), "tachyon-368-audit-target-"));
      scratch.push(highTarget);
      const beforeSoft = readdirSync("/tmp").filter((n) =>
        n.startsWith("pah-test-soft-"),
      );
      const t0 = Date.now();
      const highRun = runHelper(testHelper, highTarget, {
        PAH_TEST_FORCE_PIDFD_FD_SCAN: "1",
        PAH_TEST_NR_OPEN: "512",
        PAH_TEST_SPAWN_HIGH_FD: String(HIGH_FD),
      });
      const highMs = Date.now() - t0;
      expect(highRun.status).toBe(2);
      expect(highRun.stdout).toMatch(/^state=unknown$/m);
      // Success: pidfd fallback (forced) finds the high FD binding.
      expect(highRun.stdout).toMatch(
        new RegExp(`match pid=\\d+ starttime=\\d+ kind=fd fd=${HIGH_FD}`),
      );
      const highMatch = highRun.stdout.match(
        new RegExp(`match pid=(\\d+) starttime=\\d+ kind=fd fd=${HIGH_FD}`),
      );
      expect(highMatch).toBeTruthy();
      const childPid = highMatch![1]!;
      // Soft limit published by child must be strictly below HIGH_FD.
      // (File is cleaned by helper atexit; capture via math contract + source path.)
      expect(source).toMatch(/setrlimit\s*\(\s*RLIMIT_NOFILE/);
      expect(source).toMatch(/PAH_TEST_SPAWN_HIGH_FD/);
      // Gap (EBADF holes): no unknown for arbitrary missing FDs in [0, nr_open).
      expect(highRun.stdout).not.toMatch(
        new RegExp(`unknown reason=.*fd=${HIGH_FD - 1}\\b`),
      );
      // Error path: ambient non-child processes under forced pidfd → explicit eperm unknown.
      expect(highRun.stdout).toMatch(/unknown reason=pidfd_getfd_eperm/);
      // nr_open too large is a documented fail-closed path (production host).
      expect(source).toMatch(/pidfd_nr_open_too_large/);
      // Cleanup: helper reaps high-FD child; no leftover soft marker for that pid.
      expect(existsSync(`/tmp/pah-test-soft-${childPid}`)).toBe(false);
      const afterSoft = readdirSync("/tmp").filter((n) =>
        n.startsWith("pah-test-soft-"),
      );
      expect(afterSoft.filter((n) => !beforeSoft.includes(n))).toEqual([]);
      // Performance budget for bounded test probe (two scans × 512, not full host nr_open).
      expect(highMs).toBeLessThan(15_000);
      // Soft-bound would miss: document in assertions.
      // If completeness used [0, soft), HIGH_FD would never be probed.
      const softWouldMiss = HIGH_FD >= SOFT_AFTER_LOWER;
      expect(softWouldMiss).toBe(true);

      // Production path: oversized fs.nr_open → pidfd_nr_open_too_large on EACCES fd dirs
      // (observed for sd-pam class). Do not require specific PID (host-dependent).
      if (noCap.stdout.includes("pidfd_nr_open_too_large")) {
        expect(noCap.stdout).toMatch(/unknown reason=pidfd_nr_open_too_large/);
      }

      // --- H1 closed: post_pin barrier + forced rename/replacement (no race-miss fallback) ---
      const driftTarget = mkdtempSync(join(tmpdir(), "tachyon-368-audit-target-"));
      scratch.push(driftTarget);
      const moved = `${driftTarget}.moved`;
      scratch.push(moved);
      const seamPost = join(buildDir, "seam-post-pin");
      scratch.push(seamPost);
      const postPin = await runWithSeam({
        helper: testHelper,
        target: driftTarget,
        seamDir: seamPost,
        phase: "post_pin",
        onReady: () => {
          // Rename original inode away and place a fresh directory at the path.
          const r = spawnSync("python3", [
            "-c",
            `
import os, sys
target, moved = sys.argv[1], sys.argv[2]
os.rename(target, moved)
os.mkdir(target)
`,
            driftTarget,
            moved,
          ]);
          expect(r.status, r.stderr?.toString()).toBe(0);
          expect(existsSync(join(seamPost, "post_pin.ready"))).toBe(true);
        },
      });
      expect(existsSync(join(seamPost, "post_pin.ready"))).toBe(true);
      expect(postPin.status).toBe(2);
      expect(postPin.stdout).toMatch(/^state=unknown$/m);
      expect(postPin.stdout).not.toMatch(/^state=empty$/m);
      // Must prove specific target_* — ambient eaccess alone is insufficient.
      expect(postPin.stdout).toMatch(TARGET_UNKNOWN_RE);

      // --- Hold drift across per-observation barrier → specific target_* ---
      const obsTarget = mkdtempSync(join(tmpdir(), "tachyon-368-audit-target-"));
      scratch.push(obsTarget);
      const obsMoved = `${obsTarget}.moved`;
      scratch.push(obsMoved);
      const seamObs = join(buildDir, "seam-obs");
      scratch.push(seamObs);
      const obsHeld = await runWithSeam({
        helper: testHelper,
        target: obsTarget,
        seamDir: seamObs,
        phase: "obs",
        onReady: () => {
          const r = spawnSync("python3", [
            "-c",
            `
import os, sys
target, moved = sys.argv[1], sys.argv[2]
os.rename(target, moved)
os.mkdir(target)
`,
            obsTarget,
            obsMoved,
          ]);
          expect(r.status, r.stderr?.toString()).toBe(0);
        },
      });
      expect(existsSync(join(seamObs, "obs.ready"))).toBe(true);
      expect(obsHeld.status).toBe(2);
      expect(obsHeld.stdout).toMatch(/^state=unknown$/m);
      expect(obsHeld.stdout).toMatch(TARGET_UNKNOWN_RE);

      // --- Swap/restore characterization (malicious same-UID residual window) ---
      const swapTarget = mkdtempSync(join(tmpdir(), "tachyon-368-audit-target-"));
      scratch.push(swapTarget);
      const swapMoved = `${swapTarget}.moved`;
      scratch.push(swapMoved);
      const seamSwap = join(buildDir, "seam-swap");
      scratch.push(seamSwap);
      const swapped = await runWithSeam({
        helper: testHelper,
        target: swapTarget,
        seamDir: seamSwap,
        phase: "obs",
        onReady: () => {
          const r = spawnSync("python3", [
            "-c",
            `
import os, sys
target, moved = sys.argv[1], sys.argv[2]
os.rename(target, moved)
os.rename(moved, target)
`,
            swapTarget,
            swapMoved,
          ]);
          expect(r.status, r.stderr?.toString()).toBe(0);
        },
      });
      expect(existsSync(join(seamSwap, "obs.ready"))).toBe(true);
      expect(swapped.status).toBe(2);
      expect(swapped.stdout).toMatch(/^state=unknown$/m);
      expect(swapped.stdout).not.toMatch(/^state=empty$/m);

      // Missing target refuses closed (never silent empty).
      const missing = runHelper(
        helper,
        join(tmpdir(), `tachyon-368-nope-${process.pid}`),
      );
      expect(missing.status).toBe(3);
      expect(missing.stderr).toMatch(/error=target_unresolvable/);
    } finally {
      for (const c of children) {
        try {
          c.kill("SIGKILL");
        } catch {
          /* ignore */
        }
      }
      for (const p of scratch) {
        try {
          rmSync(p, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
    }
  }, 180_000);
});
