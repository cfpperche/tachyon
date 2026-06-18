import type { DoneKind } from "./loadPipeline.js";

/**
 * spec 230 — pure done-contract evaluator. Given a node's declared `done` kind and the signals
 * observed so far, decide whether the node's WORK is complete, has failed, or is still pending (and
 * what it's waiting on). The executor reads `pending.waitingFor` to know what to do next (e.g. run the
 * verify gate). No side effects. Interactive-idle is never an input — completion is signal/exit + verify.
 */

export interface NodeSignals {
  /** cmd nodes: the process exit code (undefined = still running). */
  exitCode?: number | null;
  /** agent nodes: the session ended (true = the agent exited/was killed). */
  exited?: boolean;
  /** agent nodes: `complete_node` was called (authenticated). */
  signalled?: boolean;
  /** result of the on-demand verify gate (undefined = not run yet / running). */
  verify?: { passed: boolean; stale: boolean } | null;
  /** the node's timeout elapsed. */
  timedOut?: boolean;
}

export type DoneVerdict =
  | { status: "done" }
  | { status: "failed"; reason: string }
  | { status: "pending"; waitingFor: string };

const PENDING_EXIT: DoneVerdict = { status: "pending", waitingFor: "process exit" };
const PENDING_SIGNAL: DoneVerdict = { status: "pending", waitingFor: "complete_node signal" };
const PENDING_VERIFY: DoneVerdict = { status: "pending", waitingFor: "verify gate" };

function fromExit(s: NodeSignals): DoneVerdict {
  if (s.exitCode === undefined || s.exitCode === null) return PENDING_EXIT;
  return s.exitCode === 0 ? { status: "done" } : { status: "failed", reason: `exited with code ${s.exitCode}` };
}

function fromSignal(s: NodeSignals): DoneVerdict {
  if (s.signalled) return { status: "done" };
  if (s.exited) return { status: "failed", reason: "session ended without signalling completion" };
  return PENDING_SIGNAL;
}

function fromVerify(s: NodeSignals): DoneVerdict {
  if (s.verify === undefined || s.verify === null) return PENDING_VERIFY;
  if (!s.verify.passed) return { status: "failed", reason: "verify gate red" };
  if (s.verify.stale) return { status: "failed", reason: "verify stale (no-op diff)" };
  return { status: "done" };
}

export function evaluateDone(done: DoneKind, s: NodeSignals): DoneVerdict {
  if (s.timedOut) return { status: "failed", reason: "timed out" };
  switch (done) {
    case "exit":
      return fromExit(s);
    case "exit_then_verify": {
      const e = fromExit(s);
      return e.status === "done" ? fromVerify(s) : e;
    }
    case "signal":
      return fromSignal(s);
    case "signal_then_verify": {
      const sig = fromSignal(s);
      return sig.status === "done" ? fromVerify(s) : sig;
    }
  }
}
