/**
 * t-06a542 — keep dist/webview/chunks aligned with what cockpit.js can actually load.
 *
 * esbuild content-hashed `chunks/cockpit-[name]-[hash].js` files accumulate across rebuilds when
 * the directory is not wiped: 0.56.110 shipped 134 `cockpit-App-*.js` (~9.7 MB) while cockpit.js
 * only referenced ~24. That is package bloat and artifact-diff noise, not a runtime correctness
 * bug — but packaging must not ship unreachable chunks.
 *
 * Reachability is a BFS over static `chunks/<basename>` references starting at cockpit.js (and any
 * other ESM entry that may import the same chunk tree). Dynamic import URLs in the esbuild output
 * still contain the chunk path as a string, so a simple path scan is enough.
 */

import fs from "node:fs";
import path from "node:path";

// Entry (cockpit.js) imports as `./chunks/cockpit-….js`; chunk-to-chunk imports are
// same-directory `./cockpit-….js`. Both must seed the graph or shared helpers look "stale".
const CHUNK_REF_RE = /(?:chunks\/|\.\/)(cockpit-[A-Za-z0-9_.-]+\.js)/g;

/**
 * @param {string} webviewDir absolute or cwd-relative path to dist/webview
 * @param {string[]} entryFiles basenames under webviewDir that seed the graph (default cockpit.js)
 * @returns {Set<string>} basenames under chunks/ that are reachable
 */
export function reachableWebviewChunkBasenames(webviewDir, entryFiles = ["cockpit.js"]) {
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
 * Fail closed at package time if any chunk on disk is not reachable from the cockpit entry graph.
 * @param {string} webviewDir
 */
export function assertWebviewChunksReachable(webviewDir) {
  const chunksDir = path.join(webviewDir, "chunks");
  if (!fs.existsSync(chunksDir)) return;

  const onDisk = fs.readdirSync(chunksDir).filter((name) => name.endsWith(".js") && !name.startsWith("."));
  if (onDisk.length === 0) return;

  const entry = path.join(webviewDir, "cockpit.js");
  if (!fs.existsSync(entry)) {
    throw new Error(
      `webview chunk audit: dist/webview/chunks has ${onDisk.length} file(s) but cockpit.js is missing — refuse to package a partial Control shell`,
    );
  }

  const reachable = reachableWebviewChunkBasenames(webviewDir);
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
