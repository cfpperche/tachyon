import * as vscode from "vscode";
import type { CockpitStrings } from "@tachyon/webview-ui/webview/shared/control/messages";

export function cockpitStrings(): CockpitStrings {
  const t = vscode.l10n.t;
  return {
    title: t("Apps"),
    subtitle: t("Project sysadmin"),
    back: t("Back"),
    refresh: t("Refresh"),
    auto: t("Auto-refresh"),
    empty: t("No Tachyon workspace attached in this window."),
    copyDiagnostics: t("Copy diagnostics"),
    openDoctor: t("Run Doctor"),
    // SDD 500 — the hint answers the question spec.md says System exists to answer, in the reader's
    // words. Overview's old hint pointed at two OTHER screens (Fleet, Board); this one points at what
    // is on this one.
    systemTitle: t("System"),
    systemHint: t("Is Tachyon up and healthy, and if not, where?"),
    settingsTitle: t("Settings"),
    settingsHint: t("Personal machine preferences and shared project policy — two files, two authorities."),
    workspaces: t("Workspaces"),
    workspacesInWindow: t("of {0} in this window"),
    engines: t("Engines"),
    agents: t("Agents"),
    errors: t("Errors"),
    approvals: t("Approvals"),
    inbox: t("Waiting on you"),
    worktrees: t("Worktrees"),
    // SDD 500 — the engine STATE badge's three words, and they are capitalized because that is how the
    // Engine screen shipped them. Before the merge these existed twice: lower-case here (read by
    // nothing) and Title Case in `EnginePanel.ts`'s own inline strings table. One table now.
    attached: t("Attached"),
    error: t("Error"),
    none: t("None"),
    state: t("State"),
    pid: t("PID"),
    version: t("Version"),
    instance: t("Instance"),
    started: t("Started"),
    bundle: t("Bundle"),
    protocol: t("Protocol"),
    url: t("URL"),
    integratedBrowser: t("Integrated Browser"),
    cdp: t("CDP"),
    noPage: t("No page"),
    port: t("Port"),
    auth: t("Auth"),
    root: t("Root"),
    hash: t("Hash"),
    running: t("running"),
    stopped: t("stopped"),
    open: t("Open"),
    noneListed: t("Nothing listed for this workspace yet."),
    kind: t("Kind"),
    branch: t("Branch"),
    status: t("Status"),
    phase: t("Phase"),
    path: t("Path"),
    name: t("Name"),
    continueTask: t("Continue task in…"),
    continueTaskPickTitle: t("Continue task from {0} in…"),
    continueTaskPickSubtitle: t(
      "Starts a new session on the destination with a focused handoff — not a native resume of the source session.",
    ),
    continueTaskPickPlaceholder: t("Filter destination agents…"),
    continueTaskPickEmpty: t("No other declared agent to continue into"),
    continueTaskDestStopped: t("stopped"),
    continueTaskDestRunning: t("running — stop first"),
    continueTaskDestDetail: t("New session with focused handoff from {0}"),
    reveal: t("Reveal"),
    copyPath: t("Copy path"),
    openConfig: t("Open workspace settings"),
    // t-7b4bb5 — two authorities, named so the dual open buttons do not look like a split mind.
    // t-2ad294 — state the split; the cards below already show it. Recovery-path contingency is docs.
    settingsBody: t(
      "Two settings files, on purpose: yours on this machine, the project's shared with the team. They own different knobs.",
    ),
    settingsScopeGlobalTitle: t("Global (personal)"),
    settingsScopeGlobalHint: t("Your machine preferences — agent pane, git path, theme."),
    settingsScopeWorkspaceTitle: t("Workspace (project)"),
    settingsScopeWorkspaceHint: t("Shared project policy in .tachyon/settings.yml — versioned with the repo."),
    settingsFileLabel: t("File:"),
    settingsOpenTachyon: t("Open global settings"),
    settingsOpenConfig: t("Open workspace settings"),
    settingsDoctor: t("Run Doctor"),
    settingsWritesTo: t("Writes to"),
    settingsWritesToEither: t("Writes to either — you pick below"),
    settingsWritesToNothing: t("Reads only"),
    companionTitle: t("Companion"),
    companionHint: t("Pair devices, manage access, and keep trusted connections in view."),
    companionTabTools: t("List Companion tab tools for agents"),
    companionTabToolsHelp: t("Writes companion.tabTools in .tachyon/settings.yml and refreshes the Bridge tool list."),
    companionAllowedHosts: t("Allowed hosts (optional)"),
    companionAllowedHostsHelp: t(
      "One host or glob per line (example.com, *.herokuapp.com). Empty = all hosts. Writes companion.allowedHosts in .tachyon/settings.yml.",
    ),
    companionAllowedHostsPlaceholder: t("example.com\n*.herokuapp.com"),
    // SDD 488 F4 — Integrated Browser GA gate (human surface + call-time; tools stay listed).
    ideBrowserTitle: t("Integrated Browser"),
    ideBrowserHint: t("VS Code editor browser and Design Mode. This gate controls the launcher action."),
    ideBrowserBody: t(
      "When enabled, the Design Mode launcher tile arms the overlay and opens the browser. Closing the browser disarms it. Agents always see ide_browser_* tools; calls fail until you enable this and open the bridge.",
    ),
    ideBrowserEnabled: t("Enable Integrated Browser"),
    ideBrowserEnabledHelp: t("Writes ideBrowser.enabled in .tachyon/settings.yml. Does not remove tools from the Bridge catalog."),
    // t-585d5c — the unit and the bounds are IN the strings, because a bare number field is where a
    // person guesses seconds and gets minutes.
    idleNotifyTitle: t("Idle agent notifications"),
    idleNotifyHelp: t(
      "How long a child agent may sit idle before Tachyon notifies its parent. 1-10080 minutes (7 days). Writes agentNotifications.idleAfterMinutes in .tachyon/settings.yml and applies on the next check — no restart.",
    ),
    idleNotifyUnit: t("minutes"),
    idleNotifyUsingDefault: t("Using the default ({0} min) — nothing written in .tachyon/settings.yml"),
    idleNotifyOff: t("Notifications are off for this workspace"),
    idleNotifyOffLabel: t("Turn notifications off"),
    idleNotifySave: t("Save"),
    idleNotifyReset: t("Back to default"),
    // t-aaad95 — Control -> Settings edits BOTH scopes now that VS Code contributes nothing.
    globalSettingsTitle: t("Your Tachyon settings"),
    globalSettingsHint: t("Per-person, per-machine, in a plain file you can edit by hand."),
    globalSettingsFileLabel: t("File:"),
    globalSettingsOpenFile: t("Open global settings"),
    globalSettingsRefused: t("This file was refused and the last good version is in use — fix it and it reloads by itself:"),
    globalSettingsCodeTheme: t("Activity code theme"),
    globalSettingsCodeThemeHelp: t("Syntax-highlight palette for code blocks in Activity."),
    globalSettingsCodeThemeAuto: t("Follow the editor"),
    globalSettingsCodeThemeDark: t("Dark"),
    globalSettingsCodeThemeLight: t("Light"),
    globalSettingsFont: t("UI font"),
    globalSettingsFontHelp: t("Monospace family for Tachyon screens. Size still follows the editor."),
    globalSettingsFontTachyon: t("Tachyon Mono"),
    globalSettingsFontDeparture: t("Departure Mono"),
    globalSettingsFontNeedsReopen: t("this page updates now; other surfaces apply the next time they are opened"),
    globalSettingsAgentPane: t("Agent pane"),
    globalSettingsAgentPaneHelp: t("The first-party agent pane. The integrated terminal stays available either way."),
    globalSettingsGitPath: t("Path to git"),
    globalSettingsGitPathHelp: t("Leave empty to use the git extension's git.path, then common install locations, then git on PATH."),
    globalSettingsSave: t("Save"),
    globalSettingsLive: t("takes effect immediately"),
    globalSettingsNeedsReopen: t("applies the next time Control is opened"),
    companionAllowedHostsSave: t("Save allowed hosts"),
    companionPaired: t("Paired"),
    companionNotPaired: t("Not paired"),
    companionPickWorkspace: t("This screen needs a single project."),
    companionShowPairCode: t("Show pair code"),
    companionPairCodeLabel: t("Code"),
    companionPairUrlLabel: t("URL"),
    companionPairExpires: t("Expires"),
    companionPairExpired: t("Code expired — generate a new one."),
    companionCopyCode: t("Copy code"),
    companionCopyUrl: t("Copy URL"),
    companionCopyAll: t("Copy all"),
    companionNewCode: t("New code"),
    companionPairUnavailable: t("Companion pairing unavailable — ensure the Bridge is listening."),
    companionPairQrLabel: t("Mobile QR"),
    companionPairQrHint: t(
      "Scan with your phone camera — opens Companion Mobile and pairs automatically. PC and phone must be on the same Tailscale tailnet (settings.companion.lanAccess: true).",
    ),
    companionLanAccessHint: t(
      "Mobile uses Tailscale only (not raw Wi‑Fi IPs). Install Tailscale on PC + phone, same account/tailnet, then generate a code.",
    ),
    devicesTitle: t("Connected devices"),
    devicesHint: t("Companion devices paired to this workspace engine (browser or mobile)."),
    devicesEmpty: t("No Companion device paired. Generate a pair code above, enter it in Tachyon Companion, then refresh."),
    devicesUnpair: t("Unpair"),
    devicesLive: t("Live"),
    devicesOffline: t("Paired · offline"),
    devicesKindBrowser: t("Browser"),
    devicesKindMobile: t("Mobile"),
    devicesPairedAt: t("Paired"),
    // SDD 482 phase 5 (`t-5e1113`) — the ratified product vocabulary; these two badges are the whole
    // user-visible surface for the distinction.
    //
    // t-4cc561 updated the claim that used to sit here. It said every OTHER occurrence of "declared"
    // or the retired species name was a frozen field/config/wire value, so the rename was two lines and not a sweep.
    // That stopped being true: the species names are now gone from identifiers, comments and copy
    // across the shell and engine. What IS still frozen, deliberately, is the narrow set that crosses
    // a boundary — the sidebar's legacy species flag, the handoff mode discriminant, and the
    // ledger's persisted shape. Those are renamed only with a protocol bump, never as nomenclature.
    agent: t("agent"),
    change: t("change"),
  };
}
