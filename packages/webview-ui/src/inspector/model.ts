import type { SessionKind } from "./classify.js";
export interface InspectorSession {
  /** Full tmux session name (the handle for capture/kill). */
  session: string;
  kind: SessionKind;
  /** Friendly label within the workspace group. */
  label: string;
  pid: number;
  dead: boolean;
  exitCode?: number;
  currentCommand: string;
  /** Command originally used to create the pane. */
  startCommand: string;
  /** Session start, epoch seconds (for uptime). */
  createdAt?: number;
  /** CPU activity over the last refresh interval — only set for live sessions on Linux. */
  cpu?: "busy" | "idle";
}

export interface TmuxServerSnapshot {
  socketName: string;
  socketPath: string;
  state: "healthy" | "no-server" | "wedged" | "unknown";
  tmuxVersion?: string;
  pids: number[];
  /** Best-effort ps output for operators; absent when the server is down. */
  diagnostics?: string;
  checkedAt: number;
}


export interface InspectorGroup {
  wsHash?: string;
  /** Resolved folder name, or a placeholder for closed/foreign workspaces. */
  workspace: string;
  /** True when this hash matches no currently-open workspace. */
  foreign: boolean;
  sessions: InspectorSession[];
}


export interface InspectorModel {
  groups: InspectorGroup[];
  totalSessions: number;
  liveSessions: number;
  /** Sessions with a dead pane — the "kill all dead" reap target. */
  deadSessions: number;
  /** Sessions in foreign (not-open-workspace) groups — the "kill all orphans" reap target. */
  orphanSessions: number;
  busySessions: number;
  server?: TmuxServerSnapshot;
}
