import { defineConfig } from "vitest/config";
import os from "node:os";
import path from "node:path";
import { decideHeavyGate } from "./src/host/hostResources";

/**
 * t-019dac: auto-size workers from free RAM (grows if you add memory).
 * Still never nproc-blind; hard-capped inside decideHeavyGate/recommendVitestMaxWorkers.
 * Forced override: TACHYON_VITEST_MAX_WORKERS.
 */
const gate = decideHeavyGate({ cpuCount: os.cpus().length || 1 });
export const VITEST_MAX_WORKERS = gate.ok ? gate.workers : 1;

export default defineConfig({
  resolve: {
    alias: {
      vscode: path.resolve(__dirname, "test/mocks/vscode.ts"),
    },
  },
  test: {
    include: ["test/unit/**/*.test.ts", "test/integration/**/*.test.ts"],
    environment: "node",
    testTimeout: 30_000,
    hookTimeout: 30_000,
    maxWorkers: VITEST_MAX_WORKERS,
    // t-aaad95 — never let the suite read the DEVELOPER's real ~/.tachyon/settings.json. A machine
    // where somebody has set a card template would otherwise disagree with CI, and the failure gives
    // no hint that a file outside the repo caused it. Tests that want a document write one into their
    // own temp home via `useGlobalSettingsHome`.
    env: { TACHYON_GLOBAL_SETTINGS_HOME: path.join(os.tmpdir(), "tachyon-vitest-no-global-settings") },
  },
});
