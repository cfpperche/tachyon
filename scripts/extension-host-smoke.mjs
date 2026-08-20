import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runTests } from "@vscode/test-electron";

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
  fs.rmSync(staging, { recursive: true, force: true });
}
