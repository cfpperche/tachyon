import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { classifyShipFile } from "./ship-boundary.mjs";
import { assertPackageTreeClean } from "./package-clean-gate.mjs";

const root = process.cwd();
const dist = path.join(root, "dist");

// The installed engine rejects dirty manifests. Fail before pruning or recording provenance so a
// guaranteed-broken VSIX never reaches a user.
assertPackageTreeClean(root);

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(file) : [file];
  });
}

if (!fs.existsSync(dist)) throw new Error("dist/ does not exist; build before preparing the package");

for (const file of walk(dist)) {
  const rel = path.relative(root, file).split(path.sep).join("/");
  if (classifyShipFile(rel) !== "allowed") {
    fs.rmSync(file);
    console.log(`pruned ${rel}`);
  }
}

// Provenance must describe the post-prune dist tree: exactly the bits vsce will ship.
execFileSync(process.execPath, ["scripts/record-provenance.mjs", "embed"], { cwd: root, stdio: "inherit" });
