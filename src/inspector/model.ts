/**
 * Pure aggregation for the server inspector: a flat pane snapshot + a hash→folder
 * name map become a grouped view model (workspace → kind → sessions). No tmux, no
 * vscode — just data shaping, fully unit-tested. The webview renders this verbatim.
 */

import type { PaneSnapshot } from "../tmux/TmuxService.js";
import { classifySession, type SessionKind } from "./classify.js";

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

const FOREIGN = "(closed / other workspace)";
const NO_HASH = "(unscoped)";

/** Stable display order within a group. */
const KIND_ORDER: SessionKind[] = ["session", "command", "runbook", "anchor", "unknown"];

export function buildInspectorModel(
  snapshot: PaneSnapshot[],
  folderByHash: Map<string, string>,
  busyBySession?: Map<string, boolean>,
  server?: TmuxServerSnapshot,
): InspectorModel {
  const byGroup = new Map<string, InspectorGroup>();
  let live = 0;

  for (const row of snapshot) {
    const c = classifySession(row.session);
    if (!row.dead) live++;
    const key = c.wsHash ?? "__nohash__";
    let group = byGroup.get(key);
    if (!group) {
      const resolved = c.wsHash ? folderByHash.get(c.wsHash) : undefined;
      group = {
        wsHash: c.wsHash,
        workspace: resolved ?? (c.wsHash ? FOREIGN : NO_HASH),
        foreign: c.wsHash !== undefined && resolved === undefined,
        sessions: [],
      };
      byGroup.set(key, group);
    }
    const busy = busyBySession?.get(row.session);
    group.sessions.push({
      session: row.session,
      kind: c.kind,
      label: c.label,
      pid: row.pid,
      dead: row.dead,
      exitCode: row.exitCode,
      currentCommand: row.currentCommand,
      startCommand: row.startCommand,
      createdAt: row.createdAt,
      cpu: !row.dead && busy !== undefined ? (busy ? "busy" : "idle") : undefined,
    });
  }

  for (const group of byGroup.values()) {
    group.sessions.sort((a, b) => {
      const k = KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind);
      return k !== 0 ? k : a.label.localeCompare(b.label);
    });
  }

  // Open/known workspaces first (by name), foreign/unscoped groups last.
  const groups = [...byGroup.values()].sort((a, b) => {
    if (a.foreign !== b.foreign) return a.foreign ? 1 : -1;
    if (!a.wsHash !== !b.wsHash) return a.wsHash ? -1 : 1;
    return a.workspace.localeCompare(b.workspace);
  });

  const deadSessions = snapshot.filter((r) => r.dead).length;
  const orphanSessions = groups.filter((g) => g.foreign).reduce((n, g) => n + g.sessions.length, 0);

  const busySessions = groups.reduce((n, group) => n + group.sessions.filter((session) => session.cpu === "busy").length, 0);
  return { groups, totalSessions: snapshot.length, liveSessions: live, deadSessions, orphanSessions, busySessions, server };
}
