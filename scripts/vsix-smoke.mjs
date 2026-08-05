#!/usr/bin/env node
/**
 * t-e0a0f5 — the step between `npm run package` and the human.
 *
 * Until now nothing touched the packaged artifact before it was installed by the maintainer, AFTER
 * publication. 0.57.0 is what that costs: a Design Mode that could not start, past dogfood, two
 * adversarial reviews, a merge, a green gate and a cut release, because everything upstream read the
 * same source against the same development `node_modules`.
 *
 * Two layers, cheapest first:
 *
 *   1. CLOSURE (static, no editor, ~1s). Ask the package what it contains, using
 *      `scripts/package-closure.mjs`. This is the layer that catches the class: measured RED on the
 *      real `tachyon-0.57.0.vsix` (`ws <= src/webview/ide-browser-bridge/cdpSession.ts`) and GREEN on
 *      `tachyon-0.57.1.vsix`.
 *   2. ACTIVATION (a real, disposable VS Code, ~5s). Install the .vsix into a throwaway
 *      extensions/user-data directory, start an extension host on an empty folder, and open one door
 *      per live surface (`test/vsix-smoke/probe/suite.js`). This is the layer that proves the package
 *      STARTS — the floor layer 1 cannot reach, because a bundle can be closed and still throw.
 *
 * WHY THIS IS A RELEASE STEP AND NOT A GATE STEP — a structural answer, not a timing one. There is no
 * .vsix at gate time and there cannot be one: `assertStableBuildSource` (scripts/engine-release-channel.mjs)
 * refuses to build a stable package from a linked worktree, off `main`, or from a dirty tree, and the
 * gate runs in a worktree on a feature branch by definition. Cost measured on this host anyway, since
 * the task asked: build 2.2s + package 4.3s + install 1.3s + activate 2.0s ≈ 10s. Cheap — and still
 * irrelevant, because the artifact does not exist to be smoked until a release is being cut.
 *
 * Usage:  node scripts/vsix-smoke.mjs [<path.vsix>] [--closure-only] [--keep]
 *         (with no path, the newest *.vsix in the checkout root)
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { packageClosureViolations } from "./package-closure.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROBE = path.join(root, "test", "vsix-smoke", "probe");
/** A host that has not answered in this long is not going to; the measured run is ~2s. */
const ACTIVATION_TIMEOUT_MS = 180_000;

const argv = process.argv.slice(2);
const closureOnly = argv.includes("--closure-only");
const keep = argv.includes("--keep");
const explicitVsix = argv.find((arg) => !arg.startsWith("--"));

function fail(message) {
  console.error(`vsix-smoke: ${message}`);
  process.exit(1);
}

function newestVsix() {
  const candidates = fs
    .readdirSync(root)
    .filter((name) => name.endsWith(".vsix"))
    .map((name) => ({ name, at: fs.statSync(path.join(root, name)).mtimeMs }))
    .sort((a, b) => b.at - a.at);
  return candidates[0] ? path.join(root, candidates[0].name) : undefined;
}

const vsix = explicitVsix ? path.resolve(explicitVsix) : newestVsix();
if (!vsix) fail("no .vsix given and none found in the checkout root — run `npm run package` first");
if (!fs.existsSync(vsix)) fail(`no such file: ${vsix}`);

const work = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-vsix-smoke-"));
const unpacked = path.join(work, "unpacked");
let exitCode = 0;

try {
  fs.mkdirSync(unpacked, { recursive: true });
  try {
    execFileSync("unzip", ["-q", "-o", vsix, "-d", unpacked], { stdio: ["ignore", "ignore", "pipe"] });
  } catch (error) {
    fail(`cannot unpack ${path.basename(vsix)}: ${error.message}`);
  }
  const extensionRoot = path.join(unpacked, "extension");
  if (!fs.existsSync(extensionRoot)) fail("the vsix has no extension/ directory");

  const identity = JSON.parse(fs.readFileSync(path.join(extensionRoot, "package.json"), "utf8"));
  console.log(`vsix-smoke: ${path.basename(vsix)} — ${identity.publisher}.${identity.name} ${identity.version}`);

  // ---- layer 1: closure -----------------------------------------------------------------------
  const violations = packageClosureViolations(extensionRoot);
  if (violations.length > 0) {
    console.error("vsix-smoke: FAILED — the package does not contain everything it loads:");
    for (const problem of violations) console.error(`  ${problem}`);
    process.exit(1);
  }
  console.log("vsix-smoke: closure OK — every first-party import and manifest asset is inside the package");

  if (closureOnly) process.exit(0);

  // ---- layer 2: activation --------------------------------------------------------------------
  const editor = await resolveEditor();
  const extensionsDir = path.join(work, "extensions");
  const userDataDir = path.join(work, "user-data");
  const workspace = path.join(work, "workspace");
  for (const dir of [extensionsDir, userDataDir, workspace]) fs.mkdirSync(dir, { recursive: true });

  const install = spawnSync(
    editor.cli,
    ["--install-extension", vsix, "--extensions-dir", extensionsDir, "--user-data-dir", userDataDir],
    { encoding: "utf8", env: { ...childEnv(work), DONT_PROMPT_WSL_INSTALL: "1" } },
  );
  if (install.status !== 0) {
    console.error(install.stdout ?? "");
    console.error(install.stderr ?? "");
    fail("the editor refused to install the package");
  }
  console.log(`vsix-smoke: installed into a disposable editor (${editor.version})`);

  const resultFile = path.join(work, "result.json");
  const args = [
    `--user-data-dir=${userDataDir}`,
    `--extensions-dir=${extensionsDir}`,
    `--extensionDevelopmentPath=${PROBE}`,
    `--extensionTestsPath=${path.join(PROBE, "suite.js")}`,
    "--disable-workspace-trust",
    "--disable-updates",
    "--disable-crash-reporter",
    "--skip-release-notes",
    "--no-sandbox",
    workspace,
  ];

  // Never the human's display: project guidance forbids opening a desktop window unasked, and an
  // Electron window stealing focus mid-release is exactly that.
  const [command, commandArgs] = headless(editor.executable, args);
  const run = spawnSync(command, commandArgs, {
    encoding: "utf8",
    timeout: ACTIVATION_TIMEOUT_MS,
    env: { ...childEnv(work), DONT_PROMPT_WSL_INSTALL: "1", TACHYON_SMOKE_RESULT: resultFile },
  });

  for (const line of `${run.stdout ?? ""}\n${run.stderr ?? ""}`.split("\n")) {
    if (line.includes("[vsix-smoke]")) console.log(`  ${line.trim()}`);
  }

  let result;
  try {
    result = JSON.parse(fs.readFileSync(resultFile, "utf8"));
  } catch {
    result = undefined;
  }

  // The file alone is never trusted: a host that died before writing it must not read as a pass.
  if (run.status !== 0 || !result?.ok) {
    console.error(`vsix-smoke: FAILED — the packaged extension did not start cleanly (exit ${run.status})`);
    for (const problem of result?.failures ?? []) console.error(`  ${problem}`);
    if (!result) {
      console.error("  the probe produced no result — the extension host died before reporting. Host output:");
      console.error((run.stderr || run.stdout || "(no output)").split("\n").slice(-25).join("\n"));
    }
    exitCode = 1;
  } else {
    console.log(`vsix-smoke: PASS — ${result.doors.length} door(s) answered in ${result.durationMs}ms`);
  }
} finally {
  if (keep) console.log(`vsix-smoke: kept working directory ${work}`);
  else fs.rmSync(work, { recursive: true, force: true });
}

process.exit(exitCode);

/**
 * A disposable editor, and where its two entry points are.
 *
 * REUSE BEFORE DOWNLOAD, deliberately. `downloadAndUnzipVSCode()` asks the update server for the
 * latest version first and only falls back to a local payload when it cannot reach it — so calling it
 * blind costs a fresh ~1 GiB unpacked copy per checkout the first time each one cuts a release.
 * t-3374e2 measured that download as the largest single consumer on this host and built the pooled
 * store for exactly it (`scripts/vscode-test-cache.ts`, `docs/runbooks/disk-and-vhdx.md`). A release
 * step is not the place to quietly re-earn that bill: any complete payload this checkout already
 * resolves is as good as the newest one, because what is being tested is the PACKAGE, not the editor.
 *
 * Order: explicit override, this checkout's cache, the pooled store, and only then the network.
 */
async function resolveEditor() {
  const override = process.env.TACHYON_SMOKE_VSCODE?.trim();
  if (override) {
    if (!fs.existsSync(override)) fail(`TACHYON_SMOKE_VSCODE points at nothing: ${override}`);
    return { executable: override, cli: cliFor(override), version: "override" };
  }

  const cached = cachedEditor();
  if (cached) return cached;

  let downloadAndUnzipVSCode;
  try {
    ({ downloadAndUnzipVSCode } = await import("@vscode/test-electron"));
  } catch (error) {
    fail(`@vscode/test-electron is unavailable, so no disposable editor can be resolved: ${String(error)}`);
  }
  console.log("vsix-smoke: no editor payload cached — downloading one (this is a one-off ~1 GiB)");
  const executable = await downloadAndUnzipVSCode();
  return { executable, cli: cliFor(executable), version: path.basename(path.dirname(executable)) };
}

/**
 * The newest complete payload already on disk, or nothing.
 *
 * The two locations and the `is-complete` marker are `@vscode/test-electron`'s own contract, restated
 * in `scripts/vscode-test-cache.ts`; a missing marker means a download is in flight or died mid-way,
 * so those bytes are never used. The names are compared as version tuples rather than as strings,
 * because `1.9.0` sorts above `1.128.0` alphabetically.
 */
function cachedEditor() {
  const stores = [path.join(root, ".vscode-test"), path.join(os.homedir(), ".cache", "tachyon", "vscode-test")];
  const found = [];
  for (const store of stores) {
    if (!fs.existsSync(store)) continue;
    for (const name of fs.readdirSync(store)) {
      const match = /^vscode-[a-z0-9-]+-(?<version>[0-9.]+)$/.exec(name);
      if (!match) continue;
      const dir = path.join(store, name);
      const executable = path.join(dir, process.platform === "darwin" ? "Contents/MacOS/Electron" : "code");
      if (!fs.existsSync(path.join(dir, "is-complete")) || !fs.existsSync(executable)) continue;
      found.push({ executable, cli: cliFor(executable), version: name, parts: match.groups.version.split(".").map(Number) });
    }
  }
  found.sort((a, b) => {
    for (let i = 0; i < Math.max(a.parts.length, b.parts.length); i++) {
      const diff = (b.parts[i] ?? -1) - (a.parts[i] ?? -1);
      if (diff !== 0) return diff;
    }
    return 0;
  });
  return found[0];
}

/** The CLI wrapper beside the Electron binary — `--install-extension` is a CLI operation. */
function cliFor(executable) {
  const cli = path.join(path.dirname(executable), "bin", process.platform === "win32" ? "code.cmd" : "code");
  return fs.existsSync(cli) ? cli : executable;
}

/** Wrap in a private X server. Real, because Electron needs one; private, because the human's is not ours. */
function headless(executable, args) {
  if (process.platform !== "linux") return [executable, args];
  const probe = spawnSync("xvfb-run", ["--help"], { stdio: "ignore" });
  if (probe.error) fail("xvfb-run is required to start a headless editor (apt install xvfb)");
  return ["xvfb-run", ["-a", "-s", "-screen 0 1280x800x24", executable, ...args]];
}

/**
 * The child's environment, scrubbed — both entries are MEASURED traps on this repo's own hosts.
 *
 * `ELECTRON_RUN_AS_NODE=1` is set in every process Tachyon spawns from the extension host, and it
 * turns the VS Code binary into a plain Node interpreter: the launch appears to work and rejects
 * every VS Code flag as a bad option. `VSCODE_IPC_HOOK_CLI` makes `bin/code` forward to whatever VS
 * Code is already running — so a smoke run would install into, and open folders in, the HUMAN'S live
 * editor instead of a disposable one. Both were hit while building this.
 *
 * The isolation vars are the same ones the editor-host gate uses (`.vscode-test.mjs`): a smoke must
 * not be able to see the live fleet's tmux server or the human's global settings, even by accident.
 */
function childEnv(work) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("VSCODE_") || key.startsWith("ELECTRON_")) delete env[key];
  }
  const tmux = path.join(work, "tmux");
  const settings = path.join(work, "global-settings-home");
  for (const dir of [tmux, settings]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  env.TMUX_TMPDIR = tmux;
  env.TACHYON_TMUX_SOCKET = `tachyon-vsix-smoke-${process.pid}`;
  env.TACHYON_GLOBAL_SETTINGS_HOME = settings;
  return env;
}
