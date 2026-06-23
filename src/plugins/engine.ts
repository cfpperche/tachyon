/**
 * spec 250 Step 3-4 — the plugin materialization engine (I/O), runtime-generic. Reads a plugin from disk,
 * plans an install (a READ-ONLY preview = the security surface shown before consent), applies it (writes each
 * runtime's config + copies the payload + records the lockfile), and reverses it on remove (un-merging exactly
 * what was written + surfacing conservative orphans). Wires every runtime the plugin declares AND the
 * workspace has, dispatching through a per-runtime adapter registry (claude + codex in v1).
 *
 * Trust + safety model (per the Step-3 review):
 *  - TWO-PHASE: preview* never write; apply* re-derive the preview and refuse if the workspace changed since
 *    consent (a `fingerprint` TOCTOU guard), plus a per-file lost-update check before each write.
 *  - FAIL-CLOSED reads: a corrupt lockfile or unparseable settings is an ERROR (never silently empty).
 *  - UNTRUSTED payload: preflighted (no symlinks/special files; bounded) AND re-checked on a STAGED copy
 *    against the consented hash before promotion (closes the preflight→copy TOCTOU).
 *  - TRANSACTIONAL install order: payload → lockfile → settings (settings activates hooks last).
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { loadManifest, resolveCompat, type PluginManifest, type Runtime } from "./manifest.js";
import {
  mergeHooks,
  removeHooks,
  parseOwnedHooks,
  normalizeHookSettings,
  type HooksBlock,
  type HookSettings,
  type OwnedHooks,
  type BlockParseResult,
} from "./adapters/hooks.js";
import { parseClaudeHooksBlock } from "./adapters/claude.js";
import { parseCodexHooksBlock } from "./adapters/codex.js";
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
const PAYLOAD_ROOT = ".tachyon/plugins";

const MAX_PAYLOAD_BYTES = 50 * 1024 * 1024; // 50 MB
const MAX_PAYLOAD_FILES = 5000;
const MAX_PAYLOAD_DEPTH = 32;

/** Per-runtime materialization spec: where its hook config lives + how to parse its native block. */
interface AdapterSpec {
  settingsRel: string;
  parseBlock: (raw: string) => BlockParseResult;
}
const ADAPTERS: Record<Runtime, AdapterSpec> = {
  claude: { settingsRel: ".claude/settings.json", parseBlock: parseClaudeHooksBlock },
  codex: { settingsRel: ".codex/hooks.json", parseBlock: parseCodexHooksBlock },
};

// ── fs helpers ──────────────────────────────────────────────────────────────

interface FileRead {
  text?: string;
  /** true ONLY for ENOENT — a genuinely absent file. Any other error (EACCES/EISDIR/…) is `error`, not absent. */
  missing: boolean;
  error?: string;
}

/** Read a file, distinguishing genuine absence (ENOENT) from an unreadable-but-present file (fail-closed). */
function readFile(file: string): FileRead {
  try {
    return { text: fs.readFileSync(file, "utf8"), missing: false };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { missing: true };
    return { missing: false, error: `${code ?? "read error"}: ${e instanceof Error ? e.message : String(e)}` };
  }
}

function atomicWrite(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

function writeSettings(file: string, settings: HookSettings): void {
  if (Object.keys(settings).length > 0) atomicWrite(file, `${JSON.stringify(settings, null, 2)}\n`);
  else fs.rmSync(file, { force: true });
}

interface SettingsRead {
  settings?: HookSettings;
  errors: string[];
}

/** Read a runtime's hook config fail-closed: absent → `{}`; unreadable or invalid → ERROR. */
function readSettings(file: string): SettingsRead {
  const rd = readFile(file);
  if (rd.error) return { errors: [`${path.basename(file)}: ${rd.error}`] };
  if (rd.missing) return { settings: {}, errors: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(rd.text as string);
  } catch {
    return { errors: [`${path.basename(file)}: invalid JSON — refusing to overwrite a broken config file`] };
  }
  return normalizeHookSettings(parsed);
}

/** True iff the on-disk config still equals the snapshot the merge was computed from (lost-update guard). */
function settingsUnchanged(file: string, expected: HookSettings): boolean {
  const r = readSettings(file);
  return !!r.settings && JSON.stringify(r.settings) === JSON.stringify(expected);
}

interface LockfileRead {
  lockfile?: Lockfile;
  errors: string[];
}

/** Read the lockfile fail-closed: absent → empty; unreadable or corrupt → ERROR. */
function readLockfile(workspaceRoot: string): LockfileRead {
  const rd = readFile(path.join(workspaceRoot, LOCKFILE_REL_PATH));
  if (rd.error) return { errors: [`${LOCKFILE_REL_PATH}: ${rd.error}`] };
  if (rd.missing) return { lockfile: emptyLockfile(), errors: [] };
  const { lockfile, errors } = parseLockfile(rd.text as string);
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

/** Walk an untrusted plugin dir BEFORE copying: reject symlinks/special files, bound bytes/files/depth, and
 *  accumulate a deterministic content hash (used in the install fingerprint + the staged-copy re-check). */
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
        bytes += fs.statSync(p).size;
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
  /** per-runtime parsed hooks block (one per declared runtime). */
  blocks: Partial<Record<Runtime, HooksBlock>>;
  /** per-runtime posix payload root (relative to a workspace). */
  rootRel: Partial<Record<Runtime, string>>;
}

export interface LoadResult {
  plugin?: LoadedPlugin;
  errors: string[];
}

/** Read + validate a plugin directory (manifest + each declared runtime's block hooks). Fail-closed. */
export function loadPlugin(pluginDir: string): LoadResult {
  const manifestRead = readFile(path.join(pluginDir, MANIFEST_REL));
  if (manifestRead.error) return { errors: [`${MANIFEST_REL}: ${manifestRead.error}`] };
  if (manifestRead.missing) return { errors: [`no ${MANIFEST_REL} in ${pluginDir}`] };
  const { manifest, errors } = loadManifest(manifestRead.text as string);
  if (!manifest) return { errors };

  const plugin: LoadedPlugin = { dir: pluginDir, manifest, blocks: {}, rootRel: {} };
  for (const rt of manifest.runtimes) {
    const spec = ADAPTERS[rt];
    const blockRel = manifest.blocks[rt];
    const hooksRead = readFile(path.join(pluginDir, blockRel, HOOKS_FILE));
    if (hooksRead.error) return { errors: [`${rt}/${HOOKS_FILE}: ${hooksRead.error}`] };
    if (hooksRead.missing) return { errors: [`${rt} block '${blockRel}' has no ${HOOKS_FILE}`] };
    const parsed = spec.parseBlock(hooksRead.text as string);
    if (!parsed.hooks) return { errors: parsed.errors.map((e) => `${rt}/${HOOKS_FILE}: ${e}`) };
    plugin.blocks[rt] = parsed.hooks;
    plugin.rootRel[rt] = path.posix.join(PAYLOAD_ROOT, manifest.name, blockRel.replace(/\/+$/, ""));
  }

  return { plugin, errors: [] };
}

// ── lockfile prior-state reconstruction (runtime-keyed) ─────────────────────

interface PriorOwned {
  owned: OwnedHooks;
  errors: string[];
}

/** Reconstruct the OwnedHooks a prior install recorded FOR ONE RUNTIME, re-validating the opaque `removal`
 *  and rejecting duplicate refs. Keyed by {runtime, kind, file, ref}. */
function priorOwned(lock: PluginLock | undefined, runtime: Runtime, settingsRel: string): PriorOwned {
  const owned: OwnedHooks = {};
  const errors: string[] = [];
  const seenRef = new Set<string>();
  if (!lock) return { owned, errors };
  for (const t of lock.targets) {
    if (t.runtime !== runtime || t.kind !== "settings-hook" || t.file !== settingsRel || !t.ref) continue;
    if (seenRef.has(t.ref)) {
      errors.push(`lockfile: duplicate ${runtime} target ref '${t.ref}'`);
      continue;
    }
    seenRef.add(t.ref);
    const parsed = parseOwnedHooks({ [t.ref]: t.removal });
    if (!parsed.owned) {
      errors.push(`lockfile: malformed removal for ${runtime} '${t.ref}': ${parsed.errors.join("; ")}`);
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

export interface InstallStep {
  runtime: Runtime;
  settingsRel: string;
  before: HookSettings;
  after: HookSettings;
  owned: OwnedHooks;
  /** SECURITY surface: the shell commands that will run on hook events once installed. */
  wiredCommands: string[];
}

export interface InstallPreview {
  manifest: PluginManifest;
  steps: InstallStep[];
  /** declared runtimes not installed here: absent from the workspace. */
  skipped: Runtime[];
  warnings: string[];
  errors: string[];
  fingerprint: string;
  payloadHash: string;
}

function fingerprintOf(plugin: LoadedPlugin, steps: InstallStep[], payloadHash: string): string {
  const basis = {
    name: plugin.manifest.name,
    version: plugin.manifest.version,
    payload: payloadHash,
    steps: steps.map((s) => ({ rt: s.runtime, before: s.before, after: s.after })),
  };
  return crypto.createHash("sha256").update(JSON.stringify(basis)).digest("hex");
}

/** Plan an install WITHOUT writing: preflight payload, read each runtime's config + the lockfile fail-closed,
 *  compute the merges, return the diff + wired commands + a consent fingerprint. */
export function previewInstall(plugin: LoadedPlugin, workspaceRoot: string, present: ReadonlySet<Runtime>): InstallPreview {
  const { manifest } = plugin;
  const empty = (errors: string[]): InstallPreview => ({ manifest, steps: [], skipped: [], warnings: [], errors, fingerprint: "", payloadHash: "" });

  const payload = preflightPayload(plugin.dir);
  if (payload.errors.length > 0) return empty(payload.errors);

  const lockRead = readLockfile(workspaceRoot);
  if (!lockRead.lockfile) return empty(lockRead.errors);
  const lock = lockRead.lockfile.plugins[manifest.name];

  const compat = resolveCompat(manifest, present);
  const steps: InstallStep[] = [];
  const skipped: Runtime[] = [...compat.missingFromWorkspace];
  const warnings: string[] = [];
  const errors: string[] = [];

  for (const rt of compat.installable) {
    const spec = ADAPTERS[rt];
    const block = plugin.blocks[rt];
    const rootRel = plugin.rootRel[rt];
    if (!block || !rootRel) {
      warnings.push(`${rt}: plugin declares ${rt} but carries no hooks — nothing to wire`);
      continue;
    }
    const prior = priorOwned(lock, rt, spec.settingsRel);
    if (prior.errors.length > 0) return empty(prior.errors);
    const read = readSettings(path.join(workspaceRoot, spec.settingsRel));
    if (!read.settings) {
      errors.push(...read.errors);
      continue;
    }
    const merge = mergeHooks(read.settings, block, rootRel, prior.owned);
    if (!merge.settings || !merge.owned) {
      errors.push(...merge.errors.map((e) => `${rt}: ${e}`));
      continue;
    }
    steps.push({
      runtime: rt,
      settingsRel: spec.settingsRel,
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

/** Apply a previewed install: re-derive + refuse a stale preview (TOCTOU), then write payload → lockfile →
 *  settings, staging + hash-checking the payload copy and lost-update-checking each settings file first. */
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

  // lost-update guard: every settings file must still match the consented snapshot BEFORE any write.
  for (const step of fresh.steps) {
    if (!settingsUnchanged(path.join(workspaceRoot, step.settingsRel), step.before)) {
      return { installed: false, runtimes: [], errors: [`${step.settingsRel} changed since preview — re-preview and re-consent`] };
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

  // 1) payload — copy to STAGING, re-preflight + hash-match the COPY, then promote (closes preflight→copy TOCTOU).
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

  // 2) lockfile (uninstall identity). 3) settings LAST (activates the hooks). The lockfile records ALL
  // runtimes BEFORE any settings write, so if a later settings write fails the partial state is removable
  // (applyRemove un-merges every recorded runtime, including the one that didn't get activated → no-op there).
  lockfile.plugins[plugin.manifest.name] = { name: plugin.manifest.name, version: plugin.manifest.version, runtimes, targets };
  writeLockfile(workspaceRoot, lockfile);
  for (const step of fresh.steps) {
    try {
      writeSettings(path.join(workspaceRoot, step.settingsRel), step.after);
    } catch (e) {
      return {
        installed: false,
        runtimes: [],
        errors: [`partial install: payload + lockfile recorded, but writing ${step.settingsRel} failed (${e instanceof Error ? e.message : String(e)}) — run remove '${plugin.manifest.name}' to clean up, then retry`],
      };
    }
  }

  return { installed: true, runtimes, errors: [] };
}

// ── remove (preview → apply) ────────────────────────────────────────────────

export interface RemovePreview {
  found: boolean;
  /** conservative orphans across all runtimes = recorded groups the user has since edited away. */
  orphans: number;
  removedCount: number;
  expectedCount: number;
  errors: string[];
}

interface RemoveStep {
  settingsRel: string;
  before: HookSettings;
  owned: OwnedHooks;
}

function planRemove(pluginName: string, workspaceRoot: string): { lockfile?: Lockfile; lock?: PluginLock; steps: RemoveStep[]; errors: string[] } {
  const lockRead = readLockfile(workspaceRoot);
  if (!lockRead.lockfile) return { steps: [], errors: lockRead.errors };
  const lock = lockRead.lockfile.plugins[pluginName];
  if (!lock) return { lockfile: lockRead.lockfile, steps: [], errors: [] };

  const steps: RemoveStep[] = [];
  for (const rt of lock.runtimes) {
    const spec = ADAPTERS[rt];
    const prior = priorOwned(lock, rt, spec.settingsRel);
    if (prior.errors.length > 0) return { lockfile: lockRead.lockfile, lock, steps: [], errors: prior.errors };
    if (Object.keys(prior.owned).length === 0) continue;
    const read = readSettings(path.join(workspaceRoot, spec.settingsRel));
    if (!read.settings) return { lockfile: lockRead.lockfile, lock, steps: [], errors: read.errors };
    steps.push({ settingsRel: spec.settingsRel, before: read.settings, owned: prior.owned });
  }
  return { lockfile: lockRead.lockfile, lock, steps, errors: [] };
}

/** Plan a remove WITHOUT writing — reports recorded-vs-orphan hook counts across all the plugin's runtimes. */
export function previewRemove(pluginName: string, workspaceRoot: string): RemovePreview {
  const plan = planRemove(pluginName, workspaceRoot);
  if (plan.errors.length > 0) return { found: !!plan.lock, orphans: 0, removedCount: 0, expectedCount: 0, errors: plan.errors };
  if (!plan.lock) return { found: false, orphans: 0, removedCount: 0, expectedCount: 0, errors: [] };
  let removedCount = 0;
  let expectedCount = 0;
  for (const step of plan.steps) {
    const r = removeHooks(step.before, step.owned);
    removedCount += r.removed ?? 0;
    expectedCount += r.expected ?? 0;
  }
  return { found: true, orphans: expectedCount - removedCount, removedCount, expectedCount, errors: [] };
}

export interface RemoveResult {
  removed: boolean;
  orphans: number;
  errors: string[];
}

/** Remove a plugin across all its runtimes: un-merge exactly the recorded groups from each runtime's config
 *  (leaving user-edited groups as surfaced orphans), delete the payload, drop the lockfile entry. Fail-closed. */
export function applyRemove(pluginName: string, workspaceRoot: string): RemoveResult {
  const plan = planRemove(pluginName, workspaceRoot);
  if (plan.errors.length > 0) return { removed: false, orphans: 0, errors: plan.errors };
  if (!plan.lock || !plan.lockfile) return { removed: false, orphans: 0, errors: [`plugin '${pluginName}' is not installed`] };

  // lost-update guard for every runtime's config before any write.
  for (const step of plan.steps) {
    if (!settingsUnchanged(path.join(workspaceRoot, step.settingsRel), step.before)) {
      return { removed: false, orphans: 0, errors: [`${step.settingsRel} changed since the remove was planned — retry`] };
    }
  }

  let orphans = 0;
  for (const step of plan.steps) {
    const r = removeHooks(step.before, step.owned);
    if (!r.settings) return { removed: false, orphans: 0, errors: r.errors };
    writeSettings(path.join(workspaceRoot, step.settingsRel), r.settings);
    orphans += (r.expected ?? 0) - (r.removed ?? 0);
  }

  fs.rmSync(path.join(workspaceRoot, PAYLOAD_ROOT, pluginName), { recursive: true, force: true });
  delete plan.lockfile.plugins[pluginName];
  writeLockfile(workspaceRoot, plan.lockfile);

  return { removed: true, orphans, errors: [] };
}
