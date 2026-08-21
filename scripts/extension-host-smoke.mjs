import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { runTests } from "@vscode/test-electron";

/**
 * Headless is THIS script's rule, not its caller's.
 *
 * `runTests` launches a real editor, and on a workstation with a display (WSLg exports DISPLAY=:0)
 * that editor is a window in the human's face. The guard used to live in ONE call site —
 * `verify-full.mjs` wrapped the npm script in `xvfb-run` — so `npm run smoke:extension-host`, which
 * is what anyone iterating actually types, popped a window every run. Measured 2026-08-20: an agent
 * ran it six times in one afternoon and the owner watched the windows appear over his editor.
 *
 * `vsix-smoke.mjs` already started its editor headless by itself; this is that same rule, in the
 * other smoke, where the launch is. The env marker keeps a caller that still wraps — or a nested
 * re-exec — from starting a second Xvfb.
 */
if (process.platform === "linux" && !process.env.TACHYON_SMOKE_HEADLESS) {
  if (spawnSync("xvfb-run", ["--help"], { stdio: "ignore" }).error) {
    console.error("xvfb-run is required to start a headless editor (apt install xvfb)");
    process.exit(1);
  }
  const relaunch = spawnSync(
    "xvfb-run",
    ["-a", "-s", "-screen 0 1280x800x24", process.execPath, fileURLToPath(import.meta.url), ...process.argv.slice(2)],
    { stdio: "inherit", env: { ...process.env, TACHYON_SMOKE_HEADLESS: "1" } },
  );
  process.exit(relaunch.status ?? 1);
}

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extensionPath = process.env.TACHYON_EXTENSION_DEVELOPMENT_PATH || path.join(repo, "apps/vscode-extension");
const staging = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-extension-smoke-"));
const fixture = path.join(staging, "sample-workspace");
const tmuxDir = path.join(staging, "tmux");
const settingsHome = path.join(staging, "global-settings-home");
fs.cpSync(path.join(repo, "test/fixtures/sample-workspace"), fixture, { recursive: true });
fs.mkdirSync(tmuxDir, { recursive: true, mode: 0o700 });
fs.mkdirSync(settingsHome, { recursive: true, mode: 0o700 });

const env = {
  ELECTRON_RUN_AS_NODE: undefined,
  TACHYON_DEV_HOST_ENGINE_RUNTIME: process.execPath,
  TACHYON_GLOBAL_SETTINGS_HOME: settingsHome,
  TACHYON_TEST_SEAMS: "1",
  TACHYON_TMUX_SOCKET: `tachyon-extension-smoke-${process.pid}`,
  TMUX_TMPDIR: tmuxDir,
};

const engineKey = createHash("sha256")
  .update(`${fs.realpathSync(fixture)}\u0000tmux:${env.TACHYON_TMUX_SOCKET}`)
  .digest("hex")
  .slice(0, 32);

try {
  const exitCode = await runTests({
    extensionDevelopmentPath: extensionPath,
    extensionTestsPath: path.join(repo, "test/extension-host-smoke"),
    extensionTestsEnv: env,
    launchArgs: [`--folder-uri=${fixture}`, "--disable-crash-reporter"],
  });
  process.exitCode = exitCode;
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = typeof error?.code === "number" ? error.code : 1;
} finally {
  if (process.platform === "linux") {
    spawnSync("systemctl", ["--user", "stop", `tachyon-engine-${engineKey}.service`], { stdio: "ignore" });
    spawnSync("systemctl", ["--user", "reset-failed", `tachyon-engine-${engineKey}.service`], { stdio: "ignore" });
  }
  fs.rmSync(staging, { recursive: true, force: true });
}
