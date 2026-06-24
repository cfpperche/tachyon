/**
 * Spec 257 — the probe result taxonomy. Pure types + classifiers; no fs / child_process / vscode.
 *
 * The captured, headless A2A lane's contract: every `probe_agent` / `read_probe_result` call resolves
 * to a {@link ProbeEnvelope} `{ runId, status, result? }` (D3). A finished run carries a
 * {@link ProbeResult} whose `reason` is a TACHYON-OWNED normalized category (D4) — never a
 * runtime-specific subtype, which lives under `native`. A per-runtime adapter maps its CLI's native
 * signalling onto exactly one reason; the neutral layer stays runtime-shaped-field-free.
 */

export type RunId = string;

/** A probe run's coarse lifecycle (D3). `running` carries no result yet — the caller polls. */
export type ProbeStatus = "running" | "completed" | "failed";

/**
 * Normalized, cross-runtime termination categories (D4). Each is a DISTINCT outcome — a timeout-kill
 * is not a model refusal is not a process crash is not a budget result. Adapters map native
 * signalling onto exactly one of these; none may be collapsed into a single boolean.
 */
export type TerminationReason =
  | "ok" // a clean, successful answer
  | "model_error" // the runtime returned a structured error *result* (not a crash)
  | "refused" // the model declined / safety refusal
  | "budget" // a cost/token budget was exhausted (a result, not a crash)
  | "timeout" // Tachyon's wall-clock cap killed the run
  | "killed_signal" // the process died from a signal (cancellation, OOM, external kill)
  | "process_error" // the process exited non-zero without a usable result
  | "parse_error" // the adapter could not parse the output/artifact (incl. schema non-compliance)
  | "empty_output"; // the process ended cleanly but produced no final message

/** Every reason, in declaration order — the exhaustive set adapters and tests iterate. */
export const ALL_TERMINATION_REASONS: readonly TerminationReason[] = [
  "ok",
  "model_error",
  "refused",
  "budget",
  "timeout",
  "killed_signal",
  "process_error",
  "parse_error",
  "empty_output",
] as const;

/**
 * Reasons whose run produced a real captured model message (→ `completed`). The rest are run-level
 * failures with no usable model output (→ `failed`). `budget`/`refused`/`model_error` are completions
 * because the runtime DID answer — with an error result whose text we lift into `lastMessage`.
 */
const COMPLETED_REASONS: ReadonlySet<TerminationReason> = new Set<TerminationReason>([
  "ok",
  "model_error",
  "refused",
  "budget",
]);

/** Runtime-specific signalling, preserved verbatim — NEVER promoted to the neutral layer (D4). */
export interface NativeOutcome {
  /** the runtime that produced this outcome (e.g. "claude", "codex"). */
  runtime: string;
  /** the runtime's own result subtype/category, if any (e.g. a Claude result `subtype`). */
  subtype?: string;
  /** any other runtime-specific fields, opaque to the neutral layer. */
  [k: string]: unknown;
}

/** The captured outcome of a finished probe (D4). Present on `completed` and `failed` envelopes. */
export interface ProbeResult {
  reason: TerminationReason;
  /** the model's clean final message, or the error text lifted from an error result. */
  lastMessage: string;
  /** process exit code; `null` when killed by signal/timeout before a code existed. */
  exitCode: number | null;
  /** the signal that killed the process, if any (e.g. "SIGKILL", "SIGTERM"). */
  signal?: string;
  /** true iff Tachyon's wall-clock cap fired (`reason === "timeout"`). */
  timedOut: boolean;
  /** cost in USD when the runtime reports it. */
  costUsd?: number;
  /** runtime-specific signalling, opaque (D4). */
  native: NativeOutcome;
}

/** The stable envelope returned by EVERY probe_agent / read_probe_result call (D3). */
export interface ProbeEnvelope {
  runId: RunId;
  status: ProbeStatus;
  /** present iff `status` is `completed` | `failed` (a captured outcome exists). */
  result?: ProbeResult;
}

/** The terminal status a reason maps to (D3/D4) — `completed` if the model answered, else `failed`. */
export function statusForReason(reason: TerminationReason): Exclude<ProbeStatus, "running"> {
  return COMPLETED_REASONS.has(reason) ? "completed" : "failed";
}

/** A clean, usable answer. */
export function isOk(result: ProbeResult): boolean {
  return result.reason === "ok";
}

/** Any non-clean outcome — an error result OR a run-level failure. */
export function isError(result: ProbeResult): boolean {
  return result.reason !== "ok";
}

/** Build the stable envelope for a finished run (status derived from the reason). */
export function envelopeFor(runId: RunId, result: ProbeResult): ProbeEnvelope {
  return { runId, status: statusForReason(result.reason), result };
}

/** The envelope for a still-running run — same shape, no result yet (D3). */
export function runningEnvelope(runId: RunId): ProbeEnvelope {
  return { runId, status: "running" };
}
