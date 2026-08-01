/*
 * t-fdfbd4 — the PORTABLE preview-reference scan: the machinery behind the `verify:full` guard that
 * refuses to let a browser test keep knocking on a door the product removed.
 *
 * WHY THIS EXISTS. `test:browser` needs a system Chrome and ~96s, so `verify:full` does not run it — and
 * for months nobody else did either. It rotted in silence: t-c55f8d measured 17 failures on main and found
 * that 16 of them were ONE defect repeated — a test opening `?view=plugins`, `?view=runtime-ops`,
 * `dist/webview/task-studio.js`, `dist/webview/mission-control.js`, all of which the product had folded
 * into the Control bundle. None of those needed a browser to be detected: they were strings pointing at
 * doors that no longer exist. This scan reads those strings and matches them against the two LIVE sources,
 * in milliseconds, on any machine — so the day a route is retired, the person retiring it sees the tests
 * that still reference it, instead of somebody rediscovering them months later.
 *
 * THE TWO AUTHORITIES, neither of them a hand-kept list:
 *   1. views   — `ROUTES` in scripts/webview-preview/routes.ts. That is the object `preview.ts` itself
 *                indexes with `params.get("view")` at runtime, so "a view the harness knows" is literally
 *                "a key of ROUTES". routes.json is GENERATED from it (generate-routes.ts) and pinned equal
 *                by test/unit/webviewPreviewCatalog.test.ts, so it is a copy, not the source.
 *   2. bundles — the `outfile:`/`outdir`+`entryNames` declarations in esbuild.mjs. That is what the build
 *                actually emits into dist/webview, so "a bundle a host page may load" is exactly what
 *                esbuild.mjs declares. Derived from the file, never restated here.
 *
 * The scan is deliberately textual and dependency-free: it must run before/without a webview build.
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";

/** Directories that open preview-harness URLs or hand-roll a host page loading a dist bundle. */
export const CALLER_ROOTS = ["test/browser", "scripts/visual-qa"];
const CALLER_EXT = /\.(?:ts|tsx|mjs|js)$/;

/**
 * Replace every comment byte with a space, preserving length and newlines, so a match's offset still maps
 * to its real line. Comments matter here beyond tidiness: the repointed tests from t-c55f8d EXPLAIN the
 * retired route in prose right above the live URL ("there is no `dist/webview/task-studio.js` any more"),
 * and a scan that read those would report the very files that were already fixed. Only code counts.
 *
 * Tracks string/template state so a `//` inside a URL literal is not mistaken for a comment, and `${…}`
 * holes so a template's interpolated code is scanned too. Regex literals are NOT parsed — a regex carrying
 * an odd quote would desync this; `agreesWithEsbuild` below is the standing proof that none does.
 */
export function blankComments(src) {
  const out = [...src];
  const blank = (from, to) => {
    for (let k = from; k < to; k++) if (out[k] !== "\n") out[k] = " ";
  };
  // stack of lexical states; the bottom is always module code.
  const stack = [{ kind: "code", depth: 0 }];
  let i = 0;
  while (i < src.length) {
    const top = stack[stack.length - 1];
    const c = src[i];
    const d = src[i + 1];
    if (top.kind === "code") {
      if (c === "/" && d === "/") {
        const nl = src.indexOf("\n", i);
        const end = nl < 0 ? src.length : nl;
        blank(i, end);
        i = end;
      } else if (c === "/" && d === "*") {
        const close = src.indexOf("*/", i + 2);
        const end = close < 0 ? src.length : close + 2;
        blank(i, end);
        i = end;
      } else if (c === "'" || c === '"') {
        stack.push({ kind: "quote", quote: c });
        i += 1;
      } else if (c === "`") {
        stack.push({ kind: "template" });
        i += 1;
      } else if (c === "{") {
        top.depth += 1;
        i += 1;
      } else if (c === "}") {
        // depth 0 inside a `${…}` hole means this brace closes the hole itself.
        if (top.depth === 0 && stack.length > 1) stack.pop();
        else top.depth -= 1;
        i += 1;
      } else {
        i += 1;
      }
      continue;
    }
    if (top.kind === "quote") {
      if (c === "\\") i += 2;
      else if (c === top.quote || c === "\n") { stack.pop(); i += 1; }
      else i += 1;
      continue;
    }
    // template literal
    if (c === "\\") i += 2;
    else if (c === "`") { stack.pop(); i += 1; }
    else if (c === "$" && d === "{") { stack.push({ kind: "code", depth: 0 }); i += 2; }
    else i += 1;
  }
  return out.join("");
}

/** 1-based line number of a byte offset. */
function lineAt(src, offset) {
  let line = 1;
  for (let i = 0; i < offset; i++) if (src[i] === "\n") line += 1;
  return line;
}

/** Every scannable caller file under CALLER_ROOTS, repo-relative and sorted. */
export function callerFiles(roots = CALLER_ROOTS) {
  const files = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || !CALLER_EXT.test(entry.name)) continue;
      const dir = entry.parentPath ?? entry.path ?? root;
      files.push(path.relative(".", path.join(dir, entry.name)).split(path.sep).join("/"));
    }
  }
  return files.sort();
}

/**
 * The webview bundles esbuild.mjs declares it emits. Two shapes, because the build has two:
 *   - `outfile: "dist/webview/<name>.js"` — every single-entry target (sidebar, pin-preview, …);
 *   - `outdir: "dist/webview"` + `entryNames: "<name>"` — the code-split ESM cockpit target, which has no
 *     `outfile` at all (esbuild.mjs even `delete`s the inherited one). Reading only `outfile:` would call
 *     the LIVE cockpit.js undeclared and fail every repointed test — the exact false positive that would
 *     get this guard deleted in its first week.
 */
export function declaredWebviewBundles(esbuildSource = readFileSync("esbuild.mjs", "utf8")) {
  const code = blankComments(esbuildSource);
  const bundles = new Set();
  for (const m of code.matchAll(/outfile:\s*"(dist\/webview\/[^"]+\.js)"/g)) bundles.add(m[1]);
  for (const m of code.matchAll(/outdir:\s*"(dist\/webview)"/g)) {
    // entryNames may sit either side of outdir inside the same config object literal.
    const window = code.slice(Math.max(0, m.index - 600), m.index + 600);
    for (const e of window.matchAll(/entryNames:\s*"([^"/]+)"/g)) bundles.add(`${m[1]}/${e[1]}.js`);
  }
  return bundles;
}

const VIEW_RE = /[?&]view=([A-Za-z0-9_-]+)/g;
const BUNDLE_RE = /dist\/webview\/([A-Za-z0-9_.-]+\.js)/g;
/**
 * An in-file waiver, next to the dead reference it excuses, naming the task that owns the decision:
 *   // preview-route-check: allow view=runtime-ops (t-2a49b2) — <why>
 * It is not a list: it lives in the file that carries the reference, dies with that file, and
 * `staleWaivers` below fails when the reference it excuses is gone, so it cannot rot either.
 */
const WAIVER_RE = /preview-route-check:\s*allow\s+((?:view=[A-Za-z0-9_-]+)|(?:dist\/webview\/[A-Za-z0-9_.-]+\.js))\s+\((t-[0-9a-f]{6})\)/g;

/** Live (comment-stripped) references a caller file makes, with the line each sits on. */
export function scanFile(file, source = readFileSync(file, "utf8")) {
  const code = blankComments(source);
  const views = [...code.matchAll(VIEW_RE)].map((m) => ({ token: `view=${m[1]}`, view: m[1], file, line: lineAt(source, m.index) }));
  const bundles = [...code.matchAll(BUNDLE_RE)].map((m) => ({ token: `dist/webview/${m[1]}`, bundle: m[1], file, line: lineAt(source, m.index) }));
  // waivers are read from the RAW source: they are comments by construction.
  const waivers = [...source.matchAll(WAIVER_RE)].map((m) => ({ token: m[1], task: m[2], file, line: lineAt(source, m.index) }));
  return { views, bundles, waivers };
}

/**
 * The whole guard, as data. Returns the dead references and the waivers that no longer excuse anything.
 * Messages name the dead token AND the file:line — a generic "invalid route" would reproduce in miniature
 * the very failure this exists to catch (t-c55f8d spent three rounds on one such message).
 */
export function scanPreviewReferences({ routeKeys, bundles, files = callerFiles() } = {}) {
  const knownViews = [...routeKeys].sort();
  const knownBundles = [...bundles].map((b) => b.replace(/^dist\/webview\//, "")).sort();
  const dead = [];
  const stale = [];
  for (const file of files) {
    const { views, bundles: bundleRefs, waivers } = scanFile(file);
    const waived = new Map(waivers.map((w) => [w.token, w]));
    // What a waiver is allowed to excuse: a reference this file makes that IS dead. Checking against
    // "referenced at all" would let a waiver for a LIVE token sit forever doing nothing, which is the
    // same inert-mechanism failure (t-b4a799) the guard exists to refuse.
    const excusable = new Set([
      ...views.filter((v) => !routeKeys.has(v.view)).map((v) => v.token),
      ...bundleRefs.filter((b) => !knownBundles.includes(b.bundle)).map((b) => b.token),
    ]);
    for (const v of views) {
      if (routeKeys.has(v.view) || waived.has(v.token)) continue;
      dead.push(
        `${file}:${v.line} opens ?view=${v.view} — no such key in ROUTES (scripts/webview-preview/routes.ts), ` +
          `so the preview harness answers this URL with "unknown view" and the page never renders. ` +
          `Live views: ${knownViews.join(", ")}. Repoint this test at a live route, delete it, or waive it in place with ` +
          `\`// preview-route-check: allow view=${v.view} (t-xxxxxx) — why\`.`,
      );
    }
    for (const b of bundleRefs) {
      if (knownBundles.includes(b.bundle) || waived.has(b.token)) continue;
      dead.push(
        `${file}:${b.line} loads dist/webview/${b.bundle} — esbuild.mjs declares no such output, ` +
          `so the host page 404s on that script and renders empty. ` +
          `Declared webview bundles: ${knownBundles.join(", ")}. Point it at a live bundle, delete it, or waive it in place with ` +
          `\`// preview-route-check: allow dist/webview/${b.bundle} (t-xxxxxx) — why\`.`,
      );
    }
    for (const w of waivers) {
      if (excusable.has(w.token)) continue;
      stale.push(
        `${file}:${w.line} waives \`${w.token}\` (${w.task}) but this file has no dead reference to it — ` +
          `either the reference is gone or it is live again. Delete the stale \`preview-route-check: allow\` ` +
          `comment so the next dead reference is not silently excused.`,
      );
    }
  }
  return { dead, stale, knownViews, knownBundles };
}
