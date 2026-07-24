/**
 * Host ↔ agent-pane webview message protocol (layer 2 first-party surface).
 * Pure data — no vscode, no DOM — unit-testable from either side.
 */

export const AGENT_PANE_VIEW_TYPE = "tachyonAgentPane";
export const AGENT_PANE_READY = "agent-pane/ready" as const;

export type AgentPaneToHost =
  | { type: typeof AGENT_PANE_READY }
  | { type: "agent-pane/input"; data: string }
  | { type: "agent-pane/resize"; cols: number; rows: number }
  /** Stage freeform text into the agent composer (381 delivery, no Enter). */
  | { type: "agent-pane/stage"; text: string }
  /** Submit freeform text (paste + Enter) via hardened tmux path. */
  | { type: "agent-pane/submit"; text: string }
  /** Open the 381 template picker preselected for this pane's agent. */
  | { type: "agent-pane/inject-template" };

/** Typography + metrics aligned with VS Code integrated terminal settings. */
export interface AgentPaneFontMetrics {
  /** Resolved CSS font-family stack (no CSS vars — xterm cannot measure them). */
  fontFamily: string;
  fontSize: number;
  fontWeight: string | number;
  fontWeightBold: string | number;
  /** Multiplier, VS Code `terminal.integrated.lineHeight` (default 1). */
  lineHeight: number;
  /** Pixel letter-spacing, VS Code `terminal.integrated.letterSpacing` (default 0). */
  letterSpacing: number;
}

export type AgentPaneFromHost =
  | {
      type: "agent-pane/init";
      agent: string;
      session: string;
      title: string;
      status: string;
      font: AgentPaneFontMetrics;
    }
  | { type: "agent-pane/data"; data: string }
  | { type: "agent-pane/status"; status: string }
  | { type: "agent-pane/exit"; code: number | null; signal: string | null }
  /** Feedback after stage/submit (toast-in-pane). */
  | { type: "agent-pane/delivery"; ok: boolean; mode: "stage" | "submit"; message: string };

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
  if (t === "agent-pane/stage" || t === "agent-pane/submit") {
    return typeof (value as { text?: unknown }).text === "string";
  }
  if (t === "agent-pane/inject-template") return true;
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
