import type { DoneKind } from "./loadPipeline.js";

/**
 * spec 230 — pure done-contract evaluator. Given a node's declared `done` kind and the signals
 * observed so far, decide whether the node's WORK is complete, has failed, or is still pending (and
 * what it's waiting on). No side effects. Interactive-idle is never an input — completion is signal/exit.
 */

export interface NodeSignals {
  /** cmd nodes: the process exit code (undefined = still running). */
  exitCode?: number | null;
  /** agent nodes: the session ended (true = the agent exited/was killed). */
  exited?: boolean;
  /** agent nodes: `complete_node` was called (authenticated). */
  signalled?: boolean;
  /** the node's timeout elapsed. */
  timedOut?: boolean;
}

export type DoneVerdict =
  | { status: "done" }
  | { status: "failed"; reason: string }
  | { status: "pending"; waitingFor: string };

const PENDING_EXIT: DoneVerdict = { status: "pending", waitingFor: "process exit" };
const PENDING_SIGNAL: DoneVerdict = { status: "pending", waitingFor: "complete_node signal" };

function fromExit(s: NodeSignals): DoneVerdict {
  if (s.exitCode === undefined || s.exitCode === null) return PENDING_EXIT;
  return s.exitCode === 0 ? { status: "done" } : { status: "failed", reason: `exited with code ${s.exitCode}` };
}

function fromSignal(s: NodeSignals): DoneVerdict {
  if (s.signalled) return { status: "done" };
  if (s.exited) return { status: "failed", reason: "session ended without signalling completion" };
  return PENDING_SIGNAL;
}

export function evaluateDone(done: DoneKind, s: NodeSignals): DoneVerdict {
  if (s.timedOut) return { status: "failed", reason: "timed out" };
  switch (done) {
    case "exit":
      return fromExit(s);
    case "signal":
      return fromSignal(s);
  }
}
