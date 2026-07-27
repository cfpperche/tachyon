import { defineConfig } from "@vscode/test-cli";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * t-d84837 — the editor-host suite runs against a COPY of its fixture, staged outside the Tachyon
 * worktrees base.
 *
 * Tachyon deliberately refuses to boot a full instance (Bridge + tmux engine + declared agents) for
 * a folder under the worktrees base: every managed worktree is a checkout of the repo and carries
 * its own `tachyon.yml`, so booting it would raise a phantom second instance
 * (`shouldActivateFolder`, t-2a73d6). That guard is correct and stays untouched.
 *
 * But when the REPO ITSELF is checked out under that base — which is what every agent worktree is —
 * the in-repo fixture inherits the exclusion. The extension activates, no workspace is ever created,
 * and every scenario needing a live workspace fails. Measured on clean `main` from a worktree:
 * 6 passing / 17 failing, with no `.tachyon/` written, no Bridge port bound, no engine unit started.
 * Nothing explains it in the logs, because the folder is simply filtered out before anything runs.
 *
 * Staging the fixture in the OS temp dir removes that coincidence without weakening the guard: the
 * suite exercises the same activation path a human's primary checkout gets, from anywhere. It also
 * stops the tests that mutate `tachyon.yml` from dirtying the committed fixture.
 */
const STAGING_ROOT = path.join(os.tmpdir(), "tachyon-vscode-test");

/**
 * The engine daemon is launched by `systemd-run` using a content-addressed COPY of the shell's
 * `process.execPath`. Inside the editor host that is the VS Code binary, and an Electron binary
 * copied away from its install directory cannot start: it dies with `error while loading shared
 * libraries: libffmpeg.so`, which systemd reports as `status=127`, so the engine never becomes
 * ready and activation fails with "persistent engine did not become ready in time".
 *
 * `TACHYON_DEV_HOST_ENGINE_RUNTIME` is the seam the Dev Host already uses for exactly this, honoured
 * on the `dev` channel that `npm run build` produces. Point it at the real Node running this config.
 */
const ENGINE_RUNTIME_ENV = { TACHYON_DEV_HOST_ENGINE_RUNTIME: process.execPath };

function stagedFixture(relativePath) {
  const source = path.resolve(import.meta.dirname, relativePath);
  const staged = path.join(STAGING_ROOT, path.basename(source));
  // Fresh every run: a fixture a previous run edited must never leak into the next one.
  fs.rmSync(staged, { recursive: true, force: true });
  fs.mkdirSync(STAGING_ROOT, { recursive: true });
  fs.cpSync(source, staged, { recursive: true });
  return staged;
}

export default defineConfig([
  {
    label: "single-root",
    files: "test/integration/**/*.test.js",
    workspaceFolder: stagedFixture("test/fixtures/sample-workspace"),
    env: ENGINE_RUNTIME_ENV,
    mocha: {
      ui: "bdd",
      timeout: 30000,
    },
  },
  {
    // Not staged: the multi-root fixture is a `.code-workspace` whose folder entries would need
    // rewriting to move. Left as-is rather than half-moved — tracked separately if it needs the
    // same treatment.
    label: "multi-root",
    files: "test/integration-multiroot/**/*.test.js",
    workspaceFolder: "test/fixtures/multiroot/multi.code-workspace",
    env: ENGINE_RUNTIME_ENV,
    mocha: {
      ui: "bdd",
      timeout: 30000,
    },
  },
]);
