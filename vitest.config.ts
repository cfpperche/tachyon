import { defineConfig } from "vitest/config";
import os from "node:os";
import path from "node:path";

/** t-6a9bc4 slice-1: never default to nproc (24 on a 15GB box thrash-kills the control plane). */
export const VITEST_MAX_WORKERS = Math.max(1, Math.min(4, os.cpus().length || 1));

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
    // fileParallelism stays default; pool size is the memory bomb, not file count alone.
  },
});
