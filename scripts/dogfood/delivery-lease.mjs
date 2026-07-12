#!/usr/bin/env node
// SDD 368 T14.6B2: execute the forcing lifecycle, not a readiness marker.
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

const root = process.cwd();
if (!existsSync(new URL("../../package.json", import.meta.url))) {
  throw new Error("delivery lease dogfood must run from the repository checkout");
}
const result = spawnSync(process.execPath, ["./node_modules/vitest/vitest.mjs", "run", "test/unit/workspaceHeadless.test.ts", "-t", "mechanism-only canonical Delivery reuses one worktree through review completion"], { cwd: root, stdio: "inherit" });
if (result.status !== 0) throw new Error(`delivery lease dogfood lifecycle failed (${result.status ?? "signal"})`);
console.log("delivery lease dogfood lifecycle passed");
