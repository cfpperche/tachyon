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
 *   2. ACTIVATION (a real, disposable VS Code). Install the .vsix into a throwaway
 *      extensions/user-data directory, start an extension host on a CONFIGURED folder, and open one
 *      door per live surface (`test/vsix-smoke/probe/suite.js`). This is the layer that proves the
 *      package STARTS — the floor layer 1 cannot reach, because a bundle can be closed and still throw.
 *
 * t-a8e1f7 — LAYER 2 RUNS TWICE, and the workspace carries a `tachyon.yml`.
 *
 * Until now the workspace was empty, so no engine was ever requested and every door was an engine-free
 * door. That left the packaged engine untouched until a human installed it. The disposable editor is
 * real Electron, which is exactly the host where the engine used to die, so the equipment for this
 * already existed. Both runs use it.
 *
 *   engine-ready — Node on PATH. The engine must become ready and answer a query (t-d11d57).
 *   node-missing — PATH pruned of Node. The shell must refuse by name, not time out.
 *
 * The second run reproduces a host that offers no Node at all. It is NOT the graphical-launcher case,
 * and believing it was cost a wrong green: VS Code re-probes the login shell and merges its PATH, so
 * the host read `~/.nvm/.../bin/node` even after the runner pruned it. See `--force-disable-user-env`
 * below.
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
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { packageClosureViolations } from "./package-closure.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROBE = path.join(root, "test", "vsix-smoke", "probe");
/** A host that has not answered in this long is not going to; the measured run is ~2s. */
const ACTIVATION_TIMEOUT_MS = 180_000;

/** This run's private tmux server. The engine identity folds it in, so the engine is private too. */
const TMUX_SOCKET = `tachyon-vsix-smoke-${process.pid}`;

/** The command the engine door asks the daemon to report back. */
const ENGINE_COMMAND = "vsix-smoke-engine-door";

/**
 * The workspace configuration both activation runs open.
 *
 * It declares one command and nothing else. A declared agent or terminal would start a process, and
 * this smoke measures the engine rather than the fleet. The engine still has to stage a runtime,
 * launch its daemon, parse this file and project it — which is the whole claim.
 */
const SMOKE_CONFIG = `# Written by scripts/vsix-smoke.mjs (t-a8e1f7). Presence is what requests the engine.
commands:
  ${ENGINE_COMMAND}:
    cmd: "echo vsix-smoke"
`;

/** Every engine this run started, keyed the way the product keys it. Teardown reads this list. */
const startedEngines = [];

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
  const baseEnv = { ...childEnv(work), DONT_PROMPT_WSL_INSTALL: "1" };
  for (const dir of [extensionsDir, userDataDir]) fs.mkdirSync(dir, { recursive: true });

  const install = spawnSync(
    editor.cli,
    ["--install-extension", vsix, "--extensions-dir", extensionsDir, "--user-data-dir", userDataDir],
    { encoding: "utf8", env: baseEnv },
  );
  if (install.status !== 0) {
    console.error(install.stdout ?? "");
    console.error(install.stderr ?? "");
    fail("the editor refused to install the package");
  }
  console.log(`vsix-smoke: installed into a disposable editor (${editor.version})`);

  const prunedPath = pathWithoutNode(baseEnv.PATH);

  /** Open every door of one activation run. Returns false when the run did not pass. */
  const activation = ({ label, expect, env }) => {
    const workspace = configuredWorkspace(work, label);
    const resultFile = path.join(work, `result-${label}.json`);
    const args = [
      `--user-data-dir=${userDataDir}`,
      `--extensions-dir=${extensionsDir}`,
      `--extensionDevelopmentPath=${PROBE}`,
      `--extensionTestsPath=${path.join(PROBE, "suite.js")}`,
      "--disable-workspace-trust",
      "--disable-updates",
      "--disable-crash-reporter",
      "--skip-release-notes",
      // MEASURED, and it is why the refusal run is honest. Without this flag VS Code runs the user's
      // login shell and merges the PATH it prints. The first attempt handed the host a PATH with no
      // Node, and the extension host read `/home/goat/.nvm/.../bin` anyway, so activation succeeded and
      // the door was red for the wrong reason. VS Code 1.128.0 `main.js`: `resolveShellEnv(): skipped
      // (--force-disable-user-env)`. Both runs pass it, so PATH is the only difference between them.
      "--force-disable-user-env",
      "--no-sandbox",
      workspace,
    ];

    // Never the human's display: project guidance forbids opening a desktop window unasked, and an
    // Electron window stealing focus mid-release is exactly that.
    const [command, commandArgs] = headless(editor.executable, args);
    console.log(`vsix-smoke: activation run '${label}' — ${expect}`);
    const run = spawnSync(command, commandArgs, {
      encoding: "utf8",
      timeout: ACTIVATION_TIMEOUT_MS,
      env: { ...env, TACHYON_SMOKE_RESULT: resultFile, TACHYON_SMOKE_EXPECT: expect },
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
      console.error(`vsix-smoke: FAILED — run '${label}' did not answer cleanly (exit ${run.status})`);
      for (const problem of result?.failures ?? []) console.error(`  ${problem}`);
      if (!result) {
        console.error("  the probe produced no result — the extension host died before reporting. Host output:");
        console.error((run.stderr || run.stdout || "(no output)").split("\n").slice(-25).join("\n"));
      }
      return false;
    }
    console.log(`vsix-smoke: run '${label}' PASS — ${result.doors.length} door(s) in ${result.durationMs}ms`);
    return true;
  };

  // Run one proves the fix. Run two proves the refusal a launcher-started editor gets.
  const ready = activation({ label: "engine-ready", expect: "engine-ready", env: baseEnv });
  const refused = activation({ label: "node-missing", expect: "node-missing", env: { ...baseEnv, PATH: prunedPath } });
  if (!ready || !refused) exitCode = 1;
  else console.log("vsix-smoke: PASS — the packaged engine starts on Electron and refuses by name without Node");
} finally {
  // t-10fda8 — stop the private tmux server BEFORE removing the tree. Removing the directory is
  // not cleanup (t-8f48da): a server whose socket file is unlinked keeps running.
  retireEngines(work);
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
  env.TACHYON_TMUX_SOCKET = TMUX_SOCKET;
  env.TACHYON_GLOBAL_SETTINGS_HOME = settings;
  return env;
}

/**
 * A workspace folder that requests the engine, plus the identity its engine will have.
 *
 * Each run gets its OWN folder. The engine key is a digest of the folder, so two folders are two
 * engines, and one run can never adopt the other's daemon. The key is recorded here rather than at
 * teardown because teardown runs after the folder is gone.
 */
function configuredWorkspace(work, label) {
  const workspace = path.join(work, `workspace-${label}`);
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, "tachyon.yml"), SMOKE_CONFIG, "utf8");
  startedEngines.push(engineWorkspaceKey(workspace));
  return workspace;
}

/**
 * The digest the product computes for an engine identity, restated.
 *
 * `engineWorkspaceKey` (packages/engine/src/engine-service/engineSupervisor.ts) folds the tmux socket override into
 * the key, so this run owns a distinct control socket, state directory and systemd unit. The rule is
 * repeated here, as `.vscode-test.mjs` repeats it, because this script must not import build output.
 * `engineIdentityIsolation` in the unit tests pins the shape, so a change fails there instead of
 * silently orphaning units.
 */
function engineWorkspaceKey(workspaceRoot) {
  const material = `${fs.realpathSync(workspaceRoot)}\u0000tmux:${TMUX_SOCKET}`;
  return createHash("sha256").update(material).digest("hex").slice(0, 32);
}

/**
 * Stop every engine this run started, and the tmux server behind it.
 *
 * The engine is persistent by design, so it outlives the extension host that asked for it. A smoke
 * that left one behind would leak a daemon per release. Names are derived from THIS run's folders;
 * nothing here globs, so a live fleet engine is unreachable from this code.
 *
 * The staged runtime and bundle under `~/.local/share/tachyon/` are deliberately left alone. They are
 * content-addressed and shared with real installs, so they are a cache, not residue.
 *
 * t-10fda8 — the kill MUST carry the smoke's private `TMUX_TMPDIR`. `-L <name>` resolves the socket
 * under `$TMUX_TMPDIR/tmux-<uid>/`, and this process's ambient env does not have that value (only the
 * editor child does — see `childEnv`). Measured: `tmux -L <name> kill-server` without that env looks
 * in the default socket directory, returns non-zero, and the smoke then `rmSync`s the work tree while
 * the server keeps running with cwd under the deleted workspace. That is the t-8f48da shape from a
 * producer that never went through `trackTempDir`.
 */
function retireEngines(work) {
  for (const key of startedEngines) {
    const unit = `tachyon-engine-${key}.service`;
    quiet("systemctl", ["--user", "stop", unit]);
    quiet("systemctl", ["--user", "reset-failed", unit]);
    const runtimeDir = process.env.XDG_RUNTIME_DIR?.trim();
    if (runtimeDir) fs.rmSync(path.join(runtimeDir, "tachyon", "engines", key), { recursive: true, force: true });
    const stateHome = process.env.XDG_STATE_HOME?.trim() || path.join(os.homedir(), ".local", "state");
    fs.rmSync(path.join(stateHome, "tachyon", "engines", key), { recursive: true, force: true });
  }
  const tmuxTmpdir = path.join(work, "tmux");
  // Drop $TMUX so this kill cannot be redirected at the fleet (t-9713ff / test/helpers/tmuxEnv.ts).
  const tmuxEnv = { ...process.env, TMUX_TMPDIR: tmuxTmpdir };
  delete tmuxEnv.TMUX;
  delete tmuxEnv.TMUX_PANE;
  // Prefer the absolute socket path: -S does not depend on ambient TMUX_TMPDIR resolution.
  const socket = path.join(tmuxTmpdir, `tmux-${process.getuid?.() ?? 0}`, TMUX_SOCKET);
  if (fs.existsSync(socket)) quiet("tmux", ["-S", socket, "kill-server"], tmuxEnv);
  else quiet("tmux", ["-L", TMUX_SOCKET, "kill-server"], tmuxEnv);
  // Belt: if kill-server missed (socket already unlinked, race), stop any server whose OWN
  // TMUX_TMPDIR still names this work tree — identity from /proc, never from a process name.
  reapPrivateTmuxUnder(work);
}

/**
 * Stop every live `tmux: server` whose own `TMUX_TMPDIR` sits under `root`.
 *
 * Same identity rule as `test/helpers/tmuxReap.ts`: the server's environ, not ours. This script is a
 * release step, not a vitest file, so it cannot share `trackTempDir`'s afterAll — it has to reap
 * itself before `rmSync`. Linux-only (`/proc`); elsewhere there is nothing to read.
 */
function reapPrivateTmuxUnder(root) {
  if (!fs.existsSync("/proc/self")) return;
  const bound = path.resolve(root) + path.sep;
  for (const name of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      if (fs.readFileSync(`/proc/${name}/comm`, "utf8").trim() !== "tmux: server") continue;
      const env = readProcEnviron(name);
      const tmuxTmpdir = env.get("TMUX_TMPDIR");
      if (!tmuxTmpdir) continue;
      const resolved = path.resolve(tmuxTmpdir);
      if (resolved !== path.resolve(root) && !resolved.startsWith(bound)) continue;
      // Pane fork children look like servers (t-ffc5bf); a real server has /dev/null on stdin.
      try {
        const stdin = fs.readlinkSync(`/proc/${name}/fd/0`);
        if (stdin.startsWith("/dev/pts/")) continue;
      } catch {
        /* unreadable: keep, never treat "could not measure" as "may pass" */
      }
      const argv = fs.readFileSync(`/proc/${name}/cmdline`, "utf8").split("\0").filter(Boolean);
      let socketPath = null;
      for (let i = 0; i < argv.length; i++) {
        if (argv[i] === "-S" && argv[i + 1]) {
          socketPath = path.resolve(argv[i + 1]);
          break;
        }
        if (argv[i] === "-L" && argv[i + 1]) {
          socketPath = path.join(resolved, `tmux-${process.getuid?.() ?? 0}`, argv[i + 1]);
          break;
        }
      }
      if (socketPath && fs.existsSync(socketPath)) {
        quiet("tmux", ["-S", socketPath, "kill-server"]);
        continue;
      }
      // Socket gone, process still up — the exact residue this task found. Re-check identity, then SIGTERM.
      if (fs.readFileSync(`/proc/${name}/comm`, "utf8").trim() !== "tmux: server") continue;
      if (readProcEnviron(name).get("TMUX_TMPDIR") !== tmuxTmpdir) continue;
      process.kill(Number(name), "SIGTERM");
    } catch {
      /* pid exited mid-scan, or not readable — not ours either way */
    }
  }
}

function readProcEnviron(pid) {
  const env = new Map();
  for (const entry of fs.readFileSync(`/proc/${pid}/environ`, "utf8").split("\0")) {
    const eq = entry.indexOf("=");
    if (eq > 0) env.set(entry.slice(0, eq), entry.slice(eq + 1));
  }
  return env;
}

/** Absent is the goal state, so every teardown call is best effort. */
function quiet(bin, argv, env = process.env) {
  try {
    const scrubbed = { ...env };
    delete scrubbed.TMUX;
    delete scrubbed.TMUX_PANE;
    execFileSync(bin, argv, { stdio: "ignore", env: scrubbed });
  } catch {
    /* already gone */
  }
}

/**
 * The same PATH with every directory that holds a Node executable removed.
 *
 * The pruning is by MEASUREMENT rather than by name: any directory answering for `node` goes, wherever
 * it lives. A named list would pass on a host that keeps Node somewhere else, which is the one host
 * this run exists to describe.
 *
 * The run is refused if pruning would also remove the tools the engine needs for other reasons. A red
 * door must mean "no Node", never "no systemd".
 */
function pathWithoutNode(value) {
  const directories = (value ?? "").split(path.delimiter).filter(Boolean);
  const kept = directories.filter((directory) => !holds(directory, "node"));
  if (kept.length === directories.length) {
    fail("no directory on PATH holds a Node executable, so the engine-ready run has nothing to prove");
  }
  for (const tool of ["systemd-run", "tmux", "git"]) {
    if (!kept.some((directory) => holds(directory, tool))) {
      fail(`pruning Node from PATH also removes ${tool}, so the refusal run would measure the wrong thing`);
    }
  }
  return kept.join(path.delimiter);
}

/** True when the directory holds an executable file of that name. */
function holds(directory, name) {
  try {
    const candidate = path.join(directory, name);
    if (!fs.statSync(candidate).isFile()) return false;
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
