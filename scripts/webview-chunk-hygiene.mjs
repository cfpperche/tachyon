/**
 * t-06a542 — keep dist/webview/chunks aligned with what the built app entries can actually load.
 *
 * esbuild content-hashed chunk files accumulate across rebuilds when the directory is not wiped:
 * 0.56.110 shipped 134 `cockpit-App-*.js` (~9.7 MB) while cockpit.js only referenced ~24. That is package
 * bloat and artifact-diff noise, not a runtime correctness bug — but packaging must not ship unreachable
 * chunks.
 *
 * SDD 485 C2 — the graph now has MORE THAN ONE ROOT. The splitting invocation builds one entry per
 * standalone app (`dist/webview/<view>.js`) and the whole point of one invocation is that they SHARE
 * chunks, so reachability seeded from a single hardcoded `cockpit.js` would delete every chunk the other
 * apps need the moment Control stops being the only entry. Two changes follow from that, and neither is
 * cosmetic:
 *
 *  - the roots are DISCOVERED (every top-level `*.js` in the directory) rather than named, so an app added
 *    to the manifest can never be forgotten here — a forgotten root reads as "prune everything it owns";
 *  - a chunk kept alive by ANY entry survives, which is what makes a shared chunk shared.
 *
 * Reachability is a BFS over static `chunks/<basename>` references. Dynamic import URLs in the esbuild
 * output still contain the chunk path as a string, so a simple path scan is enough.
 */

import fs from "node:fs";
import path from "node:path";

/**
 * The chunk filename prefix (`chunkNames: "chunks/app-[name]-[hash]"` in esbuild.mjs). It exists so a chunk
 * reference is unambiguous in minified output: an entry imports `./chunks/app-….js` and a chunk imports its
 * sibling as `./app-….js`, and nothing else in dist/webview is named that way. Before 485 this was
 * `cockpit-`, which named the one entry that existed; the chunks are shared by every app now.
 */
export const WEBVIEW_CHUNK_PREFIX = "app-";

// Entry imports as `./chunks/app-….js`; chunk-to-chunk imports are same-directory `./app-….js`.
// Both must seed the graph or shared helpers look "stale".
const CHUNK_REF_RE = new RegExp(String.raw`(?:chunks\/|\.\/)(${WEBVIEW_CHUNK_PREFIX}[A-Za-z0-9_.-]+\.js)`, "g");

/**
 * The ESM entries that root the graph: every top-level `.js` in the webview dir. Non-splitting IIFE
 * bundles (sidebar, agent-pane, mermaid, …) live there too and simply contribute no chunk references.
 * @param {string} webviewDir
 * @returns {string[]} basenames, sorted
 */
export function webviewEntryFiles(webviewDir) {
  if (!fs.existsSync(webviewDir)) return [];
  return fs.readdirSync(webviewDir)
    .filter((name) => name.endsWith(".js") && !name.startsWith("."))
    .sort();
}

/**
 * @param {string} webviewDir absolute or cwd-relative path to dist/webview
 * @param {string[]} [entryFiles] basenames under webviewDir that seed the graph (default: every top-level .js)
 * @returns {Set<string>} basenames under chunks/ that are reachable
 */
export function reachableWebviewChunkBasenames(webviewDir, entryFiles = webviewEntryFiles(webviewDir)) {
  const chunksDir = path.join(webviewDir, "chunks");
  const reachable = new Set();
  const queue = [];

  const scanText = (text) => {
    CHUNK_REF_RE.lastIndex = 0;
    let match;
    while ((match = CHUNK_REF_RE.exec(text)) !== null) {
      const base = match[1];
      if (!reachable.has(base)) {
        reachable.add(base);
        queue.push(base);
      }
    }
  };

  for (const entry of entryFiles) {
    const file = path.join(webviewDir, entry);
    if (!fs.existsSync(file)) continue;
    scanText(fs.readFileSync(file, "utf8"));
  }

  while (queue.length > 0) {
    const base = queue.pop();
    const file = path.join(chunksDir, base);
    if (!fs.existsSync(file)) continue;
    scanText(fs.readFileSync(file, "utf8"));
  }

  return reachable;
}

/**
 * @param {string} webviewDir
 * @returns {{ kept: string[], pruned: string[] }}
 */
export function pruneUnreachableWebviewChunks(webviewDir) {
  const chunksDir = path.join(webviewDir, "chunks");
  if (!fs.existsSync(chunksDir)) return { kept: [], pruned: [] };

  const names = fs.readdirSync(chunksDir).filter((name) => !name.startsWith("."));
  const onDiskJs = names.filter((name) => name.endsWith(".js"));
  const reachable = reachableWebviewChunkBasenames(webviewDir);
  const kept = [];
  const pruned = [];

  for (const name of onDiskJs) {
    if (reachable.has(name)) {
      kept.push(name);
      continue;
    }
    fs.rmSync(path.join(chunksDir, name), { force: true });
    // Sourcemaps share the content hash; drop them with the orphan JS.
    fs.rmSync(path.join(chunksDir, `${name}.map`), { force: true });
    pruned.push(name);
  }

  // Orphan maps (js already gone, or never paired) must not bloat the package either.
  for (const name of names) {
    if (!name.endsWith(".js.map")) continue;
    const jsName = name.slice(0, -".map".length);
    if (reachable.has(jsName) && fs.existsSync(path.join(chunksDir, jsName))) continue;
    fs.rmSync(path.join(chunksDir, name), { force: true });
    if (!pruned.includes(jsName)) pruned.push(name);
  }

  return { kept: kept.sort(), pruned: pruned.sort() };
}

/**
 * Fail closed at package time if any chunk on disk is not reachable from a built entry.
 * @param {string} webviewDir
 */
export function assertWebviewChunksReachable(webviewDir) {
  const chunksDir = path.join(webviewDir, "chunks");
  if (!fs.existsSync(chunksDir)) return;

  const onDisk = fs.readdirSync(chunksDir).filter((name) => name.endsWith(".js") && !name.startsWith("."));
  if (onDisk.length === 0) return;

  const entries = webviewEntryFiles(webviewDir);
  if (entries.length === 0) {
    throw new Error(
      `webview chunk audit: dist/webview/chunks has ${onDisk.length} file(s) but no top-level app entry (*.js) exists — refuse to package a partial webview build`,
    );
  }

  const reachable = reachableWebviewChunkBasenames(webviewDir, entries);
  const stale = onDisk.filter((name) => !reachable.has(name)).sort();
  if (stale.length === 0) return;

  const sample = stale.slice(0, 8).join(", ");
  const more = stale.length > 8 ? ` (+${stale.length - 8} more)` : "";
  throw new Error(
    `webview chunk audit: ${stale.length} unreferenced file(s) under dist/webview/chunks ` +
      `(reachable ${reachable.size} of ${onDisk.length}). Sample: ${sample}${more}. ` +
      `Rebuild with a clean chunks dir (esbuild wipes it) or run pruneUnreachableWebviewChunks before package.`,
  );
}
