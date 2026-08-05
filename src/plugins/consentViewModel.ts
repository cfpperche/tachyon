/**
 * spec 250 — pure consent-drawer view-model for the Plugins View. Transforms the engine's preview structs
 * (InstallPreview / UpdatePreview / RemovePreview) into a render-ready ConsentVM the BLOCKING security drawer
 * paints before any materialization, plus `deriveUpdateCheck` (UpdatePreview → the card's UpdateCheck status).
 *
 * PURE: no fs/network/vscode. The host runs the engine previews (I/O) and calls these to shape them; the
 * webview renders the ConsentVM and echoes back the consent `token` on confirm (the engine's TOCTOU guard).
 *
 * Honesty note: the engine does not (yet) classify "dangerous" hooks, so the drawer does NOT fake a danger
 * gate. The real security surface is provenance + the FULL list of shell commands that will run on agent
 * events (`wiredCommands`) + the file writes + the consent fingerprint. The user reviews every command.
 */

import type { Runtime, ToolLaunchPolicy } from "./manifest.js";
import type { InstallPreview, InstallProvenance, UpdatePreview, RemovePreview } from "./engine.js";
import type { DependencyState } from "./pluginDeps.js";
import { LOCKFILE_REL_PATH } from "./lockfile.js";
import { mcpRequiredEnv, type McpServer } from "./mcp.js";
import type { UpdateCheck } from "./viewModel.js";

const PAYLOAD_ROOT_DISPLAY = ".tachyon/plugins";

export type ConsentOp = "install" | "update" | "remove";

export interface ConsentRow {
  k: string;
  v: string;
}

/** A declared runtime in the consent drawer's per-runtime selector (spec 263). `selected` = will be
 *  materialized (install: user-toggleable; update/remove: fixed to the consented set). `present` = the
 *  runtime's config dir already exists in the workspace (label "present"); false ⇒ install will CREATE it. */
export interface ConsentRuntime {
  runtime: Runtime;
  selected: boolean;
  present: boolean;
}

/** One shell command that will run on an agent event once materialized (the security review surface). */
export interface ConsentCommand {
  runtime: Runtime;
  command: string;
}

/** A settings-hook block this plugin registers in one runtime. This is an install disclosure, not a
 * per-agent grant: projection into managed agent sessions remains workspace policy. */
export interface ConsentSettingsHook {
  runtime: Runtime;
  event: string;
  /** Exact runtime matchers. Empty means the hook block did not declare a matcher. */
  matchers: string[];
}

/** A file/dir Tachyon will write. */
export interface ConsentWrite {
  file: string;
  note?: string;
}

export interface ConsentConflict {
  settingsRel: string;
  /** baseline groups the user edited/removed (won't auto-update). */
  edited: number;
  /** user-added groups a new-version group would duplicate. */
  collided: number;
}

/** A skill this install/update materializes + the runtimes it lands in. */
export interface ConsentSkill {
  name: string;
  runtimes: Runtime[];
}

/** A colliding skill destination that needs a Keep/Replace decision (keyed by destRel). */
export interface ConsentSkillCollision {
  skill: string;
  runtime: Runtime;
  /** the decision key the apply echoes in `skillDecisions`. */
  destRel: string;
}

/** An MCP server this install/update materializes — the security surface: the exact command/url it will run
 *  and the env vars the user must provide. */
export interface ConsentMcp {
  name: string;
  transport: "stdio" | "http";
  /** the exact command + args (stdio) or the url (http). */
  detail: string;
  /** env-var NAMES this server references (the user provisions the values out-of-band). */
  env: string[];
  runtimes: Runtime[];
}

/** spec 264 — a git-hook this install/update will register: the exact command that runs on EVERY commit. */
export interface ConsentGitHook {
  event: string;
  /** the command/leaf that runs on the event (argv, or "<script> (payload script)"). */
  command: string;
  /** true ⇒ a pre-existing user hook will be chained first (preserved). */
  chainsPrior: boolean;
}

/** spec 349 — a UI surface this install/update will register. */
export interface ConsentView {
  id: string;
  title: string;
  surface: "editor" | "sidebar";
  entry: string;
  fleet: "summary";
  actions: Array<{ name: string; disclosure: string }>;
  disclosure: string;
}

/** spec 265 — a tool this install/update will DOWNLOAD + EXECUTE (the highest-trust capability). The drawer
 *  shows the resolved platform, the declared + redirect-resolved URL, the pinned checksum, and the publisher.
 *  Copy must say: the sha256 proves INTEGRITY against the manifest, NOT that the publisher is trustworthy. */
export interface ConsentTool {
  name: string;
  version: string;
  /** the resolved platform key the artifact is pinned for. */
  platform: string;
  /** the manifest-declared download URL. */
  declaredUrl: string;
  /** the redirect-resolved URL actually fetched (provenance). */
  finalUrl: string;
  /** the pinned artifact sha256 (integrity vs the manifest). */
  sha256: string;
  /** the URL host — surfaced as the publisher identity (NOT a trust assertion). */
  publisher: string;
  /** spec 269 — when present, this tool ALWAYS launches with these enforced env/args and refuses these args
   *  (shown in the drawer so the user consents to the forced launch behavior, not just the download). */
  launchPolicy?: ToolLaunchPolicy;
}

/** spec 284 — a DATA artifact this install will DOWNLOAD + STORE (read-only; never executed). Lower-trust than a
 *  tool: the drawer copy says "downloaded + stored, NOT executed" and that the sha256 proves integrity, not trust. */
export interface ConsentData {
  name: string;
  version: string;
  /** the resolved platform key, or "any" for a single cross-platform blob. */
  platform: string;
  declaredUrl: string;
  finalUrl: string;
  /** the pinned content sha256 (integrity vs the manifest). */
  sha256: string;
  /** the URL host — the publisher identity (NOT a trust assertion). */
  publisher: string;
}

/** spec 285 — an EXTERNAL system tool the plugin needs but Tachyon does NOT provision: present/missing + the
 *  host-PM assisted-install argv (when offerable) + manual guidance. Informational at install (the plugin installs
 *  regardless); the user triggers the assisted install separately. */
export interface ConsentExternalTool {
  name: string;
  present: boolean;
  /** spec 289 — the candidate binary names when more than one is accepted (audit disclosure: which host binaries
   *  satisfy this one requirement, e.g. google-chrome / chromium); absent for a single-name tool. */
  names?: string[];
  /** spec 289 — the winning trusted path when present. */
  resolvedPath?: string;
  /** the host-PM assisted-install argv (shown shell-quoted for display; run argv-directly in a visible terminal). */
  install?: string[];
  manual: string;
}

/** A colliding MCP server name that needs a Keep/Replace decision. */
export interface ConsentMcpCollision {
  server: string;
  runtime: Runtime;
  /** the decision key the apply echoes in `mcpDecisions` (`${runtime} ${ref}`). */
  key: string;
}

export interface ConsentVM {
  op: ConsentOp;
  pluginName: string;
  /** the version being installed/updated to (or the installed version being removed). */
  version: string;
  /** drawer title, e.g. "Install tdd-guard@1.3.0". */
  title: string;
  /** the confirm button label ("Install" | "Update" | "Force update" | "Remove"). */
  confirmLabel: string;
  /** ① provenance rows (source/commit/integrity) — absent for a local-dir install or a remove. */
  provenance?: ConsentRow[];
  /** spec 276 — the plugin's DIRECT declared dependencies + their install-time state (satisfied/out-of-range/
   *  missing). Surfaced so the human sees an unmet requirement BEFORE confirming. Advisory: never blocks install,
   *  never auto-installs — a plugin author's CLAIM, not a trusted endorsement. */
  requires?: DependencyState[];
  /** ② compatible + skipped runtimes (install/update only). */
  runtimes?: ConsentRuntime[];
  /** ③ permission summary — every shell command that will run on agent events (install/update only). */
  wiredCommands?: ConsentCommand[];
  /** Runtime settings-hooks this package registers. Informational: managed-agent projection is controlled
   * workspace-wide by `settings.agentHookProjection`, never by a per-agent capability grant. */
  settingsHooks?: ConsentSettingsHook[];
  /** ④ file writes preview (install/update only). */
  writes?: ConsentWrite[];
  /** update conflicts (the user edited installed hooks / a new group would duplicate). */
  conflicts?: ConsentConflict[];
  /** ⑤ skills this install/update materializes (per-runtime destinations). */
  skills?: ConsentSkill[];
  /** colliding skill destinations needing a Keep/Replace decision; Replace is destructive (double-confirm). */
  skillCollisions?: ConsentSkillCollision[];
  /** ⑥ MCP servers this install/update materializes (the highest-risk capability — arbitrary process/network). */
  mcp?: ConsentMcp[];
  /** colliding MCP server names needing a Keep/Replace decision. */
  mcpCollisions?: ConsentMcpCollision[];
  /** true when this install/update writes ANY MCP server → the drawer requires a SECOND confirmation (OQ5:
   *  stronger than skills' Replace-only double-confirm, because an installed server is agent-invokable
   *  process/network authority). */
  requiresMcpConfirm?: boolean;
  /** ⑦ spec 264 — git-hooks this install/update registers (run on EVERY commit, for every actor). */
  gitHooks?: ConsentGitHook[];
  /** true when this install/update registers ANY git-hook → the drawer requires a dedicated acknowledgement
   *  (runs on every commit for the human too, reads staged content, `--no-verify` bypasses it). */
  requiresGitHookConfirm?: boolean;
  /** spec 349 — UI surfaces this install/update registers. */
  views?: ConsentView[];
  /** true when this install/update registers ANY view → dedicated UI acknowledgement. */
  requiresViewConfirm?: boolean;
  /** true when any view reads a curated fleet summary → separate data-scope acknowledgement. */
  requiresFleetReadConfirm?: boolean;
  /** dedicated per-action acknowledgement keys (`<viewId>:<action>`). */
  requiresActionConfirm?: Record<string, string>;
  /** ⑧ spec 265 — tools this install/update will DOWNLOAD + EXECUTE (the highest-trust capability). */
  tools?: ConsentTool[];
  /** true when this install/update provisions ANY tool → the drawer requires a dedicated acknowledgement
   *  (downloads + executes a binary; sha256 proves integrity vs the manifest, not publisher trust). */
  requiresToolConfirm?: boolean;
  /** ⑨ spec 284 — DATA artifacts this install/update will DOWNLOAD + STORE (read-only, never executed). */
  data?: ConsentData[];
  /** true when this install/update provisions ANY data artifact → a dedicated (lighter than tool) acknowledgement
   *  (downloaded + stored, NOT executed; sha256 proves integrity vs the manifest). */
  requiresDataConfirm?: boolean;
  /** ⑩ spec 285 — external system tools the plugin needs (present/missing). Informational: installing the plugin
   *  runs nothing; the user triggers an assisted install (a separate, strongly-acked terminal action) if a tool is missing. */
  externalTools?: ConsentExternalTool[];
  /** true when the new version is LOWER than installed (a force-gated downgrade). */
  isDowngrade?: boolean;
  /** confirm proceeds as a `force` (conflicts and/or downgrade present) — the drawer warns. */
  requiresForce?: boolean;
  /** remove summary: what the uninstall will un-merge/delete — hook groups, skills, MCP servers, git-hooks —
   *  plus the conservative orphans (hook groups / MCP servers you edited) left in place. (The committed payload
   *  + any installer-created empty dirs are always removed too; those aren't counted here.) */
  removeSummary?: { removedCount: number; skillCount: number; mcpCount: number; gitHookCount: number; viewCount?: number; orphans: number };
  /** the consent token the apply must echo (install/update = the InstallPreview fingerprint; remove = name). */
  token: string;
  warnings?: string[];
  /** non-empty ⇒ the operation cannot proceed; the drawer shows the errors and disables confirm. */
  errors?: string[];
}

function provenanceRows(prov: InstallProvenance | undefined): ConsentRow[] | undefined {
  if (!prov) return undefined;
  const rows: ConsentRow[] = [
    { k: "source", v: prov.source.spec },
    { k: "ref", v: prov.source.ref },
    { k: "resolved commit", v: prov.source.resolvedCommit.slice(0, 12) },
    { k: "integrity", v: `${prov.integrity.algorithm}:${prov.integrity.payload.slice(0, 12)}` },
  ];
  if (prov.source.subdir) rows.splice(1, 0, { k: "subdir", v: prov.source.subdir });
  return rows;
}

/** Per-runtime selector rows: ALL declared runtimes (not just those with hooks — a no-artifact runtime is still
 *  selectable), each marked selected (∈ the target set) and present (config dir exists = a hint label). */
function runtimesFrom(install: InstallPreview, present: ReadonlySet<Runtime>): ConsentRuntime[] {
  const selected = new Set(install.targetRuntimes);
  return install.manifest.runtimes.map((rt) => ({ runtime: rt, selected: selected.has(rt), present: present.has(rt) }));
}

function wiredFrom(install: InstallPreview): ConsentCommand[] {
  return install.steps.flatMap((s) => s.wiredCommands.map((command) => ({ runtime: s.runtime, command })));
}

function settingsHooksFrom(install: InstallPreview): ConsentSettingsHook[] {
  return install.steps.flatMap((step) => Object.entries(step.owned).map(([event, groups]) => ({
    runtime: step.runtime,
    event,
    matchers: [...new Set(groups.flatMap((group) => group.matcher === undefined ? [] : [group.matcher]))],
  })));
}

function writesFrom(install: InstallPreview, pluginName: string): ConsentWrite[] {
  const writes: ConsentWrite[] = install.steps.map((s) => ({ file: s.settingsRel, note: `${s.wiredCommands.length} hook(s) merged` }));
  writes.push({ file: `${PAYLOAD_ROOT_DISPLAY}/${pluginName}/**`, note: "committed payload" });
  writes.push({ file: LOCKFILE_REL_PATH, note: "source + integrity pinned" });
  return writes;
}

/** Group a preview's skill targets into per-skill display rows + the flat list of colliding destinations. */
function skillsFrom(install: InstallPreview): { skills: ConsentSkill[]; collisions: ConsentSkillCollision[] } {
  const byName = new Map<string, Runtime[]>();
  const collisions: ConsentSkillCollision[] = [];
  for (const t of install.skillTargets) {
    const rts = byName.get(t.skill) ?? [];
    if (!rts.includes(t.runtime)) rts.push(t.runtime);
    byName.set(t.skill, rts);
    if (t.collision) collisions.push({ skill: t.skill, runtime: t.runtime, destRel: t.destRel });
  }
  return { skills: [...byName.entries()].map(([name, runtimes]) => ({ name, runtimes })), collisions };
}

/** A server's security-surface detail: the exact command + args (stdio) or the url (http). */
function mcpDetail(server: McpServer): string {
  return server.transport === "stdio" ? [server.command, ...server.args].join(" ") : server.url;
}

/** Group a preview's MCP targets into per-server display rows + the flat list of colliding server names. */
function mcpFrom(install: InstallPreview): { mcp: ConsentMcp[]; collisions: ConsentMcpCollision[] } {
  const byName = new Map<string, ConsentMcp>();
  const collisions: ConsentMcpCollision[] = [];
  for (const t of install.mcpTargets) {
    const existing = byName.get(t.ref);
    if (existing) {
      if (!existing.runtimes.includes(t.runtime)) existing.runtimes.push(t.runtime);
    } else {
      byName.set(t.ref, { name: t.ref, transport: t.server.transport, detail: mcpDetail(t.server), env: mcpRequiredEnv([t.server]), runtimes: [t.runtime] });
    }
    if (t.collision) collisions.push({ server: t.ref, runtime: t.runtime, key: `${t.runtime} ${t.ref}` });
  }
  return { mcp: [...byName.values()], collisions };
}

/** The git-hooks this install registers — each runs on EVERY commit (the highest-blast-radius surface). */
function gitHooksFrom(install: InstallPreview): ConsentGitHook[] {
  return install.gitHookTargets.map((g) => ({ event: g.event, command: g.display, chainsPrior: g.priorHook !== null }));
}

function viewActionDisclosure(action: string): string {
  if (action === "focusAgent") return "Can ask Tachyon to reveal an agent terminal to you; terminal contents may be visible on screen.";
  return `Can ask Tachyon to run the brokered action '${action}' when the host later supports it.`;
}

function viewsFrom(install: InstallPreview): ConsentView[] {
  return install.viewTargets.map((v) => ({
    id: v.id,
    title: v.title,
    surface: v.surface,
    entry: v.entry,
    fleet: v.fleet,
    actions: v.actions.map((name) => ({ name, disclosure: viewActionDisclosure(name) })),
    disclosure: "Draws UI in your editor and reads a name-free summary of your fleet.",
  }));
}

function actionConfirmsFrom(install: InstallPreview): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const v of install.viewTargets) for (const action of v.actions) out[`${v.id}:${action}`] = viewActionDisclosure(action);
  return Object.keys(out).length > 0 ? out : undefined;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "?";
  }
}

/** The tools this install will download + execute — the highest-trust surface (platform/URL/checksum/publisher). */
function toolsFrom(install: InstallPreview): ConsentTool[] {
  return install.toolTargets.map((t) => ({
    name: t.name,
    version: t.version,
    platform: t.resolvedPlatform,
    declaredUrl: t.declaredUrl,
    finalUrl: t.finalUrl,
    sha256: t.sha256,
    publisher: hostOf(t.declaredUrl),
    ...(t.launchPolicy ? { launchPolicy: t.launchPolicy } : {}),
  }));
}

/** spec 285 — the external system tools the plugin needs (present/missing + the host-PM assisted-install argv). */
function externalFrom(install: InstallPreview): ConsentExternalTool[] {
  return install.externalTargets.map((e) => ({
    name: e.name, present: e.present,
    ...(e.names && e.names.length > 1 ? { names: e.names } : {}), // spec 289 — disclose candidate set
    ...(e.resolvedPath ? { resolvedPath: e.resolvedPath } : {}),
    ...(e.install ? { install: e.install } : {}),
    manual: e.manual,
  }));
}

/** spec 284 — the DATA artifacts this install will download + store read-only (never executed). */
function dataFrom(install: InstallPreview): ConsentData[] {
  return install.dataTargets.map((d) => ({
    name: d.name,
    version: d.version,
    platform: d.resolvedPlatform,
    declaredUrl: d.declaredUrl,
    finalUrl: d.finalUrl,
    sha256: d.sha256,
    publisher: hostOf(d.declaredUrl),
  }));
}

/** Build the consent VM for a fresh install (or a dir install when `provenance` is absent). `present` is the
 *  detectRuntimes hint used ONLY to label each declared runtime "present" vs "will be created" — it never gates
 *  which runtimes install (spec 263): the user's selection (preview.targetRuntimes) does. */
export function buildInstallConsent(preview: InstallPreview, provenance?: InstallProvenance, present: ReadonlySet<Runtime> = new Set()): ConsentVM {
  const pluginName = preview.manifest.name;
  const version = preview.manifest.version;
  const { skills, collisions } = skillsFrom(preview);
  const { mcp, collisions: mcpCollisions } = mcpFrom(preview);
  return {
    op: "install",
    pluginName,
    version,
    title: `Install ${pluginName}@${version}`,
    confirmLabel: "Install",
    provenance: provenanceRows(provenance),
    ...(preview.requires.length > 0 ? { requires: preview.requires } : {}),
    runtimes: runtimesFrom(preview, present),
    ...(preview.steps.length > 0 ? { settingsHooks: settingsHooksFrom(preview) } : {}),
    wiredCommands: wiredFrom(preview),
    writes: writesFrom(preview, pluginName),
    ...(skills.length > 0 ? { skills } : {}),
    ...(collisions.length > 0 ? { skillCollisions: collisions } : {}),
    ...(mcp.length > 0 ? { mcp, requiresMcpConfirm: true } : {}),
    ...(mcpCollisions.length > 0 ? { mcpCollisions } : {}),
    ...(preview.gitHookTargets.length > 0 ? { gitHooks: gitHooksFrom(preview), requiresGitHookConfirm: true } : {}),
    ...(preview.viewTargets.length > 0 ? { views: viewsFrom(preview), requiresViewConfirm: true, requiresFleetReadConfirm: true } : {}),
    ...(actionConfirmsFrom(preview) ? { requiresActionConfirm: actionConfirmsFrom(preview) } : {}),
    ...(preview.toolTargets.length > 0 ? { tools: toolsFrom(preview), requiresToolConfirm: true } : {}),
    ...(preview.dataTargets.length > 0 ? { data: dataFrom(preview), requiresDataConfirm: true } : {}),
    ...(preview.externalTargets.length > 0 ? { externalTools: externalFrom(preview) } : {}),
    token: preview.fingerprint,
    ...(preview.warnings.length > 0 ? { warnings: preview.warnings } : {}),
    ...(preview.errors.length > 0 ? { errors: preview.errors } : {}),
  };
}

/** The reinstall door intentionally uses the complete install consent surface; only its framing differs. */
export function buildReinstallConsent(preview: InstallPreview, provenance?: InstallProvenance, present: ReadonlySet<Runtime> = new Set()): ConsentVM {
  return {
    ...buildInstallConsent(preview, provenance, present),
    title: `Reinstall ${preview.manifest.name}@${preview.manifest.version}`,
    confirmLabel: "Reinstall",
  };
}

/**
 * Build the consent VM for an update (or a force-reinstall over drift). `forceReinstall` frames a conflict/drift
 * re-materialize. The install plan + provenance come from the UpdatePreview.
 *
 * t-4e5f11 — when `contentChangedSameVersion`, frame as Reapply (same version, different source bytes). The word
 * "Update" would contradict the card badge "source changed · still vX" on the same line of product language.
 */
export function buildUpdateConsent(preview: UpdatePreview, provenance: InstallProvenance | undefined, forceReinstall = false, present: ReadonlySet<Runtime> = new Set()): ConsentVM {
  const pluginName = preview.install?.manifest.name ?? "";
  const version = preview.toVersion;
  const contentChanged = preview.contentChangedSameVersion === true;
  const requiresForce = forceReinstall || preview.conflicts.length > 0 || preview.isDowngrade;
  const conflicts: ConsentConflict[] = preview.conflicts.map((c) => ({ settingsRel: c.settingsRel, edited: c.edited, collided: c.collided }));

  const errors: string[] = [...preview.errors];
  if (!preview.found) errors.push(`'${pluginName}' is not installed — use install`);
  if (preview.upToDate) errors.push(`already up to date (v${version})`);

  const title = forceReinstall
    ? `Reinstall ${pluginName}@${version}`
    : contentChanged
      ? `Reapply ${pluginName}@${version} — source content changed`
      : `Update ${pluginName} → ${version}`;
  const confirmLabel = requiresForce ? "Force update" : contentChanged ? "Reapply" : "Update";
  const warnings = contentChanged
    ? [`Manifest version is still ${version}; the resolved plugin payload hash differs from what this workspace installed.`]
    : undefined;

  const vm: ConsentVM = {
    op: "update",
    pluginName,
    version,
    title,
    confirmLabel,
    provenance: provenanceRows(provenance),
    token: preview.install?.fingerprint ?? "",
    ...(conflicts.length > 0 ? { conflicts } : {}),
    ...(preview.isDowngrade ? { isDowngrade: true } : {}),
    ...(requiresForce ? { requiresForce: true } : {}),
    ...(warnings ? { warnings } : {}),
    ...(errors.length > 0 ? { errors } : {}),
  };
  if (preview.install) {
    vm.runtimes = runtimesFrom(preview.install, present);
    if (preview.install.steps.length > 0) vm.settingsHooks = settingsHooksFrom(preview.install);
    vm.wiredCommands = wiredFrom(preview.install);
    vm.writes = writesFrom(preview.install, pluginName);
    const { skills, collisions } = skillsFrom(preview.install);
    if (skills.length > 0) vm.skills = skills;
    if (collisions.length > 0) vm.skillCollisions = collisions;
    const { mcp, collisions: mcpCollisions } = mcpFrom(preview.install);
    if (mcp.length > 0) { vm.mcp = mcp; vm.requiresMcpConfirm = true; }
    if (mcpCollisions.length > 0) vm.mcpCollisions = mcpCollisions;
    if (preview.install.gitHookTargets.length > 0) { vm.gitHooks = gitHooksFrom(preview.install); vm.requiresGitHookConfirm = true; }
    if (preview.install.viewTargets.length > 0) {
      vm.views = viewsFrom(preview.install);
      vm.requiresViewConfirm = true;
      vm.requiresFleetReadConfirm = true;
      const actionConfirms = actionConfirmsFrom(preview.install);
      if (actionConfirms) vm.requiresActionConfirm = actionConfirms;
    }
    if (preview.install.toolTargets.length > 0) { vm.tools = toolsFrom(preview.install); vm.requiresToolConfirm = true; }
    if (preview.install.dataTargets.length > 0) { vm.data = dataFrom(preview.install); vm.requiresDataConfirm = true; }
    if (preview.install.externalTargets.length > 0) { vm.externalTools = externalFrom(preview.install); }
  }
  return vm;
}

/** Build the consent VM for a remove. The token is the remove fingerprint (lock identity + current config +
 *  owned groups) so applyRemove refuses if the plugin changed since the drawer was shown (TOCTOU). */
export function buildRemoveConsent(pluginName: string, version: string, preview: RemovePreview): ConsentVM {
  const errors = preview.found ? [...preview.errors] : [`'${pluginName}' is not installed`, ...preview.errors];
  return {
    op: "remove",
    pluginName,
    version,
    title: `Remove ${pluginName}`,
    confirmLabel: "Remove",
    removeSummary: { removedCount: preview.removedCount, skillCount: preview.skillCount, mcpCount: preview.mcpCount, gitHookCount: preview.gitHookCount, ...((preview.viewCount ?? 0) > 0 ? { viewCount: preview.viewCount } : {}), orphans: preview.orphans },
    token: preview.fingerprint,
    ...(preview.orphans > 0 ? { warnings: [`${preview.orphans} hook group(s) you edited will be left in place (orphaned), never auto-deleted`] } : {}),
    ...(errors.length > 0 ? { errors } : {}),
  };
}

/** Derive the installed card's status from an update-check (re-resolve source + previewUpdate). */
export function deriveUpdateCheck(preview: UpdatePreview): UpdateCheck {
  if (preview.errors.length > 0) return { kind: "error", detail: preview.errors.join("; ") };
  if (!preview.found) return { kind: "error", detail: "not installed" };
  if (preview.conflicts.length > 0) {
    const detail = preview.conflicts.map((c) => `${c.settingsRel}: ${c.edited} edited`).join("; ");
    return { kind: "drift", detail };
  }
  // t-4e5f11 — same version, different bytes: a distinct card state (not "update available · vX" which implies a bump).
  if (preview.contentChangedSameVersion) return { kind: "source-changed", version: preview.toVersion };
  if (preview.upToDate || preview.isDowngrade) return { kind: "up-to-date" };
  return { kind: "update-available", latestVersion: preview.toVersion };
}
