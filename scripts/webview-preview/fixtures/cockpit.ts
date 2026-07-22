/**
 * Control panel fixtures for dev-host preview (production-facing copy only).
 */

import { buildCockpitModel, type CockpitModel, type CockpitWorkspaceBundle } from "../../../src/cockpit/model";
import { routes as cockpitRoutes } from "../../../src/cockpit/route";
import type { CockpitStrings } from "../../../src/webview/cockpit/messages";
import { buildValidationsViewModel, type ValidationsViewModel } from "../../../src/webview/validations/viewModel";
import type { Validation } from "../../../src/validations/types";
import type { Fixture } from "../routes";

export const strings: CockpitStrings = {
  title: "Control",
  subtitle: "Project sysadmin",
  navOverview: "Overview",
  navEngine: "Engine",
  navFleet: "Fleet",
  navApprovals: "Approvals",
  navMission: "Board",
  navValidations: "Validations",
  navHandoff: "Handoff",
  navWorktrees: "Worktrees",
  navDeliveries: "Deliveries",
  navRuntime: "Runtime",
  navTmux: "tmux",
  navPlugins: "Plugins",
  navSettings: "Settings",
  refresh: "Refresh",
  auto: "Auto-refresh",
  empty: "No Tachyon workspace attached in this window.",
  copyDiagnostics: "Copy diagnostics",
  openMissionControl: "Open Board",
  openSettings: "Open Settings",
  openDoctor: "Run Doctor",
  copied: "Diagnostics copied",
  overviewTitle: "Overview",
  overviewHint: "Health snapshot. Fleet = agents (sidebar); Board = work queue.",
  engineTitle: "Engine / Bridge",
  fleetTitle: "Fleet",
  fleetHint: "Agents (runtime) — start, stop, terminal, activity. Work items are on the Board.",
  approvalsTitle: "Approvals",
  approvalsHint: "Human gates that block the fleet (embedded).",
  missionTitle: "Board",
  missionHint: "Work queue — tasks and lanes. Agents live in the sidebar Fleet.",
  validationsTitle: "Validations",
  validationsHint: "Validation queue — close dogfoods and checks (not on the Board).",
  handoffTitle: "Project Handoff",
  handoffHint: "Shared, curated project state — the doc a fresh agent reads first (embedded).",
  worktreesTitle: "Managed worktrees",
  worktreesHint: "Tachyon-managed checkouts — reveal and copy paths.",
  deliveriesTitle: "Deliveries",
  deliveriesHint: "Local GitDelivery records — phase, branch, worktree.",
  runtimeTitle: "Runtime Ops",
  runtimeHint: "Usage and rate limits (embedded).",
  tmuxTitle: "tmux",
  tmuxHint: "Server inspector (embedded).",
  pluginsTitle: "Plugins",
  pluginsHint: "Install, update, and integrity (embedded).",
  settingsTitle: "Settings",
  settingsHint: "Tachyon settings and workspace config.",
  workspaces: "Workspaces",
  engines: "Engines",
  agents: "Agents",
  errors: "Errors",
  bridges: "Bridges",
  approvals: "Approvals",
  worktrees: "Worktrees",
  deliveries: "Deliveries",
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
  stopped: "stopped",
  checkedAt: "Checked",
  open: "Open",
  noneListed: "Nothing listed for this workspace yet.",
  kind: "Kind",
  branch: "Branch",
  status: "Status",
  phase: "Phase",
  path: "Path",
  name: "Name",
  start: "Start",
  stop: "Stop",
  openTerminal: "Terminal",
  openActivity: "Activity",
  reveal: "Reveal",
  copyPath: "Copy path",
  copyId: "Copy id",
  openConfig: "Open tachyon.yml",
  settingsBody:
    "Tachyon product settings live in the VS Code Settings UI. Workspace agents and schedules are declared in tachyon.yml at the workspace root.",
  settingsOpenTachyon: "Open Tachyon settings",
  settingsOpenConfig: "Open tachyon.yml",
  settingsDoctor: "Run Doctor",
  companionTitle: "Companion",
  companionHint: "Pair Tachyon Companion and opt-in first-person browser tools for agents (user_browser_*).",
  companionBody:
    "When tab tools are on, agents see user_browser_* on the Bridge. Pairing Companion is still required to run them. Generate a pair code here (or via the command palette).",
  companionTabTools: "List Companion tab tools for agents",
  companionTabToolsHelp: "Writes settings.companion.tabTools in tachyon.yml and refreshes the Bridge tool list.",
  companionAllowedHosts: "Allowed hosts (optional)",
  companionAllowedHostsHelp:
    "One host or glob per line (example.com, *.herokuapp.com). Empty = all hosts. Writes settings.companion.allowedHosts in tachyon.yml.",
  companionAllowedHostsPlaceholder: "example.com\n*.herokuapp.com",
  companionAllowedHostsSave: "Save allowed hosts",
  companionPaired: "Paired",
  companionNotPaired: "Not paired",
  companionPickWorkspace: "Select a single workspace in the header to manage Companion settings.",
  companionBaseUrl: "Engine Base URL",
  companionShowPairCode: "Show pair code",
  companionCopyBaseUrl: "Copy URL",
  companionPairCodeLabel: "Code",
  companionPairUrlLabel: "URL",
  companionPairExpires: "Expires",
  companionPairExpired: "Code expired — generate a new one.",
  companionCopyCode: "Copy code",
  companionCopyUrl: "Copy URL",
  companionCopyAll: "Copy all",
  companionNewCode: "New code",
  companionPairUnavailable: "Companion pairing unavailable — ensure the Bridge is listening.",
  devicesTitle: "Connected devices",
  devicesHint: "Companion browsers paired to this workspace engine.",
  devicesEmpty: "No Companion device paired. Generate a pair code above, enter it in Tachyon Companion, then refresh.",
  devicesUnpair: "Unpair",
  devicesLive: "Live",
  devicesOffline: "Offline",
  devicesKindBrowser: "Browser",
  devicesKindMobile: "Mobile",
  devicesPairedAt: "Paired",
  declared: "declared",
  adhoc: "ad-hoc",
  agent: "agent",
  change: "change",
};

const bundles: CockpitWorkspaceBundle[] = [
  {
    control: {
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
      agents: { total: 4, running: 3 },
      authConfigured: true,
    },
    agents: [
      { name: "grok-hermes", kind: "agent", running: true, declared: true, folder: "tachyon", wsHash: "b349073a" },
      { name: "claude", kind: "agent", running: true, declared: true, folder: "tachyon", wsHash: "b349073a" },
      { name: "codex", kind: "agent", running: true, declared: true, folder: "tachyon", wsHash: "b349073a" },
      { name: "codex-budget", kind: "agent", running: false, declared: true, folder: "tachyon", wsHash: "b349073a" },
    ],
    worktrees: [
      {
        id: "mw-change-foo",
        kind: "change",
        path: "/cache/wt/b349073a/change/t-689e6c",
        branch: "tachyon/change/t-689e6c",
        status: "active",
        slug: "t-689e6c",
        folder: "tachyon",
        wsHash: "b349073a",
      },
    ],
    deliveries: [
      {
        id: "gd-1",
        phase: "in_review",
        branchRef: "tachyon/feature-x",
        agent: "grok-hermes",
        worktreePath: "/cache/wt/b349073a/feature-x",
        folder: "tachyon",
        wsHash: "b349073a",
      },
    ],
    approvals: [{ id: "a-0499c7", status: "pending", title: "Approve prune abandon" }],
    tmux: { state: "healthy", version: "3.4" },
    companion: {
      tabTools: true,
      allowedHosts: ["the-internet.herokuapp.com", "*.herokuapp.com"],
      paired: true,
      baseUrl: "http://127.0.0.1:7421",
      engineLabel: "tachyon",
      devices: [
        {
          id: "fixture-dev",
          kind: "browser",
          name: "Tachyon Companion",
          version: "0.4.8",
          pairedAt: "2026-07-21T12:00:00.000Z",
          live: true,
        },
      ],
    },
  },
];

// t-d16a39 — a second workspace so the shell-level workspace selector renders (it hides with one).
const goldenBundle: CockpitWorkspaceBundle = {
  control: {
    folderName: "golem",
    workspaceRoot: "/home/goat/golem",
    wsHash: "c7d21e90",
    bridgeUrl: "http://127.0.0.1:7431/mcp",
    identity: {
      pid: 190_004,
      instanceId: "eng-2b9d0e44",
      processStartIdentity: "start-1a7f",
      startedAt: "2026-07-16T13:22:41.000Z",
      bundleId: "bundle-0.56.10-abc",
      engineVersion: "0.56.10",
      protocol: { min: 3, max: 3 },
      bridge: { instanceId: "br-90aa", port: 7431 },
    },
    agents: { total: 1, running: 1 },
    authConfigured: true,
  },
  agents: [{ name: "claude", kind: "agent", running: true, declared: true, folder: "golem", wsHash: "c7d21e90" }],
  worktrees: [],
  deliveries: [],
  approvals: [],
  tmux: { state: "healthy", version: "3.4" },
  companion: {
    tabTools: false,
    allowedHosts: [],
    paired: false,
    baseUrl: "http://127.0.0.1:7431",
    engineLabel: "golem",
    devices: [],
  },
};

const now = "2026-07-16T18:40:00.000Z";

// Representative queue for the embedded Validations tab (t-e61439): a pending agent item, a pending human
// item and a closed one — mixed priorities so the harness exercises the badge + filter UI non-empty.
const validationsSample: Validation[] = [
  {
    id: "v-8f1a02",
    title: "Confirm cockpit Validations tab renders a non-empty queue",
    type: "dogfood",
    status: "pending",
    executor: "agent",
    priority: 0,
    assignee: "impl-e61439",
    instructions: "Open Control → Validations and confirm the queue lists real items, not the empty state.",
    source_refs: [{ type: "task", ref: "t-e61439" }],
    rounds: [],
    author: "claude",
    createdAt: "2026-07-15T09:00:00.000Z",
    updatedAt: "2026-07-16T10:00:00.000Z",
  },
  {
    id: "v-3c7d19",
    title: "Human sign-off on onboarding doc rewrite",
    type: "doc-review",
    status: "pending",
    executor: "human",
    priority: 2,
    instructions: "Read through docs/onboarding.md and confirm the new setup steps are accurate.",
    source_refs: [{ type: "file", ref: "docs/onboarding.md" }],
    rounds: [],
    author: "claude",
    createdAt: "2026-07-16T08:00:00.000Z",
    updatedAt: "2026-07-16T08:00:00.000Z",
  },
  {
    id: "v-5b2e44",
    title: "Regression sweep for plugin install flow",
    type: "regression",
    status: "closed",
    executor: "either",
    priority: 3,
    assignee: "cfpperche",
    instructions: "Install/update/remove a sample plugin end to end.",
    source_refs: [{ type: "task", ref: "t-6f21a9" }],
    rounds: [
      {
        n: 1,
        startedAt: "2026-07-14T12:00:00.000Z",
        closedAt: "2026-07-14T13:30:00.000Z",
        assignee: "cfpperche",
        outcome: "passed",
        result_note: "Install, update, and remove all worked as expected.",
      },
    ],
    author: "claude",
    createdAt: "2026-07-14T11:00:00.000Z",
    updatedAt: "2026-07-14T13:30:00.000Z",
  },
];

export const validationsFixtureVm: ValidationsViewModel = buildValidationsViewModel({
  folder: "tachyon",
  wsHash: "b349073a",
  validations: validationsSample,
});

export const cockpitFixtures: Record<string, Fixture<CockpitModel>> = {
  default: { provenance: "synthetic-edge", vm: buildCockpitModel(bundles, { section: "overview", nowIso: now }) },
  engine: { provenance: "synthetic-edge", vm: buildCockpitModel(bundles, { section: "engine", nowIso: now }) },
  fleet: { provenance: "synthetic-edge", vm: buildCockpitModel(bundles, { section: "fleet", nowIso: now }) },
  mission: { provenance: "synthetic-edge", vm: buildCockpitModel(bundles, { section: "mission", nowIso: now }) },
  // t-610705 (Phase C.1) — previews the task-detail subroute: buildCockpitModel only knows sections,
  // so activeRoute is attached after, exactly like Cockpit.ts's sendModel() does for the real host.
  "task-detail": {
    provenance: "synthetic-edge",
    vm: { ...buildCockpitModel(bundles, { section: "mission", nowIso: now }), activeRoute: cockpitRoutes.taskDetail("b349073a", "t-4f2c91") },
  },
  // t-610705 (Phase C.2) — Fleet subroutes: same activeRoute-attached-after-buildCockpitModel
  // pattern as task-detail above. nav section for both is "fleet".
  "agent-activity": {
    provenance: "synthetic-edge",
    vm: { ...buildCockpitModel(bundles, { section: "fleet", nowIso: now }), activeRoute: cockpitRoutes.agentActivity("b349073a", "claude") },
  },
  "agent-probes": {
    provenance: "synthetic-edge",
    vm: { ...buildCockpitModel(bundles, { section: "fleet", nowIso: now }), activeRoute: cockpitRoutes.agentProbes("b349073a", "claude") },
  },
  // t-610705 (Phase D, D0) — the pilot studio route (studios-routes-design.md): same activeRoute-
  // attached-after-buildCockpitModel pattern as above; nav section is "fleet" (command/terminal/
  // runbook/schedule/agent studios all parent there per the registry table). `studioMountNonce` is
  // a fixture-only stand-in for the real host's per-binding nonce — this static harness has no live
  // host to hand one out, and the client doesn't validate it against anything here anyway.
  "studio-command": {
    provenance: "synthetic-edge",
    vm: { ...buildCockpitModel(bundles, { section: "fleet", nowIso: now }), activeRoute: cockpitRoutes.studioNew("command", "b349073a"), studioMountNonce: "fixture-mount-nonce" },
  },
  "studio-command-edit": {
    provenance: "synthetic-edge",
    vm: { ...buildCockpitModel(bundles, { section: "fleet", nowIso: now }), activeRoute: cockpitRoutes.studioEdit("command", "b349073a", "verify-ui"), studioMountNonce: "fixture-mount-nonce" },
  },
  // t-610705 (Phase D, D1a) — same pattern as studio-command/-edit above for the 3 D1a studios.
  "studio-terminal": {
    provenance: "synthetic-edge",
    vm: { ...buildCockpitModel(bundles, { section: "fleet", nowIso: now }), activeRoute: cockpitRoutes.studioNew("terminal", "b349073a"), studioMountNonce: "fixture-mount-nonce" },
  },
  "studio-terminal-edit": {
    provenance: "synthetic-edge",
    vm: { ...buildCockpitModel(bundles, { section: "fleet", nowIso: now }), activeRoute: cockpitRoutes.studioEdit("terminal", "b349073a", "dev-server"), studioMountNonce: "fixture-mount-nonce" },
  },
  "studio-runbook": {
    provenance: "synthetic-edge",
    vm: { ...buildCockpitModel(bundles, { section: "fleet", nowIso: now }), activeRoute: cockpitRoutes.studioNew("runbook", "b349073a"), studioMountNonce: "fixture-mount-nonce" },
  },
  "studio-runbook-edit": {
    provenance: "synthetic-edge",
    vm: { ...buildCockpitModel(bundles, { section: "fleet", nowIso: now }), activeRoute: cockpitRoutes.studioEdit("runbook", "b349073a", "release-preview"), studioMountNonce: "fixture-mount-nonce" },
  },
  "studio-schedule": {
    provenance: "synthetic-edge",
    vm: { ...buildCockpitModel(bundles, { section: "fleet", nowIso: now }), activeRoute: cockpitRoutes.studioNew("schedule", "b349073a"), studioMountNonce: "fixture-mount-nonce" },
  },
  "studio-schedule-edit": {
    provenance: "synthetic-edge",
    vm: { ...buildCockpitModel(bundles, { section: "fleet", nowIso: now }), activeRoute: cockpitRoutes.studioEdit("schedule", "b349073a", "nightly-release-check"), studioMountNonce: "fixture-mount-nonce" },
  },
  "studio-agent": {
    provenance: "synthetic-edge",
    vm: { ...buildCockpitModel(bundles, { section: "fleet", nowIso: now }), activeRoute: cockpitRoutes.studioNew("agent", "b349073a"), studioMountNonce: "fixture-mount-nonce" },
  },
  "studio-agent-edit": {
    provenance: "synthetic-edge",
    vm: { ...buildCockpitModel(bundles, { section: "fleet", nowIso: now }), activeRoute: cockpitRoutes.studioEdit("agent", "b349073a", "reviewer"), studioMountNonce: "fixture-mount-nonce" },
  },
  validations: { provenance: "synthetic-edge", vm: buildCockpitModel(bundles, { section: "validations", nowIso: now }) },
  approvals: { provenance: "synthetic-edge", vm: buildCockpitModel(bundles, { section: "approvals", nowIso: now }) },
  // t-610705 (Phase C.3) — Handoff folds into a section (no activeRoute, unlike task-detail/Fleet
  // subroutes above): same simple section-only pattern as validations/approvals.
  handoff: { provenance: "synthetic-edge", vm: buildCockpitModel(bundles, { section: "handoff", nowIso: now }) },
  runtime: { provenance: "synthetic-edge", vm: buildCockpitModel(bundles, { section: "runtime", nowIso: now }) },
  tmux: { provenance: "synthetic-edge", vm: buildCockpitModel(bundles, { section: "tmux", nowIso: now }) },
  plugins: { provenance: "synthetic-edge", vm: buildCockpitModel(bundles, { section: "plugins", nowIso: now }) },
  worktrees: { provenance: "synthetic-edge", vm: buildCockpitModel(bundles, { section: "worktrees", nowIso: now }) },
  deliveries: { provenance: "synthetic-edge", vm: buildCockpitModel(bundles, { section: "deliveries", nowIso: now }) },
  settings: { provenance: "synthetic-edge", vm: buildCockpitModel(bundles, { section: "settings", nowIso: now }) },
  empty: { provenance: "synthetic-edge", vm: buildCockpitModel([], { section: "overview", nowIso: now }) },
  // t-d16a39 — the shell workspace selector: visible under "All workspaces" and scoped to one.
  "multi-workspace": {
    provenance: "synthetic-edge",
    vm: buildCockpitModel([...bundles, goldenBundle], { section: "fleet", nowIso: now }),
  },
  "multi-workspace-scoped": {
    provenance: "synthetic-edge",
    vm: buildCockpitModel([...bundles, goldenBundle], { section: "fleet", nowIso: now, wsHash: "c7d21e90" }),
  },
};
