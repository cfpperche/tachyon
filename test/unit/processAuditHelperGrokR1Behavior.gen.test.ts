import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";

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

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function compileHelper(buildDir: string): string {
  const out = join(buildDir, "process-audit-helper");
  const r = spawnSync("gcc", [...HARDEN_CFLAGS, "-o", out, SRC], {
    encoding: "utf8",
  });
  expect(r.status, `gcc failed: ${r.stderr || r.stdout}`).toBe(0);
  return out;
}

function runHelper(
  helper: string,
  target: string,
): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(helper, [target], { encoding: "utf8" });
  return {
    status: r.status,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  };
}

function readPidLine(
  child: ReturnType<typeof spawn>,
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

describe("container-generated delegation behavior", () => {
  it("closes F1/F2: compile helper, reject symlink targets, fail-closed on rename/identity drift, no-cap unknown with reason, live FD match, honest BLOCKED report", async () => {
    const report = readFileSync(REPORT, "utf8");
    const source = readFileSync(SRC, "utf8");

    // Report presence + honest BLOCKED (no capability feasibility claim).
    expect(report).toMatch(/Verdict/);
    expect(report).toContain("**BLOCKED.**");
    expect(report).toContain("CAP_SYS_PTRACE");
    expect(report).toContain("state=unknown");
    expect(report).not.toMatch(/\*\*PASS\.\*\*/);

    // F1 contract surface in source (realpath + O_PATH pin + revalidate).
    expect(source).toMatch(/O_PATH/);
    expect(source).toMatch(/O_DIRECTORY/);
    expect(source).toMatch(/O_CLOEXEC/);
    expect(source).toMatch(/revalidate_target/);
    expect(source).toMatch(/target_identity_drift/);
    expect(source).toMatch(/realpath\s*\(/);

    // F2: sticky capability_loss re-emitted every pass after counter reset.
    expect(source).toMatch(/saw_cap_loss/);
    expect(source).toMatch(
      /if\s*\(\s*a->saw_cap_loss\s*\)[\s\S]{0,160}capability_loss/,
    );

    const buildDir = mkdtempSync(join(tmpdir(), "tachyon-368-audit-build-"));
    const scratch: string[] = [buildDir];
    const children: Array<ReturnType<typeof spawn>> = [];

    try {
      const helper = compileHelper(buildDir);
      const srcHash = sha256File(SRC);
      const binHash = sha256File(helper);

      // Report pins exact reproducible hashes for this correction.
      expect(report).toContain(srcHash);
      expect(report).toContain(binHash);

      // --- no-cap unknown with reason ---
      const target = mkdtempSync(join(tmpdir(), "tachyon-368-audit-target-"));
      scratch.push(target);
      const noCap = runHelper(helper, target);
      expect(noCap.status).toBe(2);
      expect(noCap.stdout).toMatch(/^state=unknown$/m);
      expect(noCap.stdout).toMatch(/^cap_sys_ptrace=no$/m);
      expect(noCap.stdout).toMatch(/^match_count=0$/m);
      expect(noCap.stdout).toMatch(/unknown reason=eaccess/);
      const unknownCount = Number(
        noCap.stdout.match(/^unknown_count=(\d+)$/m)?.[1] ?? "0",
      );
      expect(unknownCount).toBeGreaterThan(0);
      // F2 no-cap path: never capability_loss without prior effective cap.
      expect(noCap.stdout).not.toMatch(/capability_loss/);
      // Output privacy: no unrelated absolute process path strings.
      for (const line of noCap.stdout.split("\n")) {
        if (line.startsWith("target=")) continue;
        expect(line).not.toMatch(/^\/(?:tmp|home|proc|var|usr)\//);
      }

      // --- F1: symlink target rejection (byte-exact realpath must match) ---
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

      // --- F1: rename/replacement mid-scan → pinned-identity drift fail-closed ---
      const driftTarget = mkdtempSync(join(tmpdir(), "tachyon-368-audit-target-"));
      scratch.push(driftTarget);
      const moved = `${driftTarget}.moved`;
      scratch.push(moved);
      const attackFlag = join(buildDir, "attacked.flag");
      for (let i = 0; i < 50; i++) {
        children.push(spawn("sleep", ["3600"]));
      }
      const attacker = spawn("python3", [
        "-c",
        `
import os, time
helper = ${JSON.stringify(helper)}
target = ${JSON.stringify(driftTarget)}
moved = ${JSON.stringify(moved)}
flag = ${JSON.stringify(attackFlag)}
for _ in range(20000):
    for name in os.listdir("/proc"):
        if not name.isdigit():
            continue
        try:
            cmd = open(f"/proc/{name}/cmdline", "rb").read()
        except OSError:
            continue
        if helper.encode() in cmd and target.encode() in cmd:
            try:
                os.rename(target, moved)
                os.mkdir(target)
                open(flag, "w").write("1")
            except OSError:
                pass
            raise SystemExit(0)
    time.sleep(0.0002)
`,
      ]);
      children.push(attacker);
      const drifted = runHelper(helper, driftTarget);
      spawnSync("sleep", ["0.05"]);
      const attacked = existsSync(attackFlag);
      expect(drifted.status).toBe(2);
      expect(drifted.stdout).toMatch(/^state=unknown$/m);
      expect(drifted.stdout).not.toMatch(/^state=empty$/m);
      if (attacked) {
        expect(drifted.stdout).toMatch(
          /unknown reason=target_(identity_drift|deleted|path_drift|missing)/,
        );
      } else {
        // Race miss still must fail closed (host EACCES incompleteness).
        expect(drifted.stdout).toMatch(/unknown reason=/);
      }

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
  });
});
