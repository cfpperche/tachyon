/**
 * 514/515 — finding and browsing `.zip` files, for the product's own picker.
 *
 * Written for apps and moved here when plugins grew the same door. Nothing in these bodies was ever
 * about apps: they find archives, they list a directory, and the caller decides what an archive means.
 * Leaving them behind an `App` name would have meant the plugins panel importing from `apps/`, which
 * reads as a dependency that does not exist.
 *
 * This module is what makes "use the product's picker, not the host's" affordable. The rule is the
 * owner's and it is a rule, not a preference: a native dialog is a different window with a different
 * theme, different keyboard, and no idea what a plugin archive is. The picker these functions feed
 * lives inside the panel, starts from the archives already lying around, and browses from there.
 */
import fs from "node:fs";
import path from "node:path";
import { zipPayloadKind, type ZipPayloadKind } from "./zipEntries.js";

/** One archive the human could install from, as the picker needs it. */
export interface ZipCandidate {
  path: string;
  name: string;
  dir: string;
  mtimeMs: number;
}

/** Where an archive plausibly sits. Ordered: the project first, then the human's usual landings. */
export function zipSearchRoots(workspaceRoot: string, home: string, tmp: string): string[] {
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
 * project carries are skipped.
 *
 * 515 — `wanted` is what the door installs, and passing it is what stops an APP package from being
 * offered where plugins install. The check reads each candidate's central directory, which costs the
 * tail of the file rather than the file, so a scan that already walked the disk does not become
 * expensive for asking what it found. The point is to hand the picker a candidate set it can filter — the
 * same shape every other QuickPicker in this product works with — rather than to reimplement a file
 * dialog in a webview.
 *
 * Newest first, because the archive someone just built or downloaded is the one they mean.
 */
export function findZipCandidates(
  roots: readonly string[],
  limit = 200,
  maxDepth = 6,
  wanted?: ZipPayloadKind,
): ZipCandidate[] {
  const skip = new Set([".git", "node_modules", ".vscode-server", "dist", "out", ".cache"]);
  const seen = new Set<string>();
  const found: ZipCandidate[] = [];
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
  const all = [...unique.values()].sort((a, b) => b.mtimeMs - a.mtimeMs);
  if (!wanted) return all;
  // An archive is dropped only when it was MEASURED to be something else. One that could not be read
  // stays: hiding a real plugin because its archive was unusual would be an unmeasured "no" dressed as
  // a measured one, and the door still validates properly when the human picks it.
  return all.filter((entry) => {
    const kind = zipPayloadKind(entry.path);
    return kind === undefined || kind === wanted;
  });
}

/** One row of the picker's directory view. */
export interface ZipBrowseEntry {
  name: string;
  path: string;
  kind: "dir" | "zip";
}

export interface ZipBrowseListing {
  dir: string;
  /** the parent directory, or undefined at the filesystem root. */
  parent?: string;
  entries: ZipBrowseEntry[];
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
export function browseForZip(dir: string, limit = 500): ZipBrowseListing {
  const resolved = path.resolve(dir);
  const parent = path.dirname(resolved);
  const listing: ZipBrowseListing = {
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
  const dirs: ZipBrowseEntry[] = [];
  const zips: ZipBrowseEntry[] = [];
  for (const entry of raw) {
    if (entry.name.startsWith(".")) continue;
    const full = path.join(resolved, entry.name);
    let stat: fs.Stats;
    try { stat = fs.statSync(full); } catch { continue; } // a broken link is not a choice
    if (stat.isDirectory()) dirs.push({ name: entry.name, path: full, kind: "dir" });
    else if (stat.isFile() && entry.name.toLowerCase().endsWith(".zip")) zips.push({ name: entry.name, path: full, kind: "zip" });
  }
  const byName = (a: ZipBrowseEntry, b: ZipBrowseEntry): number => a.name.localeCompare(b.name);
  listing.entries = [...dirs.sort(byName), ...zips.sort(byName)].slice(0, limit);
  return listing;
}
