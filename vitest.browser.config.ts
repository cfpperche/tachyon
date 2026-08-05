import { defineConfig } from "vitest/config";
import os from "node:os";
import { readHostMemory } from "./src/host/hostResources";
import { admitOrFallback } from "./src/host/vitestBudget";

// spec 342 — the browser test project, SEPARATE from vitest.config.ts (plan.md: "npm run test:browser...
// NOT in default `npm test`"). These tests launch a real system Chrome via puppeteer-core; they need the
// build to have run first (`npm run build`) so dist/webview/ui-gate.* exists. t-6e929b adds this
// project to verify:full when its diff touches src/webview; other diffs get an explicit counted skip.
//
// t-3ad4af — being SEPARATE is exactly why it claims from the same ledger. This config is a second
// door to the same host RAM: `npm run test:browser` is a vitest invocation like any other, and one an
// agent can start while a sibling is mid-suite. It was also the heaviest door to leave unmeasured,
// because it launches a real Chrome on top of the usual per-invocation cost — so its claim is sized
// for that, not for a bare node parent. A budget one caller is exempt from is not a budget.
const memory = readHostMemory();
const admission = admitOrFallback({
  memory,
  cpuCount: os.cpus().length || 1,
  label: `${process.env.TACHYON_AGENT_NAME || "vitest"}:browser`,
  invocationMb: Number(process.env.TACHYON_VITEST_BROWSER_INVOCATION_MB) || 3072,
}, 1, (message) => process.stderr.write(`${message}\n`));
if (!admission.ok) throw new Error(`[vitest:browser] ${admission.reason}`);
process.stderr.write(`[vitest:browser] ${admission.reason}\n`);
process.on("exit", () => admission.claim.release());

export default defineConfig({
  test: {
    include: ["test/browser/**/*.test.ts"],
    environment: "node",
    testTimeout: 30_000,
    hookTimeout: 30_000,
    maxWorkers: admission.workers,
  },
});
