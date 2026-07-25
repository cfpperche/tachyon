/**
 * t-09a462 — everything the bundle needs at RUNTIME must be inside the package.
 *
 * esbuild's `external` list is a promise: "do not bundle this, it will be there when the code runs."
 * esbuild does not verify the promise — that is not its job — and until now nothing downstream did
 * either. So `node-pty` was correctly declared a dependency, correctly marked external, correctly
 * `require()`d... and never packaged. Every installed build shipped an agent pane that could not
 * attach, and the build had no reason to fail: it did exactly what it was told.
 *
 * This reads the externals the BUILT bundle actually emits — not the esbuild config, which is the
 * claim rather than the result — and reports which ones a given tree can satisfy. The ship-boundary
 * and packaged-artifact audits both miss this class: they check `dist/` and the engine manifest, and
 * a runtime `require` of a node_module is in neither.
 */

import fs from "node:fs";
import path from "node:path";
import { builtinModules } from "node:module";

/** Modules Node itself provides. Taken from Node rather than a hand-written list: my first draft
 *  omitted `process` and flagged it as unpackaged, which is the same mistake as copying a schema
 *  instead of calling its parser — the copy is wrong the moment the real thing changes. */
const BUILTIN = new Set(builtinModules);
/** Provided by the extension host at runtime, never packaged. */
const HOST_PROVIDED = new Set(["vscode"]);

/**
 * Bare module specifiers the bundle requires at runtime.
 *
 * Matches `require("x")` as EMITTED — esbuild leaves external requires verbatim. Relative and
 * absolute paths are not dependencies to package; builtins and host-provided modules are excluded by
 * name so an addition to either list is a deliberate edit here rather than a silent pass.
 */
export function runtimeExternals(bundleFile) {
  const src = fs.readFileSync(bundleFile, "utf8");
  const found = new Set();
  for (const m of src.matchAll(/require\(\s*["']([^"'`]+)["']\s*\)/g)) {
    const spec = m[1];
    if (spec.startsWith(".") || spec.startsWith("/")) continue;
    if (BUILTIN.has(spec.replace(/^node:/, ""))) continue;
    if (HOST_PROVIDED.has(spec)) continue;
    // `foo/bar` depends on package `foo` (or `@scope/name` for a scoped one).
    const pkg = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
    found.add(pkg);
  }
  return [...found].sort();
}

/**
 * Which of `externals` are present under `root` (the unpacked package, or a checkout).
 * Presence means the package directory with its manifest — the entry point Node would resolve.
 */
export function missingExternals(externals, root) {
  return externals.filter((pkg) => !fs.existsSync(path.join(root, "node_modules", pkg, "package.json")));
}
