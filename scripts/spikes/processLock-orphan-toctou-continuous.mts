/**
 * t-07ccde — continuous mutual-kill stress (pathological, not production-shaped).
 * Same dual-holder detector as the victim protocol: only LIVE other pids count.
 *
 * Env: WORKERS=8 TARGET_CS=300 HOLD_MS=5 KILL_EVERY_MS=20 MAX_MS=60000
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const WORKERS = Number(process.env.WORKERS ?? 8);
const TARGET_CS = Number(process.env.TARGET_CS ?? 300);
const HOLD_MS = Number(process.env.HOLD_MS ?? 5);
const KILL_EVERY_MS = Number(process.env.KILL_EVERY_MS ?? 20);
const POLL_MS = Number(process.env.POLL_MS ?? 1);
const MAX_MS = Number(process.env.MAX_MS ?? 60_000);

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-orphan-cont-"));
const lock = path.join(scratch, "contend.lock");
const holdProbe = path.join(scratch, "hold.probe");
const csLog = path.join(scratch, "cs.jsonl");
const overlapPath = path.join(scratch, "overlaps.jsonl");
const killsPath = path.join(scratch, "kills.jsonl");
const stopPath = path.join(scratch, "STOP");
const workerPath = path.join(scratch, "contender.ts");
const lockUrl = pathToFileURL(path.join(repoRoot, "src/locks/processLock.ts")).href;
const viteNode = path.join(repoRoot, "node_modules", ".bin", "vite-node");

fs.writeFileSync(csLog, "", "utf8");
fs.writeFileSync(overlapPath, "", "utf8");
fs.writeFileSync(killsPath, "", "utf8");

fs.writeFileSync(workerPath, `
import fs from "node:fs";
import { withProcessLockSync } from ${JSON.stringify(lockUrl)};
function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}
function noteOverlap(otherRaw: string, where: string): void {
  const other = Number.parseInt(otherRaw, 10);
  if (!pidAlive(other) || other === process.pid) return;
  fs.appendFileSync(overlapPath, JSON.stringify({
    pid: process.pid, other, where, t: Date.now(),
  }) + "\\n");
}
const lock = process.argv[2]!;
const holdProbe = process.argv[3]!;
const csLog = process.argv[4]!;
const overlapPath = process.argv[5]!;
const stopPath = process.argv[6]!;
const holdMs = Number(process.argv[7]!);
const pollMs = Number(process.argv[8]!);
const opts = { timeoutMs: 8_000, pollMs };
let i = 0;
while (!fs.existsSync(stopPath) && i < 10_000) {
  i++;
  try {
    withProcessLockSync(lock, () => {
      try {
        if (fs.existsSync(holdProbe)) noteOverlap(fs.readFileSync(holdProbe, "utf8").trim(), "enter");
      } catch { /* */ }
      fs.writeFileSync(holdProbe, String(process.pid) + "\\n");
      const start = Date.now();
      while (Date.now() - start < holdMs) {
        try {
          const cur = fs.readFileSync(holdProbe, "utf8").trim();
          if (cur !== String(process.pid)) noteOverlap(cur, "mid");
        } catch { /* */ }
      }
      fs.appendFileSync(csLog, JSON.stringify({ pid: process.pid, i, t: Date.now() }) + "\\n");
      try {
        if (fs.readFileSync(holdProbe, "utf8").trim() === String(process.pid)) fs.unlinkSync(holdProbe);
      } catch { /* */ }
    }, opts);
  } catch { /* keep contending */ }
}
`, "utf8");

const children = new Map<number, ChildProcess>();
const ownedPids = new Set<number>();
let spawnCount = 0;
let stopping = false;

function spawnWorker(): void {
  spawnCount += 1;
  const child = spawn(viteNode, [
    "--root", repoRoot, workerPath, lock, holdProbe, csLog, overlapPath, stopPath,
    String(HOLD_MS), String(POLL_MS),
  ], { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] });
  if (child.pid) {
    ownedPids.add(child.pid);
    children.set(child.pid, child);
  }
  child.on("exit", () => {
    if (child.pid) {
      ownedPids.delete(child.pid);
      children.delete(child.pid);
    }
    if (!stopping && !fs.existsSync(stopPath) && children.size < WORKERS) spawnWorker();
  });
}

function countLines(file: string): number {
  try {
    return fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim()).length;
  } catch { return 0; }
}

for (let w = 0; w < WORKERS; w++) spawnWorker();

const killer = setInterval(() => {
  if (stopping || fs.existsSync(stopPath)) return;
  let holderPid: number | null = null;
  try {
    const n = Number.parseInt(fs.readFileSync(lock, "utf8").trim(), 10);
    if (Number.isInteger(n) && n > 0) holderPid = n;
  } catch { return; }
  if (holderPid === null || !ownedPids.has(holderPid)) return;
  const child = children.get(holderPid);
  if (!child || child.killed) return;
  try {
    child.kill("SIGKILL");
    fs.appendFileSync(killsPath, JSON.stringify({ killed: holderPid, t: Date.now() }) + "\n");
  } catch { /* */ }
}, KILL_EVERY_MS);

const started = Date.now();
await new Promise<void>((resolve) => {
  const tick = setInterval(() => {
    if (countLines(csLog) >= TARGET_CS || Date.now() - started >= MAX_MS) {
      clearInterval(tick);
      resolve();
    }
  }, 50);
});

fs.writeFileSync(stopPath, "1\n");
stopping = true;
clearInterval(killer);
await new Promise((r) => setTimeout(r, 400));
for (const [, c] of children) {
  try { c.kill("SIGKILL"); } catch { /* */ }
}

const overlaps = fs.readFileSync(overlapPath, "utf8").split("\n").filter((l) => l.trim());
const episodes = new Set<string>();
for (const line of overlaps) {
  try {
    const o = JSON.parse(line) as { pid: number; other: number; t: number };
    episodes.add(`${Math.min(o.pid, o.other)}-${Math.max(o.pid, o.other)}@${Math.floor(o.t / 50)}`);
  } catch { /* */ }
}

const report = {
  scenario: "continuous mutual-kill stress (pathological)",
  workers: WORKERS,
  targetCs: TARGET_CS,
  completedCriticalSections: countLines(csLog),
  kills: countLines(killsPath),
  workerSpawns: spawnCount,
  dualHolderEvents: overlaps.length,
  dualHolderEpisodes: episodes.size,
  elapsedMs: Date.now() - started,
  sampleOverlaps: overlaps.slice(0, 5),
};
console.log(JSON.stringify(report, null, 2));
try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* */ }
process.exitCode = episodes.size > 0 ? 2 : 0;
