import { afterEach, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * t-06a542 — content-hashed cockpit chunks must not accumulate into the VSIX.
 * Fail-before: a reused dist/webview/chunks kept every historical cockpit-App-*.js hash.
 *
 * Import shape matches packageCleanGate.test.ts: dynamic import of the ESM .mjs helper.
 */

let reachableWebviewChunkBasenames: (webviewDir: string, entryFiles?: string[]) => Set<string>;
let pruneUnreachableWebviewChunks: (webviewDir: string) => { kept: string[]; pruned: string[] };
let assertWebviewChunksReachable: (webviewDir: string) => void;

beforeAll(async () => {
  ({ reachableWebviewChunkBasenames, pruneUnreachableWebviewChunks, assertWebviewChunksReachable } =
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
  it("walks the import graph from cockpit.js through nested chunks", () => {
    const root = webviewFixture({
      // Entry uses chunks/; chunk-to-chunk uses same-dir ./  (real esbuild ESM output).
      "cockpit.js": `import("./chunks/cockpit-App-LIVE1.js");`,
      "chunks/cockpit-App-LIVE1.js": `import{a}from"./cockpit-chunk-LIVE2.js";`,
      "chunks/cockpit-chunk-LIVE2.js": `export const x = 1;`,
      "chunks/cockpit-App-STALE.js": `export const dead = 1;`,
    });

    const reachable = reachableWebviewChunkBasenames(root);
    expect([...reachable].sort()).toEqual(["cockpit-App-LIVE1.js", "cockpit-chunk-LIVE2.js"]);
  });

  it("prunes only unreferenced basenames and leaves the live graph", () => {
    const root = webviewFixture({
      "cockpit.js": `import("./chunks/cockpit-App-LIVE1.js");`,
      "chunks/cockpit-App-LIVE1.js": `export default 1;`,
      "chunks/cockpit-App-LIVE1.js.map": `{}`,
      "chunks/cockpit-App-STALE1.js": `export default 0;`,
      "chunks/cockpit-App-STALE1.js.map": `{}`,
      "chunks/cockpit-App-STALE2.js": `export default 0;`,
      "chunks/cockpit-App-ORPHAN.js.map": `{}`,
    });

    const result = pruneUnreachableWebviewChunks(root);
    expect(result.kept).toEqual(["cockpit-App-LIVE1.js"]);
    expect(result.pruned).toEqual([
      "cockpit-App-ORPHAN.js.map",
      "cockpit-App-STALE1.js",
      "cockpit-App-STALE2.js",
    ]);
    expect(fs.existsSync(path.join(root, "chunks/cockpit-App-LIVE1.js"))).toBe(true);
    expect(fs.existsSync(path.join(root, "chunks/cockpit-App-LIVE1.js.map"))).toBe(true);
    expect(fs.existsSync(path.join(root, "chunks/cockpit-App-STALE1.js"))).toBe(false);
    expect(fs.existsSync(path.join(root, "chunks/cockpit-App-STALE1.js.map"))).toBe(false);
  });

  it("assertWebviewChunksReachable refuses a package with leftover stale chunks", () => {
    const root = webviewFixture({
      "cockpit.js": `import("./chunks/cockpit-App-LIVE1.js");`,
      "chunks/cockpit-App-LIVE1.js": `export default 1;`,
      "chunks/cockpit-App-STALE.js": `export default 0;`,
    });

    expect(() => assertWebviewChunksReachable(root)).toThrow(/unreferenced/);
    pruneUnreachableWebviewChunks(root);
    expect(() => assertWebviewChunksReachable(root)).not.toThrow();
  });

  it("assertWebviewChunksReachable refuses chunks without cockpit.js", () => {
    const root = webviewFixture({
      "chunks/cockpit-App-ORPHAN.js": `export default 0;`,
    });
    expect(() => assertWebviewChunksReachable(root)).toThrow(/cockpit\.js is missing/);
  });
});
