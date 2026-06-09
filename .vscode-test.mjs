import { defineConfig } from "@vscode/test-cli";

export default defineConfig({
  files: "test/integration/**/*.test.js",
  workspaceFolder: "test/fixtures/sample-workspace",
  mocha: {
    ui: "bdd",
    timeout: 30000,
  },
});
