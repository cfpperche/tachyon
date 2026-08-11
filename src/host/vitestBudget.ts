import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { withProcessLockSync } from "../locks/processLock.js";
import type { HostMemorySnapshot } from "./hostResources.js";
import hostResourceCostInputs from "../../shared/host-resource-cost-inputs.cjs";

/**
 * t-3ad4af — one HOST-WIDE budget for vitest, instead of N processes each dividing the same RAM.
 *
 * `recommendVitestMaxWorkers` sizes from `MemAvailable` at the instant a process starts, and nothing
 * discounts the siblings. Three concurrent vitest runs each saw ~10GB free, each subtracted the same
 * 3GB reserve, and each divided the same remainder: 9 workers apiece, 27 in total. The reserve was
 * counted three times and the budget was spent three times. None of the three was wrong on its own,
 * which is exactly why no per-process rule can fix it — on 2026-08-05 the host's RAM ran out and the
 * owner had to reboot the machine. Second occurrence of the family; the first (t-6a9bc4) bought the
 * global `verify:full` mutex, which does not help here because `vitest.config.ts` sizes EVERY `npx
 * vitest` and the primer tells every agent to run focused tests.
 *
 * So the unit that gets rationed here is the vitest INVOCATION, and the ledger below is the one place
 * that knows how many are alive.
 *
 * ## What a run actually costs (measured, not assumed — full journal in t-3ad4af)
 *
 * Sampling PSS per process across the whole vitest tree, full `test/unit` suite (700 files), this
 * repo, 24 CPUs / 15990MB:
 *
 * | maxWorkers | peak single worker | vitest parent | subprocesses the TESTS spawn | MemAvailable drop |
 * |------------|--------------------|---------------|------------------------------|-------------------|
 * | 4          | 289MB              | 507MB         | 2078MB                       | 2795MB            |
 * | 8          | 283MB              | 511MB         | 2451MB                       | 3655MB            |
 *
 * Fitting those two points on the axis the budget actually speaks: **215MB marginal per worker, and
 * 1935MB FIXED per invocation.** The old `DEFAULT_WORKER_MB = 768` is therefore wrong twice over. It
 * overcharges a worker by ~2.7x, which under-parallelizes a lone agent on a 24-CPU machine; and it
 * models the fixed cost as ZERO, which is precisely the term that multiplies when siblings appear.
 * Three concurrent runs cost ~5.8GB before a single worker is counted, and the old formula charged
 * nothing for it.
 *
 * The fixed term is not overhead nobody asked for: 74% of the tree at 4 workers is subprocesses the
 * TESTS themselves spawn — one `tsc --noEmit` alone peaked at 1536MB. A first reading of the same
 * samples blamed "one fat worker" for that 1.5GB; attributing by cmdline is what showed it was tsc.
 * Per-process attribution is the difference between a right number and a confident wrong one.
 */

const { DEFAULT_WORKER_MB, DEFAULT_RESERVE_MB, HARD_CAP_WORKERS, envInt } = hostResourceCostInputs;
export { envInt };
/** Measured ~1935MB fixed per invocation (vitest parent + the subprocesses its tests spawn). */
const DEFAULT_INVOCATION_MB = 2048;
/**
 * Deliberately lower than the free-RAM sizer's 128MB divisor floor. This ledger combines the
 * measured marginal worker cost with a separate fixed invocation charge, so the two floors guard
 * different cost models. An operator-provided marginal cost remains authoritative down to 64MB.
 */
const VITEST_LEDGER_MIN_WORKER_MB = 64;
/** Milliseconds. The critical section is a read-modify-write of a small JSON file. */
const LOCK_TIMEOUT_MS = 10_000;

/**
 * One resolution of the two cost inputs, shared by the sizing path and the unaccounted-fallback
 * path. Separate copies are how the number a fallback REPORTS drifts from the number a real run
 * would have claimed, and the fallback's number is the only thing a reader has to go on.
 */
function resolveCostsMb(input: { workerMb?: number; invocationMb?: number }): {
  workerMb: number;
  invocationMb: number;
} {
  return {
    workerMb: Math.max(
      VITEST_LEDGER_MIN_WORKER_MB,
      input.workerMb ?? envInt("TACHYON_VERIFY_WORKER_MB") ?? DEFAULT_WORKER_MB,
    ),
    invocationMb: Math.max(0, input.invocationMb ?? envInt("TACHYON_VITEST_INVOCATION_MB") ?? DEFAULT_INVOCATION_MB),
  };
}

export type VitestClaim = {
  pid: number;
  workers: number;
  /** What this run told its siblings it would cost: invocation + workers * worker. */
  costMb: number;
  startedAtMs: number;
  label: string;
};

export type HeldVitestClaim = {
  readonly workers: number;
  readonly costMb: number;
  /** Idempotent: drops this process's claim so the next arrival sees the RAM again. */
  release(): void;
};

export type VitestAdmission =
  | { ok: true; workers: number; claim: HeldVitestClaim; reason: string }
  | { ok: false; code: "HOST_BUDGET_EXHAUSTED"; reason: string };

/**
 * Take a share, and separate "the budget said no" from "the budget mechanism broke".
 *
 * A refusal is a DECISION and must stand — that is the whole guard. But an EACCES on a ledger or
 * lock file left by another user, a full tmpdir, a ledger path that is not a file: those are the
 * mechanism failing, and refusing on them would make every test in the repo unrunnable with no way
 * out. This repo has paid for that shape before — governed refusal without governed recovery
 * (t-0cbcbd) — so an infrastructure failure still ADMITS, loudly.
 *
 * t-ad8fd2 — what it must not do is admit at the OLD per-process width. Reaching this catch means
 * the ledger could not be read, written, or locked, so this invocation is invisible: nobody can see
 * it and it can see nobody. Per-process sizing is precisely the "size as if the machine were empty"
 * assumption whose three-way repeat exhausted the host and cost the owner a reboot (t-3ad4af), and
 * two unaccounted invocations at that width are that incident exactly.
 *
 * So the degraded run gets ONE worker. Three options were on the table and the reasoning is worth
 * keeping:
 *
 *  - REFUSE. Rejected: the gate is what proves delivery, and an unwritable tmpdir would take the
 *    whole repo's test suite down with no recovery. "Unknown" is not "known spent".
 *  - PROCEED AT A GUESSED COST. Rejected: nothing reads this claim's `costMb`, because there is no
 *    ledger to read it from. A number nobody can act on is decoration.
 *  - DEGRADE, STILL ACCOUNTED WHERE ACCOUNTING WORKS. Taken. It is what the memory-pressure path
 *    already does one layer up, for the reason stated there: a run at one worker still costs its
 *    fixed term, but it stops the MARGINAL cost from being multiplied by every invisible sibling.
 *
 * A CORRUPT ledger — one whose bytes we read and could not use — does not reach here. That case is
 * handled inside `admitVitestRun`, which degrades the same way but DOES record its claim, repairing
 * the file so the next arrival sees this run instead of an empty host. This catch is the residue:
 * the ledger could not be read or could not be written, and no accounting is available at all.
 * Deliberately, nothing is written on this path — see `readLedger`; bytes we failed to read may be
 * somebody's live claim, and overwriting them is how a REAL holder becomes the unaccounted one.
 *
 * `costMb` reports what this run will actually cost rather than the old `0`. It is unaccounted
 * either way; reporting zero additionally told the reader the run was free.
 */
export function admitOrFallback(
  input: Parameters<typeof admitVitestRun>[0],
  warn: (message: string) => void,
): VitestAdmission {
  try {
    return admitVitestRun(input);
  } catch (error) {
    const { workerMb, invocationMb } = resolveCostsMb(input);
    const workers = 1;
    const costMb = invocationMb + workers * workerMb;
    warn(
      `[vitest] host budget ledger unavailable (${(error as Error).message}). `
      + `This run cannot be recorded, so concurrent runs are NOT accounted for and cannot see it. `
      + `Degrading to ${workers} worker (~${costMb}MB) rather than per-process sizing: an invocation `
      + `nobody can see must not also be a wide one. Ledger: ${input.ledgerPath ?? vitestBudgetPath()}`,
    );
    return {
      ok: true,
      workers,
      claim: { workers, costMb, release: () => {} },
      reason:
        `host budget ledger unavailable — unaccounted fallback at ${workers} worker (~${costMb}MB, `
        + `not recorded, nothing to release)`,
    };
  }
}

export function vitestBudgetPath(): string {
  return process.env.TACHYON_VITEST_BUDGET_PATH || path.join(tmpdir(), "tachyon-vitest-budget.json");
}

function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists and belongs to another user — existing is what we asked.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * The ledger as this process can actually see it — and whether it saw ALL of it.
 *
 * t-ad8fd2. ABSENT and ILLEGIBLE are different facts, and collapsing them into the same empty array
 * is the defect. "Absent" is the first run on a machine and truthfully means nobody else is running.
 * "Illegible" means claims may exist that this process cannot read, and reading that as "nobody is
 * running" is exactly how an invocation sizes itself as if the host were empty.
 *
 * Measured, on a non-root user, which of these actually happens:
 *
 * | ledger state                        | before                                    | now             |
 * |-------------------------------------|-------------------------------------------|-----------------|
 * | absent (ENOENT)                     | `[]` — correct, normal first run          | unchanged       |
 * | unparseable / non-array / bad shape | `[]`, sized as if empty, claim overwritten| degrade + repair|
 * | present but unreadable (EACCES…)    | `[]`, sized as if empty, NO WARNING       | throws          |
 *
 * The third row was the worst and the quietest: a real 16-worker holder sat in a file this process
 * could not read, and the arriving run both ignored it and then OVERWROTE its claim — turning the
 * holder into the unaccounted invocation. That one is not survivable in place, so it throws and
 * lands in `admitOrFallback`, which degrades WITHOUT writing: bytes we could not read may hold live
 * claims, and rewriting the file is precisely how their memory stops being counted.
 *
 * Content we DID read and found unusable is the opposite case — there is no live claim in there to
 * destroy — so it degrades and writes, and the write repairs the file for whoever arrives next.
 *
 * Claims that ARE readable are still returned alongside the flag — billing the siblings we can see
 * is strictly better than billing none, and the flag is what stops us pretending we saw them all.
 */
type LedgerView = {
  claims: VitestClaim[];
  /** Why this read is incomplete. Absent means the ledger was fully legible. */
  illegible?: string;
};

function readLedger(file: string): LedgerView {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // ENOENT is the ONLY benign read failure: no ledger yet, so nobody is running. It must never
    // degrade or refuse — a first run on a fresh machine is the normal case, not an incident.
    if (code === "ENOENT") return { claims: [] };
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // A truncated or hand-edited ledger must not wedge every test run in the repo, so this still
    // does not refuse — but it no longer reports an empty host. The claims are genuinely lost;
    // what changes is that the run which finds them lost sizes to the floor instead of to the cap,
    // and the claim it writes repairs the file for whoever arrives next.
    return { claims: [], illegible: "unparseable JSON" };
  }
  if (!Array.isArray(parsed)) return { claims: [], illegible: "not an array" };
  const claims = parsed.filter((entry): entry is VitestClaim =>
    !!entry
    && typeof entry === "object"
    && Number.isInteger((entry as VitestClaim).pid)
    && Number.isFinite((entry as VitestClaim).costMb)
    && Number.isFinite((entry as VitestClaim).workers));
  // A partially malformed ledger is partially invisible. Bill what we can read, and say we could
  // not read the rest — silently dropping an entry is the same fail-open one row down.
  if (claims.length !== parsed.length) {
    return { claims, illegible: `${parsed.length - claims.length} of ${parsed.length} entries malformed` };
  }
  return { claims };
}

function writeLedger(file: string, claims: VitestClaim[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(claims), { mode: 0o600 });
}

/**
 * Drop claims whose holder is gone. Liveness ONLY, never age.
 *
 * `processLock` offers `maxHoldMs` so a WAITING caller cannot be wedged forever by a recycled pid,
 * and pays for it by sometimes robbing a live-but-slow holder. A vitest run legitimately holds its
 * claim for minutes — a full suite here is ~2 minutes and a slow one much longer — so any age rule
 * would evict runs that are still using the RAM, and hand a sibling a budget that is not free. That
 * trade just cost this repo the t-099847 regression, and nothing here needs it: a claim is anchored
 * to a PROCESS, so a dead pid is positive evidence the memory is back. Nobody waits on this ledger,
 * so the wedge that `maxHoldMs` exists to prevent has no way to form.
 */
function reap(claims: VitestClaim[], isAlive: (pid: number) => boolean): VitestClaim[] {
  return claims.filter((claim) => isAlive(claim.pid));
}

/**
 * What a live sibling has ACTUALLY taken so far: the summed PSS of its whole process tree.
 *
 * PSS, not RSS, because a fork pool shares the node binary and its copy-on-write heap across a dozen
 * processes; RSS bills every one of them for the same pages and roughly doubles the answer. Returns
 * undefined where /proc is not available, and the caller then falls back to the recorded claim.
 */
export function measureTreePssMb(pid: number, procRoot = "/proc"): number | undefined {
  let entries: string[];
  try {
    entries = fs.readdirSync(procRoot);
  } catch {
    return undefined; // not Linux, or no /proc — the caller falls back to the claim
  }
  const byParent = new Map<number, number[]>();
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    let stat: string;
    try {
      stat = fs.readFileSync(path.join(procRoot, entry, "stat"), "utf8");
    } catch {
      continue; // exited between the listing and the read
    }
    // `comm` is parenthesised and may itself contain spaces and parens, so ppid is located from the
    // LAST ')' rather than by splitting the line.
    const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
    if (!Number.isInteger(ppid)) continue;
    if (!byParent.has(ppid)) byParent.set(ppid, []);
    byParent.get(ppid)!.push(Number(entry));
  }
  let totalKb = 0;
  const stack = [pid];
  const seen = new Set<number>();
  while (stack.length) {
    const current = stack.pop()!;
    if (seen.has(current)) continue;
    seen.add(current);
    try {
      const rollup = fs.readFileSync(path.join(procRoot, String(current), "smaps_rollup"), "utf8");
      const pss = rollup.match(/^Pss:\s+(\d+) kB$/m);
      if (pss) totalKb += Number(pss[1]);
    } catch {
      /* exited, or kernel without smaps_rollup — it contributes nothing rather than failing the read */
    }
    for (const child of byParent.get(current) ?? []) stack.push(child);
  }
  return Math.round(totalKb / 1024);
}

/**
 * The pids between this process and init, nearest first. Linux-only; `undefined` where /proc is not
 * readable, which the caller must read as "cannot tell" rather than "no ancestors".
 *
 * Same `stat` parsing as `measureTreePssMb` and for the same reason: `comm` is parenthesised and may
 * contain spaces and parens, so ppid is located from the LAST ')'.
 */
export function ancestorPids(pid: number, procRoot = "/proc"): number[] | undefined {
  const chain: number[] = [];
  const seen = new Set<number>([pid]);
  let current = pid;
  // A process tree deep enough to exhaust this is not one this ledger can reason about anyway.
  for (let hops = 0; hops < 64; hops++) {
    let stat: string;
    try {
      stat = fs.readFileSync(path.join(procRoot, String(current), "stat"), "utf8");
    } catch {
      // The first read failing means no /proc at all — we cannot tell. A later one failing means the
      // ancestor exited mid-walk, and what we already collected is still true.
      return chain.length > 0 ? chain : undefined;
    }
    const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
    if (!Number.isInteger(ppid) || ppid <= 1 || seen.has(ppid)) return chain;
    chain.push(ppid);
    seen.add(ppid);
    current = ppid;
  }
  return chain;
}

/**
 * What a live sibling is BILLED: its whole claim until it outgrows it, and its real size after.
 *
 * The claim is the FLOOR, not the measurement, and that ordering is the safety property. A run that
 * started a second ago has allocated almost nothing; billing it by measurement alone would admit a
 * sibling against RAM the first run is about to take, which is the original defect wearing a new
 * instrument. Measuring only ever RAISES the bill, for the run that outgrew what it reserved.
 *
 * This is only affordable because the claim itself is honest — see `maxUsefulWorkers` below. Billing
 * the claim while a focused single-file run reserved sixteen workers' worth would refuse the second
 * agent on a machine with room for six, and the primer tells every agent to run focused tests, so
 * the common case would be the broken one. The two changes only work as a pair.
 */
function billedMb(claim: VitestClaim, measure: (pid: number) => number | undefined): {
  chargeMb: number;
  materializedMb: number;
} {
  const measured = measure(claim.pid);
  if (measured === undefined) return { chargeMb: claim.costMb, materializedMb: claim.costMb };
  return { chargeMb: Math.max(measured, claim.costMb), materializedMb: measured };
}

/**
 * How much a vitest invocation may spend, given who else is already spending.
 *
 * Two views of the host, and the SMALLER one wins:
 *
 *  - `memTotal - reserve` is the structural ceiling. Budgeting from this is what stops the reserve
 *    being subtracted once per process, which was the original defect.
 *  - `memAvailable + materialized` reconstructs what the machine would look like with no vitest
 *    running: `memAvailable` is already depressed by whatever the siblings have actually allocated,
 *    so adding that back removes the double count before they are charged once, below. Note it adds
 *    back what siblings MATERIALIZED, never what they were billed — billing a sibling more than it
 *    has taken must shrink the share, and adding the same inflated number back to the pool would
 *    silently cancel that out. This is also the view that notices pressure the ledger cannot see: a
 *    browser, the extension host, the agents' own CLI processes at 259-518MB each.
 *
 * Taking the minimum means an idle machine gives a lone agent the whole thing, while a machine busy
 * with non-vitest work shrinks the pool for everyone.
 */
export function vitestPoolMb(input: { memory: HostMemorySnapshot; materializedMb: number; reserveMb?: number }): number {
  const reserve = input.reserveMb ?? envInt("TACHYON_VERIFY_RESERVE_MB") ?? DEFAULT_RESERVE_MB;
  if (input.memory.source === "unavailable") {
    // No reading of the host at all. Admit a single conservative run rather than guessing wide.
    return DEFAULT_INVOCATION_MB + 4 * DEFAULT_WORKER_MB;
  }
  const fromTotal = input.memory.memTotalMb - reserve;
  const fromAvailable = input.memory.memAvailableMb + input.materializedMb;
  return Math.max(0, Math.min(fromTotal, fromAvailable));
}

/**
 * Pure sizing, given a pool and what siblings hold. Exported so the concurrency test can pin it.
 *
 * `maxUsefulWorkers` is what keeps the claim honest, and the honest claim is what lets `billedMb`
 * use the claim as a floor. Vitest never spawns more workers than it has test files, so a run over
 * explicitly named files reserves what it can actually use rather than the full worker cap. Without
 * it, every focused run would reserve a full suite's worth of RAM it will never touch.
 */
export function sizeFromShare(input: {
  shareMb: number;
  cpuCount: number;
  workerMb?: number;
  invocationMb?: number;
  hardCap?: number;
  maxUsefulWorkers?: number;
}): number {
  const workerMb = Math.max(VITEST_LEDGER_MIN_WORKER_MB, input.workerMb ?? envInt("TACHYON_VERIFY_WORKER_MB") ?? DEFAULT_WORKER_MB);
  const invocationMb = Math.max(0, input.invocationMb ?? envInt("TACHYON_VITEST_INVOCATION_MB") ?? DEFAULT_INVOCATION_MB);
  const cpu = Math.max(1, input.cpuCount || 1);
  const hardCap = input.hardCap ?? HARD_CAP_WORKERS;
  const useful = input.maxUsefulWorkers !== undefined && input.maxUsefulWorkers >= 1
    ? input.maxUsefulWorkers
    : Number.POSITIVE_INFINITY;
  const forWorkers = input.shareMb - invocationMb;
  if (forWorkers < workerMb) return 0; // cannot even afford one — the caller must refuse
  return Math.max(1, Math.min(Math.floor(forWorkers / workerMb), cpu, hardCap, useful));
}

/**
 * t-690f52 — a vitest run spawned INSIDE another one inherits its ancestor's claim instead of
 * opening a second one, because its RAM is already billed to that ancestor. Twice over.
 *
 * Two `.gen` tests here run `npx vitest` from inside a test, and under the 16-worker gate that child
 * was being refused (measured: pool 8936MB, gate billed 7168MB, a second agent's run billed 2368MB,
 * share -600MB against the 832MB a focused child needs). The refusal is the t-3ad4af guard doing
 * exactly what it was built to do to an N+1th SIBLING — and a descendant is not a sibling:
 *
 *  - `DEFAULT_INVOCATION_MB` was measured as "the vitest parent PLUS the subprocesses its tests
 *    spawn" — 74% of the tree at 4 workers was test-spawned subprocesses. A nested `npx vitest` is
 *    one of those subprocesses. The ancestor already reserved it inside that fixed term.
 *  - `measureTreePssMb` walks the ancestor's whole tree, so once the ancestor outgrows its claim the
 *    child's pages are literally inside the ancestor's bill.
 *
 * So the old path charged the same memory twice, and the double charge is what turned a run that fit
 * into a refusal. Inheriting moves the child from counted-TWICE to counted-ONCE — never to zero,
 * which is the property that matters. A third party sizing against this host still sees the child's
 * RAM, inside the ancestor's claim floor while it is young and inside the ancestor's measured tree
 * once it is not. An invisible sibling was the original defect; this child is not invisible, it is
 * billed at its ancestor's door.
 *
 * "Refuse, do not degrade" is untouched for everyone else, and it does not transfer here for a
 * mechanical reason: refusing an N+1th independent run stops ~2GB from being taken, while refusing a
 * descendant frees NOTHING — the ancestor holds the RAM either way — and only breaks the test that
 * is blocked on it. What it can still do is bound the child, so an inherited run is sized from what
 * the ancestor reserved and has not yet materialized, with a floor of one worker.
 *
 * Reachable by: the two `.gen` tests (Agent/test trigger); anything a test spawns that transitively
 * runs vitest. NOT by `verify:full`, whose runner holds no claim of its own, so its vitest child is
 * top-level and still faces the full host-wide gate.
 */
function admitNested(input: {
  live: VitestClaim[];
  pid: number;
  measure: (pid: number) => number | undefined;
  ancestorsOf: (pid: number) => number[] | undefined;
  cpuCount: number;
  workerMb: number;
  invocationMb: number;
  hardCap?: number;
  maxUsefulWorkers?: number;
  forcedWorkers?: number;
}): VitestAdmission | undefined {
  const ancestors = input.ancestorsOf(input.pid);
  if (ancestors === undefined || ancestors.length === 0) return undefined;
  // Nearest ancestor first: with vitest inside vitest inside vitest, the innermost claim is the one
  // whose headroom is actually left to spend.
  const holder = ancestors.map((pid) => input.live.find((claim) => claim.pid === pid)).find(Boolean);
  if (!holder) return undefined;

  const materializedMb = input.measure(holder.pid) ?? 0;
  const headroomMb = Math.max(0, holder.costMb - materializedMb);
  const sized = sizeFromShare({
    shareMb: headroomMb,
    cpuCount: input.cpuCount,
    workerMb: input.workerMb,
    invocationMb: input.invocationMb,
    ...(input.hardCap !== undefined ? { hardCap: input.hardCap } : {}),
    ...(input.maxUsefulWorkers !== undefined ? { maxUsefulWorkers: input.maxUsefulWorkers } : {}),
  });
  // `TACHYON_VITEST_MAX_WORKERS` may only ever LOWER an inherited run. It is the escape hatch for a
  // caller who takes RAM deliberately, and a nested child takes its ancestor's rather than its own —
  // it also inherits the variable through the environment without anyone aiming it at the child.
  const bounded = input.forcedWorkers !== undefined && input.forcedWorkers >= 1
    ? Math.min(Math.trunc(input.forcedWorkers), Math.max(1, sized))
    : Math.max(1, sized);
  const workers = Math.max(1, Math.min(bounded, input.hardCap ?? HARD_CAP_WORKERS, Math.max(1, input.cpuCount || 1)));

  return {
    ok: true,
    workers,
    // costMb 0 and a no-op release: NOTHING is written to the ledger, because writing a claim here
    // is the double count. Recording it would bill this tree once at its own pid and again inside
    // the ancestor's tree PSS.
    claim: { workers, costMb: 0, release: () => {} },
    reason:
      `nested vitest run: inheriting the claim of ${holder.label}#${holder.pid} `
      + `(${holder.workers}w, claimed ${holder.costMb}MB, using ${materializedMb}MB) rather than taking a second one — `
      + `this process is inside that run's tree and is already billed there. Headroom ${headroomMb}MB `
      + `→ workers=${workers}, claiming 0MB (t-690f52)`
      + (headroomMb === 0
        ? `. WARNING: the ancestor has outgrown its claim, so this run is sized to the floor of 1 worker `
        + `and the host is over its reservation until it exits.`
        : ""),
  };
}

/**
 * Shared host-budget arithmetic for admit (claim) and preview (display).
 *
 * NEVER writes the ledger. Callers that need a claim do so themselves after this returns.
 * t-7f9809: one math path so the number the snapshot reports cannot drift from the number a real
 * run would receive.
 */
function evaluateVitestShare(input: {
  memory: HostMemorySnapshot;
  cpuCount: number;
  ledgerPath?: string;
  isAlive?: (pid: number) => boolean;
  measure?: (pid: number) => number | undefined;
  /** When set, drop this pid's claim so a process never bills itself (admit path). */
  excludePid?: number;
  workerMb?: number;
  invocationMb?: number;
  reserveMb?: number;
  hardCap?: number;
  maxUsefulWorkers?: number;
}): {
  file: string;
  live: VitestClaim[];
  billed: Array<{ claim: VitestClaim; chargeMb: number; materializedMb: number }>;
  usedMb: number;
  poolMb: number;
  shareMb: number;
  workers: number;
  workerMb: number;
  invocationMb: number;
  illegible?: string;
} {
  const file = input.ledgerPath ?? vitestBudgetPath();
  const isAlive = input.isAlive ?? defaultIsAlive;
  const measure = input.measure ?? ((target: number) => measureTreePssMb(target));
  const view = readLedger(file);
  const live = reap(view.claims, isAlive).filter((claim) =>
    input.excludePid === undefined || claim.pid !== input.excludePid);

  const { workerMb, invocationMb } = resolveCostsMb(input);

  const billed = live.map((claim) => ({ claim, ...billedMb(claim, measure) }));
  const usedMb = billed.reduce((sum, entry) => sum + entry.chargeMb, 0);
  const materializedMb = billed.reduce((sum, entry) => sum + entry.materializedMb, 0);
  const poolMb = vitestPoolMb({ memory: input.memory, materializedMb, reserveMb: input.reserveMb });
  const shareMb = poolMb - usedMb;
  const sized = sizeFromShare({
    shareMb,
    cpuCount: input.cpuCount,
    workerMb,
    invocationMb,
    hardCap: input.hardCap,
    maxUsefulWorkers: input.maxUsefulWorkers,
  });

  // t-ad8fd2 — a share computed from a ledger we could not fully read is a share computed against
  // an unknown number of siblings, so it must not be spent at full width. One worker, which is what
  // the memory-pressure path already degrades to (`vitest.config.ts`), and for the same stated
  // reason: the run still happens, still takes a claim, and costs the marginal workers it cannot
  // prove are free. `Math.min` and not a flat 1 because a share of ZERO is a refusal, and an
  // unreadable ledger must not turn a refusal into an admission.
  const workers = view.illegible === undefined ? sized : Math.min(1, sized);

  return {
    file, live, billed, usedMb, poolMb, shareMb, workers, workerMb, invocationMb,
    ...(view.illegible !== undefined ? { illegible: view.illegible } : {}),
  };
}

/**
 * Take a share of the host-wide vitest budget, or refuse.
 *
 * REFUSING is the point, and it is the half of this that the DONE_WHEN names: a run that cannot
 * afford its own fixed cost must not start, because STARTING it is the harm. Sizing it down to one
 * worker would not help — the ~1.9GB an invocation costs before its first worker is what actually
 * exhausted the machine, so "just one worker" is still ~2GB this host does not have.
 */
export function admitVitestRun(input: {
  memory: HostMemorySnapshot;
  cpuCount: number;
  label: string;
  ledgerPath?: string;
  isAlive?: (pid: number) => boolean;
  /** Injected by tests. Production reads the sibling's real process tree from /proc. */
  measure?: (pid: number) => number | undefined;
  now?: () => number;
  pid?: number;
  /** Injected by tests. Production walks /proc upward looking for a claim-holding ancestor. */
  ancestorsOf?: (pid: number) => number[] | undefined;
  workerMb?: number;
  invocationMb?: number;
  reserveMb?: number;
  hardCap?: number;
  /** Vitest never spawns more workers than test files; reserving beyond that is reserving fiction. */
  maxUsefulWorkers?: number;
  /** Bypass the refusal with an explicit count — the caller takes responsibility, but still claims. */
  forcedWorkers?: number;
}): VitestAdmission {
  const file = input.ledgerPath ?? vitestBudgetPath();
  const now = input.now ?? Date.now;
  const pid = input.pid ?? process.pid;

  return withProcessLockSync(`${file}.lock`, (): VitestAdmission => {
    // Our own stale claim (same pid, an earlier run in this process) must never be counted against us.
    const share = evaluateVitestShare({
      memory: input.memory,
      cpuCount: input.cpuCount,
      ledgerPath: file,
      isAlive: input.isAlive,
      measure: input.measure,
      excludePid: pid,
      workerMb: input.workerMb,
      invocationMb: input.invocationMb,
      reserveMb: input.reserveMb,
      hardCap: input.hardCap,
      maxUsefulWorkers: input.maxUsefulWorkers,
    });
    const { live, billed, usedMb, poolMb, shareMb, workerMb, invocationMb, illegible } = share;

    // Before any of the host-wide arithmetic is spent on this run: is it a DESCENDANT of a run that
    // has already paid for it? Ordered first because the answer makes the share irrelevant — an
    // inherited run is not spending the pool, it is spending its ancestor's reservation.
    const inherited = admitNested({
      live,
      pid,
      measure: input.measure ?? ((target: number) => measureTreePssMb(target)),
      ancestorsOf: input.ancestorsOf ?? ancestorPids,
      cpuCount: input.cpuCount,
      workerMb,
      invocationMb,
      ...(input.hardCap !== undefined ? { hardCap: input.hardCap } : {}),
      ...(input.maxUsefulWorkers !== undefined ? { maxUsefulWorkers: input.maxUsefulWorkers } : {}),
      ...(input.forcedWorkers !== undefined ? { forcedWorkers: input.forcedWorkers } : {}),
    });
    if (inherited) return inherited;

    let workers = share.workers;

    if (input.forcedWorkers !== undefined && input.forcedWorkers >= 1) {
      workers = Math.min(input.forcedWorkers, input.hardCap ?? HARD_CAP_WORKERS, Math.max(1, input.cpuCount || 1));
    } else if (workers === 0) {
      const holders = billed
        .map((entry) => `${entry.claim.label}#${entry.claim.pid}(${entry.claim.workers}w, using ${entry.materializedMb}MB, billed ${entry.chargeMb}MB)`)
        .join(", ");
      return {
        ok: false,
        code: "HOST_BUDGET_EXHAUSTED",
        reason:
          `vitest refused: the host-wide vitest budget is spent. Pool ${poolMb}MB, `
          + `${live.length} run(s) already hold ${usedMb}MB, leaving ${shareMb}MB — `
          + `less than the ${invocationMb}MB + ${workerMb}MB one run needs. Holders: ${holders || "(none)"}. `
          + `t-3ad4af host protection: an N+1th concurrent run costs ~${invocationMb}MB before its first `
          + `worker, so sizing down would not make it fit. Wait for a run to finish, or set `
          + `TACHYON_VITEST_MAX_WORKERS to take the RAM deliberately. Ledger: ${file}`,
      };
    }

    const costMb = invocationMb + workers * workerMb;
    writeLedger(file, [...live, { pid, workers, costMb, startedAtMs: now(), label: input.label }]);

    let released = false;
    const claim: HeldVitestClaim = {
      workers,
      costMb,
      release() {
        if (released) return;
        released = true;
        try {
          withProcessLockSync(`${file}.lock`, () => {
            // An UNREADABLE ledger throws out of here into the catch below. A partly malformed one
            // does not, and must not be rewritten either: writing back only the entries we
            // understood would delete the rest on the way out. Leaving it alone costs nothing —
            // this process is exiting, so pid liveness reaps our own claim at the next read.
            const view = readLedger(file);
            if (view.illegible !== undefined) return;
            writeLedger(file, view.claims.filter((entry) => entry.pid !== pid));
          }, { timeoutMs: LOCK_TIMEOUT_MS, label: "tachyon vitest budget ledger" });
        } catch {
          // Best-effort: a claim we fail to drop is reaped by liveness the moment this process exits.
        }
      },
    };

    return {
      ok: true,
      workers,
      claim,
      reason:
        `host vitest budget: pool ${poolMb}MB, ${live.length} sibling run(s) hold ${usedMb}MB, `
        + `share ${shareMb}MB → workers=${workers} (claiming ${costMb}MB)`
        + (illegible === undefined
          ? ""
          : `. WARNING: the ledger was only partly legible (${illegible}), so an unknown number of `
          + `sibling runs are invisible to this one — degraded to one worker rather than sizing as if `
          + `the host were empty. This claim IS recorded, so the next arrival sees this run. `
          + `Ledger: ${file}`),
    };
  }, { timeoutMs: LOCK_TIMEOUT_MS, label: "tachyon vitest budget ledger" });
}

/**
 * t-7f9809 — what a NEW vitest run would receive RIGHT NOW, without claiming.
 *
 * Same arithmetic as `admitVitestRun` (`evaluateVitestShare`); the only difference is this function
 * never writes the ledger and never returns a claim. The Runtime Ops snapshot (and any future
 * display) must use this rather than `decideHeavyGate()`, which sizes as if the process were alone.
 *
 * When the budget is spent, `ok` is false and `workers` is 0 — the only state where alone-sizing
 * and reality disagree about yes-versus-no, not only magnitude. Context fields travel with the
 * number so a later consumer can explain the figure without re-reading the ledger.
 */
export type VitestSharePreview = {
  ok: boolean;
  workers: number;
  siblingCount: number;
  usedMb: number;
  shareMb: number;
  poolMb: number;
  reason: string;
};

export function previewVitestShare(input: {
  memory: HostMemorySnapshot;
  cpuCount: number;
  ledgerPath?: string;
  isAlive?: (pid: number) => boolean;
  measure?: (pid: number) => number | undefined;
  workerMb?: number;
  invocationMb?: number;
  reserveMb?: number;
  hardCap?: number;
  maxUsefulWorkers?: number;
}): VitestSharePreview {
  const file = input.ledgerPath ?? vitestBudgetPath();

  // Lock only for a consistent ledger read (same critical section admit uses). Never write.
  return withProcessLockSync(`${file}.lock`, (): VitestSharePreview => {
    const share = evaluateVitestShare({
      memory: input.memory,
      cpuCount: input.cpuCount,
      ledgerPath: file,
      isAlive: input.isAlive,
      measure: input.measure,
      // No excludePid: a brand-new run is not already on the ledger.
      workerMb: input.workerMb,
      invocationMb: input.invocationMb,
      reserveMb: input.reserveMb,
      hardCap: input.hardCap,
      maxUsefulWorkers: input.maxUsefulWorkers,
    });
    const { live, usedMb, poolMb, shareMb, workers, workerMb, invocationMb, illegible } = share;
    // Same degrade as the admit path, and the display must not disagree with it: a snapshot showing
    // the cap while a real run would receive one worker is the drift `evaluateVitestShare` exists to
    // prevent. The caller already treats a thrown preview as "we cannot say" (snapshotService).
    const caveat = illegible === undefined
      ? ""
      : `. WARNING: ledger only partly legible (${illegible}) — an unknown number of runs are `
      + `invisible, so this is degraded to one worker rather than sized against an empty host`;

    if (workers === 0) {
      return {
        ok: false,
        workers: 0,
        siblingCount: live.length,
        usedMb,
        shareMb,
        poolMb,
        reason:
          `host vitest budget spent: pool ${poolMb}MB, ${live.length} sibling run(s) hold ${usedMb}MB, `
          + `leaving ${shareMb}MB — less than the ${invocationMb}MB + ${workerMb}MB one run needs${caveat}`,
      };
    }

    return {
      ok: true,
      workers,
      siblingCount: live.length,
      usedMb,
      shareMb,
      poolMb,
      reason:
        `host vitest budget preview: pool ${poolMb}MB, ${live.length} sibling run(s) hold ${usedMb}MB, `
        + `share ${shareMb}MB → workers=${workers} (not claimed)${caveat}`,
    };
  }, { timeoutMs: LOCK_TIMEOUT_MS, label: "tachyon vitest budget ledger" });
}
