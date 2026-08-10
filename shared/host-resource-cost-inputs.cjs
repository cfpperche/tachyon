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
 * resource: it shrinks each run's SLICE (2048 + 8×320 = 4608MB instead of 7168MB), so the host
 * admits more, smaller runs — measured on this box, peak concurrent workers falls from 27 to 21 and
 * no single run can spike load past 8. Raising it back is a one-line revert.
 */
const HARD_CAP_WORKERS = 8;

function envInt(name) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.trunc(n) : undefined;
}

module.exports = { DEFAULT_RESERVE_MB, DEFAULT_WORKER_MB, HARD_CAP_WORKERS, envInt };
