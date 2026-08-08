/**
 * The environment-independent part of verify-record reuse validity.
 *
 * Both the CLI gate and the extension host can answer these questions without guessing which
 * environment produced a record: it must be attributable (schema 2 with a fingerprint), have a
 * usable timestamp, not come from the future, and still be inside the shared freshness window.
 * Fingerprint EQUALITY remains opt-in because only a caller that knows the producer environment's
 * expected fingerprint can make that comparison honestly.
 *
 * CommonJS is deliberate: extension-host source compiles as CJS and cannot statically import an
 * `.mjs` script, while the gate's `.mjs` entrypoint can consume CJS through its default export.
 */
const DEFAULT_MAX_RECORD_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function verificationRecordValidity(record, {
  expectedFingerprint,
  maxAgeMs = DEFAULT_MAX_RECORD_AGE_MS,
  now = () => Date.now(),
} = {}) {
  if (!record || record.schema !== 2 || !record.fingerprint) {
    return { valid: false, reason: "record predates verifier fingerprinting" };
  }
  if (expectedFingerprint !== undefined && record.fingerprint !== expectedFingerprint) {
    return { valid: false, reason: "verifier or environment changed since that run" };
  }
  const at = Date.parse(record.at ?? "");
  if (!Number.isFinite(at)) return { valid: false, reason: "record has no usable timestamp" };
  const ageMs = now() - at;
  if (ageMs < 0) return { valid: false, reason: "record is dated in the future" };
  if (ageMs > maxAgeMs) {
    return { valid: false, reason: `record is stale (${Math.floor(ageMs / 86_400_000)}d old)` };
  }
  return { valid: true };
}

module.exports = { DEFAULT_MAX_RECORD_AGE_MS, verificationRecordValidity };
