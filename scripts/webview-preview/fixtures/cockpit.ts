/**
 * Control panel fixtures for dev-host preview (production-facing copy only).
 */

import { buildCockpitModel, type CockpitModel, type CockpitWorkspaceBundle } from "../../../src/cockpit/model";
import { routes as cockpitRoutes } from "../../../src/cockpit/route";
import type { CockpitStrings } from "../../../src/webview/cockpit/messages";
import type { RuntimeConfigControlSnapshot } from "../../../src/runtimeConfig/types";
import { buildValidationsViewModel, type ValidationsViewModel } from "../../../src/webview/validations/viewModel";
import type { Validation } from "../../../src/validations/types";
import type { Fixture } from "../routes";

export const strings: CockpitStrings = {
  title: "Control",
  subtitle: "Project sysadmin",
  navOverview: "Overview",
  navEngine: "Engine",
  navFleet: "Fleet",
  navInbox: "Inbox",
  navApprovals: "Approvals",
  navMission: "Board",
  navValidations: "Validations",
  navHandoff: "Handoff",
  navWorktrees: "Worktrees",
  navDeliveries: "Deliveries",
  navRuntime: "Runtime Ops",
  navRuntimeConfig: "Runtime Config",
  navTmux: "tmux",
  navPlugins: "Plugins",
  navSettings: "Settings",
  back: "Back",
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
  worktreesTitle: "Managed worktrees",
  worktreesHint: "Tachyon-managed checkouts — reveal and copy paths.",
  deliveriesTitle: "Deliveries",
  deliveriesHint: "Local GitDelivery records — phase, branch, worktree.",
  runtimeTitle: "Runtime Ops",
  runtimeHint: "Usage and rate limits (embedded).",
  runtimeConfigTitle: "Runtime Config",
  runtimeConfigHint: "Global runtime configuration, capabilities, and agent impact.",
  runtimeConfigPrototype: "Visual prototype",
  runtimeConfigEditable: "Editable measured settings",
  runtimeConfigGlobalWarning: "Global changes also affect the selected runtime outside Tachyon.",
  runtimeConfigUnset: "Not set",
  runtimeConfigDisableMcp: "Disable from source",
  runtimeConfigGlobal: "Global",
  runtimeConfigWorkspace: "Workspace",
  runtimeConfigRuntime: "Runtime",
  runtimeConfigScope: "Scope",
  runtimeConfigCapabilitiesTitle: "Skills, MCPs, hooks & extensions",
  runtimeConfigDetected: "detected",
  runtimeConfigKnown: "Known settings",
  runtimeConfigCapabilities: "Runtime capabilities",
  runtimeConfigOther: "Other settings",
  runtimeConfigOtherHint: "Preserved in the source file even when Tachyon does not edit them visually.",
  runtimeConfigSourceFile: "Source file",
  runtimeConfigUsedBy: "Used by agents",
  runtimeConfigConfigured: "configured",
  runtimeConfigEnabled: "Enabled",
  runtimeConfigDisabled: "Disabled",
  runtimeConfigReload: "Reload",
  runtimeConfigOpenFile: "Open file",
  runtimeConfigSave: "Save changes",
  runtimeConfigViewRaw: "View raw",
  runtimeConfigCodex: "OpenAI Codex",
  runtimeConfigClaude: "Anthropic Claude",
  runtimeConfigGlobalConfig: "Global config",
  runtimeConfigWorkspaceConfig: "Workspace config",
  runtimeConfigGlobalSettings: "Global settings",
  runtimeConfigWorkspaceSettings: "Workspace settings",
  runtimeConfigWorkspaceMcp: "Workspace MCP",
  runtimeConfigTheme: "Theme",
  runtimeConfigReducedMotion: "Reduced motion",
  runtimeConfigSpinnerTips: "Spinner tips",
  runtimeConfigTurnDuration: "Turn duration",
  runtimeConfigTerminalProgress: "Terminal progress bar",
  runtimeConfigAlwaysThinking: "Always thinking",
  runtimeConfigReadOnly: "Read only",
  runtimeConfigOverriddenBy: "Overridden by",
  runtimeConfigOpaqueSections: "Opaque sections",
  runtimeConfigReadError: "Could not read this runtime configuration source",
  runtimeConfigUnavailable: "Runtime configuration is unavailable because this workspace configuration did not load.",
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
  inbox: "Waiting on you",
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
  navLoading: "Loading…",
  navStalled: "This is taking longer than expected.",
  navRetry: "Retry",
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
  openProbes: "Probes",
  editAgent: "Edit",
  continueTask: "Continue task in…",
  continueTaskPickTitle: "Continue task from {0} in…",
  continueTaskPickSubtitle:
    "Starts a new session on the destination with a focused handoff — not a native resume of the source session.",
  continueTaskPickPlaceholder: "Filter destination agents…",
  continueTaskPickEmpty: "No other declared agent to continue into",
  continueTaskDestStopped: "stopped",
  continueTaskDestRunning: "running — stop first",
  continueTaskDestDetail: "New session with focused handoff from {0}",
  continueTaskNoDest: "No other declared agent to continue into (need a stopped destination).",
  reveal: "Reveal",
  copyPath: "Copy path",
  copyId: "Copy id",
  openConfig: "Open tachyon.yml",
  settingsBody:
    "Tachyon product settings live in the VS Code Settings UI. Workspace agents and schedules are declared in tachyon.yml at the workspace root.",
  settingsOpenTachyon: "Open Tachyon settings",
  settingsOpenConfig: "Open tachyon.yml",
  settingsDoctor: "Run Doctor",
  cardTemplateTitle: "Agent card layout",
  cardTemplateHint: "Choose which elements an agent card shows, and in what order.",
  cardTemplateBody: "Compose a layout here, watch the real card update, then paste the YAML into tachyon.yml.",
  cardTemplateYamlHint: "Paste this under your workspace's tachyon.yml.",
  cardTemplateCopy: "Copy YAML",
  cardTemplateReset: "Reset to default",
  cardTemplateCriticalNote: "shown anyway when a row is in this state",
  cardTemplateInlineNote: "renders inside another element",
  cardTemplateInEffect: "In effect right now:",
  cardTemplatePersonalActive: "your personal override in VS Code settings — it wins over every project template below",
  cardTemplatePersonalRefused: "your personal override was REFUSED and ignored; the cards fall back to each project's template",
  cardTemplatePersonalNone: "no personal override — each project's own template decides",
  cardTemplateProjectNone: "uses Tachyon's default card",
  cardTemplateProjectConfigured: "has its own template in tachyon.yml",
  cardTemplateProjectRefused: "its tachyon.yml template was refused; showing the default card",
  cardTemplateHomeLabel: "Write this layout to:",
  cardTemplateHomeProject: "This project (tachyon.yml)",
  cardTemplateHomePersonal: "Just me (VS Code settings)",
  cardTemplateCopyJson: "Copy JSON",
  cardTemplateJsonHint: "Paste this into your VS Code settings.json. It applies to every project you open, and wins over their templates; regions you did not change keep whatever each project chose.",
  cardTemplateOpenSettings: "Open settings",
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
  allWorkspaces: "All workspaces",
  companionPickWorkspace: "Select a single workspace in Overview to manage Companion settings.",
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
  companionPairQrLabel: "Mobile QR",
  companionPairQrHint:
    "Scan with Tachyon Companion Mobile (or paste payload). Payload: baseUrl + pairCode + protocolVersion.",
  companionPairCandidatesLabel: "URL candidates",
  companionCopyPayload: "Copy QR payload",
  companionLanAccessHint:
    "Phone on Wi‑Fi needs settings.companion.lanAccess: true (Bridge rebinds; Doctor warns).",
  devicesTitle: "Connected devices",
  devicesHint: "Companion devices paired to this workspace engine (browser or mobile).",
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
  wtReadyTitle: "Ready to remove",
  wtReadyDesc: "Clean, unoccupied, and every commit is already in its base branch. Safe to delete.",
  wtReviewTitle: "Needs review",
  wtReviewDesc: "Blocked from cleanup — read the reason before touching these by hand.",
  wtOccupiedTitle: "Occupied",
  wtOccupiedDesc: "A live agent holds this checkout right now.",
  wtRecordTitle: "Record-only",
  wtRecordDesc: "The registry row survives, but the checkout's directory is gone. Nothing to reveal — just forget the row.",
  wtRemoveCheckout: "Remove checkout",
  wtForgetRecord: "Forget record",
  wtAlsoDeleteBranch: "Also delete local branch",
  wtSelectAll: "Select all",
  wtClearSelection: "Clear",
  wtSelected: "selected",
  wtReviewConfirm: "Review & confirm…",
  wtConfirmTitle: "Confirm cleanup",
  wtConfirmBody: "Each entry is re-checked at execution — one whose state changed is skipped with a reason, the rest proceed.",
  wtConfirmRun: "Run cleanup",
  wtCancel: "Cancel",
  wtEngineUnavailable: "Engine unavailable — registry not shown (unverified data is never displayed).",
  wtBlocked: "Blocked",
  wtOccupiedBy: "occupied by",
  wtShowAll: "Show all",
  dlvMissingRef: "ref missing",
  dlvLive: "agent live",
  dlvUnmerged: "not in base",
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
    // spec 444 — one row per hygiene classification group so the preview renders the full tab.
    worktrees: [
      {
        id: "mw-change-ready",
        kind: "change",
        path: "/cache/wt/b349073a/change/docs-link-fix",
        branch: "tachyon/change/docs-link-fix",
        status: "active",
        slug: "docs-link-fix",
        folder: "tachyon",
        wsHash: "b349073a",
        tachyonCreatedBranch: true,
        classification: { state: "ready-to-remove", reasons: [], pathExists: true, dirty: false, aheadOfBase: 0, containedInBase: true },
      },
      {
        id: "mw-change-dirty",
        kind: "change",
        path: "/cache/wt/b349073a/change/t-689e6c",
        branch: "tachyon/change/t-689e6c",
        status: "active",
        slug: "t-689e6c",
        folder: "tachyon",
        wsHash: "b349073a",
        tachyonCreatedBranch: true,
        classification: { state: "needs-review", reasons: ["worktree has uncommitted changes"], pathExists: true, dirty: true, aheadOfBase: 0, containedInBase: true },
      },
      {
        id: "mw-change-busy",
        kind: "change",
        path: "/cache/wt/b349073a/change/fleet-ui",
        branch: "tachyon/change/fleet-ui",
        status: "active",
        slug: "fleet-ui",
        folder: "tachyon",
        wsHash: "b349073a",
        tachyonCreatedBranch: true,
        classification: {
          state: "occupied",
          reasons: ["occupied by 'codex' (live)"],
          pathExists: true,
          dirty: false,
          aheadOfBase: 2,
          containedInBase: false,
          occupant: { state: "live", agent: "codex", cwd: "/cache/wt/b349073a/change/fleet-ui" },
        },
      },
      {
        id: "mw-agent-tombstone",
        kind: "agent",
        path: "/cache/wt/b349073a/spec376-dogfood-impl",
        branch: "tachyon/spec376-dogfood-impl",
        status: "abandoned",
        agent: "spec376-dogfood-impl",
        folder: "tachyon",
        wsHash: "b349073a",
        tachyonCreatedBranch: true,
        classification: { state: "record-only", reasons: ["path does not exist"], pathExists: false, dirty: false, aheadOfBase: 0, containedInBase: false },
      },
      {
        id: "mw-change-tombstone-2",
        kind: "change",
        path: "/cache/wt/b349073a/change/pin-studio-fix",
        branch: "tachyon/change/pin-studio-fix",
        status: "abandoned",
        slug: "pin-studio-fix",
        folder: "tachyon",
        wsHash: "b349073a",
        tachyonCreatedBranch: true,
        classification: { state: "record-only", reasons: ["path does not exist"], pathExists: false, dirty: false, aheadOfBase: 0, containedInBase: false },
      },
    ],
    // t-43c6fa — one row per classification signal the tab now surfaces (spec 365), so the preview
    // exercises the badges/reasons instead of only the happy path.
    deliveries: [
      {
        id: "gd-1",
        phase: "in_review",
        branchRef: "tachyon/feature-x",
        agent: "grok-hermes",
        worktreePath: "/cache/wt/b349073a/feature-x",
        folder: "tachyon",
        wsHash: "b349073a",
        liveState: "live",
        containedInBase: false,
        missingRef: false,
        clean: true,
        safetyClass: "reload-safe",
        reasons: ["agent grok-hermes is live in this worktree"],
      },
      {
        id: "gd-2",
        phase: "open",
        branchRef: "tachyon/change/dropped-ref",
        agent: "codex",
        folder: "tachyon",
        wsHash: "b349073a",
        liveState: "not_live",
        containedInBase: false,
        missingRef: true,
        clean: true,
        reasons: ["branch ref no longer resolves — commits cannot be verified"],
      },
      {
        id: "gd-3",
        phase: "integrated",
        branchRef: "tachyon/change/landed",
        agent: "claude",
        worktreePath: "/cache/wt/b349073a/landed",
        folder: "tachyon",
        wsHash: "b349073a",
        liveState: "not_live",
        containedInBase: true,
        missingRef: false,
        clean: true,
        safetyClass: "reload-safe",
        reasons: [],
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

export const runtimeConfigFixtureSnapshot: RuntimeConfigControlSnapshot = {
  runtimes: [
    {
      runtime: "codex",
      label: "OpenAI Codex",
      potentialAgents: ["codex-canonico"],
      documents: [
        {
          id: "codex-global",
          label: "Global config",
          scope: "global",
          kind: "config",
          path: "/home/goat/.codex/config.toml",
          exists: true,
          revision: "preview-codex-global",
          knownSettings: [
            { key: "approval_policy", label: "Approval policy", value: "never", editValue: "never", editable: true, inputKind: "text" },
            { key: "sandbox_mode", label: "Sandbox mode", value: "danger-full-access", editValue: "danger-full-access", editable: true, inputKind: "text" },
            { key: "tui.status_line_use_colors", label: "Status line colors", value: "true", editValue: true, editable: true, inputKind: "boolean" },
          ],
          mcpServers: [{ name: "tachyon_bridge", enabled: true, editable: true }],
          unknownKeys: ["model_provider"],
          internalStateCount: 2,
        },
        {
          id: "codex-workspace",
          label: "Workspace config",
          scope: "workspace",
          kind: "config",
          path: "/home/goat/tachyon/.codex/config.toml",
          exists: true,
          revision: "preview-codex-workspace",
          knownSettings: [],
          mcpServers: [],
          unknownKeys: [],
          internalStateCount: 0,
        },
      ],
    },
    {
      runtime: "claude",
      label: "Anthropic Claude",
      potentialAgents: ["claude-opus5"],
      pendingAgents: ["claude-opus5"],
      documents: [
        {
          id: "claude-global-settings",
          label: "Global settings",
          scope: "global",
          kind: "settings",
          path: "/home/goat/.claude/settings.json",
          exists: true,
          revision: "preview-claude-global",
          knownSettings: [
            { key: "theme", label: "Theme", value: "dark", editValue: "dark", editable: true, inputKind: "text" },
            { key: "spinnerTipsEnabled", label: "Spinner tips", value: "false", editValue: false, editable: true, inputKind: "boolean" },
          ],
          mcpServers: [],
          unknownKeys: ["statusLine"],
          internalStateCount: 1,
          opaqueKeys: ["permissions"],
        },
        {
          id: "claude-workspace-settings",
          label: "Workspace settings",
          scope: "workspace",
          kind: "settings",
          path: "/home/goat/tachyon/.claude/settings.json",
          exists: true,
          revision: "preview-claude-workspace",
          knownSettings: [],
          mcpServers: [],
          unknownKeys: [],
          internalStateCount: 0,
        },
        {
          id: "claude-workspace-mcp",
          label: "Workspace MCP",
          scope: "workspace",
          kind: "mcp",
          path: "/home/goat/tachyon/.mcp.json",
          exists: true,
          revision: "preview-claude-mcp",
          knownSettings: [],
          mcpServers: [{ name: "tachyon_bridge", enabled: true, editable: true }],
          unknownKeys: [],
          internalStateCount: 0,
        },
      ],
    },
  ],
};

/**
 * t-ac79a7 — the task the nav-feedback fixture is "opening". Deliberately a card that really exists
 * in the board fixture, so the preview shows the acknowledgement on the clicked card (`.card.opening`)
 * rather than a pending state floating over a board that contains no such task. Exported so the route
 * registry builds its routeKey from the same constant instead of a literal that could drift.
 */
export const NAV_PENDING_TASK_ID = "t-4bf28a";

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
  /**
   * t-ac79a7 — the navigation-feedback state, sequenced the way the LIVE host sequences it.
   *
   * The model here is the Board with NO activeRoute, because that is what the client is still
   * holding while a Board click is in flight: `routePending` is posted synchronously from
   * navigate(), and the task-detail model does not arrive until `deps.collect()` finishes seconds
   * later (t-af3eef). So the honest picture of "waiting" is the ORIGIN screen plus the progress
   * bar — not the destination's own loading state, which only appears once the model has landed.
   *
   * The route registry pushes the pending envelope for this fixture and deliberately never the
   * matching `routeReady`, so the surface stays in the bracket for as long as a screenshot needs.
   * The client escalates on its own timers, so "slow" (after NAV_SLOW_MS) and "stalled" (after
   * NAV_STALL_MS) are the real client's states photographed at different ages rather than two
   * hand-built approximations that could drift from it.
   */
  "nav-pending": {
    provenance: "synthetic-edge",
    vm: buildCockpitModel(bundles, { section: "mission", nowIso: now }),
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
  "studio-agent-canonical": {
    provenance: "synthetic-edge",
    vm: { ...buildCockpitModel(bundles, { section: "fleet", nowIso: now }), activeRoute: cockpitRoutes.studioEdit("agent", "b349073a", "canonical-reviewer"), studioMountNonce: "fixture-mount-nonce" },
  },
  // SDD 471 — the per-agent bypassPermissions authorization renders only for a canonical Claude
  // agent with the permissions family projected; both states are inspectable.
  "studio-agent-claude-bypass-off": {
    provenance: "synthetic-edge",
    vm: { ...buildCockpitModel(bundles, { section: "fleet", nowIso: now }), activeRoute: cockpitRoutes.studioEdit("agent", "b349073a", "canonical-claude-bypass-off"), studioMountNonce: "fixture-mount-nonce" },
  },
  "studio-agent-claude-bypass-on": {
    provenance: "synthetic-edge",
    vm: { ...buildCockpitModel(bundles, { section: "fleet", nowIso: now }), activeRoute: cockpitRoutes.studioEdit("agent", "b349073a", "canonical-claude-bypass-on"), studioMountNonce: "fixture-mount-nonce" },
  },
  "studio-agent-codex-danger-off": {
    provenance: "synthetic-edge",
    vm: { ...buildCockpitModel(bundles, { section: "fleet", nowIso: now }), activeRoute: cockpitRoutes.studioEdit("agent", "b349073a", "canonical-codex-danger-off"), studioMountNonce: "fixture-mount-nonce" },
  },
  "studio-agent-codex-danger-on": {
    provenance: "synthetic-edge",
    vm: { ...buildCockpitModel(bundles, { section: "fleet", nowIso: now }), activeRoute: cockpitRoutes.studioEdit("agent", "b349073a", "canonical-codex-danger-on"), studioMountNonce: "fixture-mount-nonce" },
  },
  // t-610705 (Phase D, D2) — task is edit-only in practice (route.ts's decodeRoute rejects
  // studio-new + "task" outright — every real caller pre-mints an id), so there is no "studio-task"
  // new-session fixture to match command/terminal/runbook/schedule/agent above. Nav section is
  // "mission", not "fleet" — route.ts's studioParentSection special-cases "task" (D2).
  "studio-task-edit": {
    provenance: "synthetic-edge",
    vm: { ...buildCockpitModel(bundles, { section: "mission", nowIso: now }), activeRoute: cockpitRoutes.studioEdit("task", "b349073a", "t-4f2c91"), studioMountNonce: "fixture-mount-nonce" },
  },
  // t-610705 (Phase D, D3) — pin is nav-less (navSection: null — route.ts): unlike every studio
  // above, its underlying `section` isn't a fixed answer, so this uses "overview" (the same fallback
  // Cockpit.ts's real host uses at every navSection(currentRoute) call site) — and its `returnRoute`
  // is explicit here (a static preview harness never runs the real navigate()/captureReturnRoute
  // logic that fills it in automatically), demonstrating the "back to Mission" breadcrumb.
  "studio-pin-edit": {
    provenance: "synthetic-edge",
    vm: {
      ...buildCockpitModel(bundles, { section: "overview", nowIso: now }),
      activeRoute: cockpitRoutes.studioEdit("pin", "b349073a", "pin-7f3a", cockpitRoutes.section("mission")),
      studioMountNonce: "fixture-mount-nonce",
    },
  },
  "studio-pin-new": {
    provenance: "synthetic-edge",
    vm: {
      ...buildCockpitModel(bundles, { section: "overview", nowIso: now }),
      activeRoute: cockpitRoutes.studioNew("pin", "b349073a", cockpitRoutes.section("mission")),
      studioMountNonce: "fixture-mount-nonce",
    },
  },
  validations: { provenance: "synthetic-edge", vm: buildCockpitModel(bundles, { section: "validations", nowIso: now }) },
  approvals: { provenance: "synthetic-edge", vm: buildCockpitModel(bundles, { section: "approvals", nowIso: now }) },
  // t-ace77f — Handoff is a DETAIL ROUTE, not a section: the model still carries a background
  // section (nav-less routes fall back to overview at every call site) and `activeRoute` is what
  // actually renders, same shape as the task-detail/Fleet-subroute fixtures above.
  handoff: {
    provenance: "synthetic-edge",
    vm: {
      ...buildCockpitModel(bundles, { section: "overview", nowIso: now }),
      activeRoute: cockpitRoutes.projectHandoff("b349073a"),
    },
  },
  runtime: { provenance: "synthetic-edge", vm: buildCockpitModel(bundles, { section: "runtime", nowIso: now }) },
  "runtime-config": { provenance: "synthetic-edge", vm: buildCockpitModel(bundles, { section: "runtime-config", nowIso: now }) },
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
  // t-46eb4f — Overview with more than one root attached: the ONE global scope selector, offering
  // "All workspaces" plus each root. The single-root case is the `default` fixture, where the same
  // selector is still rendered (it just has one option) — it no longer hides itself.
  "multi-workspace-overview": {
    provenance: "synthetic-edge",
    vm: buildCockpitModel([...bundles, goldenBundle], { section: "overview", nowIso: now }),
  },
};
