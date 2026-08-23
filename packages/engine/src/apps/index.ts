import fs from "node:fs";
import path from "node:path";
import JSZip from "jszip";
import { contained } from "../files/contained.js";

const APP_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

export interface InstalledApp {
  id: string;
  title: string;
  icon: string;
  entry: string;
  root: string;
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

  if (errors.length > 0 || typeof id !== "string" || typeof title !== "string" || !icon || !entry) {
    return { ok: false, errors };
  }
  return { ok: true, app: { id, title, icon, entry, root: path.resolve(appRoot) } };
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

async function extractAppZip(zipPath: string, destination: string): Promise<void> {
  const zip = await JSZip.loadAsync(fs.readFileSync(zipPath));
  for (const entry of Object.values(zip.files)) {
    // This containment is hygiene, not a security barrier: an installed app receives unrestricted Bridge
    // access. It prevents a malformed archive from scattering files; it does not sandbox the app.
    const archivePath = entry.unsafeOriginalName ?? entry.name;
    const target = contained(destination, archivePath);
    if (!target) throw new Error(`zip entry path is outside the app directory: ${archivePath}`);
    if (entry.dir) {
      fs.mkdirSync(target, { recursive: true });
      continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, await entry.async("nodebuffer"));
  }
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
    await extractAppZip(zipPath, staging);
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
