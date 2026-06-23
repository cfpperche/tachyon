/**
 * spec 250 Step 3 — the plugin materialization engine (I/O). Reads a plugin from disk, plans an install
 * (a READ-ONLY preview = the security surface the UI shows before consent), applies it (writes the runtime
 * config + copies the payload + records the lockfile), and reverses it on remove (un-merging exactly what
 * was written + surfacing conservative orphans). v1 wires the CLAUDE runtime only; codex is Step 4.
 *
 * Trust + safety model:
 *  - TWO-PHASE: preview* never write — they return the settings diff + the exact hook commands that would
 *    run, gated by a `fingerprint`. apply* re-derive the preview and refuse if the workspace changed since
 *    consent (TOCTOU guard).
 *  - FAIL-CLOSED reads: a corrupt lockfile or unparseable settings is an ERROR (never silently treated as
 *    empty — that would orphan an installed plugin's removal identity or clobber a user's broken-but-real file).
 *  - UNTRUSTED payload: the plugin dir is preflighted (no symlinks/special files; bounded bytes/files/depth)
 *    before it is copied, and the lockfile's opaque `removal` is re-validated before it reaches the adapter.
 *  - TRANSACTIONAL order on install: payload → lockfile → settings (settings, which ACTIVATES the hooks, is
 *    written last, so any mid-failure leaves an inactive + removable state, never live hooks with no lockfile).
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { loadManifest, resolveCompat, type PluginManifest, type Runtime } from "./manifest.js";
import {
  parseClaudeHooksBlock,
  mergePluginHooks,
  removePluginHooks,
  parseOwnedHooks,
  normalizeClaudeSettings,
  type ClaudeHooksBlock,
  type ClaudeSettings,
  type OwnedHooks,
} from "./adapters/claude.js";
import {
  parseLockfile,
  serializeLockfile,
  emptyLockfile,
  LOCKFILE_REL_PATH,
  type Lockfile,
  type PluginLock,
  type MaterializedTarget,
} from "./lockfile.js";

const MANIFEST_REL = "tachyon-plugin.json";
const HOOKS_FILE = "hooks.json"; // inside a runtime block dir
const CLAUDE_SETTINGS_REL = ".claude/settings.json";
const PAYLOAD_ROOT = ".tachyon/plugins";

const MAX_PAYLOAD_BYTES = 50 * 1024 * 1024; // 50 MB
const MAX_PAYLOAD_FILES = 5000;
const MAX_PAYLOAD_DEPTH = 32;

// ── fs helpers ──────────────────────────────────────────────────────────────

function readText(file: string): string | undefined {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

/** Crash-/race-safe write: stage to a unique temp in the same dir, then atomic rename. */
function atomicWrite(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

/** Write a settings object, or remove the file when it has become empty (no orphan `{}`). */
function writeSettings(file: string, settings: ClaudeSettings): void {
  if (Object.keys(settings).length > 0) atomicWrite(file, `${JSON.stringify(settings, null, 2)}\n`);
  else fs.rmSync(file, { force: true });
}

interface SettingsRead {
  settings?: ClaudeSettings;
  errors: string[];
}

/** Read `.claude/settings.json` fail-closed: absent → `{}`; present-but-invalid → ERROR (never clobber a
 *  user's broken-but-real settings by treating a parse failure as empty). */
function readSettings(file: string): SettingsRead {
  const raw = readText(file);
  if (raw === undefined) return { settings: {}, errors: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { errors: [`${CLAUDE_SETTINGS_REL}: invalid JSON — refusing to overwrite a broken settings file`] };
  }
  return normalizeClaudeSettings(parsed);
}

interface LockfileRead {
  lockfile?: Lockfile;
  errors: string[];
}

/** Read the lockfile fail-closed: absent → empty; present-but-corrupt → ERROR (a corrupt lockfile must not
 *  silently orphan an installed plugin's removal identity). */
function readLockfile(workspaceRoot: string): LockfileRead {
  const raw = readText(path.join(workspaceRoot, LOCKFILE_REL_PATH));
  if (raw === undefined) return { lockfile: emptyLockfile(), errors: [] };
  const { lockfile, errors } = parseLockfile(raw);
  if (!lockfile) return { errors: [`${LOCKFILE_REL_PATH} is corrupt: ${errors.join("; ")}`] };
  return { lockfile, errors: [] };
}

function writeLockfile(workspaceRoot: string, lockfile: Lockfile): void {
  const file = path.join(workspaceRoot, LOCKFILE_REL_PATH);
  if (Object.keys(lockfile.plugins).length > 0) atomicWrite(file, serializeLockfile(lockfile));
  else fs.rmSync(file, { force: true });
}

// ── untrusted payload preflight ─────────────────────────────────────────────

interface PayloadCheck {
  hash: string;
  errors: string[];
}

/** Walk an untrusted plugin dir BEFORE copying it: reject symlinks/special files, bound bytes/files/depth,
 *  and accumulate a deterministic content hash (used in the install fingerprint). Never throws. */
function preflightPayload(dir: string): PayloadCheck {
  const errors: string[] = [];
  const h = crypto.createHash("sha256");
  let bytes = 0;
  let files = 0;

  const walk = (d: string, depth: number, rel: string): void => {
    if (errors.length > 0) return;
    if (depth > MAX_PAYLOAD_DEPTH) {
      errors.push(`payload exceeds max depth (${MAX_PAYLOAD_DEPTH})`);
      return;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch (e) {
      errors.push(`cannot read payload dir: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    for (const ent of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (errors.length > 0) return;
      const p = path.join(d, ent.name);
      const r = path.posix.join(rel, ent.name);
      if (ent.isSymbolicLink()) {
        errors.push(`payload contains a symlink (not allowed): ${r}`);
        return;
      }
      if (ent.isDirectory()) {
        h.update(`D:${r}\n`);
        walk(p, depth + 1, r);
      } else if (ent.isFile()) {
        if (++files > MAX_PAYLOAD_FILES) {
          errors.push(`payload exceeds max file count (${MAX_PAYLOAD_FILES})`);
          return;
        }
        const size = fs.statSync(p).size;
        bytes += size;
        if (bytes > MAX_PAYLOAD_BYTES) {
          errors.push(`payload exceeds max size (${MAX_PAYLOAD_BYTES} bytes)`);
          return;
        }
        h.update(`F:${r}:`);
        h.update(fs.readFileSync(p));
        h.update("\n");
      } else {
        errors.push(`payload contains a special file (not allowed): ${r}`);
        return;
      }
    }
  };

  walk(dir, 0, "");
  return { hash: h.digest("hex"), errors };
}

// ── runtime detection ───────────────────────────────────────────────────────

/** Which runtimes a workspace uses, by the presence of their config dir. */
export function detectRuntimes(workspaceRoot: string): Set<Runtime> {
  const present = new Set<Runtime>();
  if (fs.existsSync(path.join(workspaceRoot, ".claude"))) present.add("claude");
  if (fs.existsSync(path.join(workspaceRoot, ".codex"))) present.add("codex");
  return present;
}

// ── load a plugin from disk ─────────────────────────────────────────────────

export interface LoadedPlugin {
  dir: string;
  manifest: PluginManifest;
  /** the claude block's parsed hooks, when the plugin supports claude. */
  claudeHooks?: ClaudeHooksBlock;
  /** posix path (relative to a workspace) the claude payload will live at once installed. */
  claudeRootRel?: string;
}

export interface LoadResult {
  plugin?: LoadedPlugin;
  errors: string[];
}

/** Read + validate a plugin directory (manifest + the claude block's hooks). Fail-closed; never throws. */
export function loadPlugin(pluginDir: string): LoadResult {
  const manifestRaw = readText(path.join(pluginDir, MANIFEST_REL));
  if (manifestRaw === undefined) return { errors: [`no ${MANIFEST_REL} in ${pluginDir}`] };
  const { manifest, errors } = loadManifest(manifestRaw);
  if (!manifest) return { errors };

  const plugin: LoadedPlugin = { dir: pluginDir, manifest };

  if (manifest.runtimes.includes("claude")) {
    const blockRel = manifest.blocks.claude;
    const hooksRaw = readText(path.join(pluginDir, blockRel, HOOKS_FILE));
    if (hooksRaw === undefined) return { errors: [`claude block '${blockRel}' has no ${HOOKS_FILE}`] };
    const parsed = parseClaudeHooksBlock(hooksRaw);
    if (!parsed.hooks) return { errors: parsed.errors.map((e) => `claude/${HOOKS_FILE}: ${e}`) };
    plugin.claudeHooks = parsed.hooks;
    plugin.claudeRootRel = path.posix.join(PAYLOAD_ROOT, manifest.name, blockRel.replace(/\/+$/, ""));
  }

  return { plugin, errors: [] };
}

// ── lockfile prior-state reconstruction ─────────────────────────────────────

interface PriorOwned {
  owned: OwnedHooks;
  errors: string[];
}

/** Reconstruct the claude OwnedHooks a prior install recorded, RE-VALIDATING the opaque `removal`
 *  (the lockfile may be hand-edited) and rejecting duplicate refs. */
function priorClaudeOwned(lock: PluginLock | undefined): PriorOwned {
  const owned: OwnedHooks = {};
  const errors: string[] = [];
  const seenRef = new Set<string>();
  if (!lock) return { owned, errors };
  for (const t of lock.targets) {
    if (t.runtime !== "claude" || t.kind !== "settings-hook" || !t.ref) continue;
    if (seenRef.has(t.ref)) {
      errors.push(`lockfile: duplicate claude target ref '${t.ref}'`);
      continue;
    }
    seenRef.add(t.ref);
    const parsed = parseOwnedHooks({ [t.ref]: t.removal });
    if (!parsed.owned) {
      errors.push(`lockfile: malformed removal for '${t.ref}': ${parsed.errors.join("; ")}`);
      continue;
    }
    if (parsed.owned[t.ref]) owned[t.ref] = parsed.owned[t.ref];
  }
  return { owned, errors };
}

function collectCommands(owned: OwnedHooks): string[] {
  const cmds: string[] = [];
  for (const groups of Object.values(owned)) for (const g of groups) for (const h of g.hooks) cmds.push(h.command);
  return cmds;
}

// ── install (preview → apply) ───────────────────────────────────────────────

export interface ClaudeInstallStep {
  runtime: "claude";
  settingsRel: string;
  /** the settings as they are now (for the diff preview). */
  before: ClaudeSettings;
  /** the settings after the merge (what apply will write). */
  after: ClaudeSettings;
  owned: OwnedHooks;
  /** SECURITY surface: the shell commands that will run on hook events once installed. */
  wiredCommands: string[];
}

export interface InstallPreview {
  manifest: PluginManifest;
  steps: ClaudeInstallStep[];
  /** declared runtimes not installed here: absent from the workspace, or not engine-supported yet (codex). */
  skipped: Runtime[];
  warnings: string[];
  errors: string[];
  /** binds consent to the exact inputs (manifest+hooks+current settings+prior lock+payload). apply refuses a mismatch. */
  fingerprint: string;
  /** the preflighted payload content hash — apply re-checks the STAGED copy against this (TOCTOU close). */
  payloadHash: string;
}

/** True iff the on-disk settings still equal the snapshot the merge was computed from (lost-update guard). */
function settingsUnchanged(file: string, expected: ClaudeSettings): boolean {
  const r = readSettings(file);
  return !!r.settings && JSON.stringify(r.settings) === JSON.stringify(expected);
}

function fingerprintOf(plugin: LoadedPlugin, steps: ClaudeInstallStep[], payloadHash: string): string {
  const basis = {
    name: plugin.manifest.name,
    version: plugin.manifest.version,
    payload: payloadHash,
    steps: steps.map((s) => ({ rt: s.runtime, before: s.before, after: s.after })),
  };
  return crypto.createHash("sha256").update(JSON.stringify(basis)).digest("hex");
}

/**
 * Plan an install WITHOUT writing: preflight the payload, read the current settings + lockfile fail-closed,
 * compute the merge, and return the diff + the exact hook commands that would run + a consent fingerprint.
 */
export function previewInstall(plugin: LoadedPlugin, workspaceRoot: string, present: ReadonlySet<Runtime>): InstallPreview {
  const { manifest } = plugin;
  const empty = (errors: string[]): InstallPreview => ({ manifest, steps: [], skipped: [], warnings: [], errors, fingerprint: "", payloadHash: "" });

  const payload = preflightPayload(plugin.dir);
  if (payload.errors.length > 0) return empty(payload.errors);

  const lockRead = readLockfile(workspaceRoot);
  if (!lockRead.lockfile) return empty(lockRead.errors);
  const prior = priorClaudeOwned(lockRead.lockfile.plugins[manifest.name]);
  if (prior.errors.length > 0) return empty(prior.errors);

  const compat = resolveCompat(manifest, present);
  const steps: ClaudeInstallStep[] = [];
  const skipped: Runtime[] = [...compat.missingFromWorkspace];
  const warnings: string[] = [];
  const errors: string[] = [];

  for (const rt of compat.installable) {
    if (rt !== "claude") {
      skipped.push(rt);
      warnings.push(`${rt}: not yet wired by the engine (Step 4) — skipped`);
      continue;
    }
    if (!plugin.claudeHooks || !plugin.claudeRootRel) {
      warnings.push("claude: plugin declares claude but carries no hooks — nothing to wire");
      continue;
    }
    const read = readSettings(path.join(workspaceRoot, CLAUDE_SETTINGS_REL));
    if (!read.settings) {
      errors.push(...read.errors);
      continue;
    }
    const merge = mergePluginHooks(read.settings, plugin.claudeHooks, plugin.claudeRootRel, prior.owned);
    if (!merge.settings || !merge.owned) {
      errors.push(...merge.errors.map((e) => `claude: ${e}`));
      continue;
    }
    steps.push({
      runtime: "claude",
      settingsRel: CLAUDE_SETTINGS_REL,
      before: read.settings,
      after: merge.settings,
      owned: merge.owned,
      wiredCommands: collectCommands(merge.owned),
    });
  }

  const fingerprint = errors.length > 0 ? "" : fingerprintOf(plugin, steps, payload.hash);
  return { manifest, steps, skipped, warnings, errors, fingerprint, payloadHash: payload.hash };
}

export interface InstallResult {
  installed: boolean;
  runtimes: Runtime[];
  errors: string[];
}

/**
 * Apply a previewed install. Re-derives the preview from current state and REFUSES if the fingerprint no
 * longer matches (the workspace changed since consent). Writes in transactional order — payload → lockfile →
 * settings — so a mid-failure never leaves live hooks without a lockfile to remove them.
 */
export function applyInstall(plugin: LoadedPlugin, preview: InstallPreview, workspaceRoot: string, present: ReadonlySet<Runtime>): InstallResult {
  if (preview.errors.length > 0) return { installed: false, runtimes: [], errors: preview.errors };

  const fresh = previewInstall(plugin, workspaceRoot, present);
  if (fresh.errors.length > 0) return { installed: false, runtimes: [], errors: fresh.errors };
  if (!fresh.fingerprint || fresh.fingerprint !== preview.fingerprint) {
    return { installed: false, runtimes: [], errors: ["workspace changed since preview — re-preview and re-consent before installing"] };
  }
  if (fresh.steps.length === 0) {
    return { installed: false, runtimes: [], errors: ["nothing to install: no compatible runtime with hooks in this workspace"] };
  }

  const lockRead = readLockfile(workspaceRoot);
  if (!lockRead.lockfile) return { installed: false, runtimes: [], errors: lockRead.errors };
  const lockfile = lockRead.lockfile;

  // Lost-update guard: confirm every settings file still matches the consented snapshot BEFORE any write,
  // so a concurrent edit between consent and apply aborts cleanly (nothing written) rather than being lost.
  for (const step of fresh.steps) {
    if (!settingsUnchanged(path.join(workspaceRoot, step.settingsRel), step.before)) {
      return { installed: false, runtimes: [], errors: ["settings changed since preview — re-preview and re-consent before installing"] };
    }
  }

  const runtimes: Runtime[] = [];
  const targets: MaterializedTarget[] = [];
  for (const step of fresh.steps) {
    for (const [event, groups] of Object.entries(step.owned)) {
      targets.push({ runtime: step.runtime, kind: "settings-hook", file: step.settingsRel, ref: event, removal: groups });
    }
    runtimes.push(step.runtime);
  }

  // 1) payload — copy to STAGING first, then re-preflight + hash-match the COPY against the consented hash
  // (closes the preflight→copy TOCTOU: a source file swapped for a symlink/different content after consent is
  // caught on the staged copy, never promoted). 2) lockfile. 3) settings LAST (activates the hooks).
  const payloadDir = path.join(workspaceRoot, PAYLOAD_ROOT, plugin.manifest.name);
  const staging = `${payloadDir}.staging-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  fs.mkdirSync(path.dirname(payloadDir), { recursive: true });
  fs.cpSync(plugin.dir, staging, { recursive: true, dereference: false });
  const staged = preflightPayload(staging);
  if (staged.errors.length > 0 || staged.hash !== fresh.payloadHash) {
    fs.rmSync(staging, { recursive: true, force: true });
    return { installed: false, runtimes: [], errors: ["plugin payload changed during install — re-preview and re-consent"] };
  }
  fs.rmSync(payloadDir, { recursive: true, force: true });
  fs.renameSync(staging, payloadDir);

  lockfile.plugins[plugin.manifest.name] = { name: plugin.manifest.name, version: plugin.manifest.version, runtimes, targets };
  writeLockfile(workspaceRoot, lockfile);

  for (const step of fresh.steps) writeSettings(path.join(workspaceRoot, step.settingsRel), step.after);

  return { installed: true, runtimes, errors: [] };
}

// ── remove (preview → apply) ────────────────────────────────────────────────

export interface RemovePreview {
  found: boolean;
  /** conservative orphans = recorded groups the user has since edited away (left, never deleted). */
  orphans: number;
  removedCount: number;
  expectedCount: number;
  errors: string[];
}

function planRemove(pluginName: string, workspaceRoot: string): { lockfile?: Lockfile; lock?: PluginLock; owned: OwnedHooks; before: ClaudeSettings; errors: string[] } {
  const lockRead = readLockfile(workspaceRoot);
  if (!lockRead.lockfile) return { owned: {}, before: {}, errors: lockRead.errors };
  const lock = lockRead.lockfile.plugins[pluginName];
  if (!lock) return { lockfile: lockRead.lockfile, owned: {}, before: {}, errors: [] }; // not installed → caller decides
  const prior = priorClaudeOwned(lock);
  if (prior.errors.length > 0) return { lockfile: lockRead.lockfile, lock, owned: {}, before: {}, errors: prior.errors };
  const read = readSettings(path.join(workspaceRoot, CLAUDE_SETTINGS_REL));
  if (!read.settings) return { lockfile: lockRead.lockfile, lock, owned: prior.owned, before: {}, errors: read.errors };
  return { lockfile: lockRead.lockfile, lock, owned: prior.owned, before: read.settings, errors: [] };
}

/** Plan a remove WITHOUT writing — reports how many recorded hooks will be removed vs. left as orphans. */
export function previewRemove(pluginName: string, workspaceRoot: string): RemovePreview {
  const plan = planRemove(pluginName, workspaceRoot);
  if (plan.errors.length > 0) return { found: !!plan.lock, orphans: 0, removedCount: 0, expectedCount: 0, errors: plan.errors };
  if (!plan.lock) return { found: false, orphans: 0, removedCount: 0, expectedCount: 0, errors: [] };
  const r = removePluginHooks(plan.before, plan.owned);
  const removedCount = r.removed ?? 0;
  const expectedCount = r.expected ?? 0;
  return { found: true, orphans: expectedCount - removedCount, removedCount, expectedCount, errors: r.errors };
}

export interface RemoveResult {
  removed: boolean;
  orphans: number;
  errors: string[];
}

/**
 * Remove a plugin: un-merge exactly the recorded hook groups from settings (leaving any user-edited group as
 * a surfaced orphan), delete the committed payload, and drop the lockfile entry. Fail-closed on a corrupt
 * lockfile / malformed removal / unparseable settings (refuses rather than half-removing).
 */
export function applyRemove(pluginName: string, workspaceRoot: string): RemoveResult {
  const plan = planRemove(pluginName, workspaceRoot);
  if (plan.errors.length > 0) return { removed: false, orphans: 0, errors: plan.errors };
  if (!plan.lock || !plan.lockfile) return { removed: false, orphans: 0, errors: [`plugin '${pluginName}' is not installed`] };

  const settingsFile = path.join(workspaceRoot, CLAUDE_SETTINGS_REL);
  // lost-update guard: confirm settings still match the planned snapshot before writing (nothing written yet).
  if (!settingsUnchanged(settingsFile, plan.before)) {
    return { removed: false, orphans: 0, errors: ["settings changed since the remove was planned — retry"] };
  }
  const r = removePluginHooks(plan.before, plan.owned);
  if (!r.settings) return { removed: false, orphans: 0, errors: r.errors };

  // settings first (deactivate hooks), then payload, then the lockfile entry — using the lockfile already
  // parsed in planRemove (no second read that could fail and silently skip the entry deletion).
  writeSettings(settingsFile, r.settings);
  fs.rmSync(path.join(workspaceRoot, PAYLOAD_ROOT, pluginName), { recursive: true, force: true });
  delete plan.lockfile.plugins[pluginName];
  writeLockfile(workspaceRoot, plan.lockfile);

  return { removed: true, orphans: (r.expected ?? 0) - (r.removed ?? 0), errors: [] };
}
