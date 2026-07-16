/**
 * Engine/Bridge Control Inspector fixtures for the dev-host webview preview.
 * Two host messages (init strings + model), same handshake pattern as the tmux inspector.
 */

import { buildControlInspectorModel, type ControlInspectorModel } from "../../../src/control-inspector/model";
import type { ControlInspectorStrings } from "../../../src/webview/control-inspector/messages";
import type { Fixture } from "../routes";

export const strings: ControlInspectorStrings = {
  title: "Engine/Bridge Inspector",
  subtitle: "Control-plane snapshot for each Tachyon workspace engine (POC — sibling of tmux Server Inspector).",
  pocBanner:
    "POC (option B): separate surface from tmux Server Inspector. Read-only — no restart/kill. Fixture data for dev-host preview.",
  refresh: "Refresh",
  auto: "Auto-refresh",
  empty: "No Tachyon workspace is attached in this window. Open a folder with Tachyon active.",
  copyDiagnostics: "Copy diagnostics",
  openServerInspector: "Open tmux Inspector",
  copied: "Diagnostics copied",
  summary: "Summary",
  workspaces: "Workspaces",
  engine: "Engine",
  bridge: "Bridge",
  workspace: "Workspace",
  agents: "Agents",
  notes: "Notes",
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
  attached: "attached",
  error: "error",
  none: "none",
  running: "running",
  checkedAt: "Checked",
  openTmux: "tmux",
};

/** Happy path: one healthy attached workspace + one error + one none (shows all states). */
const defaultModel: ControlInspectorModel = buildControlInspectorModel(
  [
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
      authConfigured: true,
      notes: ["POC fixture · multi-agent fleet attached"],
    },
    {
      folderName: "mei-saas",
      workspaceRoot: "/home/goat/mei-saas",
      wsHash: "c0ffee42",
      bridgeUrl: "http://127.0.0.1:7433/mcp",
      identityError: "control socket refused (engine not running)",
      agents: { total: 2, running: 0 },
      authConfigured: true,
      notes: ["engine error state for visual QA"],
    },
    {
      folderName: "scratch",
      workspaceRoot: "/tmp/scratch-ws",
      wsHash: "deadbeef",
      bridgeUrl: "http://127.0.0.1:9/mcp",
      identity: null,
      authConfigured: "unknown",
    },
  ],
  "2026-07-16T17:50:00.000Z",
);

const emptyModel: ControlInspectorModel = buildControlInspectorModel([], "2026-07-16T17:50:00.000Z");

/** Single healthy workspace only — cleaner screenshot. */
const healthyOnly: ControlInspectorModel = buildControlInspectorModel(
  [
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
      authConfigured: true,
      notes: ["single healthy engine"],
    },
  ],
  "2026-07-16T17:50:00.000Z",
);

export const controlInspectorFixtures: Record<string, Fixture<ControlInspectorModel>> = {
  default: { provenance: "synthetic-edge", vm: defaultModel },
  healthy: { provenance: "synthetic-edge", vm: healthyOnly },
  empty: { provenance: "synthetic-edge", vm: emptyModel },
};
