/**
 * Cockpit desktop POC fixtures for dev-host preview.
 * Framing: editor sysadmin shell; top tabs only; sidebar unchanged; mobile deferred.
 */

import { buildCockpitModel, type CockpitModel } from "../../../src/cockpit/model";
import type { CockpitStrings } from "../../../src/webview/cockpit/messages";
import type { Fixture } from "../routes";

export const strings: CockpitStrings = {
  title: "Cockpit",
  subtitle: "Project sysadmin — editor panel",
  pocBanner:
    "POC desktop Cockpit (t-fe52f0 frente 1). Top tabs only (no webview left rail). VS Code sidebar unchanged. Mobile deferred. Grey tabs = soon + deep-link.",
  navOverview: "Overview",
  navEngine: "Engine / Bridge",
  navFleet: "Fleet",
  navTmux: "tmux",
  navMission: "Mission Control",
  navPlugins: "Plugins",
  navSettings: "Settings",
  refresh: "Refresh",
  auto: "Auto-refresh",
  empty: "No Tachyon workspace attached in this window.",
  copyDiagnostics: "Copy diagnostics",
  openServerInspector: "Open tmux Server Inspector",
  openMissionControl: "Open Mission Control",
  openPlugins: "Open Plugins",
  openSettings: "Open Settings",
  copied: "Diagnostics copied",
  overviewTitle: "Overview",
  overviewHint: "Health snapshot across attached workspace engines. Sidebar remains the day-to-day fleet UI.",
  engineTitle: "Engine / Bridge",
  fleetTitle: "Fleet presence",
  fleetBody:
    "Soon: presence summary in Cockpit. Day-to-day agent rows stay in the sidebar; Mission Control remains the work board.",
  tmuxTitle: "tmux sessions",
  tmuxBody: "Soon: session summary here. Full reaper stays in the dedicated tmux Server Inspector (open via button).",
  missionTitle: "Mission Control",
  missionBody: "Soon: board snapshot embedded in Cockpit. For now the full board is the existing Mission Control panel.",
  pluginsTitle: "Plugins",
  pluginsBody: "Soon: installed plugins + integrity summary in Cockpit. Install/update remains the Plugins panel.",
  settingsTitle: "Settings",
  settingsBody:
    "Soon: key Tachyon project settings at a glance. Full editor settings open via the button (Tachyon extension settings).",
  workspaces: "Workspaces",
  engines: "Engines",
  agents: "Agents",
  errors: "Errors",
  bridges: "Bridges",
  attached: "attached",
  error: "error",
  none: "none",
  state: "State",
  pid: "PID",
  version: "Version",
  instance: "Instance",
  started: "Started",
  bundle: "Bundle",
  protocol: "Protocol",
  url: "URL",
  port: "Port",
  auth: "Auth",
  root: "Root",
  hash: "Hash",
  running: "running",
  checkedAt: "Checked",
  sidebarNote: "VS Code / Tachyon sidebar unchanged — agents, spawn, pins stay there. Cockpit uses top tabs only.",
  soon: "soon",
};

const inputs = [
  {
    folderName: "tachyon",
    workspaceRoot: "/home/goat/tachyon",
    wsHash: "b349073a",
    bridgeUrl: "http://127.0.0.1:7421/mcp",
    identity: {
      pid: 188_422,
      instanceId: "eng-7f3a2c1b",
      processStartIdentity: "start-9c0e",
      startedAt: "2026-07-16T12:04:11.000Z",
      bundleId: "bundle-0.56.10-abc",
      engineVersion: "0.56.10",
      protocol: { min: 3, max: 3 },
      bridge: { instanceId: "br-4d21", port: 7421 },
    },
    agents: { total: 11, running: 7 },
    authConfigured: true as const,
    notes: [] as string[],
  },
  {
    folderName: "mei-saas",
    workspaceRoot: "/home/goat/mei-saas",
    wsHash: "c0ffee42",
    bridgeUrl: "http://127.0.0.1:7433/mcp",
    identityError: "control socket refused (engine not running)",
    agents: { total: 2, running: 0 },
    authConfigured: true as const,
    notes: [] as string[],
  },
];

const now = "2026-07-16T18:30:00.000Z";

export const cockpitFixtures: Record<string, Fixture<CockpitModel>> = {
  default: {
    provenance: "synthetic-edge",
    vm: buildCockpitModel(inputs, { section: "overview", nowIso: now }),
  },
  engine: {
    provenance: "synthetic-edge",
    vm: buildCockpitModel(inputs, { section: "engine", nowIso: now }),
  },
  empty: {
    provenance: "synthetic-edge",
    vm: buildCockpitModel([], { section: "overview", nowIso: now }),
  },
};
