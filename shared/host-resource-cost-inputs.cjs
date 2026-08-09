/** Shared operator inputs used by both host resource models. */
const DEFAULT_RESERVE_MB = 3072;
/** Measured 215MB marginal / 289MB peak for a single pool worker; rounded up for headroom. */
const DEFAULT_WORKER_MB = 320;
const HARD_CAP_WORKERS = 16;

function envInt(name) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.trunc(n) : undefined;
}

module.exports = { DEFAULT_RESERVE_MB, DEFAULT_WORKER_MB, HARD_CAP_WORKERS, envInt };
