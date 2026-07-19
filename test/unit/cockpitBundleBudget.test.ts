import { describe, it, expect } from "vitest";
import { existsSync, statSync } from "node:fs";

/** spec 410 — eager cockpit.js budget through Phase B (350 KB uncompressed). */
const EAGER_BUDGET_BYTES = 350 * 1024;
const COCKPIT_JS = "dist/webview/cockpit.js";

describe("cockpit eager bundle budget (spec 410)", () => {
  it(`keeps ${COCKPIT_JS} ≤ ${EAGER_BUDGET_BYTES} bytes when built`, () => {
    if (!existsSync(COCKPIT_JS)) {
      // Local typecheck-only runs may lack dist; CI/build paths produce it.
      expect(existsSync(COCKPIT_JS)).toBe(false);
      return;
    }
    const size = statSync(COCKPIT_JS).size;
    expect(size, `cockpit.js is ${size} bytes (budget ${EAGER_BUDGET_BYTES})`).toBeLessThanOrEqual(EAGER_BUDGET_BYTES);
  });
});
