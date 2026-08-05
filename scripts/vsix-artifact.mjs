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
 * Four checks, all against bytes inside the zip:
 *   1. every `dist/` file the build CLAIMED (the embedded provenance record) is present, unchanged;
 *   2. every file the engine manifest promises is present, unchanged -- the 0.56.102 failure exactly;
 *   3. no source map ships inside the engine payload;
 *   4. everything the packaged code loads, and everything its manifest names, is inside the package.
 *
 * Pure enough to test: it takes a path and the claims, returns problems, and never exits the process.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { packageClosureViolations } from "./package-closure.mjs";

const ENGINE_REL = "dist/engine";

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

    // 4. t-09a462, then t-e0a0f5 — an `external` is a promise that the module is there at RUNTIME.
    // Nothing verified it, so node-pty was declared, marked external, required, and never packaged:
    // the agent pane could not attach in any installed build, and the build had no reason to fail.
    //
    // This check used to compare EVERY bare `require` in dist/extension.js against the package, and
    // that was worse than useless — measured on both real release artifacts, it refused 0.57.0 AND
    // 0.57.1 over `bufferutil` and `utf-8-validate`, which are ws's optional native speedups and
    // belong in no VSIX. An audit that refuses every healthy release is an audit nobody runs, and
    // `.tachyon/deploys/` proves it: no 0.57.x has a record. Meanwhile it missed the defect that
    // actually shipped, because `ws` was reached through a dynamic `import(...)` and not a `require`.
    //
    // `package-closure.mjs` replaces it by attributing each import to the module that WROTE it: ours
    // must resolve inside the package, a library's optional load is the library's business. It covers
    // the original node-pty case, the dynamic-import case, and every other node bundle in the package
    // rather than the extension entry point alone.
    const closure = packageClosureViolations(ext);
    checked += 1;
    problems.push(...closure);

    return { ok: problems.length === 0, checked, problems };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
