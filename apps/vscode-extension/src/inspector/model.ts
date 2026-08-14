import type { TmuxServerSnapshot, InspectorGroup, InspectorModel } from "@tachyon/webview-ui/inspector/model";
export type { InspectorSession, TmuxServerSnapshot, InspectorGroup, InspectorModel } from "@tachyon/webview-ui/inspector/model";
/**
 * Pure aggregation for the server inspector: a flat pane snapshot + a hash→folder
 * name map become a grouped view model (workspace → kind → sessions). No tmux, no
 * vscode — just data shaping, fully unit-tested. The webview renders this verbatim.
 */

import type { PaneSnapshot } from "@tachyon/engine/tmux/TmuxService.js";
import { classifySession, type SessionKind } from "./classify.js";

const FOREIGN = "(closed / other workspace)";
const NO_HASH = "(unscoped)";

/** Stable display order within a group. */
const KIND_ORDER: SessionKind[] = ["session", "command", "runbook", "login", "anchor", "unknown"];

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
