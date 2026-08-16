/**
 * t-011136 — Grok end-of-turn plan verdict.
 *
 * Window (docs/research/poc-plano-interno-grok.md, 2026-08-16, grok 1.0.4):
 *   identity  `promptId` / `turnStartMs` on `updates.jsonl` session/update lines
 *   start     `user_message_chunk`, or the first event that carries a new
 *             promptId / turnStartMs
 *   end       `sessionUpdate: "turn_completed"` (also streaming-json `type: "end"`)
 *   success   `stop_reason === "end_turn"` (measured) or omitted
 *   fail      any other stop_reason
 *
 * Plan events in the window: `sessionUpdate: "plan"`, `TodosUpdated`,
 * `todo_write` / `type: "plan"`. `plan.json` is not the store (fatia 1).
 *
 * Channel: live `updates.jsonl`. `events.jsonl` names `todo_write` and
 * records `turn_ended` but does not carry the plan — a turn-end seen only
 * there is `sem-canal`, not `sem-plano`. Post-dismiss wipe (t-23ee99) is
 * not evidence; a missing session is `turn-open`, not mute.
 *
 * A measured TUI turn ran ~7 minutes with no plan and then wrote one.
 * Evaluating before `turn_completed` is `turn-open`.
 */
import fs from "node:fs";
import path from "node:path";
import { grokInternalPlanUpdatesPath } from "./grokInternalPlanReader.js";
import { decideInternalPlanTurnVerdict, type InternalPlanTurnJudgment } from "./internalPlanTurn.js";

const GROK_EVENTS_FILE = "events.jsonl";

export function judgeGrokInternalPlanTurn(input: {
  configHome: string;
  cwd: string;
  sessionId: string;
  promptId?: string;
}): InternalPlanTurnJudgment {
  const updates = grokInternalPlanUpdatesPath(input);
  if (updates && fs.existsSync(updates)) {
    let text: string;
    try {
      text = fs.readFileSync(updates, "utf8");
    } catch {
      return decideInternalPlanTurnVerdict({
        turnEnded: false,
        turnCompletedSuccessfully: false,
        planEventInWindow: false,
        channelPresent: true,
      });
    }
    return judgeGrokInternalPlanLines({
      lines: text.split("\n"),
      promptId: input.promptId,
      channelPresent: true,
    });
  }

  const sessionDir = updates ? path.dirname(updates) : undefined;
  const eventsFile = sessionDir ? path.join(sessionDir, GROK_EVENTS_FILE) : undefined;
  if (eventsFile && fs.existsSync(eventsFile) && eventsJsonlHasTurnEnded(eventsFile, input.promptId)) {
    return decideInternalPlanTurnVerdict({
      turnEnded: true,
      turnCompletedSuccessfully: true,
      planEventInWindow: false,
      channelPresent: false,
    });
  }

  return decideInternalPlanTurnVerdict({
    turnEnded: false,
    turnCompletedSuccessfully: false,
    planEventInWindow: false,
    channelPresent: false,
  });
}

export function judgeGrokInternalPlanLines(input: {
  lines: readonly string[];
  promptId?: string;
  channelPresent: boolean;
}): InternalPlanTurnJudgment {
  const turns: GrokTurn[] = [];
  let current: GrokTurn | undefined;

  for (const line of input.lines) {
    const ev = parseGrokLine(line);
    if (!ev) continue;

    if (ev.sessionUpdate === "user_message_chunk") {
      current = startTurn(turns, ev);
      continue;
    }

    let turn =
      (ev.promptId ? turns.find((row) => row.promptId === ev.promptId) : undefined) ?? current;
    if (!turn) {
      turn = startTurn(turns, ev);
      current = turn;
    }
    if (ev.promptId && !turn.promptId) turn.promptId = ev.promptId;
    if (ev.turnStartMs !== undefined && turn.turnStartMs === undefined) {
      turn.turnStartMs = ev.turnStartMs;
    }
    if (ev.plan) turn.plan = true;
    if (ev.turnEnded) {
      turn.ended = true;
      turn.stopReason = ev.stopReason;
    }
  }

  const turn = pickTurn(turns, input.promptId);
  const success = turn?.ended === true && grokTurnSucceeded(turn.stopReason);
  return decideInternalPlanTurnVerdict({
    turnEnded: turn?.ended === true,
    turnCompletedSuccessfully: success,
    planEventInWindow: turn?.plan === true,
    channelPresent: input.channelPresent,
  });
}

type GrokTurn = {
  promptId?: string;
  turnStartMs?: number;
  plan: boolean;
  ended: boolean;
  stopReason?: string;
};

type GrokEvent = {
  sessionUpdate?: string;
  promptId?: string;
  turnStartMs?: number;
  plan: boolean;
  turnEnded: boolean;
  stopReason?: string;
};

function startTurn(turns: GrokTurn[], ev: GrokEvent): GrokTurn {
  const turn: GrokTurn = {
    promptId: ev.promptId,
    turnStartMs: ev.turnStartMs,
    plan: ev.plan,
    ended: ev.turnEnded,
    stopReason: ev.stopReason,
  };
  turns.push(turn);
  return turn;
}

function pickTurn(turns: readonly GrokTurn[], promptId: string | undefined): GrokTurn | undefined {
  if (promptId) return turns.find((row) => row.promptId === promptId);
  return turns.length > 0 ? turns[turns.length - 1] : undefined;
}

function grokTurnSucceeded(stopReason: string | undefined): boolean {
  return stopReason === undefined || stopReason === "end_turn";
}

function parseGrokLine(line: string): GrokEvent | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
  if (!isPlainObject(parsed)) return undefined;

  if (parsed.type === "end" || parsed.type === "turn_ended" || parsed.event === "turn_ended") {
    return {
      promptId: stringField(parsed, "promptId") ?? stringField(parsed, "prompt_id"),
      turnEnded: true,
      stopReason: stringField(parsed, "stopReason") ?? stringField(parsed, "stop_reason"),
      plan: parsed.type === "plan",
    };
  }
  if (parsed.type === "plan") {
    return {
      promptId: stringField(parsed, "promptId") ?? stringField(parsed, "prompt_id"),
      turnEnded: false,
      plan: true,
    };
  }

  const update = extractUpdate(parsed);
  if (!update) return undefined;
  const meta = metaOf(parsed, update);
  const sessionUpdate = typeof update.sessionUpdate === "string" ? update.sessionUpdate : undefined;
  const promptId =
    stringField(update, "prompt_id") ?? stringField(meta, "promptId") ?? stringField(parsed, "prompt_id");
  const turnStartMs = numberField(meta, "turnStartMs");
  const stopReason = stringField(update, "stop_reason") ?? stringField(update, "stopReason");

  return {
    sessionUpdate,
    promptId,
    turnStartMs,
    plan: isGrokPlanUpdate(update),
    turnEnded: sessionUpdate === "turn_completed",
    stopReason,
  };
}

function extractUpdate(record: Record<string, unknown>): Record<string, unknown> | undefined {
  if (isPlainObject(record.update)) return record.update;
  if (isPlainObject(record.params) && isPlainObject(record.params.update)) return record.params.update;
  if (typeof record.sessionUpdate === "string") return record;
  return undefined;
}

function metaOf(record: Record<string, unknown>, update: Record<string, unknown>): Record<string, unknown> {
  if (isPlainObject(record.params) && isPlainObject(record.params._meta)) return record.params._meta;
  if (isPlainObject(record._meta)) return record._meta;
  if (isPlainObject(update._meta)) return update._meta;
  return {};
}

function isGrokPlanUpdate(update: Record<string, unknown>): boolean {
  if (update.sessionUpdate === "plan") return true;
  if (isPlainObject(update.rawOutput) && update.rawOutput.type === "Todo" && isPlainObject(update.rawOutput.TodosUpdated)) {
    return true;
  }
  if (update.title === "todo_write") return true;
  if (isPlainObject(update.rawInput) && update.rawInput.variant === "TodoWrite") return true;
  if (isPlainObject(update._meta) && isPlainObject(update._meta["x.ai/tool"]) && update._meta["x.ai/tool"].name === "todo_write") {
    return true;
  }
  return false;
}

function eventsJsonlHasTurnEnded(file: string, promptId: string | undefined): boolean {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return false;
  }
  for (const line of text.split("\n")) {
    const ev = parseGrokLine(line);
    if (!ev?.turnEnded) continue;
    if (!promptId || !ev.promptId || ev.promptId === promptId) return true;
  }
  return false;
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
