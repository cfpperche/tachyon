#!/usr/bin/env node
/**
 * `t-0750b6` — TypeScript sources must stay reviewable. `t-62cc44` — and must say so in 100ms.
 *
 * A single raw control byte makes git classify a whole file as binary: `git show` prints
 * "Binary files differ" instead of a diff, and grep goes silent on it. The rule is unchanged from the
 * test that introduced it; what moved is WHEN it runs.
 *
 * It used to be a vitest test, so it could only fail after `check:engine-boundary`, `typecheck` and
 * the whole build — the expensive phase of `verify:full`, which on this host also means waiting for a
 * machine-wide lock. Three separate NUL separators cost a full round each to discover, across two
 * people, all three the same idiom: a template literal joining ids for a `Set` key. Cheapest thing to
 * find early, most expensive to find late.
 *
 * This file is the ONE implementation. `scripts/verify-full.mjs` runs it as a static gate and
 * `test/unit/sourceIsDiffable.test.ts` imports the same functions — deliberately not a second copy of
 * the rule, because two hand-maintained lists disagreeing is exactly what t-dcd8eb's comment in
 * verify-full warns about for CI versus verify.
 *
 * Run directly: `node scripts/check-source-diffable.mjs` (exit 1 and a report on any offender).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * test/ AND scripts/ — every root-owned hand-written source tree, not just product code.
 *
 * The narrow version of this guard covered `src/` alone, and the test enforcing it slipped past:
 * the comment explaining how to avoid a literal NUL contained one, so the enforcer was itself
 * undiffable. A scope that excludes the enforcer is the same shape as a trigger list that misses the
 * cases that bite. This file lives under `scripts/`, so it is scanned by the rule it implements.
 */
export const SCANNED = ["test", "scripts"];

/** Tab, LF and CR are the legitimate whitespace controls. Everything else in C0, plus DEL, must be an escape. */
export const ALLOWED = new Set([0x09, 0x0a, 0x0d]);

/** Generated/vendored trees are not hand-written and are excluded by NAME, never by a broad pattern. */
export const SKIP_DIRS = new Set(["node_modules", "fixtures"]);

export function sourceFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return SKIP_DIRS.has(e.name) ? [] : sourceFiles(full);
    return e.isFile() && (full.endsWith(".ts") || full.endsWith(".mjs")) ? [full] : [];
  });
}

/** Offending byte positions, as `line:col` with the byte value — enough to fix without hunting. */
export function controlBytes(file) {
  const data = fs.readFileSync(file);
  const hits = [];
  let line = 1;
  let col = 1;
  for (const byte of data) {
    if (byte === 0x0a) { line += 1; col = 1; continue; }
    if ((byte < 0x20 && !ALLOWED.has(byte)) || byte === 0x7f) {
      hits.push(`${line}:${col} (0x${byte.toString(16).padStart(2, "0")})`);
    }
    col += 1;
  }
  return hits;
}

/** Every offender under the scanned trees, formatted as the gate and the test both report them. */
export function scanRepo(root = ROOT) {
  return SCANNED.flatMap((d) => sourceFiles(path.join(root, d)))
    .map((file) => ({ file: path.relative(root, file), hits: controlBytes(file) }))
    .filter((r) => r.hits.length > 0)
    .map((r) => `${r.file} — ${r.hits.slice(0, 5).join(", ")}`);
}

/**
 * The message is part of the contract: it teaches the correct fix rather than only reporting a
 * position. Kept verbatim from the test this replaced as the failure surface.
 */
export const FIX_HINT =
  "You almost certainly meant an ESCAPE. Write /[\\x00-\\x1f\\x7f]/ instead of the class with real bytes, " +
  "and \\u0000 instead of a literal NUL separator. Same value at runtime, and the file stays something " +
  "git can diff and grep can search.";

// Run as a CLI only when invoked directly, so importing this from the test costs nothing.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const offenders = scanRepo();
  if (offenders.length > 0) {
    process.stderr.write(`check:source-diffable — raw control bytes in ${offenders.length} file(s):\n`);
    for (const line of offenders) process.stderr.write(`  ${line}\n`);
    process.stderr.write(`\n${FIX_HINT}\n`);
    process.exit(1);
  }
  process.stdout.write("check:source-diffable ok\n");
}
