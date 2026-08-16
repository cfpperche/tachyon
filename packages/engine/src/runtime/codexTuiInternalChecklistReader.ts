/**
 * t-281339 — feed Codex TUI `update_plan` hook rows into the fatia-1
 * app-server reader. Does not reimplement the snapshot projection.
 *
 * The TUI ledger keeps `toolInput.plan` (sessionOwners recorder). The
 * production door is still `readCodexInternalChecklist`.
 */
import fs from "node:fs";
import { codexToolHookFile } from "../activity/sessionOwners.js";
import { CODEX_INTERNAL_CHECKLIST_NOTIFICATION, readCodexInternalChecklist } from "./codexInternalChecklistReader.js";
import type { InternalChecklistRead } from "./internalChecklist.js";

export function readCodexTuiInternalChecklist(workspaceRoot: string, agent: string): InternalChecklistRead {
  return readCodexInternalChecklist({
    notifications: codexTuiChecklistNotifications(workspaceRoot, agent),
  });
}

export function codexTuiChecklistNotifications(workspaceRoot: string, agent: string): unknown[] {
  const notifications: unknown[] = [];
  for (const row of readToolHookRows(codexToolHookFile(workspaceRoot))) {
    if (row.agent !== agent) continue;
    if (row.toolName !== "update_plan") continue;
    const plan = planFromToolInput(row.toolInput);
    if (!plan) continue;
    notifications.push({
      method: CODEX_INTERNAL_CHECKLIST_NOTIFICATION,
      params: { plan },
    });
  }
  return notifications;
}

function planFromToolInput(value: unknown): unknown[] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const plan = (value as { plan?: unknown }).plan;
  return Array.isArray(plan) ? plan : undefined;
}

function readToolHookRows(file: string): Array<{ agent: string; toolName: string; toolInput?: unknown }> {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out: Array<{ agent: string; toolName: string; toolInput?: unknown }> = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      const row = parsed as Record<string, unknown>;
      const agent = typeof row.agent === "string" ? row.agent : "";
      const toolName =
        typeof row.toolName === "string" ? row.toolName
          : typeof row.tool_name === "string" ? row.tool_name
            : "";
      if (!agent || !toolName) continue;
      out.push({
        agent,
        toolName,
        ...(row.toolInput !== undefined ? { toolInput: row.toolInput }
          : row.tool_input !== undefined ? { toolInput: row.tool_input }
            : {}),
      });
    } catch {
      /* skip a non-JSON / partial line */
    }
  }
  return out;
}
