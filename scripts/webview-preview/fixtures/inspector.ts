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
};

const now = 1_750_000_000; // a fixed epoch (Date.now is unavailable in the generator; the App computes ago() live)
const model: InspectorModel = {
  totalSessions: 4, liveSessions: 2, deadSessions: 1, orphanSessions: 1,
  groups: [
    {
      wsHash: "a1b2c3", workspace: "tachyon", foreign: false,
      sessions: [
        { session: "tachyon:build", kind: "session", label: "build", pid: 4821, dead: false, currentCommand: "node esbuild.mjs", createdAt: now - 140, cpu: "busy" },
        { session: "tachyon:review", kind: "session", label: "review", pid: 4822, dead: false, currentCommand: "claude", createdAt: now - 600, cpu: "idle" },
        { session: "tachyon:cmd-test", kind: "command", label: "test", pid: 5001, dead: true, exitCode: 1, currentCommand: "npm test", createdAt: now - 30 },
      ],
    },
    {
      wsHash: "ff0099", workspace: "(closed workspace)", foreign: true,
      sessions: [
        { session: "orphan:old-spike", kind: "session", label: "old-spike", pid: 3300, dead: false, currentCommand: "bash", createdAt: now - 90000, cpu: "idle" },
      ],
    },
  ],
};

const empty: InspectorModel = { groups: [], totalSessions: 0, liveSessions: 0, deadSessions: 0, orphanSessions: 0 };

export const inspectorFixtures: Record<string, Fixture<InspectorModel>> = {
  default: { provenance: "synthetic-edge", vm: model },
  empty: { provenance: "synthetic-edge", vm: empty },
};
