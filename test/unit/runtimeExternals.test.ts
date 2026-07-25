import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
// The packaging scripts are plain ESM and have no separate declaration surface.
// @ts-expect-error -- exercising the real check the packaging path runs is the point.
import { runtimeExternals, missingExternals } from "../../scripts/runtime-externals.mjs";

/**
 * t-09a462 — esbuild's `external` list is a promise that a module will be there when the code runs.
 * esbuild does not verify it, and nothing downstream did either: node-pty was declared a dependency,
 * marked external, `require()`d by the agent pane, and never packaged. Every installed build shipped
 * a pane that could not attach, and the build had no reason to fail — it did what it was told.
 *
 * The check reads what the BUILT bundle emits, not the esbuild config: the config is the claim, the
 * bundle is the result.
 */

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

function tree(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-ext-test-"));
  dirs.push(root);
  for (const [rel, body] of Object.entries(files)) {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
  }
  return root;
}

describe("runtime externals (t-09a462)", () => {
  it("finds a bare require the bundle emits", () => {
    const root = tree({ "bundle.js": `var pty = require("node-pty");\n` });
    expect(runtimeExternals(path.join(root, "bundle.js"))).toEqual(["node-pty"]);
  });

  it("ignores what Node itself provides, using Node's OWN list", () => {
    // The first draft used a hand-written regex, omitted `process`, and reported it as unpackaged.
    // A copied list is wrong the moment the real one changes — ask Node instead.
    const root = tree({
      "bundle.js": `require("fs");require("node:path");require("process");require("worker_threads");`,
    });
    expect(runtimeExternals(path.join(root, "bundle.js"))).toEqual([]);
  });

  it("ignores vscode — the host provides it and it is never packaged", () => {
    const root = tree({ "bundle.js": `require("vscode");` });
    expect(runtimeExternals(path.join(root, "bundle.js"))).toEqual([]);
  });

  it("ignores relative and absolute requires — they are not packages", () => {
    const root = tree({ "bundle.js": `require("./x");require("../y");require("/abs/z");` });
    expect(runtimeExternals(path.join(root, "bundle.js"))).toEqual([]);
  });

  it("attributes a deep require to its package, including a scoped one", () => {
    const root = tree({ "bundle.js": `require("node-pty/lib/utils");require("@scope/pkg/sub");` });
    expect(runtimeExternals(path.join(root, "bundle.js"))).toEqual(["@scope/pkg", "node-pty"]);
  });

  it("REPORTS a required package the tree does not contain — the whole point", () => {
    const root = tree({ "bundle.js": `require("node-pty");` });
    expect(missingExternals(["node-pty"], root)).toEqual(["node-pty"]);
  });

  it("accepts it once the package is actually present", () => {
    const root = tree({
      "bundle.js": `require("node-pty");`,
      "node_modules/node-pty/package.json": `{"name":"node-pty"}`,
    });
    expect(missingExternals(runtimeExternals(path.join(root, "bundle.js")), root)).toEqual([]);
  });

  it("a directory without a manifest does NOT count as present", () => {
    // Node resolves a package through its manifest; a bare directory would fail at require time.
    const root = tree({ "bundle.js": `require("node-pty");`, "node_modules/node-pty/lib/index.js": "" });
    expect(missingExternals(["node-pty"], root)).toEqual(["node-pty"]);
  });
});
