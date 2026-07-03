import { defineConfig } from "vitest/config";

// spec 342 — the browser test project, SEPARATE from vitest.config.ts (plan.md: "npm run test:browser...
// NOT in default `npm test`"). These tests launch a real system Chrome via puppeteer-core; they need the
// build to have run first (`npm run build`) so dist/webview/ui-gate.* exists.
export default defineConfig({
  test: {
    include: ["test/browser/**/*.test.ts"],
    environment: "node",
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
