/**
 * Spec 257 (D5) — the per-runtime headless-capture adapter contract. Pure types; no fs / spawn here.
 *
 * Division of labour: the {@link ProbeRunner} owns PROCESS LIFECYCLE (spawn, timeout, cancel, signal);
 * an adapter owns INVOCATION (how to call its CLI non-interactively) + INTERPRETATION (mapping the
 * finished process's native signalling onto the neutral {@link ProbeResult}/`terminationReason`, D4).
 * An adapter reads the runtime's own ARTIFACT files for the answer — never raw stdout, which carries
 * login/update/MCP-startup noise (D5).
 */

import type { ProbeModelEvidence, ProbeResult } from "@tachyon/engine/probe/taxonomy.js";

/** A runtime-neutral probe request — what to ask, where, under what bounds. */
export interface ProbeSpec {
  runtime: string;
  /** the composed brief (archetype framing already folded in by the caller). */
  prompt: string;
  model?: string;
  cwd: string;
  timeoutMs: number;
  /** neutral least-privilege intent; the adapter maps it to its runtime's sandbox flag (D8). */
  sandbox?: "read-only" | "workspace-write";
  budgetUsd?: number;
  /** archetype id whose output schema the prompt asked the model to emit (informational). */
  archetype?: string;
}

/** The concrete child-process invocation an adapter produces from a {@link ProbeSpec}. argv array, no shell. */
export interface Invocation {
  cmd: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  /** absolute path the runtime is told to write its final message to (file-based capture). */
  resultArtifact?: string;
  /** absolute path for the machine-readable event stream, if any. */
  eventArtifact?: string;
}

/** The raw process outcome the runner hands the adapter to interpret. */
export interface RawOutcome {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  /** contents of {@link Invocation.resultArtifact}, if the adapter requested one and it was read. */
  resultArtifactText?: string;
  /** contents of {@link Invocation.eventArtifact}, if present. */
  eventArtifactText?: string;
}

/** A per-runtime capability/compat report (D5) — recorded with each run so a CLI upgrade is visible. */
export interface CapabilityReport {
  available: boolean;
  binaryVersion?: string;
  /** why unavailable, when `available` is false (honest refusal, never faked). */
  reason?: string;
}

/** D5 — a runtime's headless-capture adapter. */
export interface HeadlessCaptureAdapter {
  readonly runtime: string;
  /** adapter contract version, recorded with each run (D5 versioning surface). */
  readonly adapterVersion: string;
  /**
   * SDD 473 — whether this runtime reports which model actually ran. Declared rather than inferred
   * from the runtime name, so the reason a runtime is exempt from model-proof enforcement is stated
   * here, and turning enforcement on later is a declaration instead of a change in the service.
   */
  readonly reportsEffectiveModel?: boolean;
  /**
   * SDD 476 — WHAT KIND of evidence this adapter's model reporting is, declared next to the claim
   * that it reports at all. Provider usage accounting and a runtime's own session record are both
   * reported (never inferred) and are not equally strong, and the difference belongs in the record
   * rather than in a reader's assumption.
   */
  readonly modelEvidence?: ProbeModelEvidence;
  /** build the non-interactive invocation; `scratchDir` is where artifact files may be placed.
   *  May be async — an adapter that needs private state on disk (SDD 476) prepares it here. */
  buildInvocation(spec: ProbeSpec, scratchDir: string): Invocation | Promise<Invocation>;
  /** interpret a finished process into the neutral result — content classification only; the runner
   *  has already handled timeout/signal run-level failures before delegating here. `inv` is the
   *  invocation that actually ran, so an adapter can find the private state it asked for; the runner
   *  always supplies it, and an adapter that needs it must FAIL CLOSED when it is absent rather than
   *  substitute a weaker answer (SDD 476). */
  interpret(raw: RawOutcome, spec: ProbeSpec, inv?: Invocation): ProbeResult | Promise<ProbeResult>;
  /**
   * SDD 476 — deterministic teardown of whatever {@link buildInvocation} put on disk. The runner
   * awaits this once the process is gone, on EVERY path: clean exit, timeout, cancellation, spawn
   * failure, and a throwing `interpret`. Best-effort by contract — a failure here never changes the
   * probe's outcome.
   */
  cleanup?(inv: Invocation): Promise<void>;
  /** capability + compatibility probe (D5). */
  detectCapability(): Promise<CapabilityReport>;
}

/**
 * SDD 476 — an adapter whose invocation and interpretation are pure computation: nothing to prepare
 * on disk before the spawn, nothing to tear down after it. Claude and Grok are these; Codex is not,
 * because proving its effective model requires a private `CODEX_HOME` with a real lifecycle.
 *
 * Declaring it in the type rather than in a comment means "does this adapter touch disk?" stays a
 * checked fact: a stateless adapter cannot quietly grow a `cleanup` that nothing awaits.
 */
export interface StatelessCaptureAdapter extends HeadlessCaptureAdapter {
  buildInvocation(spec: ProbeSpec, scratchDir: string): Invocation;
  interpret(raw: RawOutcome, spec: ProbeSpec, inv?: Invocation): ProbeResult;
  cleanup?: undefined;
}
