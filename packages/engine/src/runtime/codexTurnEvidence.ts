/**
 * t-73885b — gather Codex TUI hook rows for `judgeCodexInternalPlanTurn`.
 * Does not decide the verdict. Stop without a turn_id, or no Stop at all,
 * is absence of evidence — not `sem-plano`.
 *
 * Does not read the Codex plan snapshot. The parallel TUI reader owns that.
 */
import fs from "node:fs";
import { codexToolHookFile, persistenceStopFile } from "../activity/sessionOwners.js";
import { CODEX_TUI_PLAN_HOOK_EVENTS } from "./codexInternalPlanTurn.js";

export const CODEX_TUI_KNOWN_HOOK_EVENTS = [
  "SessionStart",
  "Stop",
  ...CODEX_TUI_PLAN_HOOK_EVENTS,
] as const;

export function readCodexTurnEvidence(
  workspaceRoot: string,
  agent: string,
): { notifications: unknown[]; turnId?: string; knownHookEvents: readonly string[] } | undefined {
  const stops = readJsonl(persistenceStopFile(workspaceRoot)).filter(
    (row) => row.agent === agent && row.event === "Stop",
  );
  if (stops.length === 0) return undefined;
  const lastStop = stops[stops.length - 1];
  const turnId = typeof lastStop.turnId === "string" && lastStop.turnId.length > 0 ? lastStop.turnId : undefined;
  if (!turnId) return undefined;

  const tools = readJsonl(codexToolHookFile(workspaceRoot)).filter((row) => row.agent === agent);
  const notifications: unknown[] = [
    ...tools.map((row) => ({
      hook_event_name: row.event,
      tool_name: row.toolName,
      turn_id: row.turnId,
    })),
    { hook_event_name: "Stop", turn_id: turnId },
  ];
  return { notifications, turnId, knownHookEvents: CODEX_TUI_KNOWN_HOOK_EVENTS };
}

function readJsonl(file: string): Record<string, string>[] {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out: Record<string, string>[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      const row = parsed as Record<string, unknown>;
      const mapped: Record<string, string> = {};
      for (const [key, value] of Object.entries(row)) {
        if (typeof value === "string") mapped[key] = value;
      }
      out.push(mapped);
    } catch {
      /* skip a non-JSON / partial line */
    }
  }
  return out;
}
