/**
 * t-1f425c — audit the BUILT ARTIFACT, never the config that claims to shape it.
 *
 * The dogfood↔product rule (docs/architecture/dogfood-product-boundary.md) had one open row: nothing
 * unpacked the release candidate to enumerate what is actually inside it. That row has an incident
 * behind it. Release 0.56.102 crashed on activation because the engine manifest promised a `.map`
 * file that the ship boundary pruned; every config in the repo said the build was correct, and only
 * unpacking the VSIX would have shown otherwise. The check was then done BY HAND on each release --
 * which is a habit, and habits are what this rule exists to replace.
 *
 * Three checks, all against bytes inside the zip:
 *   1. every `dist/` file the build CLAIMED (the embedded provenance record) is present, unchanged;
 *   2. every file the engine manifest promises is present, unchanged -- the 0.56.102 failure exactly;
 *   3. no source map ships inside the engine payload.
 *
 * Pure enough to test: it takes a path and the claims, returns problems, and never exits the process.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { runtimeExternals, missingExternals } from "./runtime-externals.mjs";

const ENGINE_REL = "dist/engine";
const EXTENSION_BUNDLE = "dist/extension.js";

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/** Every file under `dir`, as paths relative to it (POSIX separators). */
function walk(dir, base = dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full, base) : [path.relative(base, full).split(path.sep).join("/")];
  });
}

/**
 * Unpack `vsixPath` and compare it with what the build claims.
 *
 * @param {string} vsixPath                     the packaged .vsix
 * @param {Record<string,string>} distClaims    `dist/<rel>` -> sha256, from the embedded provenance record
 * @returns {{ ok: boolean, checked: number, problems: string[] }}
 */
export function checkPackagedArtifact(vsixPath, distClaims = {}) {
  const problems = [];
  let checked = 0;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-vsix-audit-"));
  try {
    try {
      execFileSync("unzip", ["-q", "-o", vsixPath, "-d", tmp], { stdio: ["ignore", "ignore", "pipe"] });
    } catch (error) {
      return { ok: false, checked: 0, problems: [`cannot unpack ${path.basename(vsixPath)}: ${error.message}`] };
    }
    const ext = path.join(tmp, "extension");
    if (!fs.existsSync(ext)) return { ok: false, checked: 0, problems: ["the vsix has no extension/ directory"] };

    // 1. the claimed dist tree is really in there, byte for byte.
    for (const [rel, expected] of Object.entries(distClaims)) {
      checked += 1;
      const file = path.join(ext, rel);
      if (!fs.existsSync(file)) { problems.push(`claimed but ABSENT from the vsix: ${rel}`); continue; }
      const actual = sha256(file);
      if (actual !== expected) problems.push(`bytes differ from the claim: ${rel} (claimed ${expected.slice(0, 12)}…, packaged ${actual.slice(0, 12)}…)`);
    }

    // 2. the engine manifest is a PROMISE to the activation path; an unkept one is a crash (0.56.102).
    const manifestFile = path.join(ext, ENGINE_REL, "engine-manifest.json");
    if (fs.existsSync(manifestFile)) {
      let manifest;
      try { manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8")); } catch (e) { manifest = undefined; problems.push(`engine-manifest.json is not valid JSON: ${e.message}`); }
      for (const entry of manifest?.files ?? []) {
        const rel = typeof entry === "string" ? entry : entry?.path;
        if (!rel) continue;
        checked += 1;
        const file = path.join(ext, ENGINE_REL, rel);
        if (!fs.existsSync(file)) { problems.push(`engine manifest promises a file the vsix does not contain: ${ENGINE_REL}/${rel}`); continue; }
        const expected = typeof entry === "object" ? entry.sha256 : undefined;
        if (expected && sha256(file) !== expected) problems.push(`engine manifest hash mismatch: ${ENGINE_REL}/${rel}`);
      }
    } else if (Object.keys(distClaims).some((rel) => rel.startsWith(`${ENGINE_REL}/`))) {
      problems.push(`the build claims ${ENGINE_REL}/ files but the vsix has no engine-manifest.json`);
    }

    // 3. source maps inside the engine payload are dev weight in a user install.
    for (const rel of walk(path.join(ext, ENGINE_REL))) {
      if (rel.endsWith(".map")) problems.push(`source map inside the engine payload: ${ENGINE_REL}/${rel}`);
    }

    // 4. t-09a462 — an `external` is a promise that the module is there at RUNTIME. Nothing verified
    // it, so node-pty was declared, marked external, required, and never packaged: the agent pane
    // could not attach in any installed build, and the build had no reason to fail. Read what the
    // BUILT bundle emits rather than the esbuild config — the config is the claim, the bundle is the
    // result.
    const bundle = path.join(ext, EXTENSION_BUNDLE);
    if (fs.existsSync(bundle)) {
      const externals = runtimeExternals(bundle);
      checked += externals.length;
      for (const pkg of missingExternals(externals, ext)) {
        problems.push(`the bundle requires '${pkg}' at runtime but the vsix does not contain it`);
      }
    }

    return { ok: problems.length === 0, checked, problems };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
