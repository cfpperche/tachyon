import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { classifyShipFile, engineManifestClosureViolations } from "./ship-boundary.mjs";
import { assertStableBuildSource, assertStableEngineManifest } from "./engine-release-channel.mjs";
import { assertWebviewChunksReachable, pruneUnreachableWebviewChunks } from "./webview-chunk-hygiene.mjs";

const root = process.cwd();
const dist = path.join(root, "dist");

// The installed engine rejects dirty manifests. Fail before pruning or recording provenance so a
// guaranteed-broken VSIX never reaches a user.
const stableSource = assertStableBuildSource(root);

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(file) : [file];
  });
}

if (!fs.existsSync(dist)) throw new Error("dist/ does not exist; build before preparing the package");

const engineManifestPath = path.join(dist, "engine", "engine-manifest.json");
let engineManifest;
try { engineManifest = JSON.parse(fs.readFileSync(engineManifestPath, "utf8")); }
catch (error) { throw new Error(`stable engine manifest is unreadable: ${String(error)}`); }
assertStableEngineManifest(engineManifest, stableSource);

for (const file of walk(dist)) {
  const rel = path.relative(root, file).split(path.sep).join("/");
  if (classifyShipFile(rel) !== "allowed") {
    fs.rmSync(file);
    console.log(`pruned ${rel}`);
  }
}

// t-06a542 — ship-boundary allows every dist/webview/chunks/* file; unreferenced content-hashed
// cockpit chunks must still be removed (or the package is bloated). Prune, then fail closed if any
// remain unreachable so a half-built dist cannot ship.
const webviewDir = path.join(dist, "webview");
const chunkHygiene = pruneUnreachableWebviewChunks(webviewDir);
if (chunkHygiene.pruned.length > 0) {
  console.log(`pruned ${chunkHygiene.pruned.length} unreferenced webview chunk(s)`);
}
assertWebviewChunksReachable(webviewDir);

// t-05a0b0 — the manifest above was written BEFORE the prune. The installed engine verifies it
// fail-closed, so a manifest entry the prune removed (or altered) ships a VSIX that can never
// activate. Fail the package here, deterministically, instead of on the user's Reload Window.
const closureViolations = engineManifestClosureViolations(path.join(dist, "engine"), engineManifest);
if (closureViolations.length > 0) {
  throw new Error(
    `engine manifest is not closed over the pack tree after pruning:\n  ${closureViolations.join("\n  ")}`,
  );
}

// Provenance must describe the post-prune dist tree: exactly the bits vsce will ship.
execFileSync(process.execPath, ["scripts/record-provenance.mjs", "embed"], { cwd: root, stdio: "inherit" });
