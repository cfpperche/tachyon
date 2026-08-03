import { afterEach, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * t-06a542 — content-hashed webview chunks must not accumulate into the VSIX.
 * Fail-before: a reused dist/webview/chunks kept every historical cockpit-App-*.js hash.
 *
 * SDD 485 C2 — the graph gained more than one root. The splitting invocation now builds one entry per
 * standalone app and they SHARE chunks, so the cases below check the two failures that shape can produce
 * and the old single-root version could not see: a chunk kept alive only by the second app, and a prune
 * seeded from one entry deleting what another entry still imports.
 *
 * Import shape matches packageCleanGate.test.ts: dynamic import of the ESM .mjs helper.
 */

let reachableWebviewChunkBasenames: (webviewDir: string, entryFiles?: string[]) => Set<string>;
let pruneUnreachableWebviewChunks: (webviewDir: string) => { kept: string[]; pruned: string[] };
let assertWebviewChunksReachable: (webviewDir: string) => void;
let webviewEntryFiles: (webviewDir: string) => string[];

beforeAll(async () => {
  ({ reachableWebviewChunkBasenames, pruneUnreachableWebviewChunks, assertWebviewChunksReachable, webviewEntryFiles } =
    await import("../../scripts/webview-chunk-hygiene.mjs"));
});

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function webviewFixture(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-chunk-hygiene-"));
  roots.push(root);
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }
  return root;
}

describe("webview chunk hygiene (t-06a542)", () => {
  it("walks the import graph from an app entry through nested chunks", () => {
    const root = webviewFixture({
      // Entry uses chunks/; chunk-to-chunk uses same-dir ./  (real esbuild ESM output).
      "cockpit.js": `import("./chunks/app-App-LIVE1.js");`,
      "chunks/app-App-LIVE1.js": `import{a}from"./app-chunk-LIVE2.js";`,
      "chunks/app-chunk-LIVE2.js": `export const x = 1;`,
      "chunks/app-App-STALE.js": `export const dead = 1;`,
    });

    const reachable = reachableWebviewChunkBasenames(root);
    expect([...reachable].sort()).toEqual(["app-App-LIVE1.js", "app-chunk-LIVE2.js"]);
  });

  it("discovers EVERY app entry as a root — a chunk only the second app imports survives", () => {
    // The regression this exists to stop: seeding reachability from one hardcoded entry deletes the
    // chunks that belong to every other app in the same splitting invocation.
    const root = webviewFixture({
      "cockpit.js": `import("./chunks/app-chunk-SHARED.js");`,
      "section-app-fixture.js": `import"./chunks/app-chunk-SHARED.js";import("./chunks/app-App-ONLYFIXTURE.js");`,
      // an IIFE bundle from another target: a root that contributes no chunk references at all.
      "agent-pane.js": `(()=>{console.log("iife")})();`,
      "chunks/app-chunk-SHARED.js": `export const preact = 1;`,
      "chunks/app-App-ONLYFIXTURE.js": `export default 2;`,
      "chunks/app-App-STALE.js": `export default 0;`,
    });

    expect(webviewEntryFiles(root)).toEqual(["agent-pane.js", "cockpit.js", "section-app-fixture.js"]);
    const result = pruneUnreachableWebviewChunks(root);
    expect(result.kept).toEqual(["app-App-ONLYFIXTURE.js", "app-chunk-SHARED.js"]);
    expect(result.pruned).toEqual(["app-App-STALE.js"]);
    expect(fs.existsSync(path.join(root, "chunks/app-App-ONLYFIXTURE.js"))).toBe(true);
    expect(fs.existsSync(path.join(root, "chunks/app-chunk-SHARED.js"))).toBe(true);
  });

  it("prunes only unreferenced basenames and leaves the live graph", () => {
    const root = webviewFixture({
      "cockpit.js": `import("./chunks/app-App-LIVE1.js");`,
      "chunks/app-App-LIVE1.js": `export default 1;`,
      "chunks/app-App-LIVE1.js.map": `{}`,
      "chunks/app-App-STALE1.js": `export default 0;`,
      "chunks/app-App-STALE1.js.map": `{}`,
      "chunks/app-App-STALE2.js": `export default 0;`,
      "chunks/app-App-ORPHAN.js.map": `{}`,
    });

    const result = pruneUnreachableWebviewChunks(root);
    expect(result.kept).toEqual(["app-App-LIVE1.js"]);
    expect(result.pruned).toEqual([
      "app-App-ORPHAN.js.map",
      "app-App-STALE1.js",
      "app-App-STALE2.js",
    ]);
    expect(fs.existsSync(path.join(root, "chunks/app-App-LIVE1.js"))).toBe(true);
    expect(fs.existsSync(path.join(root, "chunks/app-App-LIVE1.js.map"))).toBe(true);
    expect(fs.existsSync(path.join(root, "chunks/app-App-STALE1.js"))).toBe(false);
    expect(fs.existsSync(path.join(root, "chunks/app-App-STALE1.js.map"))).toBe(false);
  });

  it("assertWebviewChunksReachable refuses a package with leftover stale chunks", () => {
    const root = webviewFixture({
      "cockpit.js": `import("./chunks/app-App-LIVE1.js");`,
      "chunks/app-App-LIVE1.js": `export default 1;`,
      "chunks/app-App-STALE.js": `export default 0;`,
    });

    expect(() => assertWebviewChunksReachable(root)).toThrow(/unreferenced/);
    pruneUnreachableWebviewChunks(root);
    expect(() => assertWebviewChunksReachable(root)).not.toThrow();
  });

  it("assertWebviewChunksReachable refuses chunks with no app entry at all", () => {
    const root = webviewFixture({
      "chunks/app-App-ORPHAN.js": `export default 0;`,
    });
    expect(() => assertWebviewChunksReachable(root)).toThrow(/no top-level app entry/);
  });
});
