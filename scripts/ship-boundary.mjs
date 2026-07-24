import fsDefault from "node:fs";
import pathDefault from "node:path";
import cryptoDefault from "node:crypto";

const DEV_ARTIFACTS = [
  /^dist\/webview-preview(?:\/|$)/,
  /^dist\/webview\/agent-studio-fixture(?:\.|\/|$)/,
  /\.map$/,
];

const SHIPPED_FILES = [
  /^dist\//,
  /^media\//,
  /^l10n\//,
  /^package\.json$/,
  /^package\.nls(?:\.[^/]+)?\.json$/,
  /^README\.md$/,
  /^LICENSE$/,
  /^provenance\.json$/,
];

export function classifyShipFile(relPath) {
  const normalized = relPath.replaceAll("\\", "/").replace(/^\.\//, "");
  if (DEV_ARTIFACTS.some((pattern) => pattern.test(normalized))) return "dev-artifact";
  if (SHIPPED_FILES.some((pattern) => pattern.test(normalized))) return "allowed";
  return "forbidden";
}

/**
 * t-05a0b0 — the engine manifest is written at build time, but the pack tree is pruned afterwards
 * by the ship boundary. The installed engine verifies the manifest fail-closed, so a manifest that
 * references a pruned/altered file ships a VSIX that can never activate (0.56.102: staged
 * companion-mobile app.js.map). Every manifest entry must survive the prune byte-identical.
 *
 * @param {string} engineDir absolute path of the post-prune dist/engine tree vsce will pack
 * @param {{ files: Array<{ path: string, sha256: string }> }} manifest parsed engine-manifest.json
 * @returns {string[]} violations, empty when the manifest is closed over the pack tree
 */
export function engineManifestClosureViolations(engineDir, manifest, deps = {}) {
  const fs = deps.fs ?? fsDefault;
  const crypto = deps.crypto ?? cryptoDefault;
  const violations = [];
  for (const entry of manifest.files ?? []) {
    const abs = pathDefault.join(engineDir, entry.path);
    let data;
    try {
      data = fs.readFileSync(abs);
    } catch {
      violations.push(`${entry.path}: missing from the pack tree (pruned or never staged)`);
      continue;
    }
    const sha = crypto.createHash("sha256").update(data).digest("hex");
    if (sha !== entry.sha256) violations.push(`${entry.path}: sha256 mismatch vs manifest`);
  }
  return violations;
}
