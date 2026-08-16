/**
 * t-281339 — host door that consumes the three fatia-1 readers.
 * Does not re-project a plan. Mute when the runtime has no channel yet.
 *
 * Who else can reach this:
 *   Tachyon × fleet refresh → read
 *   Tachyon × spawn / restart / resume → same door, new session identity
 *   Interface / Agent / Bridge → cannot write a snapshot here
 */
import { readClaudeInternalChecklist } from "../runtime/claudeInternalChecklistReader.js";
import { readCodexTuiInternalChecklist } from "../runtime/codexTuiInternalChecklistReader.js";
import { readGrokInternalChecklist } from "../runtime/grokInternalChecklistReader.js";
import type { InternalChecklistRead } from "../runtime/internalChecklist.js";

export interface ReadAgentInternalChecklistInput {
  runtime: string | undefined;
  workspaceRoot: string;
  agent: string;
  cwd?: string;
  sessionId?: string;
  configHome?: string;
}

export function readAgentInternalChecklist(input: ReadAgentInternalChecklistInput): InternalChecklistRead {
  if (input.runtime === "grok") {
    if (!input.sessionId) return { state: "mute" };
    return readGrokInternalChecklist({
      configHome: input.configHome ?? "",
      cwd: input.cwd ?? "",
      sessionId: input.sessionId,
    });
  }
  if (input.runtime === "claude") {
    if (!input.sessionId || !input.configHome) return { state: "mute" };
    return readClaudeInternalChecklist({
      configHome: input.configHome,
      sessionId: input.sessionId,
    });
  }
  if (input.runtime === "codex") {
    return readCodexTuiInternalChecklist(input.workspaceRoot, input.agent);
  }
  return { state: "mute" };
}
