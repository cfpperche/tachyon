/**
 * t-011136 — Codex end-of-turn plan verdict.
 *
 * Window (docs/research/poc-plano-interno-codex.md, 2026-08-16, codex-cli 0.147.0):
 *   identity  `turnId` on the notification (`params.turnId` or `params.turn.id`)
 *   start     `turn/started` (or the first event for that turnId)
 *   end       `turn/completed` for that turnId
 *   success   `turn.status === "completed"`
 *   fail      `turn.status` is `failed` or `interrupted` — not `sem-plano`
 *
 * Plan event: `turn/plan/updated` with the same turnId. The last such
 * notification is the plan (fatia 1). Not a plan: `item/plan/delta`,
 * `turn.completed.items` (summary).
 *
 * Channel: `turn/plan/updated` is in the 0.147.0 ServerNotification enum.
 * `sem-canal` needs positive evidence the session's protocol omits it
 * (`knownNotifications` without that method). A mute completed turn on
 * a session that has the method is `sem-plano`.
 *
 * Correlation is reliable on the app-server notification stream. The TUI
 * `hooks.Stop` overlay was not measured as carrying turnId + plan events;
 * fatia 4 cannot close this window from that hook alone.
 */
import { CODEX_INTERNAL_PLAN_NOTIFICATION } from "./codexInternalPlanReader.js";
import { decideInternalPlanTurnVerdict, type InternalPlanTurnJudgment } from "./internalPlanTurn.js";

export function judgeCodexInternalPlanTurn(input: {
  notifications: readonly unknown[];
  turnId?: string;
  knownNotifications?: readonly string[];
}): InternalPlanTurnJudgment {
  const turns = new Map<string, { ended: boolean; success: boolean; plan: boolean; lastIndex: number }>();
  let lastSeen: string | undefined;

  input.notifications.forEach((raw, index) => {
    const mark = classifyCodexNotification(raw);
    if (!mark) return;
    const row = turns.get(mark.turnId) ?? { ended: false, success: false, plan: false, lastIndex: index };
    row.lastIndex = index;
    if (mark.kind === "plan") row.plan = true;
    if (mark.kind === "turn-end") {
      row.ended = true;
      row.success = mark.outcome === "completed";
    }
    turns.set(mark.turnId, row);
    lastSeen = mark.turnId;
  });

  const turnId = input.turnId ?? lastTurnId(turns, lastSeen);
  const row = turnId ? turns.get(turnId) : undefined;
  const channelPresent = codexPlanChannelPresent(input.knownNotifications, row?.plan === true);

  return decideInternalPlanTurnVerdict({
    turnEnded: row?.ended === true,
    turnCompletedSuccessfully: row?.success === true,
    planEventInWindow: row?.plan === true,
    channelPresent,
  });
}

export function codexPlanChannelPresent(
  knownNotifications: readonly string[] | undefined,
  sawPlanEvent: boolean,
): boolean {
  if (sawPlanEvent) return true;
  if (!knownNotifications) return true;
  return knownNotifications.includes(CODEX_INTERNAL_PLAN_NOTIFICATION);
}

function lastTurnId(
  turns: ReadonlyMap<string, { lastIndex: number }>,
  fallback: string | undefined,
): string | undefined {
  let chosen: string | undefined;
  let last = -1;
  for (const [id, row] of turns) {
    if (row.lastIndex >= last) {
      last = row.lastIndex;
      chosen = id;
    }
  }
  return chosen ?? fallback;
}

type CodexMark =
  | { kind: "turn-start"; turnId: string }
  | { kind: "turn-end"; turnId: string; outcome: "completed" | "failed" }
  | { kind: "plan"; turnId: string };

function classifyCodexNotification(raw: unknown): CodexMark | undefined {
  if (!isPlainObject(raw) || typeof raw.method !== "string") return undefined;
  const turnId = turnIdOf(raw);
  if (!turnId) return undefined;
  if (raw.method === CODEX_INTERNAL_PLAN_NOTIFICATION) return { kind: "plan", turnId };
  if (raw.method === "turn/started" || raw.method === "turn/start") {
    return { kind: "turn-start", turnId };
  }
  if (raw.method === "turn/completed") {
    const status = turnStatusOf(raw);
    if (status === "completed") return { kind: "turn-end", turnId, outcome: "completed" };
    if (status === "failed" || status === "interrupted") {
      return { kind: "turn-end", turnId, outcome: "failed" };
    }
  }
  return undefined;
}

function turnIdOf(raw: Record<string, unknown>): string | undefined {
  const params = isPlainObject(raw.params) ? raw.params : undefined;
  if (!params) return undefined;
  if (typeof params.turnId === "string" && params.turnId.length > 0) return params.turnId;
  if (isPlainObject(params.turn) && typeof params.turn.id === "string" && params.turn.id.length > 0) {
    return params.turn.id;
  }
  return undefined;
}

function turnStatusOf(raw: Record<string, unknown>): string | undefined {
  const params = isPlainObject(raw.params) ? raw.params : undefined;
  if (!params) return undefined;
  if (typeof params.status === "string") return params.status;
  if (isPlainObject(params.turn) && typeof params.turn.status === "string") return params.turn.status;
  return undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
