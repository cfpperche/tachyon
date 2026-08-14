/**
 * t-d8e772 — validate a plugin package with THE parser that will load it, from outside Tachyon.
 *
 * The gap this closes: a plugin author could commit, tag and publish a `tachyon-plugin.json` that
 * Tachyon refuses to load, and nothing said so until a human tried to install it. verify-gate v1.0.0
 * shipped that way — it declared the parser's OUTPUT shape (`{kind, path}`) instead of its input
 * contract (`{leaf}`) — and was uninstallable in every environment.
 *
 * The plugins repository has no Node toolchain and Tachyon is not on npm, so the author's side cannot
 * import the parser. This entry is bundled to a standalone `dist/plugin-validate.cjs` (same treatment
 * the tool/data/external resolvers already get) so any checkout can run it with plain `node`.
 *
 * It deliberately re-exports NOTHING and reimplements NOTHING: it calls `loadManifest`, the same
 * function `loadPlugin` uses. A second copy of the schema would drift, and a drifting validator is
 * worse than none — it would report green while the real loader refuses.
 *
 *   node dist/plugin-validate.cjs <plugin-dir> [more-dirs...]
 *
 * Exit 0 = every package loads. Exit 1 = at least one does not, with the parser's own errors. A
 * directory without a manifest is an ERROR, not a skip: silence for a missing file is how a validator
 * ends up proving nothing.
 */

import fs from "node:fs";
import path from "node:path";
import { loadManifest } from "@tachyon/engine/plugins/manifest.js";

const MANIFEST = "tachyon-plugin.json";

interface Report {
  dir: string;
  ok: boolean;
  name?: string;
  version?: string;
  errors: string[];
}

export function validatePluginDir(dir: string): Report {
  const file = path.join(dir, MANIFEST);
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (e) {
    const why = (e as NodeJS.ErrnoException).code === "ENOENT" ? "no manifest" : (e as Error).message;
    return { dir, ok: false, errors: [`${MANIFEST}: ${why}`] };
  }
  const res = loadManifest(raw) as { manifest?: { name?: string; version?: string }; errors?: string[] };
  const errors = res.errors ?? [];
  if (errors.length > 0 || !res.manifest) {
    return { dir, ok: false, errors: errors.length > 0 ? errors : ["manifest did not load"] };
  }
  // A declared leaf that is not in the package is a manifest that lies: the loader resolves it later,
  // in an environment where the fix is a republish rather than an edit.
  const missing: string[] = [];
  const hooks = (JSON.parse(raw) as { gitHooks?: Record<string, { leaf?: string }> }).gitHooks ?? {};
  for (const [event, decl] of Object.entries(hooks)) {
    if (typeof decl?.leaf === "string" && !fs.existsSync(path.join(dir, decl.leaf))) {
      missing.push(`gitHooks.${event}.leaf: '${decl.leaf}' is declared but absent from the package`);
    }
  }
  if (missing.length > 0) return { dir, ok: false, name: res.manifest.name, version: res.manifest.version, errors: missing };
  return { dir, ok: true, name: res.manifest.name, version: res.manifest.version, errors: [] };
}

function main(argv: string[]): number {
  const dirs = argv.filter((a) => !a.startsWith("-"));
  if (dirs.length === 0) {
    process.stderr.write("usage: plugin-validate <plugin-dir> [more-dirs...]\n");
    return 2;
  }
  let bad = 0;
  for (const dir of dirs) {
    const r = validatePluginDir(dir);
    if (r.ok) {
      process.stdout.write(`ok    ${r.name}@${r.version}  (${r.dir})\n`);
    } else {
      bad += 1;
      process.stderr.write(`FAIL  ${r.dir}\n`);
      for (const e of r.errors) process.stderr.write(`        ${e}\n`);
    }
  }
  if (bad > 0) {
    process.stderr.write(`\n${bad} of ${dirs.length} plugin package(s) would be REFUSED by Tachyon.\n`);
    return 1;
  }
  process.stdout.write(`${dirs.length} plugin package(s) load through Tachyon's own parser.\n`);
  return 0;
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}
