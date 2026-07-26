/**
 * Spec 257 (D6, OQ3) — the engine-managed probe subprocess runner. NOT tmux: a probe is a plain
 * child process whose lifecycle Tachyon owns (timeout, cancel, signal), capturing from the runtime's
 * artifact files rather than scraping a pane.
 *
 * Run-level vs content failures (D4): the runner classifies `timeout` and `killed_signal` itself
 * (it alone knows the wall-clock cap fired or the process was cancelled); everything else — ok /
 * model_error / refused / budget / parse_error / empty_output / process_error — is the adapter's
 * content interpretation. The `spawn` + `readFile` seams are injectable so the runner is table-testable
 * without real processes (the fetcher/spawnContract precedent).
 */

import { spawn as nodeSpawn } from "node:child_process";
import { open as fsOpen } from "node:fs/promises";
import type { ProbeResult } from "./taxonomy.js";
import type { HeadlessCaptureAdapter, Invocation, ProbeSpec, RawOutcome } from "./adapters/types.js";

/** What a finished child reports back. */
export interface ProbeExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

/** A spawned probe child the runner can wait on and kill. */
export interface ProbeChild {
  readonly pid: number | undefined;
  kill(signal?: NodeJS.Signals): void;
  /** resolves once the process has fully exited (after stdout/stderr are collected). */
  readonly exit: Promise<ProbeExit>;
}

export type SpawnFn = (inv: Invocation) => ProbeChild;
export type ReadFileFn = (path: string) => Promise<string>;

export interface RunOptions {
  /** directory the adapter may write artifact files under. */
  scratchDir: string;
  /** cancellation — aborting kills the process and yields `killed_signal`. */
  signal?: AbortSignal;
  /** injectable seams (tests). */
  spawn?: SpawnFn;
  readFile?: ReadFileFn;
  /** ms to wait after SIGTERM before escalating to SIGKILL (default 2000). */
  killGraceMs?: number;
}

/** Per-stream collection cap — a noisy CLI cannot grow stdout/stderr unbounded (codex review #45). */
const STREAM_CAP_BYTES = 1024 * 1024; // 1 MiB
/** Per-artifact read cap — bound the read BEFORE the store caps it, so a runaway file can't OOM us (#12). */
const ARTIFACT_READ_CAP_BYTES = 5 * 1024 * 1024; // 5 MiB
/** Timeout/cancel diagnostics must be useful, not an unbounded dump of JSON event streams. */
const DIAGNOSTIC_CAP_CHARS = 4000;

/** The real spawn: argv array, never a shell; collects (capped) stdout/stderr; resolves `exit` on close. */
export const defaultSpawn: SpawnFn = (inv) => {
  const child = nodeSpawn(inv.cmd, inv.args, {
    cwd: inv.cwd,
    env: inv.env ? { ...process.env, ...inv.env } : process.env,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  const cap = (cur: string, d: Buffer): string => (cur.length >= STREAM_CAP_BYTES ? cur : `${cur}${d.toString()}`.slice(0, STREAM_CAP_BYTES));
  child.stdout?.on("data", (d) => (stdout = cap(stdout, d)));
  child.stderr?.on("data", (d) => (stderr = cap(stderr, d)));
  const exit = new Promise<ProbeExit>((resolve) => {
    child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
    // a spawn failure (ENOENT/EACCES) carries no exit code — surface the message so the adapter
    // classifies process_error with a reason, not an empty parse_error (codex review #7).
    child.on("error", (err) => resolve({ code: null, signal: null, stdout, stderr: stderr || `spawn error: ${err instanceof Error ? err.message : String(err)}` }));
  });
  return { pid: child.pid, kill: (s) => child.kill(s), exit };
};

/** Bounded artifact read — reads at most {@link ARTIFACT_READ_CAP_BYTES}, so a huge file can't OOM us. */
async function boundedReadFile(p: string): Promise<string> {
  const fh = await fsOpen(p, "r");
  try {
    const buf = Buffer.allocUnsafe(ARTIFACT_READ_CAP_BYTES);
    const { bytesRead } = await fh.read(buf, 0, ARTIFACT_READ_CAP_BYTES, 0);
    return buf.subarray(0, bytesRead).toString("utf8");
  } finally {
    await fh.close();
  }
}

async function readArtifact(path: string | undefined, readFile: ReadFileFn): Promise<string | undefined> {
  if (!path) return undefined;
  try {
    return await readFile(path);
  } catch {
    return undefined; // absent artifact is a real signal (empty_output / parse_error), not a throw
  }
}

/** Best-effort diagnostic message for a run-level failure: artifact, stdout, stderr, else synthesized. */
function diagnosticMessage(raw: RawOutcome): string {
  const msg = [raw.resultArtifactText, raw.stdout, raw.stderr].map((s) => (s ?? "").trim()).find((s) => s.length > 0) ?? "";
  if (msg.length <= DIAGNOSTIC_CAP_CHARS) return msg;
  return `${msg.slice(0, DIAGNOSTIC_CAP_CHARS)}\n…[truncated ${msg.length - DIAGNOSTIC_CAP_CHARS} chars]`;
}

function synthesizedDiagnostic(raw: RawOutcome, spec: ProbeSpec, reason: "timeout" | "killed_signal", signal?: string): string {
  const boundary = reason === "timeout" ? `timed out after ${spec.timeoutMs}ms` : "was killed before completion";
  const sig = signal ?? raw.signal ?? "unknown";
  const code = raw.exitCode === null ? "null" : String(raw.exitCode);
  return `Probe ${boundary}; no result artifact, stdout, or stderr was captured. runtime=${spec.runtime} signal=${sig} exitCode=${code}`;
}

function runLevelResult(
  reason: "timeout" | "killed_signal",
  raw: RawOutcome,
  spec: ProbeSpec,
  over: { signal?: string },
): ProbeResult {
  const signal = over.signal ?? raw.signal ?? undefined;
  const diagnostic = diagnosticMessage(raw) || synthesizedDiagnostic(raw, spec, reason, signal);
  return {
    reason,
    lastMessage: diagnostic,
    exitCode: null,
    signal,
    timedOut: reason === "timeout",
    native: { runtime: spec.runtime, timeoutMs: spec.timeoutMs },
  };
}

/**
 * Run one probe to completion. Resolves to a {@link ProbeResult} — it never throws on a probe-level
 * failure (those become a reason); it only rejects on a programming error (no adapter invocation).
 */
export async function runProbe(
  adapter: HeadlessCaptureAdapter,
  spec: ProbeSpec,
  opts: RunOptions,
): Promise<ProbeResult> {
  const spawn = opts.spawn ?? defaultSpawn;
  const readFile = opts.readFile ?? boundedReadFile;
  const killGraceMs = opts.killGraceMs ?? 2000;

  const cancelledResult = (message: string): ProbeResult => ({
    reason: "killed_signal", lastMessage: message, exitCode: null, signal: "SIGTERM", timedOut: false, native: { runtime: spec.runtime },
  });

  // Cancelled before we launch — never spawn the CLI at all (codex review #4).
  if (opts.signal?.aborted) return cancelledResult("cancelled before launch");

  let timedOut = false;
  let cancelled = false;
  let terminating = false;
  let escalation: NodeJS.Timeout | undefined;
  let child: ProbeChild | undefined;

  // Idempotent termination — a timeout+abort race must not double-signal or leak a second escalation
  // timer (codex review #5/#6). Before the spawn there is nothing to signal; `cancelled` is what the
  // launch path below reads instead.
  const terminate = () => {
    if (terminating || !child) return;
    terminating = true;
    child.kill("SIGTERM");
    escalation = setTimeout(() => child!.kill("SIGKILL"), killGraceMs);
  };

  const onAbort = () => {
    cancelled = true;
    terminate();
  };
  // SDD 476 — registered BEFORE the (possibly async) buildInvocation. Preparing an adapter's private
  // state is an await, and an abort landing inside that window used to be dropped: the listener did
  // not exist yet, so the probe ran to completion or to its timeout as if nobody had cancelled it.
  opts.signal?.addEventListener("abort", onAbort, { once: true });

  // SDD 476 — may be async: an adapter that isolates runtime state (Codex's private CODEX_HOME)
  // creates it here. A throw propagates before anything spawned, so there is nothing to tear down —
  // but a SUCCESSFUL preparation followed by a cancellation must still be torn down, hence the
  // `cleanup` below rather than a bare return.
  let inv: Invocation;
  try {
    inv = await adapter.buildInvocation(spec, opts.scratchDir);
  } catch (err) {
    opts.signal?.removeEventListener("abort", onAbort);
    throw err;
  }
  if (cancelled) {
    opts.signal?.removeEventListener("abort", onAbort);
    if (adapter.cleanup) await adapter.cleanup(inv).catch(() => undefined);
    return cancelledResult("cancelled before launch");
  }
  let started: ProbeChild;
  try {
    started = spawn(inv);
    child = started;
  } catch (err) {
    // A spawn that throws outright still leaves the adapter's prepared state behind, so tear it down
    // here too — the `finally` below is only reached once there is a child to wait on.
    opts.signal?.removeEventListener("abort", onAbort);
    if (adapter.cleanup) await adapter.cleanup(inv).catch(() => undefined);
    throw err;
  }

  const timer = setTimeout(() => {
    timedOut = true;
    terminate();
  }, spec.timeoutMs);

  let exit: ProbeExit;
  try {
    exit = await started.exit;
  } finally {
    clearTimeout(timer);
    if (escalation) clearTimeout(escalation);
    opts.signal?.removeEventListener("abort", onAbort);
  }

  // SDD 476 — from here on the process is gone and the adapter may have private state on disk, so
  // every exit path runs through one `finally`: timeout, cancel, clean exit, or a throwing
  // `interpret`. Teardown is best-effort and never rewrites the outcome.
  try {
    const raw: RawOutcome = {
      stdout: exit.stdout,
      stderr: exit.stderr,
      exitCode: exit.code,
      signal: exit.signal,
      timedOut,
      resultArtifactText: await readArtifact(inv.resultArtifact, readFile),
      eventArtifactText: await readArtifact(inv.eventArtifact, readFile),
    };

    if (timedOut) return runLevelResult("timeout", raw, spec, {});
    if (cancelled || (raw.exitCode === null && raw.signal)) {
      return runLevelResult("killed_signal", raw, spec, { signal: raw.signal ?? "SIGTERM" });
    }
    return await adapter.interpret(raw, spec, inv);
  } finally {
    if (adapter.cleanup) await adapter.cleanup(inv).catch(() => undefined);
  }
}
