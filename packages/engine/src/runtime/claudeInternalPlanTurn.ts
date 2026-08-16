/**
 * t-011136 — Claude end-of-turn plan verdict.
 *
 * Window (docs/research/poc-plano-interno-claude.md, 2026-08-16, Claude Code 2.1.233):
 *   start  UserPromptSubmit hook (or the first event if the list is already mid-turn)
 *   end    hook Stop, or stream `type: result` with stop_reason end_turn /
 *          terminal_reason completed
 *   fail   hook StopFailure (auth emits this, not Stop), or result is_error /
 *          terminal_reason api_error
 *
 * Plan events in the window: TodoWrite, TaskCreate, TaskUpdate, TaskList,
 * TaskGet, TaskCreated. Subagent Task / TaskOutput / TaskStop are not the plan.
 *
 * Channel: any of those plan tools in `init.tools`. Opus 5 has none unless
 * CLAUDE_CODE_ENABLE_TODO_TOOLS=1 (fatia 1 sets that at launch).
 *
 * Do not treat StopFailure as Stop — a dead turn is not `sem-plano`.
 */
import { CLAUDE_INTERNAL_PLAN_TOOLS } from "./claudeInternalPlanReader.js";
import { decideInternalPlanTurnVerdict, type InternalPlanTurnJudgment } from "./internalPlanTurn.js";

const CLAUDE_PLAN_WRITE_TOOLS = new Set<string>([...CLAUDE_INTERNAL_PLAN_TOOLS, "TodoWrite"]);

export function claudePlanChannelPresent(initTools: readonly string[]): boolean {
  return initTools.some((name) => CLAUDE_PLAN_WRITE_TOOLS.has(name));
}

export function judgeClaudeInternalPlanTurn(input: {
  initTools: readonly string[];
  events: readonly unknown[];
}): InternalPlanTurnJudgment {
  const channelPresent = claudePlanChannelPresent(input.initTools ?? []);
  let turnEnded = false;
  let turnCompletedSuccessfully = false;
  let planEventInWindow = false;

  for (const raw of input.events) {
    const mark = classifyClaudeEvent(raw);
    if (!mark) continue;
    if (mark.kind === "turn-start") {
      turnEnded = false;
      turnCompletedSuccessfully = false;
      planEventInWindow = false;
      continue;
    }
    if (mark.kind === "plan") {
      planEventInWindow = true;
      continue;
    }
    turnEnded = true;
    turnCompletedSuccessfully = mark.outcome === "completed";
  }

  return decideInternalPlanTurnVerdict({
    turnEnded,
    turnCompletedSuccessfully,
    planEventInWindow,
    channelPresent,
  });
}

type ClaudeMark =
  | { kind: "turn-start" }
  | { kind: "turn-end"; outcome: "completed" | "failed" }
  | { kind: "plan" };

function classifyClaudeEvent(raw: unknown): ClaudeMark | undefined {
  if (!isPlainObject(raw)) return undefined;

  const hook = hookEventName(raw);
  if (hook === "UserPromptSubmit") return { kind: "turn-start" };
  if (hook === "Stop") return { kind: "turn-end", outcome: "completed" };
  if (hook === "StopFailure") return { kind: "turn-end", outcome: "failed" };
  if (hook === "TaskCreated") return { kind: "plan" };
  if (hook === "PreToolUse" || hook === "PostToolUse" || hook === "PostToolUseFailure") {
    const tool = toolName(raw);
    if (tool && CLAUDE_PLAN_WRITE_TOOLS.has(tool)) return { kind: "plan" };
    return undefined;
  }

  if (raw.type === "result") {
    if (raw.is_error === true || raw.terminal_reason === "api_error") {
      return { kind: "turn-end", outcome: "failed" };
    }
    if (raw.stop_reason === "end_turn" || raw.terminal_reason === "completed") {
      return { kind: "turn-end", outcome: "completed" };
    }
    return undefined;
  }

  if (hasPlanToolUse(raw)) return { kind: "plan" };
  return undefined;
}

function hookEventName(raw: Record<string, unknown>): string | undefined {
  if (typeof raw.hook_event_name === "string") return raw.hook_event_name;
  if (typeof raw.hook_event === "string") return raw.hook_event;
  if (raw.type === "hook" && typeof raw.event === "string") return raw.event;
  if ((raw.type === "hook_started" || raw.type === "hook_response") && typeof raw.hook_event === "string") {
    return raw.hook_event;
  }
  return undefined;
}

function toolName(raw: Record<string, unknown>): string | undefined {
  if (typeof raw.tool_name === "string") return raw.tool_name;
  if (typeof raw.toolName === "string") return raw.toolName;
  if (typeof raw.name === "string") return raw.name;
  return undefined;
}

function hasPlanToolUse(raw: Record<string, unknown>): boolean {
  if (raw.type === "tool_use" && typeof raw.name === "string" && CLAUDE_PLAN_WRITE_TOOLS.has(raw.name)) {
    return true;
  }
  const message = isPlainObject(raw.message) ? raw.message : undefined;
  const content = message && Array.isArray(message.content) ? message.content : undefined;
  if (!content) return false;
  return content.some(
    (entry) =>
      isPlainObject(entry) &&
      entry.type === "tool_use" &&
      typeof entry.name === "string" &&
      CLAUDE_PLAN_WRITE_TOOLS.has(entry.name),
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
