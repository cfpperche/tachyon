/**
 * t-7551f9 — continue an unfinished task on a different agent/runtime.
 *
 * Spawns a NEW session on `toAgent` with a focused handoff as taskBrief.
 * Does not stop `fromAgent`, does not clear its resume, does not claim native migration.
 */

import { writeFocusedHandoff, type FocusedHandoffPacket } from "./focusedHandoff.js";
import { cmdRuntimeIdentity } from "../agents/cmdRuntimeGate.js";

export interface ContinueTaskInput {
  workspaceRoot: string;
  fromAgent: string;
  fromCmd: string;
  toAgent: string;
  toCmd: string;
  reason?: string;
  taskSummary?: string;
  sourceTranscriptPath?: string;
  workspaceNote?: string;
  recentProgress?: string[];
  blockers?: string[];
  /** Destination agent is currently running. */
  toAgentRunning: boolean;
}

export type ContinueTaskPrep =
  | { ok: true; packet: FocusedHandoffPacket; taskBrief: string }
  | { ok: false; code: string; message: string };

export function prepareContinueTask(input: ContinueTaskInput): ContinueTaskPrep {
  if (!input.fromAgent.trim() || !input.toAgent.trim()) {
    return { ok: false, code: "invalid_names", message: "fromAgent and toAgent are required." };
  }
  if (input.fromAgent === input.toAgent) {
    return {
      ok: false,
      code: "same_agent",
      message: "Continue task requires a different destination agent (new session on another row).",
    };
  }
  if (input.toAgentRunning) {
    return {
      ok: false,
      code: "dest_running",
      message: `Destination agent '${input.toAgent}' is already running — stop it first or pick another agent.`,
    };
  }
  if (!input.toCmd.trim()) {
    return { ok: false, code: "no_dest_cmd", message: `Destination agent '${input.toAgent}' has no cmd.` };
  }
  // Same runtime is allowed (fresh context window) but warn via packet reason only.
  const packet = writeFocusedHandoff(input.workspaceRoot, {
    fromAgent: input.fromAgent,
    fromCmd: input.fromCmd,
    toAgent: input.toAgent,
    toCmd: input.toCmd,
    reason: input.reason,
    taskSummary: input.taskSummary,
    sourceTranscriptPath: input.sourceTranscriptPath,
    workspaceNote: input.workspaceNote,
    recentProgress: input.recentProgress,
    blockers: input.blockers,
  });
  const taskBrief =
    `## Tachyon task continuation (${packet.id})\n\n` +
    `You are continuing work from agent \`${input.fromAgent}\` ` +
    `(${cmdRuntimeIdentity(input.fromCmd)} → ${cmdRuntimeIdentity(input.toCmd)}). ` +
    `Read the handoff file in this workspace and continue from there:\n\n` +
    `\`${packet.relPath}\`\n\n` +
    packet.markdown;
  return { ok: true, packet, taskBrief };
}
