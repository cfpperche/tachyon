import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  admitVitestRun,
  admitOrFallback,
  previewVitestShare,
  sizeFromShare,
  vitestPoolMb,
  measureTreePssMb,
  type VitestClaim,
} from "../../src/host/vitestBudget.js";
import { recommendVitestMaxWorkers, type HostMemorySnapshot } from "../../src/host/hostResources.js";

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
  it("reproduces the incident: the OLD per-process sizer lets three concurrent runs divide one budget", () => {
    // The exact reading from the incident logs: MemAvailable 10190MB → workers=9, three times over.
    const duringIncident: HostMemorySnapshot = { ...HOST, memAvailableMb: 10_190 };
    const each = recommendVitestMaxWorkers({
      memory: duringIncident,
      cpuCount: 24,
      reserveMb: RESERVE_MB,
      workerMb: 768, // the estimate in force at the time
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
    // The fix must not be "lower the cap": one agent on a 24-CPU machine still gets the hard cap.
    if (decision.ok) expect(decision.workers).toBe(16);
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
    if (second.ok) expect(second.workers).toBe(16); // the dead holder's RAM came back in full
    expect(readLedger(file).map((claim) => claim.pid)).not.toContain(deadPid);
  });

  it("releases a claim so the next sizer sees the RAM again", () => {
    const file = ledgerFile();
    const shared = { memory: HOST, cpuCount: 24, ledgerPath: file, reserveMb: RESERVE_MB, invocationMb: INVOCATION_MB, workerMb: WORKER_MB, measure: () => undefined };
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
      expect(second.workers).toBeLessThan(16);
    }
  });

  it("never sizes a run it cannot afford the fixed cost of", () => {
    // Sizing down does not rescue an N+1th run: the invocation costs ~2GB before its first worker,
    // which is the whole reason this refuses instead of degrading to maxWorkers=1.
    expect(sizeFromShare({ shareMb: INVOCATION_MB + WORKER_MB - 1, cpuCount: 24, workerMb: WORKER_MB, invocationMb: INVOCATION_MB })).toBe(0);
    expect(sizeFromShare({ shareMb: INVOCATION_MB + WORKER_MB, cpuCount: 24, workerMb: WORKER_MB, invocationMb: INVOCATION_MB })).toBe(1);
  });

  it("caps the claim at the work the run actually has", () => {
    // A focused run over one file cannot use 16 workers, so reserving for 16 would refuse the next
    // agent over RAM nobody was ever going to touch.
    expect(sizeFromShare({ shareMb: POOL_MB, cpuCount: 24, workerMb: WORKER_MB, invocationMb: INVOCATION_MB, maxUsefulWorkers: 1 })).toBe(1);
    expect(sizeFromShare({ shareMb: POOL_MB, cpuCount: 24, workerMb: WORKER_MB, invocationMb: INVOCATION_MB })).toBe(16);
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
      // One 16-worker claim leaves a reduced but still positive share for the next arrival.
      const holder = admitVitestRun({
        ...base,
        label: "holder",
        ledgerPath: file,
        pid: liveProcess(),
      });
      expect(holder.ok).toBe(true);
      if (holder.ok) expect(holder.workers).toBe(16);
      const before = fs.readFileSync(file, "utf8");

      const preview = previewVitestShare({ ...base, ledgerPath: file });
      // HARD: consult must not claim.
      expect(fs.readFileSync(file, "utf8")).toBe(before);

      const next = admitVitestRun({
        ...base,
        label: "next",
        ledgerPath: file,
        pid: liveProcess(),
      });

      // THE GUARD: the number a display would show is the number a real run would get.
      expect(preview.ok).toBe(next.ok);
      expect(preview.workers).toBe(next.ok ? next.workers : 0);
      expect(preview.siblingCount).toBe(1);
      expect(preview.usedMb).toBeGreaterThan(0);
      // Alone-sizing would still show 16; the sibling must have moved the needle.
      expect(preview.workers).toBeLessThan(16);
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
      expect(preview).toMatchObject({ ok: true, workers: 16, siblingCount: 0, usedMb: 0 });
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
        measure: () => undefined,
      },
      7,
      (message) => warnings.push(message),
    );
    expect(broken.ok).toBe(true);
    if (broken.ok) expect(broken.workers).toBe(7); // the per-process fallback, not a guess
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
      7,
      (message) => warnings.push(message),
    );
    expect(refused.ok).toBe(false);
    expect(warnings).toHaveLength(1); // no second warning: nothing broke, the answer was simply no
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
