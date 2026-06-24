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
import { readFile as fsReadFile } from "node:fs/promises";
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

/** The real spawn: argv array, never a shell; collects stdout/stderr; resolves `exit` on close. */
export const defaultSpawn: SpawnFn = (inv) => {
  const child = nodeSpawn(inv.cmd, inv.args, {
    cwd: inv.cwd,
    env: inv.env ? { ...process.env, ...inv.env } : process.env,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (d) => (stdout += d.toString()));
  child.stderr?.on("data", (d) => (stderr += d.toString()));
  const exit = new Promise<ProbeExit>((resolve) => {
    child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
    child.on("error", () => resolve({ code: null, signal: null, stdout, stderr }));
  });
  return { pid: child.pid, kill: (s) => child.kill(s), exit };
};

async function readArtifact(path: string | undefined, readFile: ReadFileFn): Promise<string | undefined> {
  if (!path) return undefined;
  try {
    return await readFile(path);
  } catch {
    return undefined; // absent artifact is a real signal (empty_output / parse_error), not a throw
  }
}

/** Best-effort diagnostic message for a run-level failure: the artifact, else trimmed stdout. */
function diagnosticMessage(raw: RawOutcome): string {
  return (raw.resultArtifactText ?? raw.stdout ?? "").trim();
}

function runLevelResult(
  reason: "timeout" | "killed_signal",
  raw: RawOutcome,
  spec: ProbeSpec,
  over: { signal?: string },
): ProbeResult {
  return {
    reason,
    lastMessage: diagnosticMessage(raw),
    exitCode: null,
    signal: over.signal ?? raw.signal ?? undefined,
    timedOut: reason === "timeout",
    native: { runtime: spec.runtime },
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
  const readFile = opts.readFile ?? ((p: string) => fsReadFile(p, "utf8"));
  const killGraceMs = opts.killGraceMs ?? 2000;

  const inv = adapter.buildInvocation(spec, opts.scratchDir);
  const child = spawn(inv);

  let timedOut = false;
  let cancelled = false;
  let escalation: NodeJS.Timeout | undefined;

  const terminate = () => {
    child.kill("SIGTERM");
    escalation = setTimeout(() => child.kill("SIGKILL"), killGraceMs);
  };

  const timer = setTimeout(() => {
    timedOut = true;
    terminate();
  }, spec.timeoutMs);

  const onAbort = () => {
    cancelled = true;
    terminate();
  };
  if (opts.signal) {
    if (opts.signal.aborted) onAbort();
    else opts.signal.addEventListener("abort", onAbort, { once: true });
  }

  let exit: ProbeExit;
  try {
    exit = await child.exit;
  } finally {
    clearTimeout(timer);
    if (escalation) clearTimeout(escalation);
    opts.signal?.removeEventListener("abort", onAbort);
  }

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
  return adapter.interpret(raw, spec);
}
