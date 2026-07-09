export type ExternalToolKind = "browser" | "desktop" | "screen" | "host-action" | "gui" | "unknown";
export type ExternalToolSource = "tool-launcher" | "agent-desktop" | "agent-browser" | "agent-screen" | "host-action" | "proc-env" | "proc-tree";
export type ExternalToolConfidence = "strong" | "medium" | "weak";
export type ExternalToolState = "active" | "exited" | "stale";

export interface ExternalToolSession {
  id: string;
  agent: string;
  kind: ExternalToolKind;
  tool: string;
  source: ExternalToolSource;
  confidence: ExternalToolConfidence;
  startedAt: string;
  lastSeenAt: string;
  pid?: number;
  windowId?: string;
  sessionId?: string;
  title?: string;
  commandLabel?: string;
  state: ExternalToolState;
}

export interface ExternalToolItemVM {
  id: string;
  kind: string;
  tool: string;
  title?: string;
  pid?: number;
  windowId?: string;
  startedAt: string;
  source: string;
  confidence: string;
}

export interface ExternalToolsSummaryVM {
  active: number;
  kinds: Array<Exclude<ExternalToolKind, "unknown">>;
  strongestConfidence: ExternalToolConfidence;
  items: ExternalToolItemVM[];
}

