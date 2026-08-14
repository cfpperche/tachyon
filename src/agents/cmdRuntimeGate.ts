/**
 * t-6d09e6 — fail-closed when an agent's cmd/runtime identity changes.
 *
 * Editing cmd (e.g. claude → codex) does NOT migrate the native session. A live
 * process must be stopped first; any same-runtime resume id must be cleared so
 * the next start is a fresh conversation on the new runtime.
 */

import { binaryOf, runtimeOf } from "@tachyon/shared/resume/adapters.js";

/** Stable identity for "which CLI family is this cmd?" — runtime when known, else binary basename. */
export function cmdRuntimeIdentity(cmd: string): string {
  const rt = runtimeOf(cmd);
  if (rt) return rt;
  return binaryOf(cmd) || cmd.trim().split(/\s+/)[0] || "";
}

export function cmdRuntimeChanged(prevCmd: string, nextCmd: string): boolean {
  return cmdRuntimeIdentity(prevCmd) !== cmdRuntimeIdentity(nextCmd);
}

export type CmdRuntimeChangeGate =
  | { ok: true; clearResume: boolean }
  | { ok: false; code: "agent_running"; message: string };

/**
 * Gate a config edit that changes cmd/runtime for a named agent.
 * @param running true when the agent process is known alive (or uncertain→treat as running if caller prefers fail-closed)
 */
export function gateCmdRuntimeChange(input: {
  agent: string;
  prevCmd: string;
  nextCmd: string;
  running: boolean;
}): CmdRuntimeChangeGate {
  if (!cmdRuntimeChanged(input.prevCmd, input.nextCmd)) {
    return { ok: true, clearResume: false };
  }
  if (input.running) {
    return {
      ok: false,
      code: "agent_running",
      message:
        `can't change runtime for '${input.agent}' while it is running ` +
        `(${cmdRuntimeIdentity(input.prevCmd)} → ${cmdRuntimeIdentity(input.nextCmd)}). ` +
        `Stop the agent first. Native sessions are not migrated when cmd changes.`,
    };
  }
  return { ok: true, clearResume: true };
}
