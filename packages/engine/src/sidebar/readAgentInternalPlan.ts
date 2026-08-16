/**
 * t-281339 — host door that consumes the three fatia-1 readers.
 * Does not re-project a plan. Mute when the runtime has no channel yet.
 *
 * Who else can reach this:
 *   Tachyon × fleet refresh → read
 *   Tachyon × spawn / restart / resume → same door, new session identity
 *   Interface / Agent / Bridge → cannot write a snapshot here
 */
import { readClaudeInternalPlan } from "../runtime/claudeInternalPlanReader.js";
import { readCodexTuiInternalPlan } from "../runtime/codexTuiInternalPlanReader.js";
import { readGrokInternalPlan } from "../runtime/grokInternalPlanReader.js";
import type { InternalPlanRead } from "../runtime/internalPlan.js";

export interface ReadAgentInternalPlanInput {
  runtime: string | undefined;
  workspaceRoot: string;
  agent: string;
  cwd?: string;
  sessionId?: string;
  configHome?: string;
}

export function readAgentInternalPlan(input: ReadAgentInternalPlanInput): InternalPlanRead {
  if (input.runtime === "grok") {
    if (!input.sessionId) return { state: "mute" };
    return readGrokInternalPlan({
      configHome: input.configHome ?? "",
      cwd: input.cwd ?? "",
      sessionId: input.sessionId,
    });
  }
  if (input.runtime === "claude") {
    if (!input.sessionId || !input.configHome) return { state: "mute" };
    return readClaudeInternalPlan({
      configHome: input.configHome,
      sessionId: input.sessionId,
    });
  }
  if (input.runtime === "codex") {
    return readCodexTuiInternalPlan(input.workspaceRoot, input.agent);
  }
  return { state: "mute" };
}
