/**
 * t-e0a0f5 — what the DEV TREE has and the PACKAGE does not.
 *
 * 0.57.0 shipped a Design Mode that could not start: `Cannot find package 'ws'`. The defect crossed
 * the maintainer's dogfood, two adversarial reviews, a merge, a green gate with 7712 tests and a cut
 * release — because every one of those read the same source against the same development
 * `node_modules`, where `ws` happened to exist as a transitive of a devDependency. Nobody, at any
 * point, asked the PACKAGE what it contains.
 *
 * `test/unit/runtimeImportVisibility.test.ts` closes the SHAPE that hid it (an import built at
 * runtime). This closes the CLASS: a module the packaged bundle can load and the package does not
 * carry, whoever made it invisible and however it got left out.
 *
 * WHY ATTRIBUTION, NOT AN ALLOWLIST. A bundle's bare specifiers are not all ours. Measured on the two
 * real release artifacts, `dist/extension.js` reaches for `bufferutil`, `utf-8-validate` and
 * `proxy-agent`, and `dist/engine/engine-daemon.cjs` for `ajv` and `ajv-formats` — none of them
 * present, none of them a defect: they are optional loads inside `ws`, inside `@puppeteer/browsers`
 * (a `try { await import("proxy-agent") } catch {}`), and code-generation string literals inside ajv.
 * A checker that flags those is a checker people learn to silence. So the rule is not a hand-written
 * list of exceptions — those rot, and the next exception gets added by whoever is in a hurry — but
 * WHO WROTE THE IMPORT. esbuild emits a `// <path>` provenance comment ahead of every module it
 * inlines, so each specifier can be attributed to the file that asked for it. Ours (`src/…`) must
 * resolve inside the package. Third-party ones are the libraries' own business.
 *
 * Measured against the artifacts this task exists because of:
 *   tachyon-0.57.0.vsix -> ws <= apps/vscode-extension/src/webview/ide-browser-bridge/cdpSession.ts   (the shipped defect)
 *   tachyon-0.57.1.vsix -> no first-party violation
 * and zero first-party false positives in either.
 *
 * Pure by construction: takes an unpacked extension root, returns problems, never exits the process.
 */

import fs from "node:fs";
import path from "node:path";
import { builtinModules } from "node:module";

/** Taken from Node rather than copied, for the reason `runtime-externals.mjs` states: a copy is wrong
 *  the moment the real thing changes. */
const BUILTIN = new Set(builtinModules);
/** Provided by the extension host at runtime, never packaged. */
const HOST_PROVIDED = new Set(["vscode"]);

/**
 * esbuild's per-module provenance comment, e.g. `// node_modules/ws/lib/websocket.js`.
 * This is the whole basis of the attribution, so it is matched exactly and nothing else is guessed.
 */
const ORIGIN_MARKER = /^\/\/ (.+\.(?:ts|tsx|js|mjs|cjs|json))$/;

/**
 * Before the first marker there is esbuild's preamble. Code there has no attributable author, so it
 * counts as OURS: an unattributable import is exactly the case where a checker must not shrug.
 */
const UNATTRIBUTED = "<bundle preamble>";

/** Every file under `dir`, relative to it, POSIX separators. */
function walk(dir, base = dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full, base) : [path.relative(base, full).split(path.sep).join("/")];
  });
}

/**
 * The bundles that run on NODE inside the package.
 *
 * Webview bundles are excluded because they resolve nothing from `node_modules` — the browser has no
 * such thing, and their own missing-chunk class is owned by `webview-chunk-hygiene.mjs`. Including
 * them here would answer a question this check cannot answer, which is worse than not asking it.
 */
export function packagedNodeBundles(extensionRoot) {
  return walk(path.join(extensionRoot, "dist"))
    .filter((rel) => /\.(?:c|m)?js$/.test(rel))
    .filter((rel) => !rel.startsWith("webview/") && !rel.startsWith("webview-preview/"))
    .filter((rel) => !rel.startsWith("node_modules/"))
    .map((rel) => `dist/${rel}`)
    .sort();
}

/** `foo/bar` is package `foo`; `@scope/name/deep` is `@scope/name`. */
function packageOf(specifier) {
  return specifier.startsWith("@")
    ? specifier.split("/").slice(0, 2).join("/")
    : specifier.split("/")[0];
}

/**
 * Every literal bare specifier the bundle can load, attributed to the module that wrote it.
 *
 * Matches `require("x")` and `import("x")` — the first is what esbuild emits for an external, the
 * second is what it leaves behind for a dynamic import it did not inline. Both forms are how the
 * package gets asked for something at runtime, and 0.57.0 failed through the second one.
 *
 * @returns {Array<{ specifier: string, package: string, origin: string }>}
 */
export function bundleImports(bundleFile) {
  const found = [];
  let origin = UNATTRIBUTED;
  for (const line of fs.readFileSync(bundleFile, "utf8").split("\n")) {
    const marker = ORIGIN_MARKER.exec(line);
    if (marker) {
      origin = marker[1];
      continue;
    }
    for (const match of line.matchAll(/(?:require|import)\(\s*["']([^"'`]+)["']\s*\)/g)) {
      const specifier = match[1];
      if (specifier.startsWith(".") || specifier.startsWith("/")) continue;
      const bare = specifier.replace(/^node:/, "");
      if (specifier.startsWith("node:") || BUILTIN.has(bare) || HOST_PROVIDED.has(specifier)) continue;
      found.push({ specifier, package: packageOf(specifier), origin });
    }
  }
  return found;
}

/** An import is ours when the module that wrote it is not a third-party package. */
function isFirstParty(origin) {
  return !origin.replace(/^(?:\.\.\/)+/, "").startsWith("node_modules/");
}

/**
 * Modules OUR OWN code loads that the package does not carry.
 *
 * @param {string} extensionRoot the unpacked `extension/` directory of a .vsix
 * @returns {string[]} problems, empty when every first-party import resolves inside the package
 */
export function importClosureViolations(extensionRoot) {
  const problems = [];
  for (const rel of packagedNodeBundles(extensionRoot)) {
    /** package -> the first-party files that ask for it, deduplicated and ordered as read. */
    const wanted = new Map();
    for (const entry of bundleImports(path.join(extensionRoot, rel))) {
      if (!isFirstParty(entry.origin)) continue;
      if (!wanted.has(entry.package)) wanted.set(entry.package, new Set());
      wanted.get(entry.package).add(entry.origin);
    }
    for (const [pkg, origins] of wanted) {
      if (fs.existsSync(path.join(extensionRoot, "node_modules", pkg, "package.json"))) continue;
      if (fs.existsSync(path.join(extensionRoot, "dist", "node_modules", pkg, "package.json"))) continue;
      problems.push(
        `${rel} loads '${pkg}' from ${[...origins].join(", ")}, but the package contains no ` +
        `node_modules/${pkg} — the extension fails at first use with "Cannot find package '${pkg}'".`,
      );
    }
  }
  return problems;
}

/**
 * Files the MANIFEST promises and the package does not contain.
 *
 * The other half of the same class, and the one `.vscodeignore` cuts: `contributes` is read by VS
 * Code itself, so an icon or a walkthrough asset that did not travel is a broken surface with no
 * code involved at all. Only relative paths are considered — a `$(codicon)` reference and an http URL
 * are not files.
 *
 * This does NOT cover assets the CODE builds at runtime. `dist/extension.js` composes those from
 * segments (`Uri.joinPath(extensionUri, "dist", "webview", …)`), so there is no literal path in the
 * bundle to check: measured on 0.57.1, a literal-path scan of the shipped bundle finds zero. Saying
 * so is the point — a checker that quietly covers half a class reads as covering all of it.
 *
 * @param {string} extensionRoot the unpacked `extension/` directory of a .vsix
 * @returns {string[]} problems, empty when every manifest-declared file is present
 */
export function manifestAssetViolations(extensionRoot) {
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(extensionRoot, "package.json"), "utf8"));
  } catch (error) {
    return [`the package manifest is unreadable: ${String(error)}`];
  }

  const problems = [];
  const seen = new Set();
  const check = (value, where) => {
    if (typeof value !== "string") return;
    if (!/^[A-Za-z0-9._][A-Za-z0-9._/-]*\.[A-Za-z0-9]+$/.test(value)) return; // not a relative file path
    if (seen.has(value)) return;
    seen.add(value);
    if (!fs.existsSync(path.join(extensionRoot, value))) {
      problems.push(`the manifest declares ${where} '${value}', which is not in the package`);
    }
  };

  const visit = (node, trail) => {
    if (Array.isArray(node)) {
      node.forEach((item) => visit(item, trail));
      return;
    }
    if (!node || typeof node !== "object") return;
    for (const [key, value] of Object.entries(node)) {
      const where = trail ? `${trail}.${key}` : key;
      // Only keys that NAME a file. Walking every string would flag ids like `tachyon.start`.
      if (/^(icon|image|media|path|file|source|dark|light)$/.test(key)) check(value, where);
      else visit(value, where);
    }
  };
  visit(manifest.contributes ?? {}, "contributes");
  check(manifest.icon, "icon");
  check(manifest.main, "main");
  return problems;
}

/** Both halves, in the order a reader wants them: what the code loads, then what the manifest names. */
export function packageClosureViolations(extensionRoot) {
  return [...importClosureViolations(extensionRoot), ...manifestAssetViolations(extensionRoot)];
}
