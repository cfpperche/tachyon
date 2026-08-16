import { binaryOf } from "@tachyon/shared/resume/adapters.js";

/**
 * t-96c1b3 — on Opus 5+ both plan channels are absent from init.tools unless this is set.
 * Set, it yields TaskCreate/TaskUpdate/TaskGet/TaskList and filters TodoWrite
 * (docs/research/poc-plano-interno-claude.md).
 */
export const CLAUDE_CODE_ENABLE_TODO_TOOLS = "CLAUDE_CODE_ENABLE_TODO_TOOLS";

export function isClaudePlanToolsLaunch(runtimeOrCmd: string | undefined): boolean {
  if (!runtimeOrCmd) return false;
  return runtimeOrCmd === "claude" || binaryOf(runtimeOrCmd) === "claude";
}

/** Merge last so a caller cannot leave the plan tools off on a Claude launch. */
export function withClaudePlanToolsEnv(
  env: Record<string, string> | undefined,
  runtimeOrCmd: string | undefined,
): Record<string, string> {
  const next = { ...env };
  if (isClaudePlanToolsLaunch(runtimeOrCmd)) {
    next[CLAUDE_CODE_ENABLE_TODO_TOOLS] = "1";
  }
  return next;
}
