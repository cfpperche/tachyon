/**
 * t-07ccde — measure residual path-rm TOCTOU after orphan judgment.
 *
 * Protocol (per round):
 *   1. Spawn a victim that acquires the lock and holds forever (real process).
 *   2. Spawn W waiters that all call withProcessLockSync (real liveness, pollMs=1).
 *   3. SIGKILL only the victim (a process we created).
 *   4. Waiters race orphan recovery + path-rm; hold-probe detects LIVE dual holders.
 *   5. Stop waiters, tally, next round.
 *
 * Completions are append-only (one line per CS) so concurrent writers cannot NaN the counter.
 *
 * Usage:
 *   npx vite-node --root . scripts/spikes/processLock-orphan-toctou-measure.mts
 * Env: ROUNDS=40 WAITERS=6 HOLD_MS=8 POLL_MS=1 ROUND_MS=2000
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ROUNDS = Number(process.env.ROUNDS ?? 40);
const WAITERS = Number(process.env.WAITERS ?? 6);
const HOLD_MS = Number(process.env.HOLD_MS ?? 8);
const POLL_MS = Number(process.env.POLL_MS ?? 1);
const ROUND_MS = Number(process.env.ROUND_MS ?? 2_000);
const KEEP_SCRATCH = process.env.KEEP_SCRATCH === "1";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-orphan-toctou-"));
const lock = path.join(scratch, "contend.lock");
const holdProbe = path.join(scratch, "hold.probe");
const csLog = path.join(scratch, "cs.jsonl");
const overlapPath = path.join(scratch, "overlaps.jsonl");
const roundLog = path.join(scratch, "rounds.jsonl");
const stopPath = path.join(scratch, "STOP");
const victimSrc = path.join(scratch, "victim.ts");
const waiterSrc = path.join(scratch, "waiter.ts");
const lockUrl = pathToFileURL(path.join(repoRoot, "src/locks/processLock.ts")).href;
const viteNode = path.join(repoRoot, "node_modules", ".bin", "vite-node");

fs.writeFileSync(csLog, "", "utf8");
fs.writeFileSync(overlapPath, "", "utf8");
fs.writeFileSync(roundLog, "", "utf8");

fs.writeFileSync(victimSrc, `
import { acquireProcessLock } from ${JSON.stringify(lockUrl)};
const lockPath = process.argv[2]!;
const held = acquireProcessLock(lockPath); // real default liveness
process.stdout.write("held " + process.pid + "\\n");
// Hold forever until SIGKILL — no release, no finally.
setInterval(() => {}, 60_000);
void held;
`, "utf8");

fs.writeFileSync(waiterSrc, `
import fs from "node:fs";
import { withProcessLockSync } from ${JSON.stringify(lockUrl)};

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}

const lockPath = process.argv[2]!;
const holdProbe = process.argv[3]!;
const csLog = process.argv[4]!;
const overlapPath = process.argv[5]!;
const stopPath = process.argv[6]!;
const holdMs = Number(process.argv[7]!);
const pollMs = Number(process.argv[8]!);
const round = Number(process.argv[9]!);
const opts = { timeoutMs: 15_000, pollMs };

function noteOverlap(otherRaw: string, where: string): void {
  const other = Number.parseInt(otherRaw, 10);
  if (!pidAlive(other) || other === process.pid) return;
  fs.appendFileSync(overlapPath, JSON.stringify({
    pid: process.pid, other, where, round, t: Date.now(),
  }) + "\\n");
}

while (!fs.existsSync(stopPath)) {
  try {
    withProcessLockSync(lockPath, () => {
      try {
        if (fs.existsSync(holdProbe)) {
          noteOverlap(fs.readFileSync(holdProbe, "utf8").trim(), "enter");
        }
      } catch { /* */ }
      fs.writeFileSync(holdProbe, String(process.pid) + "\\n");
      const start = Date.now();
      while (Date.now() - start < holdMs) {
        try {
          const cur = fs.readFileSync(holdProbe, "utf8").trim();
          if (cur !== String(process.pid)) noteOverlap(cur, "mid");
        } catch { /* */ }
      }
      try {
        const cur = fs.readFileSync(holdProbe, "utf8").trim();
        if (cur !== String(process.pid)) noteOverlap(cur, "exit");
      } catch { /* */ }
      // Append-only completion — no RMW counter race.
      fs.appendFileSync(csLog, JSON.stringify({
        pid: process.pid, round, t: Date.now(),
      }) + "\\n");
      try {
        if (fs.readFileSync(holdProbe, "utf8").trim() === String(process.pid)) {
          fs.unlinkSync(holdProbe);
        }
      } catch { /* */ }
    }, opts);
  } catch {
    // timeout / churn — keep racing until STOP
  }
}
`, "utf8");

function spawnNode(script: string, args: string[]): ChildProcess {
  return spawn(viteNode, ["--root", repoRoot, script, ...args], {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function waitHeld(child: ChildProcess, timeoutMs: number): Promise<number> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      reject(new Error(`victim did not hold within ${timeoutMs}ms: ${stderr.slice(0, 300)}`));
    }, timeoutMs);
    child.stdout?.on("data", (c: Buffer) => {
      stdout += c.toString("utf8");
      const m = /held (\d+)/.exec(stdout);
      if (m) {
        clearTimeout(timer);
        resolve(Number(m[1]));
      }
    });
    child.stderr?.on("data", (c: Buffer) => { stderr += c.toString("utf8"); });
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`victim exited early code=${code} signal=${signal}: ${stderr.slice(0, 300)}`));
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

function killOwned(child: ChildProcess | null): void {
  if (!child || child.killed) return;
  try { child.kill("SIGKILL"); } catch { /* */ }
}

function countLines(file: string): number {
  try {
    return fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim()).length;
  } catch {
    return 0;
  }
}

function overlapsForRound(round: number): number {
  try {
    return fs.readFileSync(overlapPath, "utf8").split("\n").filter((l) => {
      if (!l.trim()) return false;
      try { return (JSON.parse(l) as { round: number }).round === round; }
      catch { return false; }
    }).length;
  } catch {
    return 0;
  }
}

function csForRound(round: number): number {
  try {
    return fs.readFileSync(csLog, "utf8").split("\n").filter((l) => {
      if (!l.trim()) return false;
      try { return (JSON.parse(l) as { round: number }).round === round; }
      catch { return false; }
    }).length;
  } catch {
    return 0;
  }
}

const started = Date.now();
let roundsWithDual = 0;
let totalDualEvents = 0;
let totalCs = 0;
let victimsKilled = 0;

for (let round = 1; round <= ROUNDS; round++) {
  // Fresh stop gate per round
  try { fs.unlinkSync(stopPath); } catch { /* */ }
  try { fs.unlinkSync(holdProbe); } catch { /* */ }
  try { fs.unlinkSync(lock); } catch { /* */ }

  const victim = spawnNode(victimSrc, [lock]);
  const owned: ChildProcess[] = [victim];
  let victimPid: number;
  try {
    victimPid = await waitHeld(victim, 30_000);
  } catch (e) {
    killOwned(victim);
    fs.appendFileSync(roundLog, JSON.stringify({
      round, error: String(e), t: Date.now(),
    }) + "\n");
    continue;
  }

  // Confirm lock file matches victim
  const lockPid = Number.parseInt(fs.readFileSync(lock, "utf8").trim(), 10);
  if (lockPid !== victimPid) {
    killOwned(victim);
    fs.appendFileSync(roundLog, JSON.stringify({
      round, error: `lock pid ${lockPid} != victim ${victimPid}`, t: Date.now(),
    }) + "\n");
    continue;
  }

  const waiters: ChildProcess[] = [];
  for (let w = 0; w < WAITERS; w++) {
    const c = spawnNode(waiterSrc, [
      lock, holdProbe, csLog, overlapPath, stopPath, String(HOLD_MS), String(POLL_MS), String(round),
    ]);
    waiters.push(c);
    owned.push(c);
  }

  // Let waiters pile up behind the live victim.
  await new Promise((r) => setTimeout(r, 150));

  // SIGKILL only our victim.
  const exited = new Promise<void>((resolve) => victim.once("exit", () => resolve()));
  killOwned(victim);
  await exited;
  victimsKilled += 1;

  // Waiters race orphan recovery for ROUND_MS.
  await new Promise((r) => setTimeout(r, ROUND_MS));

  fs.writeFileSync(stopPath, "1\n");
  await new Promise((r) => setTimeout(r, 200));
  for (const c of waiters) killOwned(c);
  await new Promise((r) => setTimeout(r, 50));

  const dualEvents = overlapsForRound(round);
  const cs = csForRound(round);
  totalDualEvents += dualEvents;
  totalCs += cs;
  if (dualEvents > 0) roundsWithDual += 1;

  fs.appendFileSync(roundLog, JSON.stringify({
    round, dualEvents, cs, victimPid, t: Date.now(),
  }) + "\n");
}

const elapsedMs = Date.now() - started;
const allOverlaps = fs.readFileSync(overlapPath, "utf8").split("\n").filter((l) => l.trim());
const uniqueEpisodes = new Set<string>();
for (const line of allOverlaps) {
  try {
    const o = JSON.parse(line) as { pid: number; other: number; round: number; t: number };
    const a = Math.min(o.pid, o.other);
    const b = Math.max(o.pid, o.other);
    uniqueEpisodes.add(`${o.round}:${a}-${b}`);
  } catch { /* */ }
}

const report = {
  scenario: "SIGKILL-mid-hold + multi-waiter rounds (t-07ccde residual path-rm TOCTOU)",
  rounds: ROUNDS,
  waiters: WAITERS,
  holdMs: HOLD_MS,
  pollMs: POLL_MS,
  roundMs: ROUND_MS,
  victimsKilled,
  completedCriticalSections: countLines(csLog),
  dualHolderEvents: totalDualEvents,
  dualHolderEpisodes: uniqueEpisodes.size,
  roundsWithDualHolder: roundsWithDual,
  dualRoundRate: ROUNDS > 0 ? roundsWithDual / ROUNDS : null,
  dualPerCs: countLines(csLog) > 0 ? totalDualEvents / countLines(csLog) : null,
  elapsedMs,
  scratch,
  sampleOverlaps: allOverlaps.slice(0, 6),
};

console.log(JSON.stringify(report, null, 2));

if (!KEEP_SCRATCH) {
  try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* */ }
}

process.exitCode = uniqueEpisodes.size > 0 ? 2 : 0;
