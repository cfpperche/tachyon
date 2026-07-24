/**
 * Host ↔ agent-pane webview message protocol (layer 2 first-party surface).
 * Pure data — no vscode, no DOM — unit-testable from either side.
 */

export const AGENT_PANE_VIEW_TYPE = "tachyonAgentPane";
export const AGENT_PANE_READY = "agent-pane/ready" as const;

export type AgentPaneToHost =
  | { type: typeof AGENT_PANE_READY }
  | { type: "agent-pane/input"; data: string }
  | { type: "agent-pane/resize"; cols: number; rows: number };

export type AgentPaneFromHost =
  | {
      type: "agent-pane/init";
      agent: string;
      session: string;
      title: string;
      status: string;
    }
  | { type: "agent-pane/data"; data: string }
  | { type: "agent-pane/status"; status: string }
  | { type: "agent-pane/exit"; code: number | null; signal: string | null };

export function isAgentPaneToHost(value: unknown): value is AgentPaneToHost {
  if (!value || typeof value !== "object") return false;
  const t = (value as { type?: unknown }).type;
  if (t === AGENT_PANE_READY) return true;
  if (t === "agent-pane/input") return typeof (value as { data?: unknown }).data === "string";
  if (t === "agent-pane/resize") {
    const cols = (value as { cols?: unknown }).cols;
    const rows = (value as { rows?: unknown }).rows;
    return typeof cols === "number" && typeof rows === "number" && cols > 0 && rows > 0;
  }
  return false;
}

export interface AgentPanePanelState {
  schemaVersion: 1;
  view: typeof AGENT_PANE_VIEW_TYPE;
  agent: string;
  session: string;
  title?: string;
  wsHash?: string;
}
