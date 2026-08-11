import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  DAEMON_FIXTURE_BUNDLE_DIR_ENV,
  DAEMON_FIXTURE_WORKERS,
  buildDaemonFixtureBundles,
  bundledDaemonFixture,
  daemonFixtureBundleName,
} from "../helpers/daemonFixtureBundle.js";
import { assertNoFleetLeak, isolatedDaemonChildEnv } from "../helpers/isolatedDaemonEnv.js";
import { makeTempDir } from "../helpers/tempDir.js";

/**
 * t-d1f356 — what changed when the daemon fixtures stopped being TypeScript run through vite-node and
 * became one CommonJS bundle each.
 *
 * The measured win is the reason for the change (a vite-node child re-transformed the daemon graph in
 * 1.98s, seventeen times over in `engineSupervisor.test.ts` alone). This file is about the part that
 * was NOT deducible and had to be run: collapsing an ESM graph into one CJS module changes what
 * `module` and `__dirname` mean for every file inside it. The suites that boot a real daemon are the
 * behavioural proof; these two cases pin the exact semantics they depend on, and the first one is
 * written so the guard is seen RED — it builds the hazard on purpose and asserts it bites.
 */

const ROOT = path.resolve(__dirname, "../..");

/** Run a bundle with no argv and collect stderr. No argv is the point: each entry has its own usage error. */
function runWithoutArgs(bundle: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // The bundles are real daemon code even when they only reach their usage error, so they get the
    // same isolated env as every other fixture spawn (t-93ec7f).
    const childEnv = isolatedDaemonChildEnv();
    assertNoFleetLeak(childEnv);
    const child = spawn(process.execPath, [bundle], { stdio: ["ignore", "ignore", "pipe"], env: childEnv });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", () => resolve(stderr));
  });
}

describe("daemon fixture bundles (t-d1f356)", () => {
  it("only the ENTRY starts a daemon — the raw cjs bundle really does self-start daemonMain a second time", async () => {
    // FAIL-BEFORE, in the tree rather than in a journal. `daemonMain.ts` ends with production's own
    // `if (require.main === module)` entry hook. Under vite-node every file is its own module, so that
    // is false for a file the fixture merely imports; inside a cjs bundle the whole graph shares the
    // entry's `module`, so it flips to true and the daemon boots twice — once from daemonMain, once
    // from the fixture's own `runEngineDaemon(...)`. `buildDaemonFixtureBundles` neutralizes it with a
    // single `require.main` define, and this proves the define is load-bearing rather than decorative.
    const rawDir = makeTempDir("tachyon-daemon-fixture-raw-");
    await buildDaemonFixtureBundles(rawDir, { neutralizeNonEntrySelfStart: false });
    const raw = await runWithoutArgs(path.join(rawDir, daemonFixtureBundleName("engineSupervisorWorker.ts")));
    expect(raw).toContain("missing persistent engine daemon options"); // daemonMain's entry hook fired
    expect(raw).not.toContain("usage: engineSupervisorWorker");

    const shipped = await runWithoutArgs(bundledDaemonFixture("engineSupervisorWorker.ts"));
    expect(shipped).toContain("usage: engineSupervisorWorker"); // the fixture entry, and only it
    expect(shipped).not.toContain("missing persistent engine daemon options");
  });

  it("the daemon's one module-relative path resolves to the same nothing it did under vite-node", () => {
    // `__dirname` moves with the bundle, and the daemon graph reads it exactly once:
    // `engineService.ts` builds `path.join(__dirname, "pi-bridge-extension.mjs")`, which `Workspace.ts`
    // statSync-gates to `undefined` when the file is not there. It was not there beside
    // `src/engine-service/` and it is not there beside the bundles, so the daemon sees the identical
    // `undefined` on both sides — which is why moving `__dirname` changed no behaviour. Staging a real
    // extension next to the bundles (production's layout, where the file DOES exist) would change what
    // the fixtures do; this keeps that a decision somebody makes on purpose instead of a fixture that
    // quietly grew a Pi bridge.
    const bundleDir = process.env[DAEMON_FIXTURE_BUNDLE_DIR_ENV] ?? "";
    expect(bundleDir).not.toBe("");
    expect(fs.existsSync(path.join(ROOT, "src/engine-service/pi-bridge-extension.mjs"))).toBe(false);
    expect(fs.existsSync(path.join(bundleDir, "pi-bridge-extension.mjs"))).toBe(false);
  });

  it("every declared fixture is built once per round and is a plain node script", () => {
    for (const worker of DAEMON_FIXTURE_WORKERS) {
      const bundle = bundledDaemonFixture(worker);
      expect(fs.statSync(bundle).isFile()).toBe(true);
      expect(fs.existsSync(path.join(ROOT, "test/fixtures", worker))).toBe(true);
    }
  });
});
