import fs from "node:fs";
import path from "node:path";
import { contained } from "../files/contained.js";
import { extractZipContained } from "../files/extractZip.js";

const APP_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

export interface InstalledApp {
  id: string;
  title: string;
  icon: string;
  entry: string;
  root: string;
  /** 514 — actions this app offers on its launcher tile; empty when it declares none. */
  actions: AppDeclaredAction[];
}

/**
 * One action an app puts on its own tile.
 *
 * The id is the app's vocabulary, not ours: it travels back to the page when the human picks it, and
 * Tachyon never interprets it. The icon is a codicon name because the MENU is Tachyon's chrome — an
 * app draws its own page, not our menu rows.
 */
export interface AppDeclaredAction {
  id: string;
  label: string;
  icon: string;
}

export type AppValidationResult =
  | { ok: true; app: InstalledApp }
  | { ok: false; errors: string[] };

export interface InstalledAppCatalog {
  apps: InstalledApp[];
  warnings: string[];
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function containedField(root: string, value: unknown, field: "icon" | "entry", errors: string[]): string | undefined {
  if (typeof value !== "string" || value.length === 0 || !contained(root, value)) {
    errors.push(`${field}: must be a contained relative path`);
    return undefined;
  }
  return value;
}

/** Validate one app.json value against its already-extracted directory. Every diagnostic names its field. */
export function validateAppManifest(appRoot: string, value: unknown): AppValidationResult {
  const manifest = record(value);
  if (!manifest) return { ok: false, errors: ["app.json: must contain an object"] };

  const errors: string[] = [];
  const id = manifest.id;
  if (typeof id !== "string" || !APP_ID.test(id)) errors.push("id: must be lowercase kebab-case");
  const title = manifest.title;
  if (typeof title !== "string" || title.trim().length === 0) errors.push("title: must be a non-empty string");
  const icon = containedField(appRoot, manifest.icon, "icon", errors);
  const entry = containedField(appRoot, manifest.entry, "entry", errors);

  if (entry) {
    try {
      if (!fs.statSync(contained(appRoot, entry)!).isFile()) errors.push("entry: must name an existing file");
    } catch {
      errors.push("entry: must name an existing file");
    }
  }

  const actions = parseDeclaredActions(manifest.actions, errors);

  if (errors.length > 0 || typeof id !== "string" || typeof title !== "string" || !icon || !entry) {
    return { ok: false, errors };
  }
  return { ok: true, app: { id, title, icon, entry, root: path.resolve(appRoot), actions } };
}

const ACTION_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const CODICON = /^[a-z][a-z0-9-]*$/;
const MAX_ACTIONS = 12;

/**
 * The optional `actions` block, validated by the same rule as every other field: an error NAMES what
 * is wrong, and a malformed block fails the app rather than being silently dropped — a tile that
 * quietly lost its actions is indistinguishable from an app that never declared any.
 *
 * The cap is not arithmetic taste. A context menu that scrolls has stopped being a context menu, and
 * every reference on the pattern says the same: few, relevant, contextual.
 */
function parseDeclaredActions(raw: unknown, errors: string[]): AppDeclaredAction[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    errors.push("actions: when present, must be a list");
    return [];
  }
  if (raw.length > MAX_ACTIONS) {
    errors.push(`actions: at most ${MAX_ACTIONS} entries`);
    return [];
  }
  const out: AppDeclaredAction[] = [];
  const seen = new Set<string>();
  raw.forEach((entry, index) => {
    const action = record(entry);
    if (!action) { errors.push(`actions[${index}]: must be an object`); return; }
    const id = action.id;
    const label = action.label;
    const icon = action.icon;
    if (typeof id !== "string" || !ACTION_ID.test(id)) { errors.push(`actions[${index}].id: must be lowercase kebab-case`); return; }
    if (id === "open" || id === "uninstall") { errors.push(`actions[${index}].id: '${id}' is reserved by Tachyon`); return; }
    if (seen.has(id)) { errors.push(`actions[${index}].id: '${id}' is listed more than once`); return; }
    if (typeof label !== "string" || label.trim().length === 0 || label.length > 64) { errors.push(`actions[${index}].label: must be a non-empty string`); return; }
    if (typeof icon !== "string" || !CODICON.test(icon)) { errors.push(`actions[${index}].icon: must be a codicon name`); return; }
    seen.add(id);
    out.push({ id, label, icon });
  });
  return out;
}

function readOneApp(appRoot: string): AppValidationResult {
  const manifestPath = path.join(appRoot, "app.json");
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (error) {
    return { ok: false, errors: [`app.json: ${error instanceof Error ? error.message : String(error)}`] };
  }
  return validateAppManifest(appRoot, value);
}

/** Read the disk on every call. A bad catalog row is reported and never hides its valid siblings. */
export function readInstalledApps(workspaceRoot: string): InstalledAppCatalog {
  const appsRoot = path.join(workspaceRoot, ".tachyon", "apps");
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(appsRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { apps: [], warnings: [] };
    return { apps: [], warnings: [`apps: cannot read ${appsRoot}: ${error instanceof Error ? error.message : String(error)}`] };
  }

  const apps: InstalledApp[] = [];
  const warnings: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const result = readOneApp(path.join(appsRoot, entry.name));
    if (result.ok) apps.push(result.app);
    else warnings.push(`${entry.name}: ${result.errors.join("; ")}`);
  }
  return { apps, warnings };
}

/**
 * Install an app tree from zip. This is intentionally distinct from spec 265's pinned-binary extractor:
 * that path requires innerPath/binSha256 and materializes one executable; an app is an unhashed file tree.
 */
export async function installAppZip(workspaceRoot: string, zipPath: string): Promise<InstalledApp> {
  const tachyonRoot = path.join(workspaceRoot, ".tachyon");
  fs.mkdirSync(tachyonRoot, { recursive: true });
  const staging = fs.mkdtempSync(path.join(tachyonRoot, ".app-install-"));
  try {
    await extractZipContained(zipPath, staging, "app");
    const parsed = readOneApp(staging);
    if (!parsed.ok) throw new Error(parsed.errors.join("; "));

    const appsRoot = path.join(tachyonRoot, "apps");
    fs.mkdirSync(appsRoot, { recursive: true });
    const target = path.join(appsRoot, parsed.app.id);
    const backup = path.join(tachyonRoot, `.app-backup-${parsed.app.id}-${process.pid}-${Date.now()}`);
    const replacing = fs.existsSync(target);
    if (replacing) fs.renameSync(target, backup);
    try {
      fs.renameSync(staging, target);
    } catch (error) {
      if (replacing) fs.renameSync(backup, target);
      throw error;
    }
    if (replacing) fs.rmSync(backup, { recursive: true, force: true });
    return { ...parsed.app, root: target };
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

/** One archive the human could install from, as the picker needs it. */
export interface AppZipCandidate {
  path: string;
  name: string;
  dir: string;
  mtimeMs: number;
}

/** Where an app archive plausibly sits. Ordered: the project first, then the human's usual landings. */
export function appZipSearchRoots(workspaceRoot: string, home: string, tmp: string): string[] {
  return [
    workspaceRoot,
    path.join(home, "Downloads"),
    path.join(home, "Desktop"),
    tmp,
  ];
}

/**
 * 514 — the archives the product's own picker offers.
 *
 * A BOUNDED scan, not a filesystem browser: depth and count are capped, and the noisy trees every
 * project carries are skipped. The point is to hand the picker a candidate set it can filter — the
 * same shape every other QuickPicker in this product works with — rather than to reimplement a file
 * dialog in a webview.
 *
 * Newest first, because the archive someone just built or downloaded is the one they mean.
 */
export function findAppZipCandidates(roots: readonly string[], limit = 200, maxDepth = 6): AppZipCandidate[] {
  const skip = new Set([".git", "node_modules", ".vscode-server", "dist", "out", ".cache"]);
  const seen = new Set<string>();
  const found: AppZipCandidate[] = [];
  const walk = (dir: string, depth: number): void => {
    if (found.length >= limit || depth > maxDepth) return;
    let real: string;
    try { real = fs.realpathSync(dir); } catch { return; }
    if (seen.has(real)) return; // a symlink loop is a hang, and a hang here is a picker that never opens
    seen.add(real);
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (found.length >= limit) return;
      const child = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (skip.has(entry.name)) continue;
        walk(child, depth + 1);
        continue;
      }
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".zip")) continue;
      let stat: fs.Stats;
      try { stat = fs.statSync(child); } catch { continue; }
      found.push({ path: child, name: entry.name, dir: path.dirname(child), mtimeMs: stat.mtimeMs });
    }
  };
  for (const root of roots) walk(root, 0);
  const unique = new Map(found.map((entry) => [entry.path, entry]));
  return [...unique.values()].sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** One row of the app picker's directory view. */
export interface AppBrowseEntry {
  name: string;
  path: string;
  kind: "dir" | "zip";
}

export interface AppBrowseListing {
  dir: string;
  /** the parent directory, or undefined at the filesystem root. */
  parent?: string;
  entries: AppBrowseEntry[];
  /** why the listing is empty, when it is not simply empty. */
  error?: string;
}

/**
 * 514 — one directory, as a picker needs to draw it.
 *
 * Directories first, then archives, both alphabetical — the order every file picker uses, because a
 * human scanning a narrow list is looking for a folder to enter or a file to take, in that order.
 * Hidden entries are skipped unless the human typed a path into one: `.tachyon`, `.git` and their
 * kind are noise in a chooser, but a path someone deliberately entered is not noise.
 *
 * An unreadable directory answers with a REASON rather than an empty list. "Nothing here" and
 * "permission denied" look identical in a list and are not the same fact.
 */
export function browseForAppZip(dir: string, limit = 500): AppBrowseListing {
  const resolved = path.resolve(dir);
  const parent = path.dirname(resolved);
  const listing: AppBrowseListing = {
    dir: resolved,
    ...(parent !== resolved ? { parent } : {}),
    entries: [],
  };
  let raw: fs.Dirent[];
  try {
    raw = fs.readdirSync(resolved, { withFileTypes: true });
  } catch (error) {
    return { ...listing, error: error instanceof Error ? error.message : String(error) };
  }
  const dirs: AppBrowseEntry[] = [];
  const zips: AppBrowseEntry[] = [];
  for (const entry of raw) {
    if (entry.name.startsWith(".")) continue;
    const full = path.join(resolved, entry.name);
    let stat: fs.Stats;
    try { stat = fs.statSync(full); } catch { continue; } // a broken link is not a choice
    if (stat.isDirectory()) dirs.push({ name: entry.name, path: full, kind: "dir" });
    else if (stat.isFile() && entry.name.toLowerCase().endsWith(".zip")) zips.push({ name: entry.name, path: full, kind: "zip" });
  }
  const byName = (a: AppBrowseEntry, b: AppBrowseEntry): number => a.name.localeCompare(b.name);
  listing.entries = [...dirs.sort(byName), ...zips.sort(byName)].slice(0, limit);
  return listing;
}

export interface AppUninstallResult {
  /** the app that was removed, as the catalog last knew it (undefined when nothing was there). */
  removed?: InstalledApp;
  /** absolute paths this uninstall deleted. */
  paths: string[];
}

/**
 * 514 — remove an installed app and the runtime artifacts that are ITS.
 *
 * The owner's rule, and it is a line worth stating: what the app CREATED is not the app's. If it made
 * tasks, the tasks are Tachyon's; if it spawned a squad, the agents are Tachyon's. Uninstalling takes
 * the app away, never the work that happened through it — so this deletes the app's own directory and
 * nothing else, and the confirmation the human sees says exactly that.
 *
 * Idempotent: removing an app that is already gone is not an error, it is the desired state.
 */
export function uninstallApp(workspaceRoot: string, id: string): AppUninstallResult {
  if (!APP_ID.test(id)) throw new Error(`app id '${id}' is not a valid app id`);
  const root = path.join(workspaceRoot, ".tachyon", "apps", id);
  const parsed = readOneApp(root);
  if (!fs.existsSync(root)) return { paths: [] };
  fs.rmSync(root, { recursive: true, force: true });
  return { ...(parsed.ok ? { removed: parsed.app } : {}), paths: [root] };
}
