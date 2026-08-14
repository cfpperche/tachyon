import type { ConsentRow, ConsentRuntime, ConsentCommand, ConsentSettingsHook, ConsentWrite, ConsentConflict, ConsentSkill, ConsentSkillCollision, ConsentMcp, ConsentGitHook, ConsentView, ConsentTool, ConsentData, ConsentExternalTool, ConsentMcpCollision, ConsentVM } from "@tachyon/webview-ui/plugins/consentViewModel";
export type { ConsentOp, ConsentRow, ConsentRuntime, ConsentCommand, ConsentSettingsHook, ConsentWrite, ConsentConflict, ConsentSkill, ConsentSkillCollision, ConsentMcp, ConsentGitHook, ConsentView, ConsentTool, ConsentData, ConsentExternalTool, ConsentMcpCollision, ConsentVM } from "@tachyon/webview-ui/plugins/consentViewModel";
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

import type { Runtime } from "@tachyon/engine/plugins/manifest.js";
import type { InstallPreview, InstallProvenance, UpdatePreview, RemovePreview } from "./engine.js";
import { LOCKFILE_REL_PATH } from "@tachyon/engine/plugins/lockfile.js";
import { mcpRequiredEnv, type McpServer } from "@tachyon/engine/plugins/mcp.js";
import type { UpdateCheck } from "@tachyon/webview-ui/plugins/viewModel";

const PAYLOAD_ROOT_DISPLAY = ".tachyon/plugins";

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
