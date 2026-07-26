/**
 * Spec 257 (D5) — the per-runtime headless-capture adapter contract. Pure types; no fs / spawn here.
 *
 * Division of labour: the {@link ProbeRunner} owns PROCESS LIFECYCLE (spawn, timeout, cancel, signal);
 * an adapter owns INVOCATION (how to call its CLI non-interactively) + INTERPRETATION (mapping the
 * finished process's native signalling onto the neutral {@link ProbeResult}/`terminationReason`, D4).
 * An adapter reads the runtime's own ARTIFACT files for the answer — never raw stdout, which carries
 * login/update/MCP-startup noise (D5).
 */

import type { ProbeResult } from "../taxonomy.js";

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
  /** build the non-interactive invocation; `scratchDir` is where artifact files may be placed. */
  buildInvocation(spec: ProbeSpec, scratchDir: string): Invocation;
  /** interpret a finished process into the neutral result — content classification only; the runner
   *  has already handled timeout/signal run-level failures before delegating here. */
  interpret(raw: RawOutcome, spec: ProbeSpec): ProbeResult;
  /** capability + compatibility probe (D5). */
  detectCapability(): Promise<CapabilityReport>;
}
