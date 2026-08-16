/**
 * t-73885b — gather Claude transcript bytes for `judgeClaudeInternalPlanTurn`.
 * Does not decide the verdict. A missing or unreadable transcript is
 * absence of evidence, not `sem-plano`.
 */
import fs from "node:fs";

export function readClaudeTurnEvidence(
  transcriptPath: string,
): { initTools: string[]; events: unknown[] } | undefined {
  let text: string;
  try {
    text = fs.readFileSync(transcriptPath, "utf8");
  } catch {
    return undefined;
  }
  const events: unknown[] = [];
  let initTools: string[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      events.push(parsed);
      const tools = initToolsOf(parsed);
      if (tools) initTools = tools;
    } catch {
      /* skip a non-JSON / partial line */
    }
  }
  if (events.length === 0) return undefined;
  return { initTools, events };
}

function initToolsOf(raw: unknown): string[] | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  const tools = record.tools ?? record.init_tools;
  if (Array.isArray(tools) && tools.every((item) => typeof item === "string")) {
    return tools;
  }
  const message = record.message;
  if (message && typeof message === "object" && !Array.isArray(message)) {
    const inner = (message as Record<string, unknown>).tools;
    if (Array.isArray(inner) && inner.every((item) => typeof item === "string")) {
      return inner;
    }
  }
  return undefined;
}
