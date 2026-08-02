/**
 * Host ↔ agent-pane webview message protocol (layer 2 first-party surface).
 * Pure data — no vscode, no DOM — unit-testable from either side.
 */

export const AGENT_PANE_VIEW_TYPE = "tachyonAgentPane";
export const AGENT_PANE_READY = "agent-pane/ready" as const;

export type AgentPaneInjectKind = "stage" | "submit" | "template";

export type AgentPaneToHost =
  | { type: typeof AGENT_PANE_READY }
  | { type: "agent-pane/input"; data: string }
  | { type: "agent-pane/resize"; cols: number; rows: number }
  /** Stage freeform text into the agent composer (381 delivery, no Enter). */
  | { type: "agent-pane/stage"; text: string }
  /** Submit freeform text (paste + Enter) via hardened tmux path. */
  | { type: "agent-pane/submit"; text: string }
  /** Open the 381 template picker preselected for this pane's agent. */
  | { type: "agent-pane/inject-template" }
  /** Pin the current xterm selection into the project pin list (Slice 2). */
  | { type: "agent-pane/pin-selection"; text: string }
  /** Re-attach this pane's tmux client after a detach (t-feaaea) — the session outlived it. */
  | { type: "agent-pane/reattach" };

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
  /**
   * Whether this pane currently holds the session's tmux client (t-feaaea). `detached` with
   * `sessionAlive` means only the VIEW ended — the agent kept running, so the pane offers Reattach
   * instead of telling the human to reopen it.
   */
  | { type: "agent-pane/attach-state"; state: "attached" | "detached"; reason?: string; sessionAlive?: boolean }
  /** Feedback after stage/submit (toast-in-pane). */
  | { type: "agent-pane/delivery"; ok: boolean; mode: "stage" | "submit"; message: string }
  /** Place an inject marker at the current viewport line (no PTY bytes). */
  | { type: "agent-pane/mark"; kind: AgentPaneInjectKind }
  | { type: "agent-pane/pin-result"; ok: boolean; message: string };

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
  if (t === "agent-pane/inject-template" || t === "agent-pane/reattach") return true;
  if (t === "agent-pane/pin-selection") {
    return typeof (value as { text?: unknown }).text === "string";
  }
  return false;
}

/** Build a short pin title from selected terminal text (pure). */
export function pinTitleFromSelection(text: string, agent: string, maxLen = 160): string {
  const one = text.replace(/\s+/g, " ").trim();
  if (!one) return "";
  const body = one.length > maxLen ? `${one.slice(0, Math.max(1, maxLen - 1))}…` : one;
  return `[${agent}] ${body}`;
}

export interface AgentPanePanelState {
  schemaVersion: 1;
  view: typeof AGENT_PANE_VIEW_TYPE;
  agent: string;
  session: string;
  title?: string;
  wsHash?: string;
}
