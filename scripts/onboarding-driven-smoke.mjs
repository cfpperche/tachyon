import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runTests } from "@vscode/test-electron";

/**
 * t-505f13 — the DRIVEN onboarding smoke: an EMPTY workspace folder (no tachyon.yml, no fixture
 * files) opened in a real extension host, driven through the production doors by
 * `test/onboarding-driven`. Same isolation contract as `scripts/extension-host-smoke.mjs`: private
 * tmux socket, isolated TMUX_TMPDIR, a real Node for the engine runtime, test seams on.
 *
 * Run under `xvfb-run -a` on a headless host, exactly like the gate runs the extension smoke.
 */

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extensionPath = process.env.TACHYON_EXTENSION_DEVELOPMENT_PATH || path.join(repo, "apps/vscode-extension");
const staging = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-onboarding-driven-"));
const fixture = path.join(staging, "empty-workspace");
const tmuxDir = path.join(staging, "tmux");
fs.mkdirSync(fixture, { recursive: true });
fs.mkdirSync(tmuxDir, { recursive: true, mode: 0o700 });

const env = {
  ELECTRON_RUN_AS_NODE: undefined,
  TACHYON_DEV_HOST_ENGINE_RUNTIME: process.execPath,
  TACHYON_TEST_SEAMS: "1",
  TACHYON_TMUX_SOCKET: `tachyon-onboarding-driven-${process.pid}`,
  TMUX_TMPDIR: tmuxDir,
  ONBOARDING_DRIVEN_RESULT: path.join(staging, "result.json"),
};

try {
  const exitCode = await runTests({
    extensionDevelopmentPath: extensionPath,
    extensionTestsPath: path.join(repo, "test/onboarding-driven"),
    extensionTestsEnv: env,
    launchArgs: [`--folder-uri=${fixture}`, "--disable-crash-reporter", "--skip-welcome"],
  });
  const result = fs.existsSync(env.ONBOARDING_DRIVEN_RESULT)
    ? fs.readFileSync(env.ONBOARDING_DRIVEN_RESULT, "utf8")
    : "(no result written — see the suite log above)";
  console.log(result);
  process.exitCode = exitCode;
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = typeof error?.code === "number" ? error.code : 1;
} finally {
  // A test that spawns real processes leaves none behind: the shell session lives on the private
  // socket, and taking the socket's server down is what keeps that promise here.
  try {
    const { execFileSync } = await import("node:child_process");
    execFileSync("tmux", ["-L", env.TACHYON_TMUX_SOCKET, "kill-server"], { stdio: "ignore" });
  } catch {
    /* no server — nothing to clean */
  }
  fs.rmSync(staging, { recursive: true, force: true });
}
