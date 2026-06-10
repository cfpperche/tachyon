import { defineConfig } from "@vscode/test-cli";

export default defineConfig([
  {
    label: "single-root",
    files: "test/integration/**/*.test.js",
    workspaceFolder: "test/fixtures/sample-workspace",
    mocha: {
      ui: "bdd",
      timeout: 30000,
    },
  },
  {
    label: "multi-root",
    files: "test/integration-multiroot/**/*.test.js",
    workspaceFolder: "test/fixtures/multiroot/multi.code-workspace",
    mocha: {
      ui: "bdd",
      timeout: 30000,
    },
  },
]);
