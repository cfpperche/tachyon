import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { nonEmpty, workspaceRoot } from "../helpers/repositorySourceScan.js";

/**
 * A module the bundler cannot SEE is a module the VSIX does not ship.
 *
 * Why this exists: `cdpSession.ts` loaded the CDP WebSocket with
 * `Function('return import("ws")')()` — an import expression built at runtime. esbuild bundles by
 * READING import expressions, so it found none: `dist/extension.js` shipped with zero `ws` bytes and
 * the packaged 0.57.0 failed at first use with "Cannot find package 'ws'".
 *
 * It worked in the Dev Host for a reason that makes the failure worse, not better: `ws` is installed
 * as a TRANSITIVE of `puppeteer-core`, a devDependency. The dev tree had it by accident; a release
 * install does not. So the feature was exercised, dogfooded and reviewed against a dependency graph
 * no user has.
 *
 * The trick was written to dodge missing TYPES, not to defer loading — the cost it avoided was one
 * suppression comment, and the cost it caused was a shipped feature that could not start.
 *
 * This guard is deliberately about the SHAPE, not about `ws`: any runtime-constructed import hides
 * the same way, and the next one will be a different package.
 */

const SRC = path.resolve(__dirname, "../../src");
const SOURCE_ROOTS = [
  SRC,
  path.join(workspaceRoot("@tachyon/engine"), "src"),
  path.join(workspaceRoot("@tachyon/shared"), "src"),
  path.join(workspaceRoot("@tachyon/webview-ui"), "src"),
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

describe("no module hides itself from the bundler (t-ws-bundle)", () => {
  it("builds no import expression at runtime — esbuild must be able to read every one", () => {
    // `Function("… import(…)")`, `eval("import(…)")`, and `new Function` all defeat static analysis.
    // Comments are stripped first, and that is not a detail: the first draft of this guard flagged the
    // very file it had just fixed, because the fix's own comment SPELLS the forbidden shape while
    // explaining it. A scanner that cannot tell code from prose punishes documentation, and the repo
    // paid for that lesson once already today (SDD 485 E1's merge comment tripping a text guard).
    const stripComments = (text: string) =>
      text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

    const hidden = nonEmpty(SOURCE_ROOTS.flatMap(sourceFiles), "runtime-import source scan")
      .map((file) => ({ file, text: stripComments(readFileSync(file, "utf8")) }))
      .filter(({ text }) => /(?:new\s+Function|Function|eval)\s*\([^)]*\bimport\s*\(/.test(text))
      .map(({ file }) => path.relative(path.resolve(SRC, ".."), file));

    expect(
      hidden,
      `${hidden.join(", ")} constructs an import at runtime. esbuild cannot see it, so the package is ` +
      "left out of dist/ and the extension fails on first use with \"Cannot find package\". Use a real " +
      "`await import(\"…\")`; if the module ships no types, suppress the type error explicitly.",
    ).toEqual([]);
  });

  it("declares every directly-imported runtime package, rather than inheriting it from a devDependency", () => {
    // `ws` was reachable only through puppeteer-core (dev). A direct import must be a direct
    // dependency: a transitive can change version or disappear when the dev tool is upgraded, and
    // nothing would report it until a user hit the packaged build.
    const pkg = JSON.parse(readFileSync(path.resolve(SRC, "../package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    expect(Object.keys(pkg.dependencies ?? {}), "ws is imported by src/ and must be a direct dependency")
      .toContain("ws");
  });

  it("ships the CDP socket INSIDE the extension bundle when one has been built", () => {
    // Skipped rather than failed on a clean tree: `dist/` is a build output, and a unit suite that
    // demands it turns "you have not built yet" into a red test, which teaches people to ignore red.
    const bundle = path.resolve(SRC, "../dist/extension.js");
    let text: string;
    try {
      if (!statSync(bundle).isFile()) return;
      text = readFileSync(bundle, "utf8");
    } catch {
      return;
    }
    expect(text, "the runtime-constructed import is back in the shipped bundle")
      .not.toContain('return import("ws")');
    expect(/PerMessageDeflate|websocket/i.test(text), "dist/extension.js carries no WebSocket implementation — " +
      "the CDP session will fail at runtime with \"Cannot find package 'ws'\"").toBe(true);
  });
});
