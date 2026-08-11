import fs from "node:fs";
import path from "node:path";
import * as esbuild from "esbuild";

/**
 * t-d1f356 — the three daemon fixtures are bundled ONCE per vitest round and spawned as plain `node`.
 *
 * WHY. Every fixture spawn used to be `node node_modules/vite-node/vite-node.mjs <fixture>.ts`, and
 * vite-node re-transforms the daemon's whole import graph in EACH child, with no cache between
 * processes. Measured on this host (t-d3da7f/t-d1f356): pure node 0.01s, vite-node on a trivial .ts
 * 0.18s, vite-node on the daemon graph 1.98s — so ~91% of every child's boot was the transform, paid
 * 17 times over in `engineSupervisor.test.ts` alone. PRODUCTION NEVER PAYS IT: the supervisor launches
 * an already-bundled `engine-daemon.cjs` (esbuild.mjs, `engineDaemon`) with a staged runtime. Bundling
 * the fixture the same way removes harness cost and leaves the child MORE like production, not less.
 *
 * THE HAZARD THIS FILE EXISTS TO CONTAIN, found by running it rather than by reading it. Collapsing an
 * ESM graph into ONE CommonJS module changes what `module` means for every file in it. `daemonMain.ts`
 * ends with `if (require.main === module) { … runEngineDaemon(process.argv[2]) }` — production's own
 * entry hook. Under vite-node each file is its own module, so that guard is false for a file the
 * fixture merely imports. Inside a cjs bundle the whole graph SHARES the entry's `module`, the guard
 * flips to true, and the daemon starts a second time next to the fixture's own `runEngineDaemon(…)`.
 * Reproduced before the fix: `node engineSupervisorWorker.cjs` with no argv threw daemonMain's
 * "missing persistent engine daemon options" instead of the fixture's own usage error.
 *
 * `neutralizeNonEntrySelfStart` is the containment: one esbuild `define` that makes `require.main`
 * `undefined` inside the bundle, restoring exactly the vite-node semantics — the ENTRY starts the
 * daemon, an imported module never does. It is narrow on purpose: the whole bundle contains exactly
 * one `require.main` reference (daemonMain's). `test/unit/daemonFixtureBundle.test.ts` builds both
 * variants and asserts the raw one really does double-start, so the guard is never trusted green
 * without having been seen red.
 *
 * `__dirname` moves too, and that one is inert rather than contained: the daemon graph's only
 * module-relative path is `engineService.ts`'s `path.join(__dirname, "pi-bridge-extension.mjs")`,
 * which `Workspace.ts` statSync-gates to `undefined` when the file is absent. It was absent beside
 * `src/engine-service/` under vite-node and it is absent beside the bundle, so the daemon sees the
 * same `undefined` on both sides. The bundle test asserts that absence, so dropping an extension next
 * to the bundles becomes a decision somebody makes rather than a fixture that quietly changes. There
 * is no `import.meta` anywhere in the three graphs.
 *
 * STALENESS: the bundles are built once per round, in globalSetup. `vitest --watch` does not re-run
 * globalSetup, so a source edit mid-watch is picked up by the test file and NOT by the child until the
 * run is restarted. A full run, a focused run and `verify:full` each build fresh.
 */

const ROOT = path.resolve(__dirname, "../..");

/** Kept in the same shape as `FIXTURE_WORKERS` in `daemonFixtureEnvIsolation.test.ts`, which owns the completeness check. */
export const DAEMON_FIXTURE_WORKERS = [
  "daemonEngineServiceWorker.ts",
  "engineSupervisorWorker.ts",
  "engineControlWorker.ts",
] as const;

export type DaemonFixtureWorker = (typeof DAEMON_FIXTURE_WORKERS)[number];

/** Set by `test/globalSetup/daemonFixtureBundles.ts`; read by every fixture spawn site. */
export const DAEMON_FIXTURE_BUNDLE_DIR_ENV = "TACHYON_TEST_DAEMON_FIXTURE_BUNDLE_DIR";

export function daemonFixtureBundleName(worker: DaemonFixtureWorker): string {
  return worker.replace(/\.ts$/, ".cjs");
}

export interface DaemonFixtureBundleBuild {
  outDir: string;
  ms: number;
  files: Array<{ file: string; bytes: number }>;
}

/**
 * Build all three fixtures into `outDir`. `neutralizeNonEntrySelfStart: false` reproduces the
 * double-start hazard on purpose and is only for the fail-before case in the bundle test.
 */
export async function buildDaemonFixtureBundles(
  outDir: string,
  opts: { neutralizeNonEntrySelfStart?: boolean } = {},
): Promise<DaemonFixtureBundleBuild> {
  const neutralize = opts.neutralizeNonEntrySelfStart ?? true;
  const started = process.hrtime.bigint();
  await esbuild.build({
    entryPoints: DAEMON_FIXTURE_WORKERS.map((worker) => path.join(ROOT, "test/fixtures", worker)),
    outdir: outDir,
    outExtension: { ".js": ".cjs" },
    bundle: true,
    // The production engine bundle's target shape (esbuild.mjs `engineDaemon`), so the child runs the
    // same kind of artifact the supervisor launches for real.
    platform: "node",
    format: "cjs",
    target: "node20",
    sourcemap: false,
    logLevel: "silent",
    ...(neutralize ? { define: { "require.main": "undefined" } } : {}),
  });
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  return {
    outDir,
    ms,
    files: DAEMON_FIXTURE_WORKERS.map((worker) => {
      const file = path.join(outDir, daemonFixtureBundleName(worker));
      return { file, bytes: fs.statSync(file).size };
    }),
  };
}

/** Absolute path of the bundled fixture this round built. Spawn it with plain `process.execPath`. */
export function bundledDaemonFixture(worker: DaemonFixtureWorker): string {
  const dir = process.env[DAEMON_FIXTURE_BUNDLE_DIR_ENV];
  if (!dir) {
    throw new Error(
      `${DAEMON_FIXTURE_BUNDLE_DIR_ENV} is unset: the daemon fixture bundles are built in globalSetup `
      + "(vitest.config.ts -> test/globalSetup/daemonFixtureBundles.ts). Run this file through vitest.",
    );
  }
  const file = path.join(dir, daemonFixtureBundleName(worker));
  if (!fs.existsSync(file)) throw new Error(`daemon fixture bundle missing: ${file}`);
  return file;
}
