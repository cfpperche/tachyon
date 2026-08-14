import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
// The packaging scripts are plain ESM and have no separate declaration surface.
// @ts-expect-error -- exercising the real check the release path runs is the point.
import { importClosureViolations, manifestAssetViolations } from "../../scripts/package-closure.mjs";

/**
 * t-e0a0f5 — REINTRODUCE THE DEFECT, then watch it go red.
 *
 * The first fixture is not a plausible imitation of the 0.57.0 failure; it is its literal shape, read
 * back out of the shipped `tachyon-0.57.0.vsix`: `Function("return import(\"ws\")")()` sitting under
 * esbuild's `// apps/vscode-extension/src/webview/ide-browser-bridge/cdpSession.ts` provenance comment, with no
 * `node_modules/ws` beside it. The second fixture is 0.57.1's shape — same package, `ws` inlined and
 * gone from the bundle's specifiers — and must be green.
 *
 * The false-positive fixtures matter as much as the true-positive one. Both real releases reach for
 * `bufferutil`, `utf-8-validate`, `proxy-agent` and `ajv` without carrying any of them, and all four
 * are optional loads inside third-party libraries. A checker that cried about those would be silenced
 * within a week, and the next `ws` would walk past a disabled check.
 */

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

/**
 * An unpacked extension root. `bundle` is written verbatim, so a test states the exact bytes the
 * analyser has to reason about — including esbuild's `// <path>` provenance comments, which are the
 * entire basis of first-party attribution.
 */
function stageExtension(opts: {
  bundle: string;
  bundleName?: string;
  packaged?: string[];
  manifest?: Record<string, unknown>;
}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "package-closure-test-"));
  dirs.push(root);
  const bundle = path.join(root, "dist", opts.bundleName ?? "extension.js");
  fs.mkdirSync(path.dirname(bundle), { recursive: true });
  fs.writeFileSync(bundle, opts.bundle);
  for (const pkg of opts.packaged ?? []) {
    const dir = path.join(root, "node_modules", pkg);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: pkg, version: "1.0.0" }));
  }
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify(opts.manifest ?? { name: "tachyon", publisher: "cfpperche", version: "0.0.0" }),
  );
  return root;
}

/** 0.57.0's bundle, in miniature: the runtime-built import esbuild could not see, under its author. */
const CDP_SESSION_WITH_WS = [
  "// apps/vscode-extension/src/presentation/TmuxAttachClient.ts",
  'var pty = require("node-pty");',
  "// apps/vscode-extension/src/webview/ide-browser-bridge/cdpSession.ts",
  // Byte-for-byte the shipped line, quoting included — an approximation here would prove nothing.
  "    const mod = await Function('return import(\"ws\")')();",
].join("\n");

describe("the package contains everything its own code loads (t-e0a0f5)", () => {
  it("treats relocated bundle provenance and staged dependencies as third-party code", () => {
    const root = stageExtension({ bundle: [
      "// ../../node_modules/ajv/dist/compile/index.js",
      'var formats = require("ajv-formats");',
    ].join("\n") });
    const staged = path.join(root, "dist", "node_modules", "node-pty");
    fs.mkdirSync(path.join(staged, "lib"), { recursive: true });
    fs.writeFileSync(path.join(staged, "package.json"), JSON.stringify({ name: "node-pty" }));
    fs.writeFileSync(path.join(staged, "lib", "windowsTerminal.test.js"), 'require("ps-list");');
    expect(importClosureViolations(root)).toEqual([]);
  });

  it("REFUSES the shipped 0.57.0 shape: our code loads 'ws' and the package has no ws", () => {
    const root = stageExtension({ bundle: CDP_SESSION_WITH_WS, packaged: ["node-pty"] });

    const problems = importClosureViolations(root);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("dist/extension.js loads 'ws'");
    // Naming the author is the difference between "something is missing" and a fix: the reader must
    // land on the file that wrote the import, not go hunting through a 4.7MB bundle for it.
    expect(problems[0]).toContain("apps/vscode-extension/src/webview/ide-browser-bridge/cdpSession.ts");
    expect(problems[0]).toContain("Cannot find package 'ws'");
  });

  it("accepts the 0.57.1 shape: ws inlined into the bundle, node-pty external and packaged", () => {
    const bundle = [
      "// apps/vscode-extension/src/presentation/TmuxAttachClient.ts",
      'var pty = require("node-pty");',
      "// node_modules/ws/lib/websocket.js",
      'var net = require("net");',
      "// apps/vscode-extension/src/webview/ide-browser-bridge/cdpSession.ts",
      "var socket = new WebSocket(url);",
    ].join("\n");

    expect(importClosureViolations(stageExtension({ bundle, packaged: ["node-pty"] }))).toEqual([]);
  });

  it("REFUSES the t-09a462 shape too: an external declared, required, and never packaged", () => {
    // Same class through the other door. `node-pty` is `external` in esbuild, so the bundle emits a
    // bare `require` — correct, and worthless if the module does not travel. Every installed build
    // shipped an agent pane that could not attach, and the build had no reason to fail.
    const root = stageExtension({ bundle: CDP_SESSION_WITH_WS, packaged: ["ws"] });

    const problems = importClosureViolations(root);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("loads 'node-pty'");
    expect(problems[0]).toContain("apps/vscode-extension/src/presentation/TmuxAttachClient.ts");
  });

  it("stays quiet about third-party optional loads, which are absent from every real release", () => {
    // Measured in tachyon-0.57.0.vsix and tachyon-0.57.1.vsix alike. `proxy-agent` is a
    // `try { await import(...) } catch {}` inside @puppeteer/browsers; `bufferutil` and
    // `utf-8-validate` are ws's optional native speedups; the `ajv` ones are code-generation string
    // literals. None is ours, none is a defect, and flagging them is how a check gets turned off.
    const bundle = [
      "// node_modules/@puppeteer/browsers/lib/httpUtil.js",
      'try { const { ProxyAgent } = await import("proxy-agent"); } catch {}',
      "// node_modules/ws/lib/buffer-util.js",
      'var bu = require("bufferutil");',
      "// node_modules/ajv/dist/runtime/uri.js",
      'uri.code = \'require("ajv/dist/runtime/uri").default\';',
    ].join("\n");

    expect(importClosureViolations(stageExtension({ bundle }))).toEqual([]);
  });

  it("treats an import it cannot attribute as ours, rather than shrugging", () => {
    // Code ahead of the first provenance comment has no author to blame. Fail-closed: an
    // unattributable import is precisely where a checker must not assume somebody else's problem.
    expect(importClosureViolations(stageExtension({ bundle: 'require("mystery");' }))).toHaveLength(1);
  });

  it("ignores builtins, node: specifiers, relative paths and the host-provided vscode module", () => {
    const bundle = [
      "// apps/vscode-extension/src/extension.ts",
      'var vscode = require("vscode");',
      'var fs = require("fs");',
      'var pathmod = require("node:path");',
      'var local = require("./helpers/thing.js");',
    ].join("\n");

    expect(importClosureViolations(stageExtension({ bundle }))).toEqual([]);
  });

  it("checks every node bundle in the package, not only the extension entry point", () => {
    // The engine daemon and the tool launcher are shipped Node programs too. A check that only read
    // dist/extension.js would call a package whole while one of its other programs could not start.
    const root = stageExtension({
      bundle: ['// src/engine/daemon.ts', 'var yaml = require("yaml");'].join("\n"),
      bundleName: "engine/engine-daemon.cjs",
    });

    expect(importClosureViolations(root)[0]).toContain("dist/engine/engine-daemon.cjs loads 'yaml'");
  });

  it("does not read webview bundles, which resolve nothing from node_modules", () => {
    const root = stageExtension({
      bundle: ['// packages/webview-ui/src/webview/app.tsx', 'var preact = require("preact");'].join("\n"),
      bundleName: "webview/cockpit.js",
    });

    expect(importClosureViolations(root)).toEqual([]);
  });
});

describe("the package contains every file its manifest promises (t-e0a0f5)", () => {
  it("REFUSES an icon .vscodeignore did not carry", () => {
    const root = stageExtension({
      bundle: "",
      manifest: {
        name: "tachyon",
        contributes: { viewsContainers: { activitybar: [{ id: "tachyon", title: "Tachyon", icon: "media/tachyon.svg" }] } },
      },
    });

    const problems = manifestAssetViolations(root);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("media/tachyon.svg");
  });

  it("accepts the same manifest once the file is inside the package", () => {
    const root = stageExtension({
      bundle: "",
      manifest: {
        name: "tachyon",
        contributes: { viewsContainers: { activitybar: [{ id: "tachyon", title: "Tachyon", icon: "media/tachyon.svg" }] } },
      },
    });
    fs.mkdirSync(path.join(root, "media"), { recursive: true });
    fs.writeFileSync(path.join(root, "media", "tachyon.svg"), "<svg/>");

    expect(manifestAssetViolations(root)).toEqual([]);
  });

  it("does not mistake command ids and codicon references for files", () => {
    const root = stageExtension({
      bundle: "",
      manifest: {
        name: "tachyon",
        contributes: { commands: [{ command: "tachyon.refreshRuntimeOps", title: "Refresh", icon: "$(refresh)" }] },
      },
    });

    expect(manifestAssetViolations(root)).toEqual([]);
  });
});
