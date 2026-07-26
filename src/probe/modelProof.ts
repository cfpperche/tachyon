import type { ProbeModelProof, ProbeResult } from "./taxonomy.js";

/**
 * SDD 473 — decide whether the model that ran can be shown to be the model that was asked for.
 *
 * Only what the runtime itself reports counts as proof. Cost, latency and output shape are NOT
 * evidence: a cheaper model answering a question convincingly is exactly the failure this exists to
 * catch, so nothing here infers identity from behaviour.
 */

/** A provider release stamp — `20260101`. Six+ digits, so a version bump like `-5` is not one. */
const RELEASE_STAMP = /^\d{6,}$/;

/**
 * A requested identifier is satisfied by a reported one when they are equal, or when the reported
 * identifier is the requested model plus a dated release stamp (`claude-opus-5` ←
 * `claude-opus-5-20260101`).
 *
 * A `-` boundary alone is NOT enough to separate those two cases: `claude-opus-5` is literally
 * `claude-opus` + `-5`, so plain prefix matching would let a request for `claude-opus` be "proven"
 * by `claude-opus-5` — a different model. Requiring the suffix to look like a date stamp keeps the
 * common dated-identifier case working while a truncated alias fails closed.
 */
export function modelIdentifierSatisfies(requested: string, reported: string): boolean {
  const want = requested.trim().toLowerCase();
  const got = reported.trim().toLowerCase();
  if (!want || !got) return false;
  if (got === want) return true;
  if (!got.startsWith(`${want}-`)) return false;
  return RELEASE_STAMP.test(got.slice(want.length + 1));
}

export interface ModelProofInput {
  /** the model the caller explicitly asked for, if any. */
  requested?: string;
  /** provider-native identifiers the runtime reported (modelUsage keys). */
  effective?: readonly string[];
  /** canonical families the runtime reported (modelUsage[].canonicalModel). */
  effectiveCanonical?: readonly string[];
}

/** Build the verdict. Never throws — an unusable input is `unproven`, never silently `proven`. */
export function resolveModelProof(input: ModelProofInput): ProbeModelProof {
  const requested = input.requested?.trim();
  const effective = [...new Set((input.effective ?? []).filter((entry) => entry.trim().length > 0))];
  const effectiveCanonical = [
    ...new Set((input.effectiveCanonical ?? []).filter((entry) => entry.trim().length > 0)),
  ];
  const reported = { ...(effective.length > 0 ? { effective } : {}), ...(effectiveCanonical.length > 0 ? { effectiveCanonical } : {}) };

  if (!requested) return { verdict: "not-requested", ...reported };
  if (effective.length === 0 && effectiveCanonical.length === 0) {
    return { verdict: "unproven", requested };
  }
  // Every reported model must satisfy the request. A run that used the requested model AND another
  // one is not a clean proof that the requested model produced the answer.
  const all = [...effective, ...effectiveCanonical];
  const satisfied = all.every((entry) => modelIdentifierSatisfies(requested, entry));
  return { verdict: satisfied ? "proven" : "mismatch", requested, ...reported };
}

/** Human-readable evidence for a refusal message — the reported identifiers, most precise first. */
export function describeEffectiveModels(proof: ProbeModelProof): string {
  const shown = proof.effective ?? proof.effectiveCanonical ?? [];
  return shown.length > 0 ? shown.join(", ") : "none reported";
}

/**
 * Apply the verdict to a finished result.
 *
 * `mismatch` always overrides — the runtime said it ran something else, which is unambiguous
 * regardless of runtime. `unproven` overrides only an otherwise-clean result on an adapter that
 * CAN report, because failing where proof is impossible would break working probes for no gain.
 * A result that already failed keeps its own reason: a timeout that also lacked model evidence is
 * still most usefully a timeout.
 */
export function enforceModelProof(
  result: ProbeResult,
  proof: ProbeModelProof,
  canReportEffectiveModel: boolean,
): ProbeResult {
  const withProof: ProbeResult = { ...result, modelProof: proof };
  if (proof.verdict === "mismatch") {
    return {
      ...withProof,
      reason: "model_mismatch",
      lastMessage: `probe requested model '${proof.requested}' but the runtime reported running`
        + ` ${describeEffectiveModels(proof)}; the result is refused as evidence`,
    };
  }
  if (proof.verdict === "unproven" && canReportEffectiveModel && result.reason === "ok") {
    return {
      ...withProof,
      reason: "model_unproven",
      lastMessage: `probe requested model '${proof.requested}' and the runtime reported no effective`
        + " model, so the result cannot be proven to come from that model",
    };
  }
  return withProof;
}
