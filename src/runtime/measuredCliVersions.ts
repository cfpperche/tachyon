/**
 * Product-level measured CLI versions for PATH drift display (t-1322b5).
 *
 * Half 1 only: detect and show. Never block spawn, gates, or ports.
 * Divergence is the normal state of runtimes that move often — display, do not alarm.
 *
 * One constant per runtime, one owner. Start with Codex; other runtimes join when their
 * product baseline is a single named number rather than scattered comments.
 *
 * Codex baseline is the existing product constant already used by native-memory evidence
 * and the parity F3 matrix (`0.146.0`) — not invented here, and not the older file-local
 * `CODEX_MEASURED_CLI_VERSION` (0.145.0) in codexNativeConfigProjection.
 */

/** Runtime id → measured semver (no binary banner prefix). */
export const MEASURED_CLI_VERSIONS: Readonly<Record<string, string>> = {
  codex: "0.146.0",
};

export type CliVersionParity =
  | { state: "match"; measured: string; running: string }
  | { state: "drift"; measured: string; running: string }
  | { state: "unknown-running"; measured: string };

/** Measured baseline for one runtime, or undefined when this product has none yet. */
export function measuredCliVersion(runtime: string): string | undefined {
  return MEASURED_CLI_VERSIONS[runtime];
}

/**
 * Pull a trailing semver from a CLI `--version` banner.
 * Example: `codex-cli 0.146.1` → `0.146.1`.
 * Returns undefined when no version token is present.
 */
export function normalizeCliVersion(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const match = trimmed.match(/(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.]+)?)\s*$/);
  return match?.[1];
}

/**
 * Compare the product measured version to a PATH `--version` reading.
 *
 * - No measured constant → undefined (caller skips display for that runtime).
 * - Missing or unreadable running version → `unknown-running` (never assume match).
 * - Any major/minor/patch difference → `drift` (patch bumps change measured behaviour).
 */
export function compareMeasuredCliVersion(
  runtime: string,
  runningRaw: string | null | undefined,
): CliVersionParity | undefined {
  const measured = measuredCliVersion(runtime);
  if (measured === undefined) return undefined;

  if (runningRaw == null) {
    return { state: "unknown-running", measured };
  }
  const running = normalizeCliVersion(runningRaw);
  if (running === undefined) {
    return { state: "unknown-running", measured };
  }
  if (running === measured) {
    return { state: "match", measured, running };
  }
  return { state: "drift", measured, running };
}
