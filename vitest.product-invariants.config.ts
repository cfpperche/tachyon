import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: { alias: { vscode: path.resolve(__dirname, "test/mocks/vscode.ts") } },
  test: {
    include: ["test/product-invariants/**/*.test.ts"],
    setupFiles: ["test/product-invariants/setup.ts"],
    environment: "node",
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
