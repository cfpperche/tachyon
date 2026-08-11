import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DAEMON_FIXTURE_BUNDLE_DIR_ENV, buildDaemonFixtureBundles } from "../helpers/daemonFixtureBundle.js";

/**
 * t-d1f356 — bundle the three daemon fixtures ONCE per round, here, so no test child ever pays a
 * vite-node transform of the daemon import graph again. The reasoning, the measured numbers and the
 * `require.main === module` hazard live in `test/helpers/daemonFixtureBundle.ts`.
 *
 * WHY ITS OWN globalSetup FILE and not a second job inside `tmuxLeakGuard.ts`: teardown order. The
 * leak guard's teardown THROWS on a finding, and a build directory that only gets removed after it
 * would leak ~13MB of /tmp on exactly the runs that already went red. Registered after the guard in
 * `vitest.config.ts`, so this teardown runs first.
 *
 * WHY A PER-RUN TEMP DIRECTORY and not `node_modules/.cache`: in this repo `node_modules` is a symlink
 * shared by every agent worktree, so a cached bundle path there would hand one agent's compiled daemon
 * to another agent's suite. The output is per-run and removed with the run.
 */

let outDir = "";

export async function setup(): Promise<void> {
  // Workers are forked after this returns, so they inherit the pointer — the same mechanism the tmux
  // leak guard uses for its run stamp.
  outDir = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-daemon-fixture-bundles-"));
  const built = await buildDaemonFixtureBundles(outDir);
  process.env[DAEMON_FIXTURE_BUNDLE_DIR_ENV] = outDir;
  const total = built.files.reduce((sum, entry) => sum + entry.bytes, 0);
  process.stderr.write(
    `[daemon-fixture-bundles] ${built.files.length} fixtures bundled in ${built.ms.toFixed(0)}ms `
    + `(${(total / 1024 / 1024).toFixed(1)}MB) -> ${outDir}\n`,
  );
}

export async function teardown(): Promise<void> {
  if (outDir === "") return;
  fs.rmSync(outDir, { recursive: true, force: true });
}
