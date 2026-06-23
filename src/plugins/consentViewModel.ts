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

/** Build the consent VM for a fresh install (or a dir install when `provenance` is absent). */
export function buildInstallConsent(preview: InstallPreview, provenance?: InstallProvenance): ConsentVM {
  const pluginName = preview.manifest.name;
  const version = preview.manifest.version;
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
