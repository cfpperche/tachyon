// Pin vitest to THIS example's tests. Without a local config, vitest running
// from this folder resolves the parent repo's config (test/unit/**/*.test.ts)
// and finds nothing — `npm test` exits 1 with "No test files found".
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["test/**/*.test.js"] },
});
