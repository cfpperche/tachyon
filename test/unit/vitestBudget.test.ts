import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  admitVitestRun,
  admitOrFallback,
  ancestorPids,
  envInt,
  previewVitestShare,
  sizeFromShare,
  vitestPoolMb,
  measureTreePssMb,
  type VitestClaim,
} from "../../src/host/vitestBudget.js";
import { recommendVitestMaxWorkers, type HostMemorySnapshot } from "../../src/host/hostResources.js";
import hostResourceCostInputs from "../../shared/host-resource-cost-inputs.cjs";

/**
 * t-3ad4af — the defect was a SUM, so every test here is about more than one sizer.
 *
 * The incident: six agents running focused tests, six independent sizers, each reading ~10GB free,
 * each subtracting the same 3GB reserve, each dividing the same remainder. The host's RAM ran out
 * and the owner rebooted the machine. No single process was wrong, which is why a test that runs one
 * sizer can never see this — the assertions below all involve concurrent holders.
 */

const HOST: HostMemorySnapshot = {
  memTotalMb: 15_990,
  memAvailableMb: 15_990,
  swapTotalMb: 0,
  swapFreeMb: 0,
  source: "proc-meminfo",
};

const RESERVE_MB = 3_072;
const INVOCATION_MB = 2_048;
const WORKER_MB = 320;
const POOL_MB = HOST.memTotalMb - RESERVE_MB;
/**
 * t-fb7025 — the cap is read, never restated. Its VALUE is pinned once, in
 * `hostResources.test.ts`; here the question is only whether the ledger applies it, so a literal
 * would turn every arithmetic assertion below into a second, silent pin of an operator constant.
 */
const CAP = hostResourceCostInputs.HARD_CAP_WORKERS as number;

/**
 * t-fb7025 — a host where the SIBLING DISCOUNT is observable, and that is the whole reason it
 * exists.
 *
 * `HOST` has room for more than one cap-sized claim, so the second arrival there comes back at the
 * cap: capped, not discounted. An assertion like "the next run gets less" would then be reporting a
 * subtraction that never happened — it would pass on a machine where the ledger was doing nothing.
 * This one affords exactly one cap-sized claim plus a remainder, so any number below the cap can
 * only have come from the sibling.
 */
const TIGHT_HOST: HostMemorySnapshot = { ...HOST, memTotalMb: 11_000, memAvailableMb: 11_000 };

const temporaries: string[] = [];
const spawned: ReturnType<typeof spawn>[] = [];

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaries.push(dir);
  return dir;
}

function ledgerFile(): string {
  return path.join(tempDir("tachyon-vitest-budget-test-"), "budget.json");
}

/** A ledger path that is a DIRECTORY, so writing it fails the way a broken ledger does. */
function brokenLedgerPath(): string {
  return tempDir("tachyon-vitest-budget-broken-");
}

afterEach(() => {
  for (const child of spawned.splice(0)) {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
  for (const dir of temporaries.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A real live process to anchor a claim to, so pid liveness is exercised rather than stubbed. */
function liveProcess(): number {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)"], { stdio: "ignore" });
  spawned.push(child);
  return child.pid!;
}

function readLedger(file: string): VitestClaim[] {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

describe("vitest host budget (t-3ad4af)", () => {
  it("uses the shared cost inputs by identity while keeping the ledger's measured floor intentional", () => {
    // t-f60468 — identity, not source text, catches a faithful local env parser copied back here.
    expect(envInt).toBe(hostResourceCostInputs.envInt);

    // The free-RAM sizer has no fixed invocation term and protects its divisor at 128MB. The
    // host-wide ledger separately charges 2048MB per invocation, so its marginal worker input is
    // intentionally authoritative down to 64MB. Pin the difference so it cannot drift silently.
    const memory: HostMemorySnapshot = { ...HOST, memAvailableMb: 3_500 };
    expect(recommendVitestMaxWorkers({ memory, cpuCount: 24, reserveMb: 3_072, workerMb: 100 })).toBe(3);
    expect(sizeFromShare({ shareMb: 2_448, cpuCount: 24, invocationMb: 2_048, workerMb: 100 })).toBe(4);
  });

  it("reproduces the incident: the OLD per-process sizer lets three concurrent runs divide one budget", () => {
    // The exact reading from the incident logs: MemAvailable 10190MB → workers=9, three times over.
    const duringIncident: HostMemorySnapshot = { ...HOST, memAvailableMb: 10_190 };
    const each = recommendVitestMaxWorkers({
      memory: duringIncident,
      cpuCount: 24,
      reserveMb: RESERVE_MB,
      workerMb: 768, // the estimate in force at the time
      hardCap: 16, // likewise the cap in force at the time — t-fb7025 later lowered it to 8
    });
    expect(each).toBe(9);

    // Three sizers, none of them wrong on its own, all of them dividing the same remainder. The
    // reserve is subtracted three times and the machine is oversubscribed by construction.
    const concurrent = 3;
    const reserveCountedTimes = concurrent * RESERVE_MB;
    expect(reserveCountedTimes).toBeGreaterThan(RESERVE_MB);
    expect(concurrent * each).toBe(27);
    // 27 workers at the REAL measured marginal cost is far past what the host had free.
    expect(concurrent * (INVOCATION_MB + each * WORKER_MB)).toBeGreaterThan(duringIncident.memAvailableMb);
  });

  it("charges the reserve once host-wide, not once per sizer", () => {
    // Whatever the siblings hold, the pool never exceeds total-minus-one-reserve.
    for (const materializedMb of [0, 2_000, 6_000]) {
      expect(vitestPoolMb({ memory: HOST, materializedMb, reserveMb: RESERVE_MB })).toBe(POOL_MB);
    }
  });

  it("keeps the SUM of concurrent sizers inside the host budget, and refuses rather than overcommit", () => {
    const file = ledgerFile();
    const admitted: { workers: number; costMb: number }[] = [];
    let refusals = 0;

    // Ten arrivals against a pool that fits far fewer. Each is anchored to a real live pid and holds
    // its claim, exactly as a running vitest would.
    for (let i = 0; i < 10; i++) {
      const decision = admitVitestRun({
        memory: HOST,
        cpuCount: 8,
        label: `run${i}`,
        ledgerPath: file,
        pid: liveProcess(),
        reserveMb: RESERVE_MB,
        invocationMb: INVOCATION_MB,
        workerMb: WORKER_MB,
        // Nothing has actually allocated yet: bill every holder its full claim. This is the moment
        // the incident happened in — all six sizers ran before any of them had taken its RAM.
        measure: () => undefined,
      });
      if (decision.ok) admitted.push({ workers: decision.workers, costMb: decision.claim.costMb });
      else refusals++;
    }

    expect(admitted.length).toBeGreaterThan(1); // more than one run still gets in
    expect(refusals).toBeGreaterThan(0); // and the budget does run out

    // THE GUARD: the sum of everything admitted fits in the host budget.
    const totalMb = admitted.reduce((sum, run) => sum + run.costMb, 0);
    expect(totalMb).toBeLessThanOrEqual(POOL_MB);

    // Every admitted run is in the ledger exactly once — no claim was lost or double-counted.
    const ledger = readLedger(file);
    expect(ledger).toHaveLength(admitted.length);
    expect(ledger.reduce((sum, claim) => sum + claim.costMb, 0)).toBe(totalMb);
  });

  it("gives a lone sizer the whole machine", () => {
    const file = ledgerFile();
    const decision = admitVitestRun({
      memory: HOST,
      cpuCount: 24,
      label: "alone",
      ledgerPath: file,
      pid: liveProcess(),
      reserveMb: RESERVE_MB,
      invocationMb: INVOCATION_MB,
      workerMb: WORKER_MB,
      measure: () => undefined,
    });
    expect(decision.ok).toBe(true);
    // t-3ad4af's fix was the LEDGER, not a smaller cap: one agent alone on a 24-CPU machine is not
    // discounted for siblings that do not exist, so it still gets the whole cap — whatever the cap
    // is. (t-fb7025 later lowered that cap for an unrelated reason, CPU load rather than RAM; this
    // assertion is about the discount being absent, and never was about the number.)
    if (decision.ok) expect(decision.workers).toBe(CAP);
  });

  it("does not bill a run whose process has died", async () => {
    const file = ledgerFile();
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)"], { stdio: "ignore" });
    const deadPid = child.pid!;
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));

    const first = admitVitestRun({
      memory: HOST,
      cpuCount: 8,
      label: "crashes",
      ledgerPath: file,
      pid: deadPid,
      reserveMb: RESERVE_MB,
      invocationMb: INVOCATION_MB,
      workerMb: WORKER_MB,
      measure: () => undefined,
    });
    expect(first.ok).toBe(true);

    // Killed without releasing — the SIGKILL case that leaves a claim behind. `processLock` taught
    // this repo that governed refusal without governed recovery is a permanent wedge (t-0cbcbd).
    //
    // Awaiting `exit` is not incidental tidiness: a killed child stays a ZOMBIE, and `kill(pid, 0)`
    // answers YES for a zombie, until its parent reaps it. Polling liveness instead of awaiting the
    // event spins forever here. Production is not exposed to it — a vitest parent is reaped by the
    // shell that spawned it — but a liveness check is only as truthful as the reaping behind it.
    child.kill("SIGKILL");
    await exited;

    const second = admitVitestRun({
      memory: HOST,
      cpuCount: 24,
      label: "after",
      ledgerPath: file,
      pid: liveProcess(),
      reserveMb: RESERVE_MB,
      invocationMb: INVOCATION_MB,
      workerMb: WORKER_MB,
      measure: () => undefined,
    });
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.workers).toBe(CAP); // the dead holder's RAM came back in full
    expect(readLedger(file).map((claim) => claim.pid)).not.toContain(deadPid);
  });

  it("releases a claim so the next sizer sees the RAM again", () => {
    const file = ledgerFile();
    // TIGHT_HOST, so "the next sizer sees less" is the subtraction and not the cap. See its comment.
    const shared = { memory: TIGHT_HOST, cpuCount: 24, ledgerPath: file, reserveMb: RESERVE_MB, invocationMb: INVOCATION_MB, workerMb: WORKER_MB, measure: () => undefined };
    const first = admitVitestRun({ ...shared, label: "first", pid: liveProcess() });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const during = admitVitestRun({ ...shared, label: "during", pid: liveProcess() });
    expect(during.ok).toBe(true);
    if (during.ok) expect(during.workers).toBeLessThan(first.workers);

    first.claim.release();
    expect(readLedger(file).map((claim) => claim.label)).toEqual(["during"]);
  });

  it("bills a sibling that outgrew its claim by what it actually took", () => {
    const file = ledgerFile();
    const holder = liveProcess();
    const first = admitVitestRun({
      memory: HOST,
      cpuCount: 2,
      label: "small-claim",
      ledgerPath: file,
      pid: holder,
      reserveMb: RESERVE_MB,
      invocationMb: INVOCATION_MB,
      workerMb: WORKER_MB,
      measure: () => undefined,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.claim.costMb).toBe(INVOCATION_MB + 2 * WORKER_MB); // 2 CPUs → a small claim

    // The same holder is now measured using far more than it reserved. Measuring may only RAISE a
    // bill: a run that outgrew its claim must not be billed the smaller number.
    const overrun = 9_000;
    const second = admitVitestRun({
      memory: HOST,
      cpuCount: 24,
      label: "arrives-later",
      ledgerPath: file,
      pid: liveProcess(),
      reserveMb: RESERVE_MB,
      invocationMb: INVOCATION_MB,
      workerMb: WORKER_MB,
      measure: (pid) => (pid === holder ? overrun : 0),
    });
    expect(second.ok).toBe(true);
    if (second.ok) {
      // Billed 9000 of a 12918 pool, so the newcomer gets what is genuinely left, not a share
      // computed from the stale, smaller claim.
      const sizedFromOverrun = sizeFromShare({
        shareMb: POOL_MB - overrun,
        cpuCount: 24,
        workerMb: WORKER_MB,
        invocationMb: INVOCATION_MB,
      });
      expect(second.workers).toBe(sizedFromOverrun);
      expect(second.workers).toBeLessThan(CAP);
    }
  });

  it("never sizes a run it cannot afford the fixed cost of", () => {
    // Sizing down does not rescue an N+1th run: the invocation costs ~2GB before its first worker,
    // which is the whole reason this refuses instead of degrading to maxWorkers=1.
    expect(sizeFromShare({ shareMb: INVOCATION_MB + WORKER_MB - 1, cpuCount: 24, workerMb: WORKER_MB, invocationMb: INVOCATION_MB })).toBe(0);
    expect(sizeFromShare({ shareMb: INVOCATION_MB + WORKER_MB, cpuCount: 24, workerMb: WORKER_MB, invocationMb: INVOCATION_MB })).toBe(1);
  });

  it("caps the claim at the work the run actually has", () => {
    // A focused run over one file cannot use a full pool's worth of workers, so reserving for the
    // cap would refuse the next agent over RAM nobody was ever going to touch.
    expect(sizeFromShare({ shareMb: POOL_MB, cpuCount: 24, workerMb: WORKER_MB, invocationMb: INVOCATION_MB, maxUsefulWorkers: 1 })).toBe(1);
    expect(sizeFromShare({ shareMb: POOL_MB, cpuCount: 24, workerMb: WORKER_MB, invocationMb: INVOCATION_MB })).toBe(CAP);
  });

  describe("previewVitestShare (t-7f9809 — display without claim)", () => {
    const base = {
      memory: HOST,
      cpuCount: 24,
      reserveMb: RESERVE_MB,
      invocationMb: INVOCATION_MB,
      workerMb: WORKER_MB,
      measure: () => undefined as number | undefined,
    };

    it("matches what the next admit would receive, and never writes the ledger", () => {
      const file = ledgerFile();
      // TIGHT_HOST for the same reason as above: on `HOST` the second number would be the cap
      // rather than the discount, and this guard would pass without the ledger doing anything.
      const shared = { ...base, memory: TIGHT_HOST, ledgerPath: file };
      const holder = admitVitestRun({ ...shared, label: "holder", pid: liveProcess() });
      expect(holder.ok).toBe(true);
      if (holder.ok) expect(holder.workers).toBe(CAP);
      const before = fs.readFileSync(file, "utf8");

      const preview = previewVitestShare(shared);
      // HARD: consult must not claim.
      expect(fs.readFileSync(file, "utf8")).toBe(before);

      const next = admitVitestRun({ ...shared, label: "next", pid: liveProcess() });

      // THE GUARD: the number a display would show is the number a real run would get.
      expect(preview.ok).toBe(next.ok);
      expect(preview.workers).toBe(next.ok ? next.workers : 0);
      expect(preview.siblingCount).toBe(1);
      expect(preview.usedMb).toBeGreaterThan(0);
      // Alone-sizing would still show the cap; the sibling must have moved the needle.
      expect(preview.workers).toBeGreaterThan(0);
      expect(preview.workers).toBeLessThan(CAP);
    });

    it("reports workers=0 when the budget is spent (yes/no, not only magnitude)", () => {
      const file = ledgerFile();
      // Fill the pool with concurrent claims the same way a real multi-agent host does.
      for (let i = 0; i < 10; i++) {
        admitVitestRun({
          ...base,
          cpuCount: 8,
          label: `fill${i}`,
          ledgerPath: file,
          pid: liveProcess(),
        });
      }
      const before = fs.readFileSync(file, "utf8");
      const preview = previewVitestShare({ ...base, ledgerPath: file });
      expect(preview.ok).toBe(false);
      expect(preview.workers).toBe(0);
      expect(preview.siblingCount).toBeGreaterThan(0);
      // HARD: preview must not claim.
      expect(fs.readFileSync(file, "utf8")).toBe(before);
      const refused = admitVitestRun({
        ...base,
        label: "too-late",
        ledgerPath: file,
        pid: liveProcess(),
      });
      expect(refused.ok).toBe(false);
    });

    it("alone on an empty ledger still yields the hard-cap machine share", () => {
      const file = ledgerFile();
      const preview = previewVitestShare({ ...base, ledgerPath: file });
      expect(preview).toMatchObject({ ok: true, workers: CAP, siblingCount: 0, usedMb: 0 });
      // No ledger file is created by a pure consult against an empty path.
      expect(fs.existsSync(file)).toBe(false);
    });
  });

  it("holds the budget when SEPARATE PROCESSES size at the same moment", async () => {
    // The incident was six OS processes racing, not ten calls in a loop. Everything above shares one
    // interpreter, so it proves the arithmetic and nothing about the cross-process lock — and a lost
    // update there looks exactly like the defect: two sizers each writing a ledger that never saw
    // the other. So this one bundles the real module and runs real, concurrent `node` processes.
    const dir = tempDir("tachyon-vitest-budget-race-");
    const bundle = path.join(dir, "budget.mjs");
    const esbuild = await import("esbuild");
    await esbuild.build({
      entryPoints: [path.resolve(__dirname, "../../src/host/vitestBudget.ts")],
      outfile: bundle,
      bundle: true,
      platform: "node",
      format: "esm",
    });

    const file = path.join(dir, "budget.json");
    const runner = path.join(dir, "runner.mjs");
    fs.writeFileSync(runner, `
      import { admitVitestRun } from ${JSON.stringify(bundle)};
      // Spin to a shared wall-clock barrier before touching the ledger. Node startup jitter is tens
      // of milliseconds and the critical section is about one, so without this the racers mostly
      // MISS each other: measured, an unlocked ledger only lost an update in 2 of 6 runs. That is a
      // lottery, not a detector. The barrier tests the same code — it only makes the concurrency
      // this test claims to create actually happen.
      const startAt = Number(process.argv[3]);
      while (Date.now() < startAt) { /* spin */ }
      const decision = admitVitestRun({
        memory: ${JSON.stringify(HOST)},
        cpuCount: 8,
        label: process.argv[2],
        ledgerPath: ${JSON.stringify(file)},
        reserveMb: ${RESERVE_MB},
        invocationMb: ${INVOCATION_MB},
        workerMb: ${WORKER_MB},
        measure: () => undefined,
      });
      process.stdout.write(JSON.stringify(decision.ok
        ? { ok: true, workers: decision.workers, costMb: decision.claim.costMb }
        : { ok: false }) + "\\n");
      // Hold the claim open, exactly as a running vitest does, until the parent kills us.
      setTimeout(() => {}, 120000);
    `);

    const startAt = Date.now() + 750; // enough for every child to be spun up and waiting
    const racers = Array.from({ length: 8 }, (_, index) => {
      const child = spawn(process.execPath, [runner, `racer${index}`, String(startAt)], { stdio: ["ignore", "pipe", "pipe"] });
      spawned.push(child);
      return new Promise<{ ok: boolean; costMb?: number }>((resolve, reject) => {
        let out = "";
        let err = "";
        child.stdout!.on("data", (chunk) => {
          out += chunk;
          const line = out.indexOf("\n");
          if (line >= 0) resolve(JSON.parse(out.slice(0, line)));
        });
        child.stderr!.on("data", (chunk) => {
          err += chunk;
        });
        child.once("exit", () => reject(new Error(`racer exited before deciding: ${err}`)));
      });
    });

    const decisions = await Promise.all(racers);
    const admitted = decisions.filter((decision) => decision.ok);
    expect(admitted.length).toBeGreaterThan(1);
    expect(decisions.length - admitted.length).toBeGreaterThan(0); // the pool really did run out

    // THE GUARD, across real processes: the sum fits, and nobody's claim was lost to a racing write.
    const totalMb = admitted.reduce((sum, decision) => sum + (decision.costMb ?? 0), 0);
    expect(totalMb).toBeLessThanOrEqual(POOL_MB);
    const ledger = readLedger(file);
    expect(ledger).toHaveLength(admitted.length);
    expect(ledger.reduce((sum, claim) => sum + claim.costMb, 0)).toBe(totalMb);
  });

  it("falls back loudly when the ledger MECHANISM breaks, but still refuses when the budget says no", () => {
    // Two failures that must not be confused. A broken ledger is not a full host: refusing on it
    // would make every test in the repo unrunnable, with no way out (t-0cbcbd — governed refusal
    // needs governed recovery). A spent budget IS a decision, and it has to stand.
    const warnings: string[] = [];
    const broken = admitOrFallback(
      {
        memory: HOST,
        cpuCount: 24,
        label: "broken-ledger",
        // A directory where a file must be: the ledger write throws, not the budget. Registered for
        // cleanup like every other temp here — an unregistered mkdtemp leaks one directory per gate
        // run, on every machine that runs the suite.
        ledgerPath: brokenLedgerPath(),
        pid: liveProcess(),
        invocationMb: INVOCATION_MB,
        workerMb: WORKER_MB,
        measure: () => undefined,
      },
      (message) => warnings.push(message),
    );
    expect(broken.ok).toBe(true);
    // t-ad8fd2 — ONE worker, not the old per-process width. This run cannot be recorded, so no
    // sibling can see it; admitting it at alone-sizing is the "as if the machine were empty"
    // assumption that emptied the host in the first place.
    if (broken.ok) expect(broken.workers).toBe(1);
    // And it reports what it will actually cost. The old `costMb: 0` said the run was free.
    if (broken.ok) expect(broken.claim.costMb).toBe(INVOCATION_MB + WORKER_MB);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/ledger unavailable/i);
    expect(warnings[0]).toMatch(/NOT\s+accounted for/i); // says what protection was lost

    // Same helper, a genuinely spent pool: this one still refuses rather than falling back.
    const file = ledgerFile();
    const holder = liveProcess();
    fs.writeFileSync(file, JSON.stringify([
      { pid: holder, workers: 16, costMb: POOL_MB, startedAtMs: Date.now(), label: "hog" },
    ]));
    const refused = admitOrFallback(
      {
        memory: HOST,
        cpuCount: 24,
        label: "arrives-to-nothing",
        ledgerPath: file,
        pid: liveProcess(),
        reserveMb: RESERVE_MB,
        invocationMb: INVOCATION_MB,
        workerMb: WORKER_MB,
        measure: () => undefined,
      },
      (message) => warnings.push(message),
    );
    expect(refused.ok).toBe(false);
    expect(warnings).toHaveLength(1); // no second warning: nothing broke, the answer was simply no
  });

  /**
   * t-ad8fd2 — the first run on a machine has no ledger, and that is NORMAL.
   *
   * Pinned separately from everything else here because it is the constraint every fix to the error
   * path has to survive: absent and illegible are different facts, and a fix that collapses them the
   * other way — degrading or refusing because there is no file yet — breaks the very first vitest
   * invocation on a fresh checkout, which is the one nobody would think to test.
   */
  it("admits the FIRST run at full width: an absent ledger means nobody is running, not a broken one", () => {
    const warnings: string[] = [];
    const file = path.join(tempDir("tachyon-vitest-budget-first-"), "never-written.json");
    expect(fs.existsSync(file)).toBe(false);

    const first = admitOrFallback(
      {
        memory: HOST,
        cpuCount: 24,
        label: "first-run",
        ledgerPath: file,
        pid: liveProcess(),
        reserveMb: RESERVE_MB,
        invocationMb: INVOCATION_MB,
        workerMb: WORKER_MB,
        measure: () => undefined,
        ancestorsOf: () => undefined,
      },
      (message) => warnings.push(message),
    );

    expect(warnings).toEqual([]); // nothing broke, so nothing is warned about
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    // Full width, not the degraded floor: an empty host really is empty.
    expect(first.workers).toBeGreaterThan(1);
    expect(first.claim.costMb).toBe(INVOCATION_MB + first.workers * WORKER_MB);
    // And it is RECORDED, which is what makes the second run on this machine see the first.
    expect(readLedger(file).map((claim) => claim.label)).toEqual(["first-run"]);
  });

  /**
   * t-ad8fd2 — the defect: an illegible ledger made an invocation UNACCOUNTED, and two unaccounted
   * invocations each size as if the machine were empty.
   *
   * Two invocations against a ledger neither can read. They cannot see each other THROUGH the file —
   * nothing can fix that, the bytes are unreadable — so the property that has to hold is the other
   * one: neither may spend the host as if it were alone, and neither may erase the run it cannot
   * see. Before the fix both took the caller's per-process width with `costMb: 0`, and the first one
   * overwrote the ledger, destroying a live holder's claim.
   */
  it("bounds TWO concurrent invocations that cannot read the ledger, and keeps the claim they cannot see", () => {
    const file = path.join(tempDir("tachyon-vitest-budget-opaque-"), "budget.json");
    // A real, live, expensive holder — the run these two are blind to.
    const hog: VitestClaim = {
      pid: liveProcess(), workers: 16, costMb: 5_000, startedAtMs: Date.now(), label: "hog",
    };
    fs.writeFileSync(file, JSON.stringify([hog]));
    fs.chmodSync(file, 0o200); // present and writable, but this process cannot READ it

    const base = {
      memory: HOST,
      cpuCount: 24,
      ledgerPath: file,
      reserveMb: RESERVE_MB,
      invocationMb: INVOCATION_MB,
      workerMb: WORKER_MB,
      measure: () => undefined,
      ancestorsOf: () => undefined,
    };
    const warnA: string[] = [];
    const warnB: string[] = [];
    const a = admitOrFallback({ ...base, label: "A", pid: liveProcess() }, (m) => warnA.push(m));
    // B arrives while A is still running — the concurrency the whole ledger exists for.
    const b = admitOrFallback({ ...base, label: "B", pid: liveProcess() }, (m) => warnB.push(m));

    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (!a.ok || !b.ok) return;

    // NEITHER sizes as if the host were empty. This is the assertion that goes red without the fix:
    // both used to come back at the caller's per-process width.
    expect(a.workers).toBe(1);
    expect(b.workers).toBe(1);
    // Neither reports itself as free, either.
    expect(a.claim.costMb).toBe(INVOCATION_MB + WORKER_MB);
    expect(b.claim.costMb).toBe(INVOCATION_MB + WORKER_MB);
    // Both said so out loud, rather than quietly picking a number.
    expect(warnA).toHaveLength(1);
    expect(warnB).toHaveLength(1);

    // And the holder they could not see is STILL on the ledger. Before the fix, A read the file as
    // empty and then overwrote it — turning a live 16-worker run into the unaccounted invocation,
    // which is the same defect one level down.
    fs.chmodSync(file, 0o600);
    expect(readLedger(file)).toEqual([hog]);
  });

  /**
   * t-ad8fd2 — the repairable half: bytes we DID read and could not use.
   *
   * There is no live claim inside a corrupt file to protect, so this case does not stop at bounding.
   * The run degrades AND records, and the record is what the next arrival reads — so here two
   * concurrent invocations really do end up seeing each other, through a file the first one fixed.
   */
  it("degrades on a CORRUPT ledger but still records, so the next concurrent run bills it", () => {
    const file = path.join(tempDir("tachyon-vitest-budget-corrupt-"), "budget.json");
    fs.writeFileSync(file, '[{"pid":1,"workers":4,'); // truncated mid-write

    const base = {
      memory: HOST,
      cpuCount: 24,
      ledgerPath: file,
      reserveMb: RESERVE_MB,
      invocationMb: INVOCATION_MB,
      workerMb: WORKER_MB,
      measure: () => undefined,
      ancestorsOf: () => undefined,
    };
    const warnings: string[] = [];
    const a = admitOrFallback({ ...base, label: "A", pid: liveProcess() }, (m) => warnings.push(m));

    expect(a.ok).toBe(true);
    if (!a.ok) return;
    expect(warnings).toEqual([]); // it did not fall back — the ledger still works, its contents did not
    expect(a.workers).toBe(1); // red without the fix: the full width against an assumed-empty host
    expect(a.reason).toMatch(/partly legible/i);

    // The claim landed, and the file is legible again for whoever comes next.
    const recorded = readLedger(file);
    expect(recorded.map((claim) => claim.label)).toEqual(["A"]);
    expect(recorded[0]!.costMb).toBe(INVOCATION_MB + WORKER_MB);

    // B arrives while A holds it, and BILLS A rather than sizing against an empty host.
    const b = admitOrFallback({ ...base, label: "B", pid: liveProcess() }, (m) => warnings.push(m));
    expect(b.ok).toBe(true);
    if (!b.ok) return;
    expect(b.reason).toMatch(new RegExp(`1 sibling run\\(s\\) hold ${INVOCATION_MB + WORKER_MB}MB`));
    expect(readLedger(file).map((claim) => claim.label)).toEqual(["A", "B"]);
  });

  it("measures a real process tree, parent plus children", () => {
    // The instrument itself: a confident wrong number here would size the whole host. This process
    // has a live child, so the tree must exceed what any single process reports.
    liveProcess();
    const measured = measureTreePssMb(process.pid);
    expect(measured).toBeDefined();
    expect(measured!).toBeGreaterThan(0);
  });
});

/**
 * t-690f52 — a vitest run spawned INSIDE another one is a descendant, not a sibling.
 *
 * Measured on the real gate before any of this existed: the 16-worker run billed 7168MB, a second
 * agent's focused run billed 2368MB, the pool was 8936MB, and the share left for the nested child
 * was -600MB. The child died loading `vitest.config.ts` and the parent test reported the one thing
 * that does not help — "Command failed". The RAM it was refused over was RAM its own ancestor had
 * already reserved, so the ledger was charging the same pages twice.
 *
 * Every case here keeps the ancestry EXPLICIT via `ancestorsOf`, because the distinction the fix
 * turns on — descendant vs sibling — is invisible in the arithmetic and lives entirely in /proc.
 */
describe("nested vitest inherits its ancestor's claim (t-690f52)", () => {
  /**
   * The measured shape of the incident: a gate holding 16 workers, and a nested focused child.
   *
   * Sixteen is no longer a size this host would hand out (t-fb7025 lowered the cap to the measured
   * CPU knee), and the fixture keeps it anyway: it is a RECORDING of the ledger state that produced
   * the bug, not a prediction of what a run gets today. Rewriting it to the current cap would
   * quietly stop replaying the incident these cases exist for.
   */
  const FOCUSED_INVOCATION_MB = 512;
  const GATE_CLAIM_MB = INVOCATION_MB + 16 * WORKER_MB; // 7168
  /**
   * What the sampled machine looks like with no vitest on it. Everything else is derived from this,
   * so `memAvailable` MOVES when a holder's tree grows — a fixture that pins both independently can
   * assert a pool the machine could never be in, and `vitestPoolMb` reads exactly that pair.
   */
  const BASELINE_AVAILABLE_MB = 8_936;

  const measured = new Map<number, number>();
  afterEach(() => measured.clear());

  function host(): HostMemorySnapshot {
    const inUse = [...measured.values()].reduce((sum, mb) => sum + mb, 0);
    return { ...HOST, memAvailableMb: BASELINE_AVAILABLE_MB - inUse };
  }

  /** The 16-worker gate, plus the unrelated agent run that was live in the sampled window. */
  function gateHolder(file: string, pid: number, usingMb: number): void {
    const other = liveProcess();
    fs.writeFileSync(file, JSON.stringify([
      { pid, workers: 16, costMb: GATE_CLAIM_MB, startedAtMs: Date.now(), label: "gate" },
      { pid: other, workers: 1, costMb: 2_368, startedAtMs: Date.now(), label: "other-agent" },
    ] satisfies VitestClaim[]));
    measured.set(pid, usingMb);
    measured.set(other, 76); // the sampled reading: billed 2368MB, using 76MB
  }

  /** The nested child as `vitest.config.ts` sizes it: one named file, so 512MB + one worker. */
  function nestedChild(file: string, pid: number, ancestors: number[]) {
    return admitVitestRun({
      memory: host(),
      cpuCount: 24,
      label: "nested",
      ledgerPath: file,
      pid,
      reserveMb: RESERVE_MB,
      invocationMb: FOCUSED_INVOCATION_MB,
      workerMb: WORKER_MB,
      maxUsefulWorkers: 1,
      measure: (target) => measured.get(target),
      ancestorsOf: () => ancestors,
    });
  }

  it("THE MEASURED BUG: the child of a claim holder was refused over RAM its ancestor already reserved", () => {
    const file = ledgerFile();
    const gate = liveProcess();
    gateHolder(file, gate, 2_682); // the real sample: 2682MB materialized of a 7168MB claim

    // The ancestry from the `ps` snapshot: vitest main → worker → npm exec → sh → vitest main.
    const admitted = nestedChild(file, liveProcess(), [liveProcess(), liveProcess(), liveProcess(), gate]);

    expect(admitted.ok).toBe(true);
    if (!admitted.ok) return;
    expect(admitted.reason).toContain("inheriting the claim of gate");
    // Sized to what it can use, never to the ancestor's whole headroom.
    expect(admitted.workers).toBe(1);
  });

  it("keeps the refusal for a run that is NOT a descendant — the sibling t-3ad4af bought protection from", () => {
    const file = ledgerFile();
    gateHolder(file, liveProcess(), 2_682);

    // Same host, same exhausted ledger, same focused cost. The ONLY difference is that nothing in
    // this run's ancestry holds a claim, so it is an N+1th independent run and must still be told no.
    const sibling = admitVitestRun({
      memory: host(),
      cpuCount: 24,
      label: "unrelated-agent",
      ledgerPath: file,
      pid: liveProcess(),
      reserveMb: RESERVE_MB,
      invocationMb: FOCUSED_INVOCATION_MB,
      workerMb: WORKER_MB,
      maxUsefulWorkers: 1,
      measure: (target) => measured.get(target),
      ancestorsOf: () => [liveProcess(), liveProcess()],
    });

    expect(sibling.ok).toBe(false);
    if (sibling.ok) return;
    expect(sibling.code).toBe("HOST_BUDGET_EXHAUSTED");
  });

  it("counts the child ONCE, not zero: it writes no claim, and the ancestor's bill is unchanged", () => {
    const file = ledgerFile();
    const gate = liveProcess();
    gateHolder(file, gate, 2_682);
    const before = readLedger(file);

    const admitted = nestedChild(file, liveProcess(), [gate]);
    expect(admitted.ok).toBe(true);
    if (!admitted.ok) return;

    // Nothing was added. Writing a claim here is the double count: this tree would be billed at its
    // own pid AND again inside the ancestor's tree PSS.
    expect(readLedger(file)).toEqual(before);
    expect(admitted.claim.costMb).toBe(0);
    admitted.claim.release();
    expect(readLedger(file)).toEqual(before); // and releasing nothing does not disturb the ancestor

    // Invisible is the other failure, and it is the one that caused the original incident. The child
    // stays visible to a third party through the ancestor: while the ancestor is young its claim
    // floor covers the child, and once the ancestor outgrows the claim the tree walk includes it.
    measured.set(gate, GATE_CLAIM_MB + 400); // the ancestor's tree, child's pages included
    const thirdParty = admitVitestRun({
      memory: host(),
      cpuCount: 24,
      label: "third-party",
      ledgerPath: file,
      pid: liveProcess(),
      reserveMb: RESERVE_MB,
      invocationMb: INVOCATION_MB,
      workerMb: WORKER_MB,
      measure: (target) => measured.get(target),
      ancestorsOf: () => [],
    });
    expect(thirdParty.ok).toBe(false); // the grown tree is charged in full to whoever arrives next
  });

  it("bounds an inherited run by the ancestor's unmaterialized headroom", () => {
    const file = ledgerFile();
    const gate = liveProcess();

    // A nested run with no useful-worker cap would take the hard cap if nothing bounded it. What
    // bounds it is what the ancestor reserved and has not spent: 7168 - 5168 = 2000MB, which after
    // the 512MB fixed term buys 4 workers — fewer than the cap, and that is the point.
    gateHolder(file, gate, 5_168);
    const roomy = admitVitestRun({
      memory: host(),
      cpuCount: 24,
      label: "nested-broad",
      ledgerPath: file,
      pid: liveProcess(),
      reserveMb: RESERVE_MB,
      invocationMb: FOCUSED_INVOCATION_MB,
      workerMb: WORKER_MB,
      measure: (target) => measured.get(target),
      ancestorsOf: () => [gate],
    });
    expect(roomy.ok).toBe(true);
    if (roomy.ok) expect(roomy.workers).toBe(4);
  });

  it("degrades to one worker, loudly, when the ancestor has outgrown its own claim", () => {
    const file = ledgerFile();
    const gate = liveProcess();
    gateHolder(file, gate, GATE_CLAIM_MB + 1_500); // no headroom left at all

    const admitted = nestedChild(file, liveProcess(), [gate]);
    // Refusing here would free nothing — the ancestor holds the RAM either way — and would only
    // break the test blocked on this child. So it starts, at the floor, and says the host is over.
    expect(admitted.ok).toBe(true);
    if (!admitted.ok) return;
    expect(admitted.workers).toBe(1);
    expect(admitted.reason).toContain("outgrown its claim");
  });

  it("lets TACHYON_VITEST_MAX_WORKERS lower an inherited run but never raise it", () => {
    const file = ledgerFile();
    const gate = liveProcess();
    gateHolder(file, gate, 5_168); // headroom buys 4

    const shared = {
      memory: host(),
      cpuCount: 24,
      label: "nested-forced",
      ledgerPath: file,
      reserveMb: RESERVE_MB,
      invocationMb: FOCUSED_INVOCATION_MB,
      workerMb: WORKER_MB,
      measure: (target: number) => measured.get(target),
      ancestorsOf: () => [gate],
    };

    // The variable is the escape hatch for a caller taking RAM deliberately. A nested child takes
    // its ancestor's RAM, and inherits the variable through the environment without anyone aiming
    // it at the child — so upward it does not travel.
    const raised = admitVitestRun({ ...shared, pid: liveProcess(), forcedWorkers: 16 });
    expect(raised.ok).toBe(true);
    if (raised.ok) expect(raised.workers).toBe(4);

    const lowered = admitVitestRun({ ...shared, pid: liveProcess(), forcedWorkers: 2 });
    expect(lowered.ok).toBe(true);
    if (lowered.ok) expect(lowered.workers).toBe(2);
  });

  it("inherits from the NEAREST claim holder when runs are nested more than one deep", () => {
    const file = ledgerFile();
    const outer = liveProcess();
    const inner = liveProcess();
    fs.writeFileSync(file, JSON.stringify([
      { pid: outer, workers: 16, costMb: GATE_CLAIM_MB, startedAtMs: Date.now(), label: "outer" },
      { pid: inner, workers: 4, costMb: 3_000, startedAtMs: Date.now(), label: "inner" },
    ] satisfies VitestClaim[]));
    measured.set(outer, 2_000);
    measured.set(inner, 2_800);

    // Ancestry runs inward-out, so the inner run is met first — and its headroom is the one left to
    // spend. Billing the outer one's headroom would spend RAM the inner run has already taken.
    const admitted = nestedChild(file, liveProcess(), [inner, outer]);
    expect(admitted.ok).toBe(true);
    if (admitted.ok) expect(admitted.reason).toContain("inheriting the claim of inner");
  });

  it("does not inherit where /proc cannot answer, so a non-Linux host keeps the old refusal", () => {
    const file = ledgerFile();
    gateHolder(file, liveProcess(), 2_682);
    const admitted = admitVitestRun({
      memory: host(),
      cpuCount: 24,
      label: "no-proc",
      ledgerPath: file,
      pid: liveProcess(),
      reserveMb: RESERVE_MB,
      invocationMb: FOCUSED_INVOCATION_MB,
      workerMb: WORKER_MB,
      maxUsefulWorkers: 1,
      measure: (target) => measured.get(target),
      ancestorsOf: () => undefined, // "cannot tell" is not "no ancestors"
    });
    expect(admitted.ok).toBe(false);
  });

  it("reads a real ancestry out of /proc, and answers undefined where there is none", () => {
    // The instrument. A wrong answer here decides the whole thing, so it is read against the real
    // kernel rather than a fixture: this process is a descendant of whatever spawned it.
    const chain = ancestorPids(process.pid);
    expect(chain).toBeDefined();
    expect(chain!).toContain(process.ppid);
    expect(chain!.indexOf(process.ppid)).toBe(0); // nearest first
    expect(chain!).not.toContain(process.pid);

    expect(ancestorPids(process.pid, path.join(tempDir("tachyon-no-proc-"), "absent"))).toBeUndefined();
  });
});
