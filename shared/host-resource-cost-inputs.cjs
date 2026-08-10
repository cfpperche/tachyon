/** Shared operator inputs used by both host resource models. */
const DEFAULT_RESERVE_MB = 3072;
/** Measured 215MB marginal / 289MB peak for a single pool worker; rounded up for headroom. */
const DEFAULT_WORKER_MB = 320;
/**
 * t-fb7025 — sized by the MEASURED CPU knee, not by how much RAM happens to be free.
 *
 * Everything else in this file is a memory term, and so was this cap: it existed to bound the
 * per-run RAM claim. What it never had was a term for the resource that actually degrades. Measured
 * 2026-08-09 on the owner's machine (24 logical CPUs, 16GB), the same tree, twice:
 *
 *     15 workers → 91s wall, load1 peak 16.67, MemAvailable −4145MB
 *      8 workers → 88s wall, load1 peak  8.63, MemAvailable −3454MB
 *
 * Half the load spike for three seconds, which is inside the noise. That is not luck: the suite is
 * 392s of CPU work whose longest single FILE is 55s, so the makespan is `max(392/W, 55)` and stays
 * pinned at 55s for every W above ~7. Workers past the knee buy nothing and cost load, and the load
 * is what the human sharing this machine feels — `docs/research/t-fb7025-gate-cost.md` measures the
 * gate saturating a VS Code session during a run, at an hour when it was only busy 15% of the time.
 *
 * This is NOT a retreat from t-3ad4af. That incident was a SUM — six independent sizers dividing the
 * same RAM — and the ledger in `src/host/vitestBudget.ts` is what fixed it; the pool it divides is
 * untouched here. `vitestBudget.test.ts` used to say "the fix must not be lower the cap", and it was
 * right about the fix it was defending. Lowering the cap is a different change for a different
 * resource: it shrinks each run's SLICE, so the host admits more, smaller runs. Measured on this box
 * at the cap of 8 (2048 + 8×320 = 4608MB per run, against 7168MB at the old 16): peak concurrent
 * workers fell from 27 to 21 and no single run spiked load past 8. Raising it is a one-line revert.
 *
 * t-392418 — the cap is 6 since 2026-08-10, and everything above still holds: the curve, the knee,
 * the reason the cap is a CPU term. What changed is where we stop descending it.
 *
 * t-91379d re-measured the same suite serially that day: 716 files sum to 247s of CPU and
 * `engineSupervisor.test.ts` alone is 50s. At 6 workers the other 715 files finish in ~41s, still
 * under the 50s floor that one file imposes — so 6 is inside the flat part of `max(CPU/W, longest
 * file)`, not below it. The 392s/55s pair above is the 2026-08-09 measurement of the same shape;
 * both agree, and 6 is the conservative side of the one knee.
 *
 * The owner chose it, in those terms: "coloca 6 conservador e vamos medindo à medida que rodamos as
 * tarefas e aí vamos calibrando, mas sem ficar masturbando engenharia". So this is a number to be
 * re-decided by a human reading real gate runs — not a target for an auto-tuner. Each run's slice is
 * now 2048 + 6×320 = 3968MB; the peak-concurrency figures above were measured at 8 and were not
 * re-measured for 6.
 *
 * WHOEVER RECALIBRATES THIS: the unit suite is not the only caller. `vitest.browser.config.ts`
 * passes no `hardCap`, so it inherits this constant — and its arithmetic is its own, because it
 * launches a real Chrome: invocationMb 3072 and workerMb 384 against the unit suite's 2048 and 320.
 * So one cap sizes two different claims:
 *
 *     unit    at 6 → 2048 + 6×320 = 3968MB   (was 4608MB at 8)
 *     browser at 6 → 3072 + 6×384 = 5376MB   (was 6144MB at 8)
 *
 * The direction is safe for both — a lower cap only shrinks a claim, which is the property t-3ad4af
 * cares about. What is NOT true is that 6 was calibrated for the browser suite: it comes from the
 * unit suite's CPU curve, and nothing above measured Chrome. There is a second, quieter effect —
 * that config declares `maxUsefulWorkers: 8`, so the cap now binds BELOW it and the browser suite
 * runs at 6 where it used to run at 8. Its own comment measures 43.4s at 8 workers and 42.5s at 16
 * and concludes it is bound by Chrome startup rather than worker parallelism, which is a reason to
 * expect 6 to cost little — an expectation, not a measurement. Nobody has run it at 6.
 *
 * Read both lines before moving this number, and say which suite your new measurement describes.
 */
const HARD_CAP_WORKERS = 6;

function envInt(name) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.trunc(n) : undefined;
}

module.exports = { DEFAULT_RESERVE_MB, DEFAULT_WORKER_MB, HARD_CAP_WORKERS, envInt };
