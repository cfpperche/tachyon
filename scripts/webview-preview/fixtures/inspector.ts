/**
 * spec 279 — Inspector-view fixtures for the dev preview harness. The Inspector needs TWO host messages
 * (init strings + model), so its makeMessage returns an array. Provenance: `synthetic-edge` — the strings are
 * the English l10n defaults and the InspectorModel is hand-authored, both TYPED against the real shapes
 * (InspectorStrings / InspectorModel) so a drift breaks the build. (The real model is built by
 * buildInspectorModel from a live tmux snapshot — there's no cheap pure capture, hence typed synthetic states.)
 */

import type { InspectorModel } from "../../../src/inspector/model";
import type { InspectorStrings } from "../../../src/webview/inspector/messages";
import type { Fixture } from "../routes";

export const strings: InspectorStrings = {
  title: "tmux Server Inspector",
  subtitle: "Live view of the dedicated tachyon socket — every session Tachyon owns.",
  refresh: "Refresh", auto: "Auto-refresh",
  empty: "No Tachyon sessions on the socket. Start an agent, command, or runbook to populate the server.",
  summary: "{0} sessions · {1} live",
  foreignNote: "not an open workspace — orphaned or owned by another window",
  pid: "pid", live: "live", dead: "exited", exit: "exit {0}", busy: "busy", idle: "idle",
  open: "Open", capture: "Capture", kill: "Kill", reapDead: "Kill {0} dead", reapOrphans: "Reap {0} orphaned",
  killConfirm: "Kill session {0}? This stops the process and removes the pane.",
  kindSession: "Agents & terminals", kindCommand: "Commands", kindRunbook: "Runbook steps",
  kindAnchor: "Engine internals", kindUnknown: "Other", captureEmpty: "(no output)",
  ageSeconds: "{0}s", ageMinutes: "{0}m", ageHours: "{0}h", ageDays: "{0}d",
  overview: "Overview", server: "Server", all: "All", search: "Search sessions, commands, or labels",
  workspace: "Workspace", status: "Status", kind: "Kind", cpu: "CPU", details: "Details",
  fullName: "Full session name", hash: "Workspace hash", command: "Current command", startCommand: "Start command", uptime: "Uptime",
  total: "Total", orphaned: "Orphaned", socket: "Socket", path: "Path", health: "Health", version: "tmux version",
  serverPids: "Server PIDs", diagnostics: "Process diagnostics", noDiagnostics: "No process diagnostics available.",
  refreshCapture: "Refresh capture", close: "Close", bulkActions: "Bulk actions",
};

const now = 1_750_000_000; // a fixed epoch (Date.now is unavailable in the generator; the App computes ago() live)
const model: InspectorModel = {
  totalSessions: 4, liveSessions: 3, deadSessions: 1, orphanSessions: 1, busySessions: 1,
  server: { socketName: "tachyon", socketPath: "/tmp/tmux-1000/tachyon", state: "healthy", tmuxVersion: "tmux 3.6a", pids: [4770], diagnostics: "PID %CPU RSS ELAPSED STAT CMD\n4770 0.2 9000 01:20 Ss tmux -L tachyon", checkedAt: now * 1000 },
  groups: [
    {
      wsHash: "a1b2c3d4", workspace: "tachyon", foreign: false,
      sessions: [
        { session: "tachyon-a1b2c3d4-build", kind: "session", label: "build", pid: 4821, dead: false, currentCommand: "node esbuild.mjs", startCommand: "npm run build", createdAt: now - 140, cpu: "busy" },
        { session: "tachyon-a1b2c3d4-review", kind: "session", label: "review", pid: 4822, dead: false, currentCommand: "claude", startCommand: "claude", createdAt: now - 600, cpu: "idle" },
        { session: "tachyon-cmd-a1b2c3d4-test", kind: "command", label: "test", pid: 5001, dead: true, exitCode: 1, currentCommand: "npm test", startCommand: "npm test", createdAt: now - 30 },
      ],
    },
    {
      wsHash: "ff009911", workspace: "(closed workspace)", foreign: true,
      sessions: [
        { session: "tachyon-ff009911-old-spike", kind: "session", label: "old-spike", pid: 3300, dead: false, currentCommand: "bash", startCommand: "bash", createdAt: now - 90000, cpu: "idle" },
      ],
    },
  ],
};

const empty: InspectorModel = { groups: [], totalSessions: 0, liveSessions: 0, deadSessions: 0, orphanSessions: 0, busySessions: 0 };

/**
 * SDD 485 D1 — a REAL server's worth of sessions, and the reason it exists is written in this spec's own
 * notes: C5's two-width pass came back clean on a broken Board partly because its fixture had too few
 * cards to make the layout fail. Four sessions cannot show what the row grid, the five-column filter bar
 * or a long `startCommand` do when the list is the length a working machine actually produces.
 *
 * Shaped like a machine with agents running: three attached workspaces (one of them narrow), one closed
 * folder whose sessions are now orphans, a crashed command, a couple of anchors, and commands whose
 * `startCommand` is long enough to exercise the `.meta` ellipsis. 20 sessions across four groups — 15
 * live, 5 dead, 4 orphaned — against the `default` fixture's four.
 */
const volumeGroups: InspectorModel["groups"] = [
  {
    wsHash: "a1b2c3d4", workspace: "tachyon", foreign: false,
    sessions: [
      { session: "tachyon-a1b2c3d4-build", kind: "session", label: "build", pid: 4821, dead: false, currentCommand: "node esbuild.mjs", startCommand: "npm run build", createdAt: now - 140, cpu: "busy" },
      { session: "tachyon-a1b2c3d4-review", kind: "session", label: "review", pid: 4822, dead: false, currentCommand: "claude", startCommand: "claude", createdAt: now - 600, cpu: "idle" },
      { session: "tachyon-a1b2c3d4-tmuxapp", kind: "session", label: "tmuxapp", pid: 4823, dead: false, currentCommand: "claude", startCommand: "claude", createdAt: now - 5400, cpu: "busy" },
      { session: "tachyon-a1b2c3d4-codex-1", kind: "session", label: "codex-1", pid: 4824, dead: false, currentCommand: "codex", startCommand: "codex", createdAt: now - 88000, cpu: "idle" },
      { session: "tachyon-cmd-a1b2c3d4-verify", kind: "command", label: "verify", pid: 5001, dead: false, currentCommand: "vitest", startCommand: "npm run verify:full:quiet", createdAt: now - 45, cpu: "busy" },
      { session: "tachyon-cmd-a1b2c3d4-typecheck", kind: "command", label: "typecheck", pid: 5002, dead: true, exitCode: 0, currentCommand: "", startCommand: "npm run typecheck", createdAt: now - 900 },
      { session: "tachyon-cmd-a1b2c3d4-test", kind: "command", label: "test", pid: 5003, dead: true, exitCode: 1, currentCommand: "npm test", startCommand: "npm test -- --reporter=verbose test/unit/webviewConvention.test.ts", createdAt: now - 30 },
      { session: "tachyon-rb-a1b2c3d4-release-1", kind: "runbook", label: "release · package", pid: 5101, dead: false, currentCommand: "vsce", startCommand: "npx @vscode/vsce package --no-dependencies --out dist/tachyon.vsix", createdAt: now - 210, cpu: "busy" },
      { session: "tachyon-rb-a1b2c3d4-release-2", kind: "runbook", label: "release · audit", pid: 5102, dead: true, exitCode: 0, currentCommand: "", startCommand: "node scripts/audit-vsix.mjs", createdAt: now - 260 },
      { session: "tachyon-ctl-a1b2c3d4", kind: "anchor", label: "engine", pid: 4770, dead: false, currentCommand: "node", startCommand: "node dist/daemon.js", createdAt: now - 172000, cpu: "idle" },
      { session: "probe-43bca1cc-scratch", kind: "unknown", label: "probe-43bca1cc", pid: 5210, dead: false, currentCommand: "bash", startCommand: "bash", createdAt: now - 1200, cpu: "idle" },
    ],
  },
  {
    wsHash: "d4e5f6a7", workspace: "tachyon-docs", foreign: false,
    sessions: [
      { session: "tachyon-d4e5f6a7-writer", kind: "session", label: "writer", pid: 6001, dead: false, currentCommand: "claude", startCommand: "claude", createdAt: now - 3300, cpu: "idle" },
      { session: "tachyon-cmd-d4e5f6a7-lint", kind: "command", label: "lint", pid: 6002, dead: false, currentCommand: "eslint", startCommand: "npm run lint -- --max-warnings=0", createdAt: now - 20, cpu: "busy" },
      { session: "tachyon-cmd-d4e5f6a7-build", kind: "command", label: "build", pid: 6003, dead: true, exitCode: 2, currentCommand: "", startCommand: "npm run build:docs", createdAt: now - 7200 },
      { session: "tachyon-ctl-d4e5f6a7", kind: "anchor", label: "engine", pid: 6004, dead: false, currentCommand: "node", startCommand: "node dist/daemon.js", createdAt: now - 172000, cpu: "idle" },
    ],
  },
  {
    wsHash: "9f8e7d60", workspace: "spike", foreign: false,
    sessions: [
      { session: "tachyon-9f8e7d60-scratch", kind: "session", label: "scratch", pid: 7001, dead: false, currentCommand: "bash", startCommand: "bash", createdAt: now - 61, cpu: "idle" },
    ],
  },
  {
    wsHash: "ff009911", workspace: "(closed workspace)", foreign: true,
    sessions: [
      { session: "tachyon-ff009911-old-spike", kind: "session", label: "old-spike", pid: 3300, dead: false, currentCommand: "bash", startCommand: "bash", createdAt: now - 90000, cpu: "idle" },
      { session: "tachyon-cmd-ff009911-migrate", kind: "command", label: "migrate", pid: 3301, dead: false, currentCommand: "node", startCommand: "node scripts/migrate-storage.mjs --dry-run --verbose", createdAt: now - 90200, cpu: "idle" },
      { session: "tachyon-rb-ff009911-nightly-3", kind: "runbook", label: "nightly · sweep", pid: 3302, dead: true, exitCode: 137, currentCommand: "", startCommand: "node scripts/nightly-sweep.mjs", createdAt: now - 91000 },
      { session: "tachyon-ctl-ff009911", kind: "anchor", label: "engine", pid: 3303, dead: false, currentCommand: "node", startCommand: "node dist/daemon.js", createdAt: now - 91500, cpu: "idle" },
    ],
  },
];

const volume: InspectorModel = {
  totalSessions: volumeGroups.reduce((n, g) => n + g.sessions.length, 0),
  liveSessions: volumeGroups.reduce((n, g) => n + g.sessions.filter((x) => !x.dead).length, 0),
  deadSessions: volumeGroups.reduce((n, g) => n + g.sessions.filter((x) => x.dead).length, 0),
  orphanSessions: volumeGroups.find((g) => g.foreign)?.sessions.length ?? 0,
  busySessions: volumeGroups.reduce((n, g) => n + g.sessions.filter((x) => x.cpu === "busy").length, 0),
  server: {
    socketName: "tachyon", socketPath: "/tmp/tmux-1000/tachyon", state: "healthy", tmuxVersion: "tmux 3.6a",
    pids: [4770, 6004, 3303],
    diagnostics: "PID %CPU RSS ELAPSED STAT CMD\n4770 0.2 9000 01:20 Ss tmux -L tachyon\n6004 0.1 8600 47:11 Ss tmux -L tachyon\n3303 0.0 8100 25:24:03 Ss tmux -L tachyon",
    checkedAt: now * 1000,
  },
  groups: volumeGroups,
};

export const inspectorFixtures: Record<string, Fixture<InspectorModel>> = {
  default: { provenance: "synthetic-edge", vm: model },
  empty: { provenance: "synthetic-edge", vm: empty },
  volume: { provenance: "synthetic-edge", vm: volume },
};
