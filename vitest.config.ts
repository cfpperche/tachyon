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
    include: ["test/unit/**/*.test.ts", "test/integration/**/*.test.ts", "test/product-invariants/**/*.test.ts"],
    environment: "node",
    testTimeout: 30_000,
    hookTimeout: 30_000,
    maxWorkers: VITEST_MAX_WORKERS,
  },
});
