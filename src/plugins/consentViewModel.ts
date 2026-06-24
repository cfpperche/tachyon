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

import type { Runtime } from "./manifest.js";
import type { InstallPreview, InstallProvenance, UpdatePreview, RemovePreview } from "./engine.js";
import { LOCKFILE_REL_PATH } from "./lockfile.js";
import { mcpRequiredEnv, type McpServer } from "./mcp.js";
import type { UpdateCheck } from "./viewModel.js";

const PAYLOAD_ROOT_DISPLAY = ".tachyon/plugins";

export type ConsentOp = "install" | "update" | "remove";

export interface ConsentRow {
  k: string;
  v: string;
}

/** A runtime in the plan: `install` = the block will be merged here; `skip` = declared but absent in workspace. */
export interface ConsentRuntime {
  runtime: Runtime;
  status: "install" | "skip";
}

/** One shell command that will run on an agent event once materialized (the security review surface). */
export interface ConsentCommand {
  runtime: Runtime;
  command: string;
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
  /** ② compatible + skipped runtimes (install/update only). */
  runtimes?: ConsentRuntime[];
  /** ③ permission summary — every shell command that will run on agent events (install/update only). */
  wiredCommands?: ConsentCommand[];
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
  /** true when the new version is LOWER than installed (a force-gated downgrade). */
  isDowngrade?: boolean;
  /** confirm proceeds as a `force` (conflicts and/or downgrade present) — the drawer warns. */
  requiresForce?: boolean;
  /** remove summary: hook groups that will be un-merged + conservative orphans left as-is. */
  removeSummary?: { removedCount: number; orphans: number };
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

function runtimesFrom(install: InstallPreview): ConsentRuntime[] {
  return [
    ...install.steps.map((s) => ({ runtime: s.runtime, status: "install" as const })),
    ...install.skipped.map((r) => ({ runtime: r, status: "skip" as const })),
  ];
}

function wiredFrom(install: InstallPreview): ConsentCommand[] {
  return install.steps.flatMap((s) => s.wiredCommands.map((command) => ({ runtime: s.runtime, command })));
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

/** Build the consent VM for a fresh install (or a dir install when `provenance` is absent). */
export function buildInstallConsent(preview: InstallPreview, provenance?: InstallProvenance): ConsentVM {
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
    runtimes: runtimesFrom(preview),
    wiredCommands: wiredFrom(preview),
    writes: writesFrom(preview, pluginName),
    ...(skills.length > 0 ? { skills } : {}),
    ...(collisions.length > 0 ? { skillCollisions: collisions } : {}),
    ...(mcp.length > 0 ? { mcp, requiresMcpConfirm: true } : {}),
    ...(mcpCollisions.length > 0 ? { mcpCollisions } : {}),
    token: preview.fingerprint,
    ...(preview.warnings.length > 0 ? { warnings: preview.warnings } : {}),
    ...(preview.errors.length > 0 ? { errors: preview.errors } : {}),
  };
}

/**
 * Build the consent VM for an update (or a force-reinstall over drift). `forceReinstall` frames a conflict/drift
 * re-materialize. The install plan + provenance come from the UpdatePreview.
 */
export function buildUpdateConsent(preview: UpdatePreview, provenance: InstallProvenance | undefined, forceReinstall = false): ConsentVM {
  const pluginName = preview.install?.manifest.name ?? "";
  const version = preview.toVersion;
  const requiresForce = forceReinstall || preview.conflicts.length > 0 || preview.isDowngrade;
  const conflicts: ConsentConflict[] = preview.conflicts.map((c) => ({ settingsRel: c.settingsRel, edited: c.edited, collided: c.collided }));

  const errors: string[] = [...preview.errors];
  if (!preview.found) errors.push(`'${pluginName}' is not installed — use install`);
  if (preview.upToDate) errors.push(`already up to date (v${version})`);

  const vm: ConsentVM = {
    op: "update",
    pluginName,
    version,
    title: forceReinstall ? `Reinstall ${pluginName}@${version}` : `Update ${pluginName} → ${version}`,
    confirmLabel: requiresForce ? "Force update" : "Update",
    provenance: provenanceRows(provenance),
    token: preview.install?.fingerprint ?? "",
    ...(conflicts.length > 0 ? { conflicts } : {}),
    ...(preview.isDowngrade ? { isDowngrade: true } : {}),
    ...(requiresForce ? { requiresForce: true } : {}),
    ...(errors.length > 0 ? { errors } : {}),
  };
  if (preview.install) {
    vm.runtimes = runtimesFrom(preview.install);
    vm.wiredCommands = wiredFrom(preview.install);
    vm.writes = writesFrom(preview.install, pluginName);
    const { skills, collisions } = skillsFrom(preview.install);
    if (skills.length > 0) vm.skills = skills;
    if (collisions.length > 0) vm.skillCollisions = collisions;
    const { mcp, collisions: mcpCollisions } = mcpFrom(preview.install);
    if (mcp.length > 0) { vm.mcp = mcp; vm.requiresMcpConfirm = true; }
    if (mcpCollisions.length > 0) vm.mcpCollisions = mcpCollisions;
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
    removeSummary: { removedCount: preview.removedCount, orphans: preview.orphans },
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
  if (preview.upToDate || preview.isDowngrade) return { kind: "up-to-date" };
  return { kind: "update-available", latestVersion: preview.toVersion };
}
